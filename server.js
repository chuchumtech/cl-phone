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
  router: 'You are the router. Greet the user. If they need pickup info, transfer to Pickup. If items, transfer to Items. Do not answer questions yourself.',
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
// 2. SERVER
// ---------------------------------------------------------------------------

await loadPromptsFromDB()

const wss = new WebSocketServer({ port: PORT })

wss.on('connection', (ws, req) => {
  if (req.url !== '/twilio-stream') {
    ws.close()
    return
  }
  
  console.log('[WS] New Connection')

  // --- VARIABLES (The Closure Trick) ---
  // We declare these upfront so the tools can reference them 
  // even though they aren't initialized yet.
  let session = null;
  let routerAgent = null;
  let pickupAgent = null;
  let itemsAgent = null;

  // --- A. Define BUSINESS Tools ---

  const pickupTool = tool({
    name: 'get_pickup_times',
    description: 'Get pickup dates/times/addresses.',
    parameters: z.object({
      region: z.string().nullable().describe('Region name e.g. Brooklyn'),
      city: z.string().nullable().describe('City name e.g. Lakewood'),
    }),
    execute: async ({ region, city }) => {
      const spoken_text = await speakAnswer('pickup_success', { 
          city: city || region || 'your location', 
          date_spoken: "Tuesday", 
          time_window: "5pm to 9pm", 
          address: "123 Main St" 
      }) 
      return { spoken_text }
    },
  })

  const itemInfoTool = tool({
    name: 'get_item_info',
    description: 'Get kashrus or description for an item.',
    parameters: z.object({
      item_query: z.string(),
      focus: z.enum(['kashrus', 'description', 'both']),
    }),
    execute: async ({ item_query }) => {
       const spoken_text = await speakAnswer('item_full', {
           item: item_query,
           hechsher: "CRC",
           description: "Available"
       })
       return { spoken_text }
    },
  })

  // --- B. Define NAVIGATION Tools ---

  const transferToPickup = tool({
    name: 'transfer_to_pickup',
    description: 'Transfer caller to the pickup scheduling department.',
    parameters: z.object({}),
    execute: async () => {
      console.log('🔄 Switching to Pickup Agent')
      // Uses the 'pickupAgent' variable which will be defined by the time this runs
      await session.updateAgent(pickupAgent) 
      return "Transferring you to the pickup specialist."
    }
  })

  const transferToItems = tool({
    name: 'transfer_to_items',
    description: 'Transfer caller to the item information department.',
    parameters: z.object({}),
    execute: async () => {
      console.log('🔄 Switching to Items Agent')
      await session.updateAgent(itemsAgent)
      return "Transferring you to the item specialist."
    }
  })

  const transferToRouter = tool({
    name: 'transfer_to_main_menu',
    description: 'Go back to the main menu/receptionist.',
    parameters: z.object({}),
    execute: async () => {
      console.log('🔄 Switching to Router Agent')
      await session.updateAgent(routerAgent)
      return "One moment, let me get the receptionist."
    }
  })

  // --- C. Initialize Agents ---
  // Now we create the agents using the tools we just defined.
  // Note: We do NOT use .addTool(). We pass the array in the constructor.

  pickupAgent = new RealtimeAgent({
    name: 'Pickup Specialist',
    instructions: PROMPTS.pickup,
    tools: [pickupTool, transferToRouter], // Has the business tool + back button
  })

  itemsAgent = new RealtimeAgent({
    name: 'Item Specialist',
    instructions: PROMPTS.items,
    tools: [itemInfoTool, transferToRouter], // Has the business tool + back button
  })

  routerAgent = new RealtimeAgent({
    name: 'Router',
    instructions: PROMPTS.router,
    tools: [transferToPickup, transferToItems], // Can only transfer
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
