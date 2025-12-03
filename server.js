import http from 'http'
import { WebSocketServer } from 'ws'

const PORT = process.env.PORT || 8080

// Basic HTTP server (Render will ping this for health)
const server = http.createServer((req, res) => {
  res.writeHead(200)
  res.end('Chasdei Lev Voice Gateway is running')
})

const wss = new WebSocketServer({ server, path: '/twilio-stream' })

wss.on('connection', (ws, req) => {
  console.log('[WS] New Twilio media stream connected')

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString())
      console.log('[WS] Event:', data.event)

      // Later we'll handle:
      // - data.event === 'media' -> send audio to AI
      // - data.event === 'start' / 'stop' -> setup/cleanup
    } catch (e) {
      console.error('[WS] Error parsing message', e)
    }
  })

  ws.on('close', () => {
    console.log('[WS] Twilio stream closed')
  })

  ws.on('error', (err) => {
    console.error('[WS] WebSocket error', err)
  })
})

server.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`)
})