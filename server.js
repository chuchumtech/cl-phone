import dotenv from 'dotenv'
import http from 'http'
import url from 'url'
import { WebSocketServer } from 'ws'
import { z } from 'zod'
import { RealtimeAgent, RealtimeSession, tool } from '@openai/agents/realtime'
import { TwilioRealtimeTransportLayer } from '@openai/agents-extensions'
import { speakAnswer } from './answers.js'
import { supabase } from './supabaseClient.js'

dotenv.config()

const { OPENAI_API_KEY, PORT = 8080 } = process.env
if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 1. PROMPT MANAGEMENT
// ---------------------------------------------------------------------------

const PROMPTS = {
  router: '',
  pickup: '',
  items: ''
}

async function loadPromptsFromDB() {
  try {
    const { data, error } = await supabase
      .from('agent_system_prompts')
      .select('key, content')
      .in('key', ['agent_router', 'agent_pickup', 'agent_items'])
      .eq('is_active', true)

    if (error) throw error

    data.forEach(row => {
      if (row.key === 'agent_router') PROMPTS.router = row.content
      if (row.key === 'agent_pickup') PROMPTS.pickup = row.content
      if (row.key === 'agent_items') PROMPTS.items = row.content
    })
    
    if (!PROMPTS.router) PROMPTS.router = "You are the router. Greet the user and transfer them."
    console.log('[Prompts] Loaded agent personas from DB')
  } catch (err) {
    console.error('[Prompts] Error loading from DB:', err)
  }
}

loadPromptsFromDB()

// ---------------------------------------------------------------------------
// 2. DOMAIN HELPERS
// ---------------------------------------------------------------------------

const LOCATION_SYNONYMS = {
  'boro park': { region: 'Brooklyn' },
  boropark: { region: 'Brooklyn' },
  flatbush: { region: 'Brooklyn' },
  brooklyn: { region: 'Brooklyn' },
  lakewood: { region: 'Lakewood' },
  monsey: { region: 'Monsey' },
  'five towns': { region: 'Five Towns' },
}

function normalizeLocation(raw) {
  if (!raw) return {}
  const key = raw.toLowerCase().trim()
  const mapped = LOCATION_SYNONYMS[key]
  if (mapped?.region) return { region: mapped.region }
  if (mapped?.city) return { region: mapped.city }
  return { region: raw }
}

async function getPickupTimes({ region, city }) {
  const norm = normalizeLocation(city || region)
  const params = new URLSearchParams()
  if (norm.region) params.set('region', norm.region)
  
  const apiUrl = `https://phone.chuchumtech.com/api/pickup-times?${params.toString()}`
  console.log('[Pickup API] Fetching:', apiUrl)

  const res = await fetch(apiUrl)
  if (!res.ok) throw new Error('Pickup API error')
  const json = await res.json()
  return json.results || []
}

async function getItemRecords({ itemQuery }) {
  if (!itemQuery || !itemQuery.trim()) return []
  const search = itemQuery.trim()
  const { data, error } = await supabase
    .from('cl_items_kashrus')
    .select('*')
    .or(`item.ilike.%${search}%,description.ilike.%${search}%,aka_name.ilike.%${search}%`)
    .limit(5)
  
  if (error) {
    console.error('[DB] Item search error:', error)
    return []
  }
  return data || []
}

// ---------------------------------------------------------------------------
// 3. SERVER & SESSION
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  res.writeHead(200).end('Chasdei Lev Multi-Agent Gateway is running')
})

const wss = new WebSocketServer({ server })

// HELPER: Extract JSON definition from Tool Object for raw API updates
function formatTools(toolList) {
  return toolList.map(t => {
    // If it's already a definition, return it
    if (t.type === 'function') return t
    // If it's the SDK tool wrapper, extract the definition
    if (t.definition) return { type: 'function', ...t.definition }
    return t
  })
}

