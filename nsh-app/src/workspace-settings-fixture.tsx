// Runnable native synthetic surface: nsh run nsh-app/src/workspace-settings-fixture.tsx
// No network, native profile, filesystem or model. Same Dsh HTTP envelopes and mux frames as production.
import { mount, Scroll, signal, Text, View } from 'nsh'
import { Dsh, DshError, type SocketLike } from './dsh.ts'
import { WorkspaceSettings } from './workspace-settings.tsx'
import { language, type Language } from './strings.ts'

let items = [
  { workspaceId: 'alpha', title: 'Alpha', path: '/synthetic/alpha', sessionIds: ['chat-a', 'chat-b', 'chat-c'] },
  { workspaceId: 'beta', title: 'Beta', path: '/synthetic/beta', sessionIds: [] as string[] },
  { workspaceId: 'gamma', title: 'Gamma', path: '/synthetic/gamma', sessionIds: [] as string[] },
]
let mode = 'normal'
const sockets = new Set<SocketLike>()
const calls = signal('')
function socket(): SocketLike {
  const s: SocketLike = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
    send(raw) {
      const m = JSON.parse(raw)
      if (m.type !== 'open') return
      setTimeout(() => {
        if (s.readyState !== 1) return
        s.onmessage?.({ data: JSON.stringify(mode === 'offline' ? { type: 'error', streamId: m.streamId, error: { code: 'network' } } : { type: 'item', streamId: m.streamId, value: { type: 'baseline', value: { items, archivedSessionIds: [], pinnedSessionIds: [] } } }) })
      }, 0)
    },
    close() { s.readyState = 3; sockets.delete(s); s.onclose?.() },
  }
  sockets.add(s); setTimeout(() => { s.readyState = 1; s.onopen?.() }, 0)
  return s
}
const client = new Dsh('https://synthetic.invalid/dsh', 'synthetic', { socket, fetch: (async (_url, init) => {
  const f = JSON.parse(String(init?.body)), r = f.payload.args.request
  calls.set(f.method)
  if (mode === 'offline') throw new Error('Synthetic offline')
  if (mode === 'rejected') return new Response(JSON.stringify({ result: { ok: false, error: { code: 'workspace/name-conflict' } } }))
  const row = items.find(w => w.workspaceId === r.workspaceId)!
  if (f.method === 'workspace/rename') row.title = r.title
  else if (f.method === 'workspace/delete') items = items.filter(w => w !== row)
  else if (f.method === 'workspace/insertBefore') { items = items.filter(w => w !== row); items.splice(r.beforeWorkspaceId ? items.findIndex(w => w.workspaceId === r.beforeWorkspaceId) : items.length, 0, row) }
  else if (f.method === 'workspace/insertSessionBefore') { row.sessionIds = row.sessionIds.filter(id => id !== r.sessionId); row.sessionIds.splice(r.beforeSessionId ? row.sessionIds.indexOf(r.beforeSessionId) : row.sessionIds.length, 0, r.sessionId) }
  else throw new DshError('unknown', 'Unexpected fixture call')
  if (mode === 'lost-ack') throw new Error('Synthetic lost acknowledgement')
  if (mode === 'lost-readback') mode = 'offline'
  return new Response(JSON.stringify({ result: { ok: true, value: null } }))
}) as typeof fetch })

function App() {
  const selected = signal('normal')
  return <Scroll class="flex-1 bg-background" contentClass="px-4 pt-[54px] pb-[48px] gap-2">
    <Text class="text-foreground text-[14px]">Synthetic rc.5 workspace settings</Text>
    <View class="flex-row flex-wrap gap-2">{['normal', 'lost-ack', 'lost-readback', 'rejected', 'offline'].map(m => <View role="button" testID={`fixture-${m}`} class="min-h-[48px] justify-center bg-secondary px-2" onPress={() => { mode = m; selected.set(m) }}><Text class="text-foreground">{m}</Text></View>)}</View>
    <Text testID="fixture-mode" class="text-foreground">{selected()}</Text><Text testID="fixture-call" class="text-muted-foreground">{calls()}</Text>
    <View class="flex-row flex-wrap gap-2">{(['en', 'zh', 'zh-Hant', 'es', 'fr', 'ko', 'ja', 'ru'] as Language[]).map(l => <View role="button" testID={`fixture-${l}`} class="min-h-[48px] justify-center px-2" onPress={() => language.set(l)}><Text class="text-foreground">{l}</Text></View>)}</View>
    <WorkspaceSettings client={() => client} online={() => true} chats={() => [{ sessionId: 'chat-a', title: 'First chat', updatedAt: 1, running: false }, { sessionId: 'chat-b', title: 'Second chat', updatedAt: 2, running: false }]} />
  </Scroll>
}
mount(App)
