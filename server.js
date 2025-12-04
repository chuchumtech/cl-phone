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
  router: 'You are the router...',
  pickup: 'You are the pickup specialist...',
  items: 'You are the items specialist...'
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
// 2. HELPER: Tool Formatter
// ---------------------------------------------------------------------------
// The OpenAI API expects raw JSON for tools, but the SDK gives us objects.
// This helper ensures we send the correct format during updates.
function formatToolsForUpdate(toolList) {
  return toolList.map(t => {
    if (t.type === 'function') return t
    if (t.definition) return { type: 'function', ...t.definition }
    return t
  })
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

  let session = null // Capture session in scope
  let routerAgent = null // Capture router in scope so "Back" tool can see it

  // --- A. Define Business Tools ---

  const pickupTool = tool({
    name: 'get_pickup_times',
    description: 'Get pickup dates/times/addresses.',
    parameters: z.object({
      region: z.string().nullable().describe('Region name e.g. Brooklyn'),
      city: z.string().nullable().describe('City name e.g. Lakewood'),
    }),
    execute: async ({ region, city }) => {
      // ... (Add your API logic here) ...
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
       // ... (Add your API logic here) ...
       const spoken_text = await speakAnswer('item_full', {
           item: item_query,
           hechsher: "CRC",
           description: "Tasty cheese"
       })
       return { spoken_text }
    },
  })

  // --- B. Define Navigation Tools (The "Handoffs") ---

  // 1. Tool to go BACK (Needs 'routerAgent' which is defined later)
  const transferToRouter = tool({
    name: 'transfer_to_main_menu',
    description: 'Go back to the main menu.',
    parameters: z.object({}),
    execute: async () => {
      console.log('🔄 Switching to Router')
      if (session && routerAgent) {
        // Manually update the session with the Router's configuration
        await session.client.updateSession({
          instructions: routerAgent.instructions,
          tools: formatToolsForUpdate(routerAgent.tools)
        })
      }
      return "Transferring you to the main menu."
    }
  })

  // 2. Define Specialists (Now we can pass transferToRouter in the constructor!)
  const pickupAgent = new RealtimeAgent({
    name: 'Pickup Specialist',
    instructions: PROMPTS.pickup,
    tools: [pickupTool, transferToRouter], // <--- No .addTool needed!
  })

  const itemsAgent = new RealtimeAgent({
    name: 'Item Specialist',
    instructions: PROMPTS.items,
    tools: [itemInfoTool, transferToRouter], // <--- No .addTool needed!
  })

  // 3. Tools to go FORWARD (Use the specialists we just made)
  const transferToPickup = tool({
    name: 'transfer_to_pickup',
    description: 'Transfer to pickup department.',
    parameters: z.object({}),
    execute: async () => {
      console.log('🔄 Switching to Pickup')
      if (session) {
        await session.client.updateSession({
            instructions: pickupAgent.instructions,
            tools: formatToolsForUpdate(pickupAgent.tools)
        })
      }
      return "Transferring you to the pickup specialist."
    }
  })

  const transferToItems = tool({
    name: 'transfer_to_items',
    description: 'Transfer to item department.',
    parameters: z.object({}),
    execute: async () => {
      console.log('🔄 Switching to Items')
      if (session) {
        await session.client.updateSession({
            instructions: itemsAgent.instructions,
            tools: formatToolsForUpdate(itemsAgent.tools)
        })
      }
      return "Transferring you to the item specialist."
    }
  })

  // --- C. Finally, Define the Router Agent ---
  // Now we assign the variable we declared at the top
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
      // Important: Start ONLY with Router tools visible
      tools: formatToolsForUpdate(routerAgent.tools) 
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
