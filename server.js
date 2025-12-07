import dotenv from 'dotenv'
import http from 'http'
import WebSocket, { WebSocketServer } from 'ws'
import { supabase } from './supabaseClient.js'
import { parse as parseUrl } from 'url'
import axios from 'axios'

dotenv.config()

const {
  OPENAI_API_KEY,
  PORT = 8080,
  PROMPT_REFRESH_SECRET, // set this in Render env
} = process.env

if (!OPENAI_API_KEY) {
  console.error('[Fatal] Missing OPENAI_API_KEY')
  process.exit(1)
}

// ---------------- PROMPT CACHE ----------------

const PROMPTS = {
  router: '',
  items: '',
}

async function reloadPromptsFromDB() {
  try {
    const { data, error } = await supabase
      .from('cl_phone_agents')
      .select('slug, system_prompt')
      .in('slug', ['router', 'items'])

    if (error) {
      console.error('[Prompts] Error loading from DB:', error)
      return
    }

    for (const row of data || []) {
      if (row.slug === 'router') PROMPTS.router = row.system_prompt || ''
      if (row.slug === 'items') PROMPTS.items = row.system_prompt || ''
    }

    console.log('[Prompts] Reloaded:',
      'router=', PROMPTS.router ? 'OK' : 'MISSING',
      'items=', PROMPTS.items ? 'OK' : 'MISSING'
    )
  } catch (e) {
    console.error('[Prompts] Unexpected error reloading:', e)
  }
}

// Initial load on startup
await reloadPromptsFromDB()

// ---------------- HTTP SERVER (for refresh) ----------------

const httpServer = http.createServer(async (req, res) => {
  // Simple endpoint: POST /refresh-prompts
  if (req.method === 'POST' && req.url === '/refresh-prompts') {
    const authHeader = req.headers['authorization'] || ''
    if (!PROMPT_REFRESH_SECRET || authHeader !== `Bearer ${PROMPT_REFRESH_SECRET}`) {
      res.writeHead(401, { 'Content-Type': 'text/plain' })
      return res.end('unauthorized')
    }

    await reloadPromptsFromDB()
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    return res.end('ok')
  }

  // Everything else: 404
  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('not found')
})

// ---------------- WS SERVER (for Twilio) ----------------

const wss = new WebSocketServer({ server: httpServer })

