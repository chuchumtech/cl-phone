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

// ---------------------------------------------------------------------------
// 1. PROMPT LOADER
// ---------------------------------------------------------------------------
const PROMPTS = {
  // Router now explicitly knows to extract the topic
  router: 'You are the router. Greet the user. Listen to their request. If they ask about pickup/schedule, use "transfer_to_pickup" and pass their question in the "summary". If they ask about items/food, use "transfer_to_items" and pass their question.',
  pickup: 'You are the Pickup Specialist. You answer questions about dates and times using the get_pickup_times tool. If asked about items, transfer to main menu.',
  items: 'You are the Item Specialist. You answer questions about food and kashrus using the get_item_info tool. If asked about pickup, transfer to main menu.'
}

async function loadPromptsFromDB() {
  try {
    const { data } = await supabase
      .from('agent_system_prompts')
      .select('key, content')
      .in('key', ['agent_router', 'agent_pickup', 'agent_items'])
      .eq('is_active', true)

    data?.forEach(row => {
      if (row.key === 'agent_router') PROMPTS.router = row.content
      if (row.key === 'agent_pickup') PROMPTS.pickup = row.content
      if (row.key === 'agent_items') PROMPTS.items = row.content
    })
    console.log('[System] Prompts Loaded')
  } catch (e) {
    console.error('[System] DB Error', e)
  }
}

// ---------------------------------------------------------------------------
// 2. REAL API HELPERS (Restored)
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
  
  // REAL API CALL
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
// 3. SERVER
// ---------------------------------------------------------------------------

await loadPromptsFromDB()

const wss = new WebSocketServer({ port: PORT })

wss.on('connection', (ws, req) => {
  if (req.url !== '/twilio-stream') {
    ws.close()
    return
  }
  
  console.log('[WS] New Connection')

  let session = null;
  let routerAgent = null;
  let pickupAgent = null;
  let itemsAgent = null;

  // --- A. Define BUSINESS Tools (With Real Logic) ---

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
        
        if (!results.length) {
          return { spoken_text: await speakAnswer('pickup_not_found', { city, region }) }
        }
        
        const first = results[0]
        const cityLabel = first.region || first.city || city || region || 'your location'
        
        if (first.is_tbd) {
          return { spoken_text: await speakAnswer('pickup_tbd', { city: cityLabel }) }
        }

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
        let key = 'item_full'
        if (focus === 'kashrus') key = 'item_kashrus_only'
        else if (focus === 'description') key = 'item_description_only'

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

  // --- B. Define NAVIGATION Tools (With Warm Handoff) ---

  const transferToPickup = tool({
    name: 'transfer_to_pickup',
    description: 'Transfer caller to the pickup scheduling department.',
    parameters: z.object({
      summary: z.string().describe('The specific question the user asked, e.g., "When is pickup in Lakewood?"')
    }),
    execute: async ({ summary }) => {
      console.log(`🔄 Switching to Pickup [Context: ${summary}]`)
      
      // 1. Swap the Agent (Brain)
      await session.updateAgent(pickupAgent) 
      
      // 2. Inject the User's original question into the new session immediately
      // This tricks the new agent into thinking the user just asked the question.
      if (summary) {
        session.sendUserMessageContent([{ type: 'input_text', text: summary }])
      }
      
      return "Transferring you to the pickup specialist."
    }
  })

  const transferToItems = tool({
    name: 'transfer_to_items',
    description: 'Transfer caller to the item information department.',
    parameters: z.object({
      summary: z.string().describe('The specific question the user asked, e.g., "Is the cheese chalav yisroel?"')
    }),
    execute: async ({ summary }) => {
      console.log(`🔄 Switching to Items [Context: ${summary}]`)
      
      await session.updateAgent(itemsAgent)

      if (summary) {
        session.sendUserMessageContent([{ type: 'input_text', text: summary }])
      }

      return "Transferring you to the item specialist."
    }
  })

const transferToRouter = tool({
    name: 'transfer_to_main_menu',
    description: 'Go back to the main menu.',
    parameters: z.object({}),
    execute: async () => {
      console.log('🔄 Switching to Router')
      await session.updateAgent(routerAgent)
      
      // CRITICAL UPDATE: 
      // We simulate the user saying this so the Router triggers the "Returning User" logic
      // instead of the initial greeting.
      if (session && session.sendMessage) {
          session.sendMessage("I need help with something else.")
      }
      
      return "One moment, let me get the receptionist."
    }
  })

  // --- C. Initialize Agents ---

  pickupAgent = new RealtimeAgent({
    name: 'Pickup Specialist',
    instructions: PROMPTS.pickup,
    tools: [pickupTool, transferToRouter], 
  })

  itemsAgent = new RealtimeAgent({
    name: 'Item Specialist',
    instructions: PROMPTS.items,
    tools: [itemInfoTool, transferToRouter], 
  })

  routerAgent = new RealtimeAgent({
    name: 'Router',
    instructions: PROMPTS.router,
    tools: [transferToPickup, transferToItems], 
  })

  // --- D. Start Session ---

  session = new RealtimeSession(routerAgent, {
    transport: new TwilioRealtimeTransportLayer({ twilioWebSocket: ws }),
    model: 'gpt-realtime',
    config: {
      audio: { output: { voice: 'verse' } },
    }
  })

  session.connect({ apiKey: OPENAI_API_KEY })
    .then(() => {
      console.log('✅ Connected to OpenAI')
      if (session.sendMessage) {
        session.sendMessage('GREETING_TRIGGER')
      }
    })
    .catch(err => {
      console.error('[Session Error]', err)
      ws.close()
    })
})

console.log(`Listening on port ${PORT}`)
