// DSH's streams for the pin tests (src/pins.test.tsx): workspace/follow starts with no chat pinned, and the
// `fixture.desktop-pins` host event pushes the pin set DSH Desktop would push after a pin there. Made-up chats only.
import { host } from 'nsh'

const follows: FakeSocket[] = []
host.on('fixture.desktop-pins', (data: any) => {
  for (const s of follows) s.push({ type: 'pinned', pinnedSessionIds: data.ids })
})

class FakeSocket {
  readyState = 0
  onopen?: () => void
  onmessage?: (e: { data: string }) => void
  onclose?: () => void
  onerror?: () => void
  private stream = ''
  constructor(_url: string) { setTimeout(() => { this.readyState = 1; this.onopen?.() }, 0) }
  push(value: unknown) { if (this.readyState === 1 && this.stream) this.onmessage?.({ data: JSON.stringify({ type: 'item', streamId: this.stream, value }) }) }
  send(raw: string) {
    const m = JSON.parse(raw)
    if (m.type !== 'open') return
    if (m.endpoint === 'workspace/follow') {
      this.stream = m.streamId; follows.push(this)
      setTimeout(() => this.push({ type: 'baseline', value: {
        items: [{ workspaceId: 'w1', path: '/synthetic/acme-api', title: 'acme-api', sessionIds: ['s1', 's2', 's3'] }],
        archivedSessionIds: [], pinnedSessionIds: [],
      } }), 0)
    } else if (m.endpoint === 'session/follow') {
      const id = m.payload.args.request.address.sessionId
      setTimeout(() => { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify({ type: 'item', streamId: m.streamId, value: { type: 'snapshot', header: { id }, cursor: 1, hasMore: false,
        projections: { values: {} }, assistantStream: { revision: 0 }, records: [
          { type: 'event', event: { type: 'user/message', seq: 1, time: 1, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Move billing to the v2 API' }], source: { kind: 'user' } }, surfaceOp: 'append' } },
        ] } }) }) }, 0)
    }
  }
  close() { this.readyState = 3; follows.splice(follows.indexOf(this), 1); this.onclose?.() }
}
;(globalThis as any).WebSocket = FakeSocket
