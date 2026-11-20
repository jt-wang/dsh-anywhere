// Fully native ChatScreen fixture. All transport stays in memory; no installed runtime, profile or model.
import { host, mount, signal, Text, View } from 'nsh'
import { ChatScreen } from '../chat.tsx'
import { network, settings } from '../state.ts'
import { language } from '../strings.ts'
import { createActivity } from '../activity.tsx'

let version = '0.2.2-rc.5', capability: unknown = 5, running = false, pending = false
let mode = 'success', continued = false, lastId = ''
let teamEnabled = false, activitySeq = 20
const writes = signal(0), requestIds = signal(''), scenario = signal('eligible')
const sockets: FakeSocket[] = []
const event = (seq: number, type: string, data: unknown) => ({ type: 'event', event: { type, seq, time: 1700000000000 + seq, data, surfaceOp: 'append' } })
const records = () => [
  event(1, 'turn/start', { turn: 1 }), event(2, 'step/start', { turn: 1, step: 1 }),
  event(3, 'user/message', { id: 'question', source: { kind: 'user' }, content: [{ type: 'text', text: 'Summarize the synthetic report.' }] }),
  event(4, 'assistant/attempt', { turn: 1, step: 1, message: { id: 'attempt', role: 'assistant', content: [] } }),
  event(5, 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'TIMEOUT', message: 'Synthetic provider timeout. No external model was called.' } } }),
  ...(continued ? [event(6, 'turn/start', { turn: 2 }), event(7, 'step/start', { turn: 2, step: 1 }), event(8, 'user/message', { id: 'retry', source: { kind: 'retry', rpcId: lastId }, content: [] }), event(9, 'assistant/message', { turn: 2, step: 1, message: { id: 'answer', role: 'assistant', content: [{ type: 'text', text: 'The synthetic report is ready. Generation continued without a new user message.' }] } }), event(10, 'turn/end', { turn: 2, reason: { kind: 'completed' } })] : []),
]
function snapshot() { return { type: 'snapshot', header: { id: 'continuation-sample' }, cursor: continued ? 10 : 5, records: records(), hasMore: false, projections: { values: { title: 'Manual continuation' } }, assistantStream: { revision: 0 } } }
function push() { for (const socket of sockets) socket.push() }
function setScenario(name: string) {
  version = name === 'legacy' ? '0.2.2-rc.1' : name === 'unknown' ? 'custom' : '0.2.2-rc.5'
  capability = name === 'malformed' ? { ending: 5 } : name === 'denied' ? null : 5
  running = name === 'busy'; pending = name === 'pending'; mode = name
  continued = false; scenario.set(name); network.set(name !== 'offline'); push()
}
host.on('fixture.scenario', (v: any) => setScenario(v.name))
host.on('fixture.language', (v: any) => language.set(v.language))
host.on('fixture.activity', (v: any) => {
  teamEnabled = v.enabled
  if (v.type === 'snapshot') push()
  else for (const socket of sockets) socket.emit(event(activitySeq++, v.type, {}))
})
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (url.endsWith('/v1/capabilities')) return new Response(JSON.stringify({ upstreamVersion: version }))
  const frame = JSON.parse(String(init?.body)), request = frame.payload.args.request
  let value: unknown = { groups: [], values: {} }, error: unknown
  if (frame.method === 'session/projections') value = { kind: 'sequenced', asOfSeq: continued ? 10 : 5, values: { agentTeam: { enabled: teamEnabled, tasks: [] }, conversationContinuation: continued ? null : capability, inbox: { 'next-turn': pending ? [{ id: 'waiting', source: { kind: 'user' } }] : [], 'next-step': [] } } }
  if (frame.method === 'session/state') value = { cursor: continued ? 10 : 5, running, active: true, queue: [], pendingInput: [] }
  if (frame.method === 'session/prompt') {
    writes.update((n) => n + 1); requestIds.set(requestIds() + (requestIds() ? ',' : '') + request.requestId); lastId = request.requestId
    if (mode === 'unconfirmed') error = { code: 'timeout', message: 'Synthetic unconfirmed delivery' }
    else {
      value = { accepted: true }
      if (mode !== 'ack-only') { continued = true; setTimeout(push, 80) }
      if (mode === 'lost-response') error = { code: 'timeout', message: 'Synthetic response lost after admission' }
    }
  }
  return new Response(JSON.stringify({ result: error ? { ok: false, error } : { ok: true, value } }))
}) as typeof fetch
class FakeSocket {
  readyState = 0
  onopen?: () => void; onmessage?: (e: { data: string }) => void; onclose?: () => void; onerror?: () => void
  follow?: string
  constructor(_url: string) { sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.() }, 0) }
  send(raw: string) { const f = JSON.parse(raw); if (f.type === 'open' && f.endpoint === 'session/follow') { this.follow = f.streamId; setTimeout(() => this.push(), 0) } }
  emit(value: unknown) { if (this.follow && this.readyState === 1) this.onmessage?.({ data: JSON.stringify({ type: 'item', streamId: this.follow, value }) }) }
  push() { this.emit(snapshot()) }
  close() { this.readyState = 3; this.onclose?.() }
}
;(globalThis as any).WebSocket = FakeSocket
function App() {
  settings.set({ origin: 'http://127.0.0.1:40001/dsh', key: 'synthetic' })
  const params = host.params as { child?: boolean; activity?: boolean } | undefined
  const child = params?.child, activity = params?.activity ? createActivity() : undefined
  const teamState = () => { const board = activity?.team(); return board?.kind === 'ready' ? String(board.enabled) : board?.kind ?? '' }
  return <View class="flex-1 bg-background pt-[env(safe-area-inset-top)]">
    <Text class="text-foreground text-[16px] px-4 py-2">Manual continuation · synthetic only</Text>
    <View class="flex-row flex-wrap px-3">{['eligible', 'legacy', 'unknown', 'denied', 'unconfirmed', 'lost-response', 'offline'].map((name) => <View role="button" testID={`fixture-${name}`} class="px-2 py-2" onPress={() => setScenario(name)}><Text class="text-muted-foreground text-[12px]">{name}</Text></View>)}</View>
    <Text testID="fixture-state" class="px-4 text-muted-foreground text-[12px]">{scenario()} · writes: {writes()}</Text>
    <Text testID="fixture-request-ids" class="px-4 text-muted-foreground text-[10px]">{requestIds()}</Text>
    <If when={activity}><Text testID="fixture-team-state">{teamState()}</Text></If>
    <ChatScreen sessionId="continuation-sample" onTitle={() => {}} activity={activity} child={child ? { parentSessionId: 'parent', subagent: { id: 'continuation-sample', mode: 'continuable', createdAt: 1 } } : undefined} />
  </View>
}
mount(App)
