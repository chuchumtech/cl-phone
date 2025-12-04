import http from 'http'
import url from 'url'
import { WebSocketServer } from 'ws'
import dotenv from 'dotenv'
import { z } from 'zod'
import { RealtimeAgent, RealtimeSession, tool } from '@openai/agents/realtime'
import { TwilioRealtimeTransportLayer } from '@openai/agents-extensions'
import { supabase } from './supabaseClient.js'

dotenv.config()

const { OPENAI_API_KEY } = process.env
if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in environment')
  process.exit(1)
}

const DEFAULT_SYSTEM_PROMPT = `
You are the automated Chasdei Lev pickup information assistant.
Your name is Chaim.
If your system prompt cannot be loaded from the database, you must say:
"There is a temporary issue with the Chasdei Lev phone system. Please try your call again later."
Then end the call.
`

// --- 1. Database & Template Helpers -----------------------------------------

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

async function getTemplate(key) {
  const { data, error } = await supabase
    .from('answer_templates')
    .select('spoken_template')
    .eq('key', key)
    .single()
  
  if (error || !data) {
    console.error(`[Templates] Error fetching '${key}':`, error)
    return "Information is currently unavailable."
  }
  return data.spoken_template
}

// --- 2. Location & Formatting Logic -----------------------------------------

function normalizeLocation(raw) {
  if (!raw) return ''
  const lower = raw.toLowerCase().trim()
  
  const SYNONYMS = {
    'boro park': 'Brooklyn',
    'boropark': 'Brooklyn',
    'flatbush': 'Brooklyn',
    'five towns': 'Five Towns',
    'far rockaway': 'Far Rockaway'
  }
  return SYNONYMS[lower] || raw
}

function formatSpokenDate(dateStr) {
  if (!dateStr) return ""
  const date = new Date(dateStr + 'T12:00:00') 
  const dayName = date.toLocaleDateString('en-US', { weekday: 'long' })
  const monthName = date.toLocaleDateString('en-US', { month: 'long' })
  const dayNum = date.getDate()
  
  let suffix = 'th'
  if (dayNum % 10 === 1 && dayNum !== 11) suffix = 'st'
  else if (dayNum % 10 === 2 && dayNum !== 12) suffix = 'nd'
  else if (dayNum % 10 === 3 && dayNum !== 13) suffix = 'rd'

  return `${dayName}, ${monthName} ${dayNum}${suffix}`
}

function formatSpokenTime(start, end) {
  if (!start || !end) return ""
  const to12h = (t) => {
    const [h, m] = t.split(':')
    const date = new Date()
    date.setHours(Number(h), Number(m))
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }
  return `${to12h(start)} to ${to12h(end)}`
}

// --- 3. The Tool (The Brain) -----------------------------------------------

const pickupTool = tool({
  name: 'get_pickup_times',
  description: 'Get pickup dates/times/addresses for a Chasdei Lev distribution location',
  parameters: z.object({
    city: z.string().describe('City or Region name, e.g. "Lakewood", "Monsey", "Brooklyn"'),
  }),
  execute: async ({ city }) => {
    try {
      console.log('[Tool] Searching for:', city)
      
      const searchKey = normalizeLocation(city)
      
      const { data: locations, error } = await supabase
        .from('cl_sukkos_distribution_locations_rows')
        .select('*')
        .or(`region.ilike.%${searchKey}%,city.ilike.%${searchKey}%`)
        .limit(1)

      if (error || !locations || locations.length === 0) {
        const template = await getTemplate('pickup_not_found')
        return { spoken_text: template }
      }

      const loc = locations[0]
      const cityLabel = loc.region || loc.city

      if (loc.is_tbd) {
        const template = await getTemplate('pickup_tbd')
        const spoken = template.replace('{{city}}', cityLabel)
        return { spoken_text: spoken }
      }

      const template = await getTemplate('pickup_success')
      const dateSpoken = formatSpokenDate(loc.event_date)
      const timeSpoken = formatSpokenTime(loc.start_time, loc.end_time)
      const addressParts = [
        loc.location_name, loc.address_line1, loc.city, loc.state
      ].filter(p => p && p.trim() !== '')
      
      const fullAddress = addressParts.join(', ')

      const spoken = template
        .replace('{{city}}', cityLabel)
        .replace('{{date_spoken}}', dateSpoken)
        .replace('{{time_window}}', timeSpoken)
        .replace('{{address}}', fullAddress)

      return { spoken_text: spoken }

    } catch (err) {
      console.error('[Tool] Error:', err)
      return { spoken_text: "I'm having trouble accessing the schedule right now." }
    }
  },
})

// --- 4. Server Setup --------------------------------------------------------

const PORT = process.env.PORT || 8080

const server = http.createServer((req, res) => {
  res.writeHead(200)
  res.end('Chasdei Lev Voice Gateway is running')
})

const wss = new WebSocketServer({ server })

wss.on('connection', (ws, req) => {
  const { pathname } = url.parse(req.url || '')
  console.log('[WS] New connection path:', pathname)

  if (pathname !== '/twilio-stream') {
    ws.close()
    return
  }

  const twilioTransport = new TwilioRealtimeTransportLayer({
    twilioWebSocket: ws,
  })

  ;(async () => {
    try {
      const instructions = await getSystemPrompt()
      console.log(`[System] Prompt loaded (${instructions.length} chars)`)

      const agent = new RealtimeAgent({
        name: 'Chasdei Lev Pickup Assistant',
        instructions,
        tools: [pickupTool],
      })

      const session = new RealtimeSession(agent, {
        transport: twilioTransport,
        model: 'gpt-4o-realtime-preview-2024-10-01', 
        config: {
          turnDetection: {
            type: 'server_vad',
            threshold: 0.6, // Higher = Ignores background noise
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

      session.on('response.completed', () => console.log('[Session] Response sent'))
      session.on('error', (err) => console.error('[Session] Error:', err))

      await session.connect({ apiKey: OPENAI_API_KEY })
      console.log('[Session] Connected to OpenAI')

      // --- CRITICAL FIX: FORCE THE GREETING ---
      setTimeout(() => {
          console.log('[Session] Triggering greeting...')
          
          // 1. Send the text trigger
          session.sendUserMessageContent([{ type: 'input_text', text: 'GREETING_TRIGGER' }])
          
          // 2. FORCE response generation (Required because VAD is waiting for silence)
          if (session.client && typeof session.client.createResponse === 'function') {
             session.client.createResponse();
          } else {
             // Fallback for different SDK versions: try to force a response via raw event
             // This uses the underlying client to send "response.create"
             try {
                session.client.realtime.send('response.create', { response: {} })
             } catch(e) {
                console.log("Could not force response via raw client, relying on VAD timeout")
             }
          }
      }, 1500) // 1.5s delay for Twilio to stabilize

    } catch (err) {
      console.error('[Session] Startup Error:', err)
      ws.close()
    }
  })()
})

server.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`)
})
