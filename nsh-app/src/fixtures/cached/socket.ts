// The real app over a controllable transport. No computer, credentials or real network are used.
import { host } from 'nsh'

let online = !(host.params as { offline?: boolean } | undefined)?.offline
let version = 1
const sockets: FakeSocket[] = []
host.on('fixture.connection', (data: any) => {
  online = data.online
  if (data.version) version = data.version
  for (const socket of sockets) {
    if (!online && socket.readyState !== 3) socket.close()
    else if (online && socket.readyState === 0) socket.open()
  }
})

class FakeSocket {
  readyState = 0
  onopen?: () => void
  onmessage?: (e: { data: string }) => void
  onclose?: () => void
  onerror?: () => void
  constructor(_url: string) { sockets.push(this); setTimeout(() => { if (online) this.open() }, 0) }
  open() { this.readyState = 1; this.onopen?.() }
  send(raw: string) {
    const m = JSON.parse(raw)
    if (m.type !== 'open') return
    let value: unknown
    if (m.endpoint === 'workspace/follow') value = { type: 'baseline', value: {
      items: [{ workspaceId: 'w1', path: '/synthetic/project', title: `Project-v${version}`, sessionIds: ['s1', 's2'] }],
      archivedSessionIds: [], pinnedSessionIds: ['s2'],
    } }
    else if (m.endpoint === 'session/follow') {
      const id = m.payload.args.request.address.sessionId
      value = { type: 'snapshot', header: { id }, cursor: 1, hasMore: false,
        projections: { values: { title: id === 's1' ? 'First chat' : 'Second chat' } }, assistantStream: { revision: 0 }, records: [
          { type: 'event', event: { type: 'user/message', seq: 1, time: 1, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: `History-${id}-v${version}` }], source: { kind: 'user' } }, surfaceOp: 'append' } },
        ] }
    }
    if (value) setTimeout(() => { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify({ type: 'item', streamId: m.streamId, value }) }) }, 0)
  }
  close() { this.readyState = 3; this.onclose?.() }
}
;(globalThis as any).WebSocket = FakeSocket
