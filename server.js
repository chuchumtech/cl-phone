import dotenv from 'dotenv'
import http from 'http'
import url from 'url'
import { WebSocketServer } from 'ws'
import { z } from 'zod'
import { RealtimeAgent, RealtimeSession, tool } from '@openai/agents/realtime'
import { TwilioRealtimeTransportLayer } from '@openai/agents-extensions'
import { speakAnswer } from './answers.js'
import { supabase } from './supabaseClient.js'

// Load .env locally; on Render, env vars are injected directly and this is harmless
dotenv.config()

const { OPENAI_API_KEY } = process.env
if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in environment')
  process.exit(1)
}

// ---------------- SYSTEM PROMPT (DEFAULT + DB OVERRIDE) --------------------

const DEFAULT_SYSTEM_PROMPT = `
You are the automated Chasdei Lev pickup information assistant.
If your system prompt cannot be loaded from the database, you must say:
"There is a temporary issue with the Chasdei Lev phone system. Please try your call again later."
Then end the call.
`

// This is what the agent will actually use. We’ll try to override it from Supabase:
let SYSTEM_PROMPT = DEFAULT_SYSTEM_PROMPT

async function loadSystemPromptFromDB() {
  try {
    const { data, error } = await supabase
      .from('agent_system_prompts')
      .select('content')
      .eq('key', 'cl_pickup_system_prompt')
      .eq('is_active', true)
      .single()

    if (error || !data) {
      console.error('[Prompt] DB error or missing row, using DEFAULT_SYSTEM_PROMPT:', error)
      SYSTEM_PROMPT = DEFAULT_SYSTEM_PROMPT
      return
    }

    if (!data.content || typeof data.content !== 'string' || !data.content.trim()) {
      console.error('[Prompt] Empty/invalid content in DB, using DEFAULT_SYSTEM_PROMPT')
      SYSTEM_PROMPT = DEFAULT_SYSTEM_PROMPT
      return
    }

    SYSTEM_PROMPT = data.content
    console.log('[Prompt] Loaded system prompt from DB, length:', SYSTEM_PROMPT.length)
  } catch (err) {
    console.error('[Prompt] Unexpected error loading system prompt, using default:', err)
    SYSTEM_PROMPT = DEFAULT_SYSTEM_PROMPT
  }
}

// Fire once on startup (no await needed)
loadSystemPromptFromDB()

// ---------------- LOCATION HELPERS -----------------------------------------

const LOCATION_SYNONYMS = {
  'boro park': { region: 'Brooklyn' },
  boropark: { region: 'Brooklyn' },
  flatbush: { region: 'Brooklyn' },
  brooklyn: { region: 'Brooklyn' },
  lakewood: { region: 'Lakewood' },
  monsey: { region: 'Monsey' },
  'five towns': { region: 'Five Towns' },
  // add more as needed
}

function normalizeLocation(raw) {
  if (!raw) return {}

  const key = raw.toLowerCase().trim()
  const mapped = LOCATION_SYNONYMS[key]

  // If we have a mapped region (e.g. "flatbush" => "Brooklyn")
  if (mapped?.region) {
    return { region: mapped.region }
  }

  // If we had mapped city, treat that as region for the API
  if (mapped?.city) {
    return { region: mapped.city }
  }

  // Fallback: whatever the caller said is the region
  return { region: raw }
}

async function getPickupTimes({ region, city }) {
  const norm = normalizeLocation(city || region)
  const params = new URLSearchParams()

  if (norm.region) params.set('region', norm.region)
  if (norm.city) params.set('region', norm.region)

  const apiUrl = `https://phone.chuchumtech.com/api/pickup-times?${params.toString()}`
  console.log('[Pickup] Fetching:', apiUrl)

  const res = await fetch(apiUrl)
  if (!res.ok) {
    console.error('[Pickup] Error from pickup-times API:', res.status, await res.text())
    throw new Error('Pickup API error')
  }

  const json = await res.json()
  console.log('[Pickup] Results:', JSON.stringify(json))

  return json.results || []
}

