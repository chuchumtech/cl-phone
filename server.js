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
  router: 'You are Leivi. Greet user. If pickup, say "Let me check the schedule..." -> transfer_to_pickup. If items, say "Let me check that item..." -> transfer_to_items. If sheitels/wigs, say "Let me check the wig calendar..." -> transfer_to_sheitel.',
  pickup: 'You are Leivi (Pickup Mode). Answer schedule questions. If user needs items/wigs, call transfer_to_main_menu.',
  items: 'You are Leivi (Item Mode). Answer item questions. If user needs pickup/wigs, call transfer_to_main_menu.',
  sheitel: 'You are Leivi (Sheitel Mode). Answer wig sale questions. If user needs pickup/items, call transfer_to_main_menu.'
}

async function loadPromptsFromDB() {
  try {
    const { data } = await supabase
      .from('agent_system_prompts')
      .select('key, content')
      .in('key', ['agent_router', 'agent_pickup', 'agent_items', 'agent_sheitel'])
      .eq('is_active', true)

    data?.forEach(row => {
      if (row.key === 'agent_router') PROMPTS.router = row.content
      if (row.key === 'agent_pickup') PROMPTS.pickup = row.content
      if (row.key === 'agent_items') PROMPTS.items = row.content
      if (row.key === 'agent_sheitel') PROMPTS.sheitel = row.content
    })
    console.log('[System] Prompts Loaded')
  } catch (e) { console.error(e) }
}

// --- API HELPERS ---

// ... (Keep getPickupTimes and getItemRecords here) ...

async function getSheitelSales() {
    // We only select date and region. We intentionally do NOT select the address.
    const { data, error } = await supabase
        .from('cl_sheitel_sales')
        .select('event_date, region') 
        .eq('is_active', true)
        .gte('event_date', new Date().toISOString())
        .order('event_date', { ascending: true })
        .limit(1)

    if (error) {
        console.error('[Sheitel DB Error]', error)
        return []
    }
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
  let sheitelAgent = null; // New Agent Variable

  // --- BUSINESS TOOLS ---

  // ... (Keep pickupTool and itemInfoTool here) ...

  const sheitelTool = tool({
    name: 'get_sheitel_sales',
    description: 'Check for upcoming wig/sheitel sales.',
    parameters: z.object({}), // No parameters needed, just checks the calendar
    execute: async () => {
      const sales = await getSheitelSales()
      
      if (!sales || !sales.length) {
          return { spoken_text: await speakAnswer('sheitel_none', {}) }
      }

      const sale = sales[0]
      // Format date for speech
      const dateSpoken = new Date(sale.event_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })

      return { 
          spoken_text: await speakAnswer('sheitel_upcoming', { 
              region: sale.region, 
              date: dateSpoken 
          })
      }
    },
  })

  // --- NAVIGATION TOOLS ---

  // ... (Keep transferToPickup and transferToItems here) ...

  const transferToSheitel = tool({
      name: 'transfer_to_sheitel',
      description: 'Use this for questions about Wigs, Sheitels, or the Salon.',
      parameters: z.object({
        summary: z.string().describe('The user question')
      }),
      execute: async ({ summary }) => {
        console.log(`[Switch] -> Sheitel | Context: ${summary}`)
        await session.updateAgent(sheitelAgent)
        
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

  sheitelAgent = new RealtimeAgent({
    name: 'Sheitel Brain',
    instructions: PROMPTS.sheitel,
    tools: [sheitelTool, transferToRouter],
  })

  routerAgent = new RealtimeAgent({
    name: 'Router Brain',
    instructions: PROMPTS.router,
    tools: [transferToPickup, transferToItems, transferToSheitel], // Added new transfer tool
  })

  // --- SESSION ---

  session = new RealtimeSession(routerAgent, {
    transport: new TwilioRealtimeTransportLayer({ twilioWebSocket: ws }),
    model: 'gpt-realtime',
    config: { audio: { output: { voice: 'verse' } } }
  })

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
