// Synthetic follow frames exercise the real chat/List; no installed DSH or user content.
import { host, mount, Text, View } from 'nsh'
import { ChatScreen } from '../../chat.tsx'
import { settings } from '../../state.ts'

const origin = 'http://127.0.0.1:40001/dsh'
// Native renders use the same synthetic transport, without a computer or background HTTP errors.
globalThis.fetch = (async () => new Response(JSON.stringify({ result: { ok: true, value: { groups: [], values: {} } } }), { headers: { 'content-type': 'application/json' } })) as typeof fetch
const sockets: FakeSocket[] = []
let grown = false
function snapshot() {
  let seq = 0
  const event = (type: string, data: unknown) => ({ type: 'event', event: { type, seq: ++seq, time: 1700000000000 + seq, data, surfaceOp: 'append' } })
  const user = (id: string, text: string) => event('user/message', { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const assistant = (id: string, type: 'text' | 'reasoning', text: string) => event('assistant/message', { turn: 1, step: 1, message: { id, role: 'assistant', content: [{ type, text }] } })
  return { type: 'snapshot', header: { id: 's1' }, cursor: 100, hasMore: false, projections: { values: { title: 'Thinking controls' } }, assistantStream: { revision: 0 }, records: [
    user('older', 'Earlier question'), assistant('older-answer', 'text', Array.from({ length: 25 }, (_, i) => `Earlier answer ${i}.`).join('\n\n')),
    user('question', 'Current question'), event('turn/start', { turn: 1 }),
    assistant('a1', 'reasoning', Array.from({ length: grown ? 65 : 55 }, (_, i) => `First thought paragraph ${i}.`).join('\n\n')),
    assistant('a2', 'reasoning', 'Second independent thought.'),
    assistant('answer', 'text', Array.from({ length: 25 }, (_, i) => `Answer paragraph ${i}.`).join('\n\n')),
  ] }
}
class FakeSocket {
  readyState = 0
  onopen?: () => void
  onmessage?: (e: { data: string }) => void
  onclose?: () => void
  onerror?: () => void
  follow?: string
  constructor(_url: string) { sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.() }, 0) }
  send(raw: string) { const m = JSON.parse(raw); if (m.type === 'open' && m.endpoint === 'session/follow') { this.follow = m.streamId; setTimeout(() => this.push(), 0) } }
  push() { if (this.follow) this.onmessage?.({ data: JSON.stringify({ type: 'item', streamId: this.follow, value: snapshot() }) }) }
  close() { this.readyState = 3; this.onclose?.() }
}
;(globalThis as any).WebSocket = FakeSocket
const grow = () => { grown = true; for (const socket of sockets) socket.push() }
host.on('fixture.grow', grow)
function App() {
  settings.set({ origin, key: 'synthetic' })
  return <View class="flex-1 bg-background pt-[env(safe-area-inset-top)]">
    <View class="px-4 py-2 flex-row items-center justify-between"><Text class="text-foreground text-[17px]">Thinking controls</Text><View role="button" testID="grow" onPress={grow} class="p-2"><Text class="text-primary">Append reasoning</Text></View></View>
    <ChatScreen sessionId="s1" at="question" onTitle={() => {}} />
  </View>
}
mount(App)
