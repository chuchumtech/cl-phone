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
// 1. PROMPT & AGENT MANAGEMENT
// ---------------------------------------------------------------------------

const PROMPTS = {
  router: 'You are the router...',
  pickup: 'You are the pickup specialist...',
  items: 'You are the items specialist...'
}

async function loadPromptsFromDB() {
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
}

// ---------------------------------------------------------------------------
// 2. TOOL DEFINITIONS (Reusable)
// ---------------------------------------------------------------------------

// We define tools *outside* the connection to keep code clean. 
// They don't need 'session' access if they just return data strings.

const pickupTool = tool({
  name: 'get_pickup_times',
  description: 'Get pickup dates/times/addresses.',
  parameters: z.object({
    region: z.string().nullable().describe('Region name e.g. Brooklyn'),
    city: z.string().nullable().describe('City name e.g. Lakewood'),
  }),
  execute: async ({ region, city }) => {
    // ... (Your existing pickup logic) ...
    // For brevity, assuming this returns the spoken text string
    return { spoken_text: "Pickup is Tuesday at 5pm." } 
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
    // ... (Your existing item logic) ...
    return { spoken_text: "The cheese is Chalav Yisrael." }
  },
})

// ---------------------------------------------------------------------------
// 3. SERVER LOGIC
// ---------------------------------------------------------------------------

await loadPromptsFromDB() // Load once at startup

const wss = new WebSocketServer({ port: PORT })

wss.on('connection', (ws, req) => {
  if (req.url !== '/twilio-stream') {
    ws.close()
    return
  }
  
  // --- DEFINE AGENTS ---
  // We create 3 distinct "Brains". 
  // Each has its own Instructions and its own Tools.

  const pickupAgent = new RealtimeAgent({
    name: 'Pickup Specialist',
    instructions: PROMPTS.pickup,
    tools: [pickupTool], // This agent ONLY knows pickup tools
  })

  const itemsAgent = new RealtimeAgent({
    name: 'Item Specialist',
    instructions: PROMPTS.items,
    tools: [itemInfoTool], // This agent ONLY knows item tools
  })

  // We define the Router's tools *here* because they need access to `session`
  // to perform the switch (the "Handoff").

  const transferToPickup = tool({
    name: 'transfer_to_pickup',
    description: 'Transfer to the pickup scheduling department.',
    parameters: z.object({}),
    execute: async () => {
      console.log('🔄 Switching to Pickup Agent')
      // THE MAGIC FIX: Use updateAgent()
      await session.updateAgent(pickupAgent)
      // Return a message so the new agent knows what happened
      return "Transfer complete. You are now speaking with the Pickup Specialist."
    }
  })

  const transferToItems = tool({
    name: 'transfer_to_items',
    description: 'Transfer to the item information department.',
    parameters: z.object({}),
    execute: async () => {
      console.log('🔄 Switching to Items Agent')
      await session.updateAgent(itemsAgent)
      return "Transfer complete. You are now speaking with the Item Specialist."
    }
  })

  // Add a "Back to Menu" tool for the specialists to use
  const transferToRouter = tool({
    name: 'transfer_to_main_menu',
    description: 'Go back to the main menu.',
    parameters: z.object({}),
    execute: async () => {
      console.log('🔄 Switching to Router')
      await session.updateAgent(routerAgent)
      return "Transfer complete. You are back at the main menu."
    }
  })

  // Add the "Back" tool to the specialists
  // (We modify the instances we created above)
  pickupAgent.addTool(transferToRouter)
  itemsAgent.addTool(transferToRouter)

  // Finally, define the Router Agent
  const routerAgent = new RealtimeAgent({
    name: 'Router',
    instructions: PROMPTS.router,
    tools: [transferToPickup, transferToItems],
  })

  // --- START SESSION ---

  const session = new RealtimeSession(routerAgent, {
    transport: new TwilioRealtimeTransportLayer({ twilioWebSocket: ws }),
    model: 'gpt-realtime',
    config: {
      audio: { output: { voice: 'verse' } }
    }
  })

  session.connect({ apiKey: OPENAI_API_KEY })
    .then(() => {
      console.log('✅ Connected to OpenAI')
      session.sendUserMessageContent([{ type: 'input_text', text: 'GREETING_TRIGGER' }])
    })
    .catch(err => {
      console.error(err)
      ws.close()
    })
})

console.log(`Listening on port ${PORT}`)
