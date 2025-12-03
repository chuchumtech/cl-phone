import http from 'http'
import url from 'url'
import { WebSocketServer } from 'ws'
import dotenv from 'dotenv'
import { z } from 'zod'
import { RealtimeAgent, RealtimeSession, tool } from '@openai/agents/realtime'
import { TwilioRealtimeTransportLayer } from '@openai/agents-extensions'

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

Rules:
- Speak slowly and clearly.
- Never guess times or locations. Always call the tool.
- If the caller asks something unrelated to pickup times, explain you can only help with pickup times.
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

  // --- Define the pickup-times tool for the agent --------------------------

  const pickupTool = tool({
    name: 'get_pickup_times',
    description: 'Get pickup dates/times/addresses for a Chasdei Lev distribution location',
    parameters: z.object({
      region: z.string().optional().describe('Region name, e.g. "Brooklyn", "Five Towns"'),
      city: z.string().optional().describe('City name, e.g. "Lakewood", "Monsey"'),
    }),
    // args: { region?: string; city?: string }
    execute: async ({ region, city }) => {
      console.log('[Tool:get_pickup_times] Called with:', { region, city })
      const results = await getPickupTimes({ region, city })
      return results
    },
  })

  // --- Create the Realtime agent -------------------------------------------

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
    } catch (err) {
      console.error('[Session] Failed to connect to OpenAI:', err)
      ws.close()
    }
  })()

  ws.on('close', () => {
    console.log('[WS] Twilio stream closed')
    // Session will end automatically when transport closes,
    // but you could add extra cleanup here if needed.
  })

  ws.on('error', (err) => {
    console.error('[WS] WebSocket error', err)
  })
})

server.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`)
})