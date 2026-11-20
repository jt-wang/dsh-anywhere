// Synthetic child conversation; no linked computer, user data, model or external socket.
import { host, mount, signal, Text, View } from 'nsh'
import { ChatScreen } from '../../chat.tsx'
import { settings } from '../../state.ts'

const last = signal('none'), writes = signal(0)
let version = '0.2.2-rc.2'
host.on('fixture.version', (value: any) => { version = value.version })
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (url.endsWith('/v1/capabilities')) return new Response(JSON.stringify({ upstreamVersion: version }))
  const frame = JSON.parse(init?.body as string)
  if (frame.method.startsWith('subagents/')) { last.set(frame.method); writes.set(writes() + 1) }
  const value = frame.method === 'subagents/prompt' ? { messageId: 'accepted' } : { accepted: true }
  return new Response(JSON.stringify({ result: { ok: true, value } }))
}) as typeof fetch
class FakeSocket {
  readyState = 0
  onopen?: () => void
  onmessage?: (event: { data: string }) => void
  onclose?: () => void
  onerror?: () => void
  constructor(_url: string) { setTimeout(() => { this.readyState = 1; this.onopen?.() }, 0) }
  send(raw: string) {
    const frame = JSON.parse(raw)
    if (frame.type === 'open' && frame.endpoint === 'session/follow') setTimeout(() => this.onmessage?.({ data: JSON.stringify({
      type: 'item', streamId: frame.streamId, value: { type: 'snapshot', header: { id: 'child' }, cursor: 1, hasMore: false,
        projections: { values: { title: 'Child history' } }, assistantStream: { revision: 0 },
        records: [{ type: 'event', event: { type: 'turn/start', seq: 1, time: 1700000000000, data: { turn: 1 }, surfaceOp: 'append' } }],
      },
    }) }), 0)
  }
  close() { this.readyState = 3; this.onclose?.() }
}
;(globalThis as any).WebSocket = FakeSocket
function App() {
  settings.set({ origin: 'http://127.0.0.1:40001/dsh', key: 'synthetic' })
  return <View class="flex-1">
    <Text testID="fixture-last">{last()}</Text><Text testID="fixture-writes">{writes()}</Text>
    <ChatScreen sessionId="child" onTitle={() => {}} child={{ parentSessionId: 'parent', subagent: { id: 'child', mode: 'continuable', createdAt: 1 } }} />
  </View>
}
mount(App)
