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
function formatForOpenAI(toolList) {
  return toolList.map(t => {
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

  let session = null 

  // --- A. Define CORE Tools ---

  const pickupTool = tool({
    name: 'get_pickup_times',
    description: 'Get pickup dates/times/addresses.',
    parameters: z.object({
      region: z.string().nullable().describe('Region name e.g. Brooklyn'),
      city: z.string().nullable().describe('City name e.g. Lakewood'),
    }),
    execute: async ({ region, city }) => {
      // ⬇️ Replace this with your actual API Logic from previous versions
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
       // ⬇️ Replace this with your actual API Logic from previous versions
       const spoken_text = await speakAnswer('item_full', {
           item: item_query,
           hechsher: "CRC",
           description: "Available"
       })
       return { spoken_text }
    },
  })

  // --- B. Define NAVIGATION Tools ---
  
  const pickupToolsList = [pickupTool] 
  const itemsToolsList = [itemInfoTool]
  
  // 1. Transfer TO Pickup
  const transferToPickup = tool({
    name: 'transfer_to_pickup',
    description: 'Transfer to pickup department.',
    parameters: z.object({}),
    execute: async () => {
      console.log('🔄 Switching to Pickup')
      if (session && session.client) {
        // Add "Back" button dynamically
        const toolsForPickup = [...pickupToolsList, transferToRouter]
        
        await session.client.updateSession({
            instructions: PROMPTS.pickup,
            tools: formatForOpenAI(toolsForPickup)
        })
      }
      return "Transferring you to the pickup specialist."
    }
  })

  // 2. Transfer TO Items
  const transferToItems = tool({
    name: 'transfer_to_items',
    description: 'Transfer to item department.',
    parameters: z.object({}),
    execute: async () => {
      console.log('🔄 Switching to Items')
      if (session && session.client) {
        const toolsForItems = [...itemsToolsList, transferToRouter]
        
        await session.client.updateSession({
            instructions: PROMPTS.items,
            tools: formatForOpenAI(toolsForItems)
        })
      }
      return "Transferring you to the item specialist."
    }
  })

  // 3. Transfer BACK to Router
  const transferToRouter = tool({
    name: 'transfer_to_main_menu',
    description: 'Go back to the main menu.',
    parameters: z.object({}),
    execute: async () => {
      console.log('🔄 Switching to Router')
      if (session && session.client) {
        const toolsForRouter = [transferToPickup, transferToItems]
        
        await session.client.updateSession({
          instructions: PROMPTS.router,
          tools: formatForOpenAI(toolsForRouter)
        })
      }
      return "Transferring you to the main menu."
    }
  })

  // --- C. Master Logic ---

  const allTools = [
    pickupTool,
    itemInfoTool,
    transferToPickup,
    transferToItems,
    transferToRouter
  ]

  const masterAgent = new RealtimeAgent({
    name: 'Chasdei Lev Logic Core',
    instructions: PROMPTS.router, 
    tools: allTools, // Register ALL tools locally
  })

  // --- D. Start Session ---

  session = new RealtimeSession(masterAgent, {
    transport: new TwilioRealtimeTransportLayer({ twilioWebSocket: ws }),
    model: 'gpt-realtime',
    config: {
      audio: { output: { voice: 'verse' } },
      // Start with ONLY Router tools visible
      tools: formatForOpenAI([transferToPickup, transferToItems]) 
    }
  })

  session.connect({ apiKey: OPENAI_API_KEY })
    .then(() => {
      console.log('✅ Connected to OpenAI')
      // FIX: Use session.client to send the user message
      session.client.sendUserMessageContent([{ type: 'input_text', text: 'GREETING_TRIGGER' }])
    })
    .catch(err => {
      console.error(err)
      ws.close()
    })
})

console.log(`Listening on port ${PORT}`)
