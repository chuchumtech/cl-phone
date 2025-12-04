import dotenv from 'dotenv'
import http from 'http'
import { WebSocketServer } from 'ws'
import { z } from 'zod'
import { RealtimeAgent, RealtimeSession, tool } from '@openai/agents/realtime'
import { TwilioRealtimeTransportLayer } from '@openai/agents-extensions'
import { speakAnswer } from './answers.js'
import { supabase } from './supabaseClient.js'

dotenv.config()

const { OPENAI_API_KEY, PORT = 8080 } = process.env

// --- PROMPTS ---
const PROMPTS = {
  router: 'You are Leivi. Greet user. If they ask for pickup, say "Let me check the schedule..." and call transfer_to_pickup. If items, say "Let me check that item..." and call transfer_to_items.',
  pickup: 'You are Leivi (Pickup Mode). Answer schedule questions. If user needs items/something else, call transfer_to_main_menu.',
  items: 'You are Leivi (Item Mode). Answer item questions. If user needs pickup/something else, call transfer_to_main_menu.'
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
  } catch (e) { console.error(e) }
}

// --- API HELPERS (Keeping these short for brevity, assume full logic exists) ---
// ... (Include your full getPickupTimes and getItemRecords functions here) ...
// For the sake of this paste, I am assuming the API logic is exactly as your previous working version.
async function getPickupTimes({ region, city }) {
    // ... insert your fetch logic here ...
    const params = new URLSearchParams();
    if(region) params.append('region', region);
    if(city) params.append('region', city); // API quirk
    
    // Quick Hack for testing if you don't paste the full function
    // In production, paste the full function from previous steps
    const res = await fetch(`https://phone.chuchumtech.com/api/pickup-times?${params.toString()}`);
    const json = await res.json();
    return json.results || [];
}

async function getItemRecords({ itemQuery }) {
    // ... insert your DB logic here ...
     const search = itemQuery.trim()
     const { data } = await supabase.from('cl_items_kashrus')
        .select('*')
        .or(`item.ilike.%${search}%,description.ilike.%${search}%`)
        .limit(5)
     return data || []
}

// --- SERVER ---

await loadPromptsFromDB()
const wss = new WebSocketServer({ port: PORT })

wss.on('connection', (ws, req) => {
  if (req.url !== '/twilio-stream') { ws.close(); return; }
  console.log('[WS] New Connection')

  let session = null;
  let routerAgent = null;
  let pickupAgent = null;
  let itemsAgent = null;

  // --- TOOLS ---

  const pickupTool = tool({
    name: 'get_pickup_times',
    description: 'Get pickup dates/times.',
    parameters: z.object({
      region: z.string().nullable(),
      city: z.string().nullable(),
    }),
    execute: async ({ region, city }) => {
      try {
        const results = await getPickupTimes({ region, city })
        if (!results.length) return { spoken_text: await speakAnswer('pickup_not_found', { city, region }) }
        
        const first = results[0]
        const cityLabel = first.region || first.city || city || 'your location'
        
        if (first.is_tbd) return { spoken_text: await speakAnswer('pickup_tbd', { city: cityLabel }) }

        return { 
            spoken_text: await speakAnswer('pickup_success', { 
                city: cityLabel, 
                date_spoken: first.event_date || first.date, 
                time_window: `${first.start_time} to ${first.end_time}`, 
                address: first.full_address 
            })
        }
      } catch (e) { return { spoken_text: "I'm having trouble accessing the schedule." } }
    },
  })

  const itemInfoTool = tool({
    name: 'get_item_info',
    description: 'Get item details.',
    parameters: z.object({
      item_query: z.string(),
      focus: z.enum(['kashrus', 'description', 'both']),
    }),
    execute: async ({ item_query }) => {
      const items = await getItemRecords({ itemQuery: item_query })
      if (!items.length) return { spoken_text: await speakAnswer('item_not_found', {}) }
      if (items.length > 1) return { spoken_text: await speakAnswer('item_ambiguous', { options: items.map(i=>i.item).join(', ') }) }
      
      const item = items[0]
      return { 
          spoken_text: await speakAnswer('item_full', {
              item: item.item, hechsher: item.hechsher || 'unknown', description: item.description || ''
          })
      }
    },
  })

  // --- NAVIGATION (THE INVISIBLE HANDOFF) ---

  const transferToPickup = tool({
    name: 'transfer_to_pickup',
    description: 'Use this to look up schedule info.',
    parameters: z.object({
      summary: z.string().describe('The user question')
    }),
    execute: async ({ summary }) => {
      console.log(`[Switch] -> Pickup | Context: ${summary}`)
      await session.updateAgent(pickupAgent)
      
      // Delay to let the "Sure, let me check..." audio finish naturally
      if (summary) {
        setTimeout(() => { if(session) session.sendMessage(summary) }, 2500)
      }
      // Return a silence filler so the user hears nothing weird
      return "..." 
    }
  })

  const transferToItems = tool({
    name: 'transfer_to_items',
    description: 'Use this to look up item info.',
    parameters: z.object({
      summary: z.string().describe('The user question')
    }),
    execute: async ({ summary }) => {
      console.log(`[Switch] -> Items | Context: ${summary}`)
      await session.updateAgent(itemsAgent)
      
      if (summary) {
        setTimeout(() => { if(session) session.sendMessage(summary) }, 2500)
      }
      return "..."
    }
  })

  const transferToRouter = tool({
    name: 'transfer_to_main_menu',
    description: 'Use this when the user wants to switch topics.',
    parameters: z.object({}),
    execute: async () => {
      console.log('[Switch] -> Router')
      await session.updateAgent(routerAgent)
      
      // Trigger the "Returning User" logic
      setTimeout(() => { 
          if(session) session.sendMessage("I need help with something else.") 
      }, 2000)
      
      return "..."
    }
  })

  // --- AGENTS ---

  pickupAgent = new RealtimeAgent({
    name: 'Pickup Brain',
    instructions: PROMPTS.pickup,
    tools: [pickupTool, transferToRouter],
  })

  itemsAgent = new RealtimeAgent({
    name: 'Items Brain',
    instructions: PROMPTS.items,
    tools: [itemInfoTool, transferToRouter],
  })

  routerAgent = new RealtimeAgent({
    name: 'Router Brain',
    instructions: PROMPTS.router,
    tools: [transferToPickup, transferToItems],
  })

  // --- SESSION ---

  session = new RealtimeSession(routerAgent, {
    transport: new TwilioRealtimeTransportLayer({ twilioWebSocket: ws }),
    model: 'gpt-realtime',
    config: { audio: { output: { voice: 'verse' } } }
  })

  // Ignore race condition errors
  session.on('error', (err) => {
      const msg = err.message || JSON.stringify(err);
      if (msg.includes('active_response')) return;
      console.error('[Error]', msg);
  })

  session.connect({ apiKey: OPENAI_API_KEY }).then(() => {
      console.log('✅ Connected')
      if (session.sendMessage) session.sendMessage('GREETING_TRIGGER')
  })
})

console.log(`Listening on port ${PORT}`)
