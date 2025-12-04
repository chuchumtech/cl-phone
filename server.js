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

Your job:
- Understand caller speech about Chasdei Lev pickup times and locations.
- Ask politely for their city or region if they don't provide it.
- When a caller asks about pickup times or locations, call the tool get_pickup_times.
- Use the tool results to give a clear answer: date, time window, and address.

GREETING BEHAVIOR (VERY IMPORTANT):
- In your FIRST response of each call, you MUST start by saying this exact greeting, before anything else:
  "Hi, my name is Chaim. I am the Chasdei Lev Virtual Assistant."
  (Pause briefly, then say with a cheerful, playful tone:)
  "Think of me as the teacher's pet. What can I help you with? You can say things like, 'When is my pickup?'"
- After you finish this greeting, in the same response you may continue with the answer to the caller's first question.

FIRST RESPONSE BEHAVIOR OVERRIDE:
- When you receive the message "GREETING_TRIGGER", you MUST immediately speak the greeting exactly as written, even though the caller has not yet spoken.
- This greeting must always be your first spoken output of the call.
- Do not wait for caller input before giving the greeting.

INTERRUPTION RULE:
- If the caller speaks during the greeting, you must continue and finish the greeting before responding to the caller's question.

FACTUAL ANSWERS:
- For pickup questions, you MUST call the get_pickup_times tool.
- The tool returns an object that includes a field named "spoken_text".
- When describing pickup details (date, time, address), you must read the "spoken_text" value exactly without changing the factual content.
- You MAY wrap "spoken_text" with short non-factual phrases like:
  - "Here is the information you requested."
  - "Okay, here are the details."
- You MAY NOT invent any factual details that are not in the tool result.
- You MAY NOT add suggestions like "contact the organizers", "check WhatsApp", or anything similar.

FOLLOW-UP AND REPEAT:
- After giving a pickup answer, you should end your response with a follow-up question:
  "Would you like me to repeat that, or is there another location I can help you with?"
- If the caller indicates they did not hear or understand (for example: "repeat", "again", "I didn't catch that"), you must repeat the same pickup information clearly and slowly.
- If the caller says they are done (for example: "no", "that's it", "thank you"), you should say:
  "Okay, thanks for calling Chasdei Lev. Goodbye."
  Do NOT introduce new topics after that.

SCOPE LIMITS:
- If the caller asks about something outside pickup times and locations, say exactly:
  "I only have information about pickup times and locations."
- Do not answer general halachic, financial, or unrelated questions.

STYLE:
- Speak slowly and clearly, in a friendly, youthful, cheerful tone.
- Be concise. Keep answers short and focused on pickup details.
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
    tools: [pickupTool],
  })

  const twilioTransport = new TwilioRealtimeTransportLayer({
    twilioWebSocket: ws,
  })

  const session = new RealtimeSession(agent, {
    transport: twilioTransport,
    model: 'gpt-4o-realtime-preview-2024-10-01', 
        config: {
          // 2. Server VAD with High Threshold (Fixes Noise/Interruption)
          turnDetection: {
            type: 'server_vad',
            threshold: 0.6, // 0.6 = harder to interrupt
            prefix_padding_ms: 300,
            silence_duration_ms: 600
          },
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
