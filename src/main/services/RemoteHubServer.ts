/**
 * RemoteHubServer — هاب محلی روی 127.0.0.1 — stub
 * PWA فقط از طریق tailscale serve / cloudflared به همین پورت می‌رسد
 */
import { createServer, type Server } from 'node:http'

let server: Server | null = null

export function startHub(port = 0): number {
  if (server) return (server.address() as any)?.port ?? 0
  server = createServer((req, res) => {
    // CORS فقط origin خود هاب
    res.setHeader('content-type', 'application/json; charset=utf-8')
    if (req.url === '/health') {
      res.end(JSON.stringify({ ok: true }))
      return
    }
    res.statusCode = 404
    res.end(JSON.stringify({ ok: false, error: 'not found' }))
  })
  // فقط loopback
  server.listen(port, '127.0.0.1')
  return (server.address() as any)?.port ?? 0
}

export function stopHub() {
  if (server) {
    server.close()
    server = null
  }
}
