import dotenv from 'dotenv'
import http from 'http'
import url from 'url'
import { WebSocketServer } from 'ws'
import { z } from 'zod'
import { RealtimeAgent, RealtimeSession, tool } from '@openai/agents/realtime'
import { TwilioRealtimeTransportLayer } from '@openai/agents-extensions'
import { speakAnswer } from './answers.js'   // 👈 NEW
import { supabase } from './supabaseClient.js' // same one answers.js uses

const DEFAULT_SYSTEM_PROMPT = `
You are the automated Chasdei Lev pickup information assistant.
If your system prompt cannot be loaded from the database, you must say:
"There is a temporary issue with the Chasdei Lev phone system. Please try your call again later."
Then end the call.
`

async function getSystemPrompt() {
  try {
    const { data, error } = await supabase
      .from('agent_system_prompts')
      .select('content')
      .eq('key', 'cl_pickup_system_prompt')
      .eq('is_active', true)
      .single()

    if (error || !data) {
      console.error('[Prompt] Error loading system prompt:', error)
      return DEFAULT_SYSTEM_PROMPT
    }

    return data.content
  } catch (err) {
    console.error('[Prompt] Unexpected error loading system prompt:', err)
    return DEFAULT_SYSTEM_PROMPT
  }
}

//dotenv.config()

const { OPENAI_API_KEY } = process.env
if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in environment')
  process.exit(1)
}



// --- Location helpers -------------------------------------------------------

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

// --- Tool: pickup-times using speakAnswer -----------------------------------

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

      // --- Format date + time nicely for speech ----------------------------

      const rawDate = first.event_date || first.date || ''
      const dateSpoken = formatSpokenDate(rawDate)

      const start = formatTime24To12(first.start_time)
      const end = formatTime24To12(first.end_time)

      const timeWindowSpoken =
        first.is_tbd
          ? '' // if TBD, we’ll just omit the time window for now
          : start && end
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

      // Prefer region-style label (Brooklyn / Monsey / Lakewood)
      const cityLabel =
        first.region || first.city || city || region || 'your location'

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

// --- HTTP + WebSocket server -----------------------------------------------

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

  const twilioTransport = new TwilioRealtimeTransportLayer({
    twilioWebSocket: ws, // this is the Twilio Media Streams WS connection
  })

  ;(async () => {
    try {
      // 👇 Load system prompt from Supabase (or fall back to default)
      const instructions = await getSystemPrompt()
      console.log('[Prompt] Using instructions length:', instructions.length)

      // --- Create the Realtime agent for THIS call -------------------------
      const agent = new RealtimeAgent({
        name: 'Chasdei Lev Pickup Assistant',
        instructions: instructions,
        tools: [pickupTool],
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

      // Optional: log basic events from the session
      session.on('response.completed', () => {
        console.log('[Session] Response completed')
      })

      session.on('error', (err) => {
        console.error('[Session] Error:', err)
      })

      await session.connect({ apiKey: OPENAI_API_KEY })
      console.log('[Session] Connected to OpenAI Realtime API')

      // 👇 Force Chaim to greet immediately on call connect
      session.sendMessage('GREETING_TRIGGER')
    } catch (err) {
      console.error('[Session] Failed to start Realtime session:', err)
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
