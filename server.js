import http from 'http'
import url from 'url'
import { WebSocketServer } from 'ws'
import dotenv from 'dotenv'
import { z } from 'zod'
import { RealtimeAgent, RealtimeSession, tool } from '@openai/agents/realtime'
import { TwilioRealtimeTransportLayer } from '@openai/agents-extensions'
import { speakAnswer } from './answers.js'   // 👈 NEW

dotenv.config()

const { OPENAI_API_KEY } = process.env
if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in environment')
  process.exit(1)
}

const SYSTEM_PROMPT = `
You are the automated Chasdei Lev pickup information assistant.

Your job:
- Understand caller speech.
- Ask politely for their city or region if they don't provide it.
- When a caller asks about pickup times or locations, call the tool get_pickup_times.
- Use the tool results to give a clear answer: date, time window, and address.

CRITICAL RULES:
- You are NOT allowed to guess, speculate, or invent any information.
- For pickup questions, you MUST call the get_pickup_times tool.
- The tool returns an object that includes a field named "spoken_text".
- You must speak ONLY the "spoken_text" value, exactly as it is, with no extra words before or after.
- Do NOT add extra suggestions like "maybe contact the organizers" or anything similar.
- If the tool's "spoken_text" says that there is no information, you must say only that and nothing more.
- If the caller asks about something outside pickup times and locations, say exactly:
  "I only have information about pickup times and locations."
- You are not a general assistant; you answer only using tool results.
`

// --- Location helpers -------------------------------------------------------

const LOCATION_SYNONYMS = {
  'boro park': { region: 'Brooklyn' },
  boropark: { region: 'Brooklyn' },
  flatbush: { region: 'Brooklyn' },
  brooklyn: { region: 'Brooklyn' },
  lakewood: { city: 'Lakewood' },
  monsey: { city: 'Monsey' },
  'five towns': { region: 'Five Towns' },
  // add more as needed
}

function normalizeLocation(raw) {
  if (!raw) return {}

  const key = raw.toLowerCase().trim()
  const mapped = LOCATION_SYNONYMS[key]
  if (mapped) return mapped

  // Fallback: assume it’s a city
  return { city: raw }
}

async function getPickupTimes({ region, city }) {
  const norm = normalizeLocation(city || region)
  const params = new URLSearchParams()

  if (norm.region) params.set('region', norm.region)
  if (norm.city) params.set('city', norm.city)

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

const pickupTool = tool({
  name: 'get_pickup_times',
  description: 'Get pickup dates/times/addresses for a Chasdei Lev distribution location',
  parameters: z.object({
    region: z.string().optional().describe('Region name, e.g. "Brooklyn", "Five Towns"'),
    city: z.string().optional().describe('City name, e.g. "Lakewood", "Monsey"'),
  }),
  // args: { region?: string; city?: string }
  execute: async ({ region, city }) => {
    try {
      console.log('[Tool:get_pickup_times] Called with:', { region, city })
      const results = await getPickupTimes({ region, city })

      if (!results.length) {
        // No data for that location → use a fixed, safe template
        const spoken_text = await speakAnswer('pickup_not_found', {
          city: city || region || 'that location',
        })

        return {
          spoken_text,
          has_results: false,
          results: [],
        }
      }

      // Use the first result as the primary answer (you can change this later)
      const first = results[0]

      const spoken_text = await speakAnswer('pickup_success', {
        city: first.city || city || region || 'your location',
        date: first.date || '',
        time_window: first.time_window || '',
        address: first.address || '',
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

  // --- Create the Realtime agent for THIS call -----------------------------

  const agent = new RealtimeAgent({
    name: 'Chasdei Lev Pickup Assistant',
    instructions: SYSTEM_PROMPT,
    tools: [pickupTool],
  })

  // --- Bridge Twilio <-> OpenAI via the Twilio transport -------------------

  const twilioTransport = new TwilioRealtimeTransportLayer({
    twilioWebSocket: ws, // this is the Twilio Media Streams WS connection
  })

  const session = new RealtimeSession(agent, {
    transport: twilioTransport,
    model: 'gpt-realtime', // OpenAI Realtime voice model
    config: {
      audio: {
        output: {
          voice: 'verse', // you can change the voice later if you want
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

  ;(async () => {
    try {
      await session.connect({ apiKey: OPENAI_API_KEY })
      console.log('[Session] Connected to OpenAI Realtime API')

      // Optional: greet the caller from AI itself
      session.sendMessage({
        type: 'input_text',
        text:
    "Speak in a cheerful, young-sounding voice. " +
    "Hi, my name is Chaim. I am the Chasdei Lev Virtual Assistant. " +
    "Think of me as the teacher's pet! " +
    "What can I help you with? You can say things like, 'When is my pickup?'",
      })
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