async function getItemRecords({ itemQuery }) {
  if (!itemQuery || !itemQuery.trim()) {
    return []
  }

  const search = itemQuery.trim()

  // Try to match by item name or description
  const { data, error } = await supabase
    .from('cl_items_kashrus') // 👈 change if your table name is different
    .select('*')
    .or(`item.ilike.%${search}%,description.ilike.%${search}%`)
    .limit(5)

  if (error) {
    console.error('[Items] Error fetching item info:', error)
    return []
  }

  return data || []
}
// ---------------- TOOL: pickup-times using speakAnswer ----------------------

function formatTime24To12(t) {
  // t is like "12:30:00"
  if (!t) return ''
  const [h, m] = t.split(':')
  const date = new Date()
  date.setHours(Number(h), Number(m), 0, 0)
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatSpokenDate(isoDate) {
  // isoDate like "2025-09-14"
  if (!isoDate) return ''
  const d = new Date(isoDate + 'T12:00:00') // avoid timezone weirdness
  return d.toLocaleDateString('en-US', {
    weekday: 'long',   // Sunday
    month: 'long',     // September
    day: 'numeric',    // 14
    // we skip the year so it doesn't sound clunky
  })
}

const pickupTool = tool({
  name: 'get_pickup_times',
  description: 'Get pickup dates/times/addresses for a Chasdei Lev distribution location',
  parameters: z.object({
    region: z.string().optional().describe('Region name, e.g. "Brooklyn", "Five Towns"'),
    city: z.string().optional().describe('City name, e.g. "Lakewood", "Monsey"'),
  }),
  execute: async ({ region, city }) => {
    try {
      console.log('[Tool:get_pickup_times] Called with:', { region, city })
      const results = await getPickupTimes({ region, city })

      if (!results.length) {
        const spoken_text = await speakAnswer('pickup_not_found', {
          city,
          region,
        })

        return {
          spoken_text,
          has_results: false,
          results: [],
        }
      }

      const first = results[0]

      // Prefer region-style label (Brooklyn / Monsey / Lakewood)
      const cityLabel =
        first.region || first.city || city || region || 'your location'

      // 🔴 NEW: Handle TBD *before* formatting date/time
      if (first.is_tbd === true) {
        const spoken_text = await speakAnswer('pickup_tbd', {
          city: cityLabel,
        })

        return {
          spoken_text,
          has_results: false,  // no concrete date/time yet
          results,
        }
      }

      // --- Format date + time nicely for speech (only when NOT TBD) --------
      const rawDate = first.event_date || first.date || ''
      const dateSpoken = formatSpokenDate(rawDate)

      const start = formatTime24To12(first.start_time)
      const end = formatTime24To12(first.end_time)

      const timeWindowSpoken =
        start && end
          ? `${start} to ${end}`
          : ''

      const address =
        first.full_address ||
        [
          first.location_name,
          first.address_line1,
          first.address_line2,
          first.city,
          first.state,
          first.postal_code,
        ]
          .filter(Boolean)
          .join(', ')

      const spoken_text = await speakAnswer('pickup_success', {
        city: cityLabel,
        date_spoken: dateSpoken,
        time_window: timeWindowSpoken,
        address,
      })

      return {
        spoken_text,
        has_results: true,
        results,
      }
    } catch (err) {
      console.error('[Tool:get_pickup_times] Error:', err)
      const spoken_text = await speakAnswer('fallback_error')
      return {
        spoken_text,
        has_results: false,
        results: [],
      }
    }
  },
})

const itemInfoTool = tool({
  name: 'get_item_info',
  description:
    'Get kashrus/hechsher details and a basic description for a specific Chahs-day Layv item.',
  parameters: z.object({
    item_query: z
      .string()
      .describe('What the caller says about the item, e.g. "cheese pack", "Haolam cheese", "salmon".'),
    focus: z
      .enum(['kashrus', 'description', 'both'])
      .describe(
        'What the caller is primarily asking about: kashrus, description, or both. If unsure, use "both".'
      ),
  }),
  execute: async ({ item_query, focus }) => {
    try {
      console.log('[Tool:get_item_info] Called with:', { item_query, focus })

      const items = await getItemRecords({ itemQuery: item_query })

      if (!items || !items.length) {
        const spoken_text = await speakAnswer('item_not_found', {})
        return {
          spoken_text,
          has_results: false,
          results: [],
        }
      }

      // If multiple possible items, ask which one
      if (items.length > 1) {
        const names = items.map((it) => it.item).filter(Boolean)
        let optionsText = ''

        if (names.length === 1) {
          optionsText = names[0]
        } else if (names.length === 2) {
          optionsText = `${names[0]} and ${names[1]}`
        } else {
          const last = names[names.length - 1]
          const rest = names.slice(0, -1)
          optionsText = `${rest.join(', ')}, and ${last}`
        }

        const spoken_text = await speakAnswer('item_ambiguous', {
          options: optionsText,
        })

        return {
          spoken_text,
          has_results: false,
          results: items,
        }
      }

      // Exactly one item found
      const item = items[0]

      const baseParams = {
        item: item.item || item_query,
        hechsher: item.hechsher || 'not specified',
        description: item.description || 'no description available',
      }

      // Decide which template to use based on focus
      let key = 'item_full'
      if (focus === 'kashrus') key = 'item_kashrus_only'
      else if (focus === 'description') key = 'item_description_only'

      const spoken_text = await speakAnswer(key, baseParams)

      return {
        spoken_text,
        has_results: true,
        results: [item],
      }
    } catch (err) {
      console.error('[Tool:get_item_info] Error:', err)
      const spoken_text = await speakAnswer('fallback_error')
      return {
        spoken_text,
        has_results: false,
        results: [],
      }
    }
  },
})

// ---------------- HTTP + WebSocket server ----------------------------------

const PORT = process.env.PORT || 8080

const server = http.createServer((req, res) => {
  res.writeHead(200)
  res.end('Chasdei Lev Voice Gateway is running')
})

const wss = new WebSocketServer({ server })

wss.on('connection', (ws, req) => {
  const { pathname } = url.parse(req.url || '')
  console.log('[WS] New connection on path:', pathname)

  if (pathname !== '/twilio-stream') {
    console.log('[WS] Unknown path, closing')
    ws.close()
    return
  }

  console.log('[WS] New Twilio media stream connected')

  // --- Create the Realtime agent for THIS call (same as working version) ---
  const agent = new RealtimeAgent({
    name: 'Chasdei Lev Pickup Assistant',
    instructions: SYSTEM_PROMPT,   // 👈 now DB-updated global
    tools: [pickupTool, itemInfoTool],
  })

  const twilioTransport = new TwilioRealtimeTransportLayer({
    twilioWebSocket: ws,
  })

  const session = new RealtimeSession(agent, {
    transport: twilioTransport,
    model: 'gpt-realtime', 
        config: {
          audio: {
        output: {
          voice: 'verse',
        },
      },
    },
  })

  session.on('response.completed', () => {
    console.log('[Session] Response completed')
  })

  session.on('error', (err) => {
    console.error('[Session] Error:', err)
  })

  ;(async () => {
    try {
      await session.connect({ apiKey: OPENAI_API_KEY })
      console.log('[Session] Connected to OpenAI Realtime API')

      // Same greeting trigger as in your last working version
      session.sendMessage('GREETING_TRIGGER')
    } catch (err) {
      console.error('[Session] Failed to connect to OpenAI:', err)
      ws.close()
    }
  })()

  ws.on('close', () => {
    console.log('[WS] Twilio stream closed')
  })

  ws.on('error', (err) => {
    console.error('[WS] WebSocket error', err)
  })
})

server.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`)
})
