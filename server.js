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
  PROMPT_REFRESH_SECRET,
  ROUTER_ENDPOINT,
  ITEM_SEARCH_ENDPOINT,
} = process.env

if (!OPENAI_API_KEY) {
  console.error('[Fatal] Missing OPENAI_API_KEY')
  process.exit(1)
}
if (!ROUTER_ENDPOINT) {
  console.warn('[Warn] ROUTER_ENDPOINT not set – router tool will fail.')
}
if (!ITEM_SEARCH_ENDPOINT) {
  console.warn('[Warn] ITEM_SEARCH_ENDPOINT not set – items tool will fail.')
}

// ---------------------------------------------------------------------------
// 1. PROMPT CACHE
// ---------------------------------------------------------------------------

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

    console.log(
      '[Prompts] Reloaded:',
      'router=', PROMPTS.router ? 'OK' : 'MISSING',
      'items=', PROMPTS.items ? 'OK' : 'MISSING'
    )
  } catch (e) {
    console.error('[Prompts] Unexpected error reloading:', e)
  }
}

// Initial load on startup
await reloadPromptsFromDB()

// ---------------------------------------------------------------------------
// 2. HTTP SERVER (for /refresh-prompts)
// ---------------------------------------------------------------------------

const httpServer = http.createServer(async (req, res) => {
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

  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('not found')
})

