// Native iOS/Android fixture. Only read calls are allowed; local view edits never reach DSH.
import { mount, Scroll, signal, Storage, Text, View } from 'nsh'
import { OfflineCache } from './cache.ts'
import { loadPrefs } from './prefs.ts'
import { WorkspaceViewPreferences } from './workspace-settings.tsx'
import { SessionsScreen } from './sessions.tsx'
import { network, offlineCache, settings } from './state.ts'

const opened = signal(''), calls = signal('')
const items = [
  { workspaceId: 'child', path: '/synthetic/root/child', title: 'Child workspace', sessionIds: ['nested'] },
  { workspaceId: 'root', path: '/synthetic/root', title: 'Root workspace', sessionIds: ['old', 'new', 'archive', 'pin'] },
  { workspaceId: 'empty', path: '/synthetic/empty', title: 'Empty workspace', sessionIds: [] },
]
const chats = [['old', 1], ['new', 9], ['archive', 12], ['pin', 2], ['nested', 7], ['loose', 4]] as const
globalThis.fetch = (async (_url, init) => {
  const frame = JSON.parse(String(init?.body)); calls.set(`${calls()} ${frame.method}`.trim())
  if (frame.method !== 'session/list' && frame.method !== 'session/search') throw new Error('Fixture forbids remote writes')
  return new Response(JSON.stringify({ result: { ok: true, value: { items: frame.method === 'session/search' ? [] : chats.map(([sessionId, updatedAt]) => ({ sessionId, updatedAt, projections: { values: { title: `Chat ${sessionId}` } } })) } } }))
}) as typeof fetch
class Socket {
  readyState = 0
  onopen?: () => void
  onclose?: () => void
  onmessage?: (event: { data: string }) => void
  constructor() { setTimeout(() => { this.readyState = 1; this.onopen?.() }, 0) }
  send(raw: string) {
    const frame = JSON.parse(raw)
    if (frame.type === 'open' && frame.endpoint === 'workspace/follow') setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'item', streamId: frame.streamId, value: { type: 'baseline', value: { items, archivedSessionIds: ['archive'], pinnedSessionIds: ['pin'] } } }) }), 0)
  }
  close() { this.readyState = 3; this.onclose?.() }
}
;(globalThis as any).WebSocket = Socket
function App() {
  settings.set({ origin: 'https://synthetic.invalid/dsh', key: 'synthetic' })
  return <View class="flex-1 bg-background pt-[36px]">
    <Scroll class="h-[320px]" contentClass="px-4"><WorkspaceViewPreferences /></Scroll>
    <Text testID="fixture-opened" class="text-foreground">{opened()}</Text>
    <Text testID="fixture-calls" class="text-muted-foreground">{calls()}</Text>
    <SessionsScreen onOpen={c => opened.set(c.sessionId)} newChat={() => false} onNewChatClosed={() => {}} />
  </View>
}
async function start() {
  await loadPrefs()
  if (await Storage.getItem('workspace-view-fixture-offline') === 'true') {
    network.set(false)
    const cache = await OfflineCache.open('workspace-view-fixture')
    cache.list([{ sessionId: 'old', title: 'Chat old', updatedAt: 1, running: false }])
    cache.workspaces({ items, archivedSessionIds: ['archive'], pinnedSessionIds: ['pin'] })
    offlineCache.set(cache)
  }
  mount(App)
}
void start()
