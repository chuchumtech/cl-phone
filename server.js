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
// 1. PROMPT MANAGEMENT (DB LOADER)
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
    
    // Fallback/Safety check
    if (!PROMPTS.router) console.warn('[Prompts] Warning: Router prompt missing from DB')
    
    console.log('[Prompts] Loaded agent personas from DB')
  } catch (err) {
    console.error('[Prompts] Error loading from DB:', err)
  }
}

// Load on startup
loadPromptsFromDB()

// ---------------------------------------------------------------------------
// 2. DOMAIN HELPERS (API Calls)
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

wss.on('connection', (ws, req) => {
  const { pathname } = url.parse(req.url || '')
  if (pathname !== '/twilio-stream') {
    ws.close()
    return
  }

  console.log('[WS] New Call. Initializing Router.')

  let currentSession = null

  // --- TOOL DEFINITIONS (Inside connection scope to access currentSession) ---

  // A. BUSINESS TOOLS (Only used by Specialists)
  
  const pickupTool = tool({
    name: 'get_pickup_times',
    description: 'Get pickup dates/times/addresses.',
    parameters: z.object({
      // FIXED: Used nullable() instead of optional() for Strict Mode
      region: z.string().nullable().describe('The region name if mentioned, e.g. Brooklyn'),
      city: z.string().nullable().describe('The city name if mentioned, e.g. Lakewood'),
    }),
    execute: async ({ region, city }) => {
      try {
        const results = await getPickupTimes({ region, city })
        
        // 1. Not Found
        if (!results.length) {
          return { spoken_text: await speakAnswer('pickup_not_found', { city, region }) }
        }
        
        const first = results[0]
        const cityLabel = first.region || first.city || city || region || 'your location'
        
        // 2. TBD
        if (first.is_tbd) {
          return { spoken_text: await speakAnswer('pickup_tbd', { city: cityLabel }) }
        }

        // 3. Success
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
      // FIXED: Removed optional(), forced the enum to be required. 
      focus: z.enum(['kashrus', 'description', 'both']).describe('Whether the user wants kashrus info, description, or both.'), 
    }),
    execute: async ({ item_query, focus }) => {
      try {
        const items = await getItemRecords({ itemQuery: item_query })
        
        // 1. Not Found
        if (!items.length) return { spoken_text: await speakAnswer('item_not_found', {}) }
        
        // 2. Ambiguous
        if (items.length > 1) {
          const names = items.map(i => i.item).join(', ')
          return { spoken_text: await speakAnswer('item_ambiguous', { options: names }) }
        }

        // 3. Success
        const item = items[0]
        let key = 'item_full'
        if (focus === 'kashrus') key = 'item_kashrus_only'
        else if (focus === 'description') key = 'item_description_only'
        // Default to 'item_full' if 'both' is passed

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

  // B. NAVIGATION TOOLS (Used to swap agents)

  // Swaps to Pickup Agent
  const transferToPickupTool = tool({
    name: 'transfer_to_pickup_specialist',
    description: 'Use this when the user asks about schedule, pickup, times, or location.',
    parameters: z.object({}),
    execute: async () => {
      console.log('[Router] -> Pickup Specialist')
      if (currentSession) {
        await currentSession.update({
            instructions: PROMPTS.pickup, // Swaps the System Prompt
            tools: [pickupTool, transferToRouterTool] // Swaps the Tools
        })
      }
      return "Transferring you to the pickup scheduler."
    }
  })

  // Swaps to Item Agent
  const transferToItemsTool = tool({
    name: 'transfer_to_items_specialist',
    description: 'Use this when the user asks about food, products, items, or hechsher/kashrus.',
    parameters: z.object({}),
    execute: async () => {
      console.log('[Router] -> Items Specialist')
      if (currentSession) {
        await currentSession.update({
            instructions: PROMPTS.items, // Swaps the System Prompt
            tools: [itemInfoTool, transferToRouterTool] // Swaps the Tools
        })
      }
      return "Transferring you to the item specialist."
    }
  })

  // Swaps back to Router (Main Menu)
  const transferToRouterTool = tool({
    name: 'transfer_to_main_menu',
    description: 'Use this if the user asks a question you cannot answer because it is not your department.',
    parameters: z.object({}),
    execute: async () => {
      console.log('[Nav] -> Router')
      if (currentSession) {
        await currentSession.update({
            instructions: PROMPTS.router,
            tools: [transferToPickupTool, transferToItemsTool]
        })
      }
      return "One moment, let me switch departments."
    }
  })

  // --- INITIALIZATION (Start as Router) ---
  
  const agent = new RealtimeAgent({
    name: 'Chasdei Lev Router',
    instructions: PROMPTS.router, 
    tools: [transferToPickupTool, transferToItemsTool], // Router starts with only transfer tools
  })

  const twilioTransport = new TwilioRealtimeTransportLayer({
    twilioWebSocket: ws,
  })

  currentSession = new RealtimeSession(agent, {
    transport: twilioTransport,
    model: 'gpt-realtime', 
    config: {
        audio: { output: { voice: 'verse' } },
    },
  })

  currentSession.on('response.completed', () => console.log('[Session] Response Completed'))
  currentSession.on('error', (err) => console.error('[Session] Error:', err))

  ;(async () => {
    try {
      await currentSession.connect({ apiKey: OPENAI_API_KEY })
      console.log('[Session] Connected to OpenAI')
      
      // Only the Router handles the greeting!
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