// ---------------------------------------------------------------------------
// 3. WS SERVER (Twilio <-> OpenAI Realtime)
// ---------------------------------------------------------------------------

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
  let callSid = null
  let openaiReady = false
  let twilioStarted = false
  let greetingSent = false

  // Map: call_id -> toolName for function calling
  const functionCallMap = new Map()

  function maybeSendGreeting() {
    if (!openaiReady || !twilioStarted || greetingSent) return

    greetingSent = true
    console.log('[Greeting] Sending GREETING_TRIGGER to OpenAI')

    // Trigger greeting
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

    openaiWs.send(JSON.stringify({ type: 'response.create' }))
  }

  // ---------------- OpenAI WS: on open ----------------

  openaiWs.on('open', () => {
    console.log('[OpenAI] Realtime session opened')

    const routerPrompt =
      PROMPTS.router || 'You are the Chasdei Lev router agent.'

    openaiWs.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          instructions: routerPrompt,
          modalities: ['audio', 'text'],
          // Use a known-good voice for gpt-4o-realtime-preview
          // (alloy, ash, ballad, coral, echo, sage, shimmer, verse)
          voice: 'cedar',
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          turn_detection: { type: 'server_vad' },
          tools: [
            {
              type: 'function',
              name: 'determine_route',
              description: 'Classify caller intent for Chasdei Lev phone calls.',
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

    openaiReady = true
    maybeSendGreeting()
  })

  // ---------------- Twilio -> OpenAI ----------------

  twilioWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())

      if (msg.event === 'start') {
        callSid = msg.start?.callSid || null
        console.log('[Twilio] Call started', callSid)
        twilioStarted = true
        maybeSendGreeting()
      }

      if (msg.event === 'media') {
        if (!isAssistantSpeaking) {
          openaiWs.send(
            JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: msg.media.payload, // base64 g711_ulaw
            })
          )
        } else {
          // Ignore caller audio while assistant is speaking
        }
      }

      if (msg.event === 'stop') {
        console.log('[Twilio] Call ended', callSid)
        try {
          openaiWs.close()
        } catch {}
      }
    } catch {
      // ignore non-JSON frames
    }
  })

  twilioWs.on('close', () => {
    console.log('[WS] Twilio websocket closed')
    try {
      openaiWs.close()
    } catch {}
  })

  twilioWs.on('error', (err) => {
    console.error('[WS] Twilio WS Error:', err)
    try {
      openaiWs.close()
    } catch {}
  })

  // ---------------- OpenAI -> Twilio ----------------

  openaiWs.on('message', async (raw) => {
    const event = JSON.parse(raw.toString())
    console.log('[OpenAI evt]', event.type)

    switch (event.type) {
      // ---- AUDIO OUT ----
      case 'response.output_audio.delta': {
        isAssistantSpeaking = true
        const b64 = event.delta
        if (b64) {
          twilioWs.send(
            JSON.stringify({
              event: 'media',
              media: { payload: b64 }, // base64 g711_ulaw
            })
          )
        }
        break
      }

      case 'response.output_audio.done': {
        // audio finished for this response (we also rely on response.done)
        break
      }

      case 'response.done': {
        // Full response finished; safe to listen again
        isAssistantSpeaking = false
        break
      }

      // ---- TEXT OUT (optionally carry handoff JSON if you want) ----
      case 'response.output_text.delta': {
        const text = event.delta
        if (text && looksLikeHandoff(text)) {
          const handoff = JSON.parse(text)
          await handleHandoff(handoff)
        }
        break
      }

      // ---- FUNCTION CALL LIFECYCLE ----
      case 'response.output_item.added': {
        const item = event.item
        if (item?.type === 'function_call') {
          const toolName = item.name
          const callId = item.call_id
          if (callId && toolName) {
            functionCallMap.set(callId, toolName)
            console.log('[Tool] function_call started', callId, toolName)
          }
        }
        break
      }

      case 'response.function_call_arguments.delta': {
        // We could accumulate args here; we wait for .done
        break
      }

      case 'response.function_call_arguments.done': {
        const callId = event.call_id
        const argsJson = event.arguments || '{}'
        let args = {}
        try {
          args = JSON.parse(argsJson)
        } catch (e) {
          console.error('[Tool] Failed to parse arguments JSON:', e, argsJson)
        }

        const toolName = functionCallMap.get(callId)
        if (!toolName) {
          console.warn('[Tool] Unknown call_id:', callId)
          break
        }

        await handleToolCall(toolName, args, callId)
        break
      }

      case 'error': {
        console.error('[OpenAI error event]', event)
        break
      }

      default:
        // ignore other events
        break
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

  // -------------------------------------------------------------------------
  // 4. HANDOFF DETECTOR (if you ever embed JSON in text)
  // -------------------------------------------------------------------------

  function looksLikeHandoff(text) {
    try {
      const obj = JSON.parse(text)
      return obj && obj.intent && obj.handoff_from
    } catch {
      return false
    }
  }

  // -------------------------------------------------------------------------
  // 5. TOOL CALL HANDLING (determine_route, search_items)
// ---------------------------------------------------------------------------

  async function handleToolCall(toolName, args, callId) {
    try {
      if (toolName === 'determine_route') {
        if (!ROUTER_ENDPOINT) {
          console.error('[Tool] ROUTER_ENDPOINT not configured')
          return
        }

        const resp = await axios.post(ROUTER_ENDPOINT, {
          ...args,
          call_sid: callSid,
          current_agent: currentAgent,
        })

        const output = resp.data || {}

        // Attach function_call_output
        openaiWs.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: callId,
              output,
            },
          })
        )

        openaiWs.send(JSON.stringify({ type: 'response.create' }))

        // Optionally: auto-handoff when router says so
        if (output.intent && output.intent === 'items') {
          await handleHandoff({
            handoff_from: 'router',
            intent: 'items',
            question_type: output.question_type || 'specific',
            question: output.cleaned_question || null,
          })
        }

        return
      }

      if (toolName === 'search_items') {
        if (!ITEM_SEARCH_ENDPOINT) {
          console.error('[Tool] ITEM_SEARCH_ENDPOINT not configured')
          return
        }

        const resp = await axios.post(ITEM_SEARCH_ENDPOINT, {
          ...args,
          call_sid: callSid,
        })

        const output = resp.data || {}

        openaiWs.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: callId,
              output,
            },
          })
        )

        openaiWs.send(JSON.stringify({ type: 'response.create' }))
        return
      }

      console.warn('[Tool] Unknown toolName:', toolName)
    } catch (err) {
      console.error('[Tool] Error in handleToolCall', toolName, err)
    }
  }

  // -------------------------------------------------------------------------
  // 6. AGENT SWITCHING (router <-> items)
// ---------------------------------------------------------------------------

  async function handleHandoff(h) {
    console.log('[Handoff]', h)

    if (h.intent === 'items') {
      currentAgent = 'items'
      const itemsPrompt =
        PROMPTS.items || 'You are the Chasdei Lev items agent.'

      openaiWs.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            instructions: itemsPrompt,
            tools: [
              {
                type: 'function',
                name: 'search_items',
                description: 'Search for Chasdei Lev items and return item details.',
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
      const routerPrompt =
        PROMPTS.router || 'You are the Chasdei Lev router agent.'

      openaiWs.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            instructions: routerPrompt,
            tools: [
              {
                type: 'function',
                name: 'determine_route',
                description: 'Classify caller intent for Chasdei Lev phone calls.',
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
