// A linked phone (../../../header-fixture.tsx) whose computer connects, keeps trying or cannot be reached (host.params.connection: online,
// connecting, offline), for src/header.test.tsx on every target, the device hosts too: the shell's calls and the socket
// are answered here, before the app loads. Synthetic data only; no computer, credentials or network are used.
import { host } from 'nsh'

const ORIGIN = 'http://127.0.0.1:40001/dsh'
const mode = ((host.params ?? {}) as { connection?: string }).connection ?? 'online'
const now = Date.now()
const answers: Record<string, unknown> = {
  'link.state': { paired: true, origin: ORIGIN, token: 'synthetic-device-token', cacheId: 'synthetic-header' },
  'link.path': { kind: 'direct' }, 'link.tailcatOnly': { on: false }, 'network.state': { online: true }, 'app.state': { active: true },
  'app.info': { version: '0.0.0', build: '0', os: 'sample', deviceClass: 'phone' }, 'app.clock': { hourCycle: 'h23' },
  'link.diagnose': { relay: 'reachable', computer: 'unreachable' },
  'link.lastFailure': mode === 'offline' ? { reason: 'no-answer', code: 'unreachable', route: 'relay', at: now, dialMs: 20_000 } : null,
}
// connecting: the check of which part answers is still running, so the banner keeps saying it connects (after 3 s
// without a connection it would show what the check found).
;(host as any).call = (name: string) =>
  mode === 'connecting' && name === 'link.diagnose' ? new Promise(() => {}) : Promise.resolve(answers[name] ?? null)
// The two chats the socket of fixtures/cached/socket.ts follows.
const list = { type: 'server-response', rpcId: 'x', result: { ok: true, value: { items: [
  { sessionId: 's1', updatedAt: now - 10 * 60_000, running: false, blank: false, cwd: '/synthetic/project', projections: { asOfSeq: 1, values: { title: 'First chat' } } },
  { sessionId: 's2', updatedAt: now - 2 * 3600_000, running: false, blank: false, cwd: '/synthetic/project', projections: { asOfSeq: 1, values: { title: 'Second chat' } } },
] } } }
;(globalThis as any).fetch = async (url: string) => {
  if (mode !== 'online') throw new Error('no answer')
  if (String(url).endsWith('/api/session/list')) return new Response(JSON.stringify(list), { status: 200, headers: { 'content-type': 'application/json' } })
  return new Response('{}', { status: 404 })
}

// online: the socket of fixtures/cached/socket.ts (imported before this file), which opens and lists two chats.
if (mode !== 'online') {
  class Unreachable {
    readyState = 0
    onopen?: () => void
    onmessage?: (e: { data: string }) => void
    onclose?: () => void
    onerror?: () => void
    // connecting: the socket neither opens nor fails; offline: it fails at once, each time the app tries again.
    constructor(_url: string) { if (mode === 'offline') setTimeout(() => this.close(), 0) }
    send() {}
    close() { if (this.readyState === 3) return; this.readyState = 3; this.onerror?.(); this.onclose?.() }
  }
  ;(globalThis as any).WebSocket = Unreachable
}
