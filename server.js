import dotenv from 'dotenv'
import http from 'http'
import { WebSocketServer } from 'ws'
import { z } from 'zod'
import { RealtimeAgent, RealtimeSession, tool } from '@openai/agents/realtime'
import { TwilioRealtimeTransportLayer } from '@openai/agents-extensions'
import { speakAnswer } from './answers.js'
import { supabase } from './supabaseClient.js'
import { parse as parseUrl } from 'url'

dotenv.config()

const { OPENAI_API_KEY, PORT = 8080 } = process.env

if (!OPENAI_API_KEY) {
  console.error('[Fatal] Missing OPENAI_API_KEY in environment')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 1. PROMPT LOADER
// ---------------------------------------------------------------------------

const PROMPTS = {
  router:
    'You are Leivi. Greet user. If pickup, say "Let me check the schedule..." then call transfer_to_pickup. If items, say "Let me check that item..." then call transfer_to_items. If sheitels/wigs, say "Let me check the wig calendar..." then call transfer_to_sheitel.',
  pickup:
    'You are Leivi (Pickup Mode). Answer schedule questions using get_pickup_times. If user needs items or wigs, call transfer_to_main_menu.',
  items:
    'You are Leivi (Item Mode). Answer item questions using get_item_info. If user needs pickup or wigs, call transfer_to_main_menu.',
  sheitel:
    'You are Leivi (Sheitel Mode). Answer wig sale questions using get_sheitel_sales. If user needs pickup or items, call transfer_to_main_menu.',
}

async function loadPromptsFromDB() {
  try {
    const { data, error } = await supabase
      .from('agent_system_prompts')
      .select('key, content')
      .in('key', ['agent_router', 'agent_pickup', 'agent_items', 'agent_sheitel'])
      .eq('is_active', true)

    if (error) {
      console.error('[System] DB Error loading prompts:', error)
      return
    }

    data?.forEach((row) => {
      if (row.key === 'agent_router' && row.content) PROMPTS.router = row.content
      if (row.key === 'agent_pickup' && row.content) PROMPTS.pickup = row.content
      if (row.key === 'agent_items' && row.content) PROMPTS.items = row.content
      if (row.key === 'agent_sheitel' && row.content) PROMPTS.sheitel = row.content
    })

    console.log('[System] Prompts Loaded from DB')
  } catch (e) {
    console.error('[System] Unexpected DB Error while loading prompts:', e)
  }
}

// ---------------------------------------------------------------------------
// 2. API HELPERS
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

  try {
    const res = await fetch(apiUrl)
    if (!res.ok) throw new Error(`Pickup API error: HTTP ${res.status}`)
    const json = await res.json()
    return json.results || []
  } catch (e) {
    console.error('[Pickup API] Error:', e)
    return []
  }
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

async function getSheitelSales() {
  const nowIso = new Date().toISOString()
  const { data, error } = await supabase
    .from('cl_sheitel_sales')
    .select('event_date, region')
    .eq('is_active', true)
    .gte('event_date', nowIso)
    .order('event_date', { ascending: true })
    .limit(1)

  if (error) {
    console.error('[Sheitel DB Error]', error)
    return []
  }
  return data || []
}

// ---------------------------------------------------------------------------
// 3. START SERVER + WS
// ---------------------------------------------------------------------------

await loadPromptsFromDB()

const wss = new WebSocketServer({ port: PORT })

wss.on('connection', (ws, req) => {
  // Parse path + query so we can see ?source=...
  const { pathname, query } = parseUrl(req.url || '', true)
  const source = query?.source || 'direct'

  if (pathname !== '/twilio-stream') {
    console.warn('[WS] Unknown path:', pathname)
    ws.close()
    return
  }

  console.log('[WS] New Connection. source =', source)

  let session = null
  let routerAgent = null
  let pickupAgent = null
  let itemsAgent = null
  let sheitelAgent = null

  // -------------------------------------------------------------------------
  // BUSINESS TOOLS
  // -------------------------------------------------------------------------

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
          return {
            spoken_text: await speakAnswer('pickup_not_found', { city, region }),
          }
        }

        const first = results[0]
        const cityLabel = first.region || first.city || city || region || 'your location'

        if (first.is_tbd) {
          return {
            spoken_text: await speakAnswer('pickup_tbd', { city: cityLabel }),
          }
        }

        const spoken_text = await speakAnswer('pickup_success', {
          city: cityLabel,
          date_spoken: first.event_date || first.date,
          time_window: `${first.start_time} to ${first.end_time}`,
          address: first.full_address,
        })

        return { spoken_text, data: first }
      } catch (e) {
        console.error('[Tool:get_pickup_times] Error:', e)
        return {
          spoken_text: "I'm having trouble accessing the schedule right now.",
        }
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
        if (!items.length) {
          return {
            spoken_text: await speakAnswer('item_not_found', {}),
          }
        }

        if (items.length > 1) {
          const names = items.map((i) => i.item).filter(Boolean)
          const options = names.join(', ')
          return {
            spoken_text: await speakAnswer('item_ambiguous', { options }),
          }
        }

        const item = items[0]
        let key = 'item_full'
        if (focus === 'kashrus') key = 'item_kashrus_only'
        else if (focus === 'description') key = 'item_description_only'

        const spoken_text = await speakAnswer(key, {
          item: item.item,
          hechsher: item.hechsher || 'unknown',
          description: item.description || '',
        })

        return { spoken_text, data: item }
      } catch (e) {
        console.error('[Tool:get_item_info] Error:', e)
        return {
          spoken_text: "I'm having trouble accessing the item database.",
        }
      }
    },
  })

  const sheitelTool = tool({
    name: 'get_sheitel_sales',
    description: 'Check for upcoming wig/sheitel sales.',
    parameters: z.object({}), // no inputs
    execute: async () => {
      try {
        const sales = await getSheitelSales()
        if (!sales || !sales.length) {
          return {
            spoken_text: await speakAnswer('sheitel_none', {}),
          }
        }

        const sale = sales[0]
        const dateSpoken = new Date(sale.event_date).toLocaleDateString('en-US', {
          month: 'long',
          day: 'numeric',
        })

        return {
          spoken_text: await speakAnswer('sheitel_upcoming', {
            region: sale.region,
            date: dateSpoken,
          }),
        }
      } catch (e) {
        console.error('[Tool:get_sheitel_sales] Error:', e)
        return {
          spoken_text: "I'm having trouble accessing the wig sale calendar.",
        }
      }
    },
  })

  // -------------------------------------------------------------------------
  // NAVIGATION TOOLS
  // -------------------------------------------------------------------------

  const transferToPickup = tool({
    name: 'transfer_to_pickup',
    description: 'Use this to look up schedule info.',
    parameters: z.object({
      summary: z.string().describe('The user question'),
    }),
    execute: async ({ summary }) => {
      console.log('[Switch] -> Pickup | Context:', summary)
      await session.updateAgent(pickupAgent)

      if (summary) {
        setTimeout(() => {
          if (session) session.sendMessage(summary)
        }, 2500)
      }
      return '...'
    },
  })

  const transferToItems = tool({
    name: 'transfer_to_items',
    description: 'Use this to look up item info.',
    parameters: z.object({
      summary: z.string().describe('The user question'),
    }),
    execute: async ({ summary }) => {
      console.log('[Switch] -> Items | Context:', summary)
      await session.updateAgent(itemsAgent)

      if (summary) {
        setTimeout(() => {
          if (session) session.sendMessage(summary)
        }, 2500)
      }
      return '...'
    },
  })

  const transferToSheitel = tool({
    name: 'transfer_to_sheitel',
    description: 'Use this for questions about Wigs, Sheitels, or the Salon.',
    parameters: z.object({
      summary: z.string().describe('The user question'),
    }),
    execute: async ({ summary }) => {
      console.log('[Switch] -> Sheitel | Context:', summary)
      await session.updateAgent(sheitelAgent)

      if (summary) {
        setTimeout(() => {
          if (session) session.sendMessage(summary)
        }, 2500)
      }
      return '...'
    },
  })

  const transferToRouter = tool({
    name: 'transfer_to_main_menu',
    description: 'Use this when the user wants to switch topics.',
    parameters: z.object({}),
    execute: async () => {
      // If call came from IVR (e.g. Rebbi menu), go back to IVR instead of router agent
      if (source === 'ivr_rebbi') {
        console.log('[Switch] -> Back to IVR Rebbi menu (closing WS)')
        // tiny delay so the model can finish its last sentence
        setTimeout(() => {
          try {
            ws.close()
          } catch (e) {
            console.error('[WS] Error closing for IVR return:', e)
          }
        }, 500)
        return '...'
      }

      console.log('[Switch] -> Router agent')
      await session.updateAgent(routerAgent)

      setTimeout(() => {
        if (session) session.sendMessage('I need help with something else.')
      }, 2000)

      return '...'
    },
  })

  // -------------------------------------------------------------------------
  // AGENTS
  // -------------------------------------------------------------------------

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
    tools: [transferToPickup, transferToItems, transferToSheitel],
  })

  // -------------------------------------------------------------------------
  // SESSION
  // -------------------------------------------------------------------------

  session = new RealtimeSession(routerAgent, {
    transport: new TwilioRealtimeTransportLayer({ twilioWebSocket: ws }),
    model: 'gpt-realtime',
    config: {
      audio: {
        output: {
          voice: 'verse',
        },
      },
    },
  })

  session.on('error', (err) => {
    const msg = err?.message || JSON.stringify(err)
    // Ignore "active_response" chatter from interruptions
    if (msg.includes('active_response')) return
    console.error('[Session Error]', msg)
  })

  session.on('response.completed', () => {
    console.log('[Session] Response completed')
  })

  session.connect({ apiKey: OPENAI_API_KEY }).then(
    () => {
      console.log('[Session] ✅ Connected to OpenAI')
      if (session.sendMessage) {
        session.sendMessage('GREETING_TRIGGER')
      }
    },
    (err) => {
      console.error('[Session] Failed to connect to OpenAI:', err)
      ws.close()
    }
  )

  ws.on('close', () => {
    console.log('[WS] Twilio stream closed')
  })

  ws.on('error', (err) => {
    console.error('[WS] Error:', err)
  })
})

console.log(`[server] Listening for Twilio WS on port ${PORT}`)
