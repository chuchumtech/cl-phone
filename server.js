import dotenv from 'dotenv'
import { WebSocketServer } from 'ws'
import { supabase } from './supabaseClient.js'
import { parse as parseUrl } from 'url'
import axios from 'axios'

dotenv.config()

const { OPENAI_API_KEY, PORT = 8080 } = process.env

if (!OPENAI_API_KEY) {
  console.error('[Fatal] Missing OPENAI_API_KEY')
  process.exit(1)
}

// ---------------- PROMPTS FROM DB ----------------

async function loadAgentPrompt(slug) {
  const { data, error } = await supabase
    .from('cl_phone_agents')
    .select('system_prompt')
    .eq('slug', slug)
    .single()

  if (error) {
    console.error('[DB] Error loading prompt for', slug, error)
    return ''
  }
  return data.system_prompt || ''
}

// ---------------- START WS SERVER ----------------

const wss = new WebSocketServer({ port: PORT })
console.log(`[server] Listening for Twilio WS on port ${PORT}`)

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

    const routerPrompt = await loadAgentPrompt('router')

    openaiWs.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          instructions: routerPrompt,
          modalities: ['audio', 'text'],
          voice: 'verse',            // 👈 choose voice here
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          turn_detection: { type: 'server_vad' },
          tools: [
            {
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
  })

  // 2) Twilio → OpenAI (only when Leivi not talking)
  twilioWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())

      if (msg.event === 'start') {
        console.log('[Twilio] Call started', msg.start.callSid)
      }

      if (msg.event === 'media' && !isAssistantSpeaking) {
        // Twilio media payload is μ-law 8kHz
        // Because we set input_audio_format = g711_ulaw,
        // we can pass it straight through as base64 bytes.
        openaiWs.send(
          JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: msg.media.payload, // already base64 ulaw
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

    // Audio stream from model
    if (event.type === 'response.output_audio.delta') {
      isAssistantSpeaking = true
      const b64 = event.delta
      if (b64) {
        twilioWs.send(
          JSON.stringify({
            event: 'media',
            media: { payload: b64 }, // g711_ulaw already
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

    // Function calls from tools
    if (event.type === 'response.function_call_arguments.delta') {
      // when arguments are streamed, you usually accumulate;
      // for simplicity assume we receive full args in one event:
      const { name, arguments: args } = event
      await handleToolCall(name, args)
    }
  })

  openaiWs.on('close', () => {
    console.log('[OpenAI] Socket closed')
    try {
      twilioWs.close()
    } catch {}
  })

  openaiWs.on('error', (err) => {
    console.error('[OpenAI] Error:', err)
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
      const resp = await axios.post(
        process.env.ROUTER_ENDPOINT, // your Vercel determine-route
        args
      )

      openaiWs.send(
        JSON.stringify({
          type: 'response.function_call_output',
          output: resp.data,
        })
      )
    }

    if (name === 'search_items') {
      const resp = await axios.post(
        process.env.ITEM_SEARCH_ENDPOINT, // your Vercel search-items
        args
      )

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
      const itemsPrompt = await loadAgentPrompt('items')

      openaiWs.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            instructions: itemsPrompt,
            // keep same voice/model/audio formats
            tools: [
              {
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
      const routerPrompt = await loadAgentPrompt('router')

      openaiWs.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            instructions: routerPrompt,
            tools: [
              {
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