httpServer.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT} (HTTP + WS)`)
})

wss.on('connection', async (twilioWs, req) => {
  const { pathname } = parseUrl(req.url || '', true)
  if (pathname !== '/twilio-stream') {
    console.log('[WS] Unknown path:', pathname)
    twilioWs.close()
    return
  }

  console.log('[WS] New Twilio media stream connection')

  // 1) Connect to OpenAI Realtime
  const openaiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    }
  )

  let isAssistantSpeaking = false
  let currentAgent = 'router'

  openaiWs.on('open', async () => {
    console.log('[OpenAI] Realtime session opened')

    const routerPrompt = PROMPTS.router || 'You are the Chasdei Lev router agent.'

    // 1) Configure session
    openaiWs.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          instructions: routerPrompt,
          modalities: ['audio', 'text'],
          voice: 'cedar',
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          turn_detection: { type: 'server_vad' },
          tools: [
            {
              type: 'function',
              name: 'determine_route',
              description: 'Classify caller intent',
              parameters: {
                type: 'object',
                properties: {
                  message: { type: 'string' },
                  ai_classification: { type: 'string' },
                },
                required: ['message', 'ai_classification'],
              },
            },
          ],
        },
      })
    )

    // 2) Trigger initial greeting
    openaiWs.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'GREETING_TRIGGER',
            },
          ],
        },
      })
    )

    openaiWs.send(
      JSON.stringify({
        type: 'response.create',
      })
    )
  })

  // 2) Twilio → OpenAI (only when Leivi not talking)
  twilioWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())

      if (msg.event === 'start') {
        console.log('[Twilio] Call started', msg.start.callSid)
      }

      if (msg.event === 'media' && !isAssistantSpeaking) {
        openaiWs.send(
          JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: msg.media.payload, // base64 g711_ulaw
          })
        )
      }

      if (msg.event === 'stop') {
        console.log('[Twilio] Call ended')
        openaiWs.close()
      }
    } catch {
      // ignore non-JSON
    }
  })

  // 3) OpenAI → Twilio
  openaiWs.on('message', async (raw) => {
    const event = JSON.parse(raw.toString())
    // console.log('[OpenAI evt]', event.type)

    // Audio stream from model
    if (event.type === 'response.output_audio.delta') {
      isAssistantSpeaking = true
      const b64 = event.delta
      if (b64) {
        twilioWs.send(
          JSON.stringify({
            event: 'media',
            media: { payload: b64 },
          })
        )
      }
    }

    if (event.type === 'response.completed' || event.type === 'response.done') {
      isAssistantSpeaking = false
    }

    // Text chunks – look for handoff JSON
    if (event.type === 'response.output_text.delta' && event.delta) {
      const text = event.delta
      if (looksLikeHandoff(text)) {
        const handoff = JSON.parse(text)
        await handleHandoff(handoff)
      }
    }

    // Function calls from tools (arguments streamed)
    if (event.type === 'response.function_call_arguments.delta') {
      const { name, arguments: args } = event
      await handleToolCall(name, args)
    }

    if (event.type === 'error') {
      console.error('[OpenAI error event]', event)
    }
  })

  openaiWs.on('close', () => {
    console.log('[OpenAI] Socket closed')
    try {
      twilioWs.close()
    } catch {}
  })

  openaiWs.on('error', (err) => {
    console.error('[OpenAI] WS Error:', err)
    try {
      twilioWs.close()
    } catch {}
  })

  // ---------- helper: detect handoff ----------
  function looksLikeHandoff(text) {
    try {
      const obj = JSON.parse(text)
      return obj && obj.intent && obj.handoff_from
    } catch {
      return false
    }
  }

  // ---------- helper: tool calls ----------
  async function handleToolCall(name, args) {
    if (name === 'determine_route') {
      const resp = await axios.post(process.env.ROUTER_ENDPOINT, args)

      openaiWs.send(
        JSON.stringify({
          type: 'response.function_call_output',
          output: resp.data,
        })
      )
    }

    if (name === 'search_items') {
      const resp = await axios.post(process.env.ITEM_SEARCH_ENDPOINT, args)

      openaiWs.send(
        JSON.stringify({
          type: 'response.function_call_output',
          output: resp.data,
        })
      )
    }
  }

  // ---------- agent switching: router <-> items ----------
  async function handleHandoff(h) {
    console.log('[Handoff]', h)

    if (h.intent === 'items') {
      currentAgent = 'items'
      const itemsPrompt = PROMPTS.items || 'You are the Chasdei Lev items agent.'

      openaiWs.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            instructions: itemsPrompt,
            tools: [
              {
                type: 'function',
                name: 'search_items',
                description: 'Search for Chasdei Lev items',
                parameters: {
                  type: 'object',
                  properties: {
                    query: { type: 'string' },
                  },
                  required: ['query'],
                },
              },
            ],
          },
        })
      )

      if (h.question) {
        openaiWs.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: h.question }],
            },
          })
        )

        openaiWs.send(JSON.stringify({ type: 'response.create' }))
      }
    }

    if (h.intent === 'router') {
      currentAgent = 'router'
      const routerPrompt = PROMPTS.router || 'You are the Chasdei Lev router agent.'

      openaiWs.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            instructions: routerPrompt,
            tools: [
              {
                type: 'function',
                name: 'determine_route',
                description: 'Classify caller intent',
                parameters: {
                  type: 'object',
                  properties: {
                    message: { type: 'string' },
                    ai_classification: { type: 'string' },
                  },
                  required: ['message', 'ai_classification'],
                },
              },
            ],
          },
        })
      )

      if (h.question) {
        openaiWs.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: h.question }],
            },
          })
        )

        openaiWs.send(JSON.stringify({ type: 'response.create' }))
      }
    }
  }
})