wss.on('connection', (ws, req) => {
  const { pathname } = url.parse(req.url || '')
  if (pathname !== '/twilio-stream') {
    ws.close()
    return
  }

  console.log('[WS] New Call. Initializing Router.')
  let currentSession = null

  // --- TOOL DEFINITIONS ---

  // 1. BUSINESS TOOLS
  const pickupTool = tool({
    name: 'get_pickup_times',
    description: 'Get pickup dates/times/addresses.',
    parameters: z.object({
      region: z.string().nullable().describe('Region name e.g. Brooklyn'),
      city: z.string().nullable().describe('City name e.g. Lakewood'),
    }),
    execute: async ({ region, city }) => {
      try {
        const results = await getPickupTimes({ region, city })
        if (!results.length) return { spoken_text: await speakAnswer('pickup_not_found', { city, region }) }
        
        const first = results[0]
        const cityLabel = first.region || first.city || city || region || 'your location'
        
        if (first.is_tbd) return { spoken_text: await speakAnswer('pickup_tbd', { city: cityLabel }) }

        const spoken_text = await speakAnswer('pickup_success', { 
            city: cityLabel, 
            date_spoken: first.event_date || first.date, 
            time_window: `${first.start_time} to ${first.end_time}`, 
            address: first.full_address 
        })
        return { spoken_text, data: first }
      } catch (e) {
        console.error(e)
        return { spoken_text: "I'm having trouble accessing the schedule right now." }
      }
    },
  })

  const itemInfoTool = tool({
    name: 'get_item_info',
    description: 'Get kashrus or description for an item.',
    parameters: z.object({
      item_query: z.string(),
      focus: z.enum(['kashrus', 'description', 'both']),
    }),
    execute: async ({ item_query, focus }) => {
      try {
        const items = await getItemRecords({ itemQuery: item_query })
        if (!items.length) return { spoken_text: await speakAnswer('item_not_found', {}) }
        
        if (items.length > 1) {
          const names = items.map(i => i.item).join(', ')
          return { spoken_text: await speakAnswer('item_ambiguous', { options: names }) }
        }

        const item = items[0]
        let key = focus === 'kashrus' ? 'item_kashrus_only' : focus === 'description' ? 'item_description_only' : 'item_full'
        
        const spoken_text = await speakAnswer(key, {
            item: item.item,
            hechsher: item.hechsher || 'unknown',
            description: item.description || ''
        })
        return { spoken_text, data: item }
      } catch (e) {
        return { spoken_text: "I'm having trouble accessing the item database." }
      }
    },
  })

  // 2. NAVIGATION TOOLS
  const transferToPickupTool = tool({
    name: 'transfer_to_pickup_specialist',
    description: 'Transfer caller to the pickup scheduling department.',
    parameters: z.object({}),
    execute: async () => {
      console.log('[Router] -> Pickup Specialist')
      try {
        if (currentSession && currentSession.client) {
            // FIX: Use .client.updateSession()
            await currentSession.client.updateSession({
                instructions: PROMPTS.pickup,
                tools: formatTools([pickupTool, transferToRouterTool]) // Use helper
            })
        }
        return "Transferring you to the pickup scheduler."
      } catch (err) {
        console.error('[Transfer Error]', err)
        return "I'm having trouble connecting you."
      }
    }
  })

  const transferToItemsTool = tool({
    name: 'transfer_to_items_specialist',
    description: 'Transfer caller to the product and kashrus department.',
    parameters: z.object({}),
    execute: async () => {
      console.log('[Router] -> Items Specialist')
      try {
        if (currentSession && currentSession.client) {
            await currentSession.client.updateSession({
                instructions: PROMPTS.items,
                tools: formatTools([itemInfoTool, transferToRouterTool])
            })
        }
        return "Transferring you to the item specialist."
      } catch (err) {
        console.error('[Transfer Error]', err)
        return "I'm having trouble connecting you."
      }
    }
  })

  const transferToRouterTool = tool({
    name: 'transfer_to_main_menu',
    description: 'Return to the main menu.',
    parameters: z.object({}),
    execute: async () => {
      console.log('[Nav] -> Router')
      try {
        if (currentSession && currentSession.client) {
            await currentSession.client.updateSession({
                instructions: PROMPTS.router,
                tools: formatTools([transferToPickupTool, transferToItemsTool])
            })
        }
        return "One moment, let me switch departments."
      } catch (err) {
        console.error('[Transfer Error]', err)
        return "I'm having trouble switching departments."
      }
    }
  })

  // --- INITIALIZATION ---
  
  // Register ALL tools locally so the Agent knows how to run them
  const allTools = [
    pickupTool, 
    itemInfoTool, 
    transferToPickupTool, 
    transferToItemsTool, 
    transferToRouterTool
  ]

  const agent = new RealtimeAgent({
    name: 'Chasdei Lev Assistant',
    instructions: PROMPTS.router, 
    tools: allTools, 
  })

  const twilioTransport = new TwilioRealtimeTransportLayer({
    twilioWebSocket: ws,
  })

  currentSession = new RealtimeSession(agent, {
    transport: twilioTransport,
    model: 'gpt-realtime', 
    config: {
        audio: { output: { voice: 'verse' } },
        // Initially, OpenAI only sees the Router tools
        tools: [transferToPickupTool, transferToItemsTool] 
    },
  })

  currentSession.on('response.completed', () => console.log('[Session] Response Completed'))
  currentSession.on('error', (err) => console.error('[Session] Error:', err))

  ;(async () => {
    try {
      await currentSession.connect({ apiKey: OPENAI_API_KEY })
      console.log('[Session] Connected to OpenAI')
      currentSession.sendMessage('GREETING_TRIGGER')
    } catch (err) {
      console.error('[Session] Connect failed:', err)
      ws.close()
    }
  })()
})

server.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`)
})
