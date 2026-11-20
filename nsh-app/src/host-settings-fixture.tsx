// Runnable native UI fixture: nsh test src/host-settings-fixture.tsx. No sockets or account APIs.
import { mount, Scroll, signal, Text, View } from 'nsh'
import { HostSettings } from './host-settings.tsx'
import { DshError } from './dsh.ts'
import { language, type Language } from './strings.ts'
import type { AccountClient } from './host-settings-account.ts'

function App() {
  const calls = signal<string[]>([]), mode = signal('mac'), active = signal(true), online = signal(true)
  let revision = 4, selected = 'basic', revoked = false, retried = false, loggedOut = false
  const streams = new Map<string, (v: unknown) => void>()
  const state = () => ({ status: loggedOut || mode() === 'signed-out' ? 'signed-out' : 'credential-stored', links: { usageUrl: 'https://synthetic.invalid/usage', topUpUrl: 'https://synthetic.invalid/topup' }, attempt: null })
  const notice = { id: 'n1', createdAt: '2026-01-01', displayUntil: null, title: 'Synthetic account notice', body: 'No real account or paid API.', actions: [{ label: 'Account', style: 'primary', target: { type: 'app_route', name: 'account' } }, { label: 'Dismiss', style: 'secondary', target: { type: 'dismiss' } }] }
  const client = { stream(method: string, args: unknown, item: (v: unknown) => void) {
    calls.set([...calls(), JSON.stringify({ method, args })]); streams.set(method, item)
    if (method === 'account/watch') item({ type: 'snapshot', state: state() })
    return () => { if (streams.get(method) === item) streams.delete(method) }
  }, async rpc(method: string, args: Record<string, any>) {
    calls.set([...calls(), JSON.stringify({ method, args })])
    if (mode() === 'offline') throw new DshError('network', 'Synthetic offline')
    if (mode() === 'unsupported') throw new DshError('gateway/method-unavailable', 'Synthetic unavailable')
    if (method === 'agentPresets/list') return { presets: [{ id: 'basic', name: 'Basic', isDefault: selected === 'basic' }, { id: 'ptc', name: 'PTC', isDefault: selected === 'ptc' }, { id: 'broken', broken: 'Synthetic activation failure', isDefault: false }] }
    if (method === 'settings/describe') return { writable: true, namespaces: [{ ns: 'agent-preset-registry', revision }] }
    if (method === 'agentPresets/read') {
      if (args.agentPreset !== 'ptc' && args.agentPreset !== 'basic' && args.agentPreset !== 'broken') throw new Error('Must use exact agentPreset wire argument')
      return { agentPreset: args.agentPreset, content: '- name: cordis:synthetic\n' }
    }
    if (method === 'settings/mutate') {
      if (mode() === 'conflict' || args.expectedRevision !== revision) throw new DshError('settings/conflict', 'Synthetic stale revision')
      selected = args.ops[0].value; revision++
      if (mode() === 'lost') throw new DshError('network', 'Synthetic lost response after write')
      return {}
    }
    if (method === 'cuaAccess/systemStatus') return mode() === 'legacy-cua' ? { accessibility: true, screenRecording: true, helper: { pid: 123 }, parent: { pid: 122 } } : mode() === 'windows' ? { platform: 'win32', sessionLocked: null, captureAvailable: false, elevated: true, helper: { pid: 123 } } : { platform: 'darwin', accessibility: false, screenRecording: true, helper: { pid: 123, name: 'Synthetic helper' }, parent: { pid: 122 } }
    if (method === 'cuaAccess/ptcConfiguration') return { persistent: false, writable: false }
    if (method === 'cuaAccess/applications') return { allowedApps: revoked ? [] : [{ id: 'allowed1', name: 'Synthetic editor' }], blockedApps: retried ? [] : [{ id: 'blocked1', name: 'Synthetic browser' }], persistentAvailable: true }
    if (method === 'cuaAccess/revoke') { revoked = true; return }
    if (method === 'cuaAccess/retryApproval') { retried = true; return }
    if (method === 'cuaAccess/requestPermission' || method === 'cuaAccess/openSettings') return {}
    if (method === 'account/getState') return state()
    if (method === 'account/hasRunningAccountTasks') return true
    if (method.startsWith('account/')) {
      if (args.client?.version !== 'fixture-1' || typeof args.client?.timezoneOffsetSeconds !== 'number' || 'platform' in args.client) throw new Error('Wrong account client identity')
      if (method === 'account/signOut') { loggedOut = true; streams.get('account/watch')?.({ type: 'credentials-changed', state: state() }); if (mode() === 'lost-signout') throw new DshError('network', 'Synthetic lost signout response'); return state() }
      if (state().status === 'signed-out') return method === 'account/reportNotificationEvent' ? false : null
      if (method === 'account/getProfile') return { status: 'ready', value: { id: 'synthetic', name: 'Synthetic user', contact: 'masked contact' } }
      if (method === 'account/getBalance') return { status: 'ready', value: [{ currency: 'USD', balance: '1.00000001' }], bonusWallets: [{ currency: 'CNY', balance: '2.50' }] }
      if (method === 'account/getNotifications') return { nextPollAfterSeconds: 600, notifications: [notice] }
      if (method === 'account/getNotificationContent') return notice
      if (method === 'account/reportNotificationEvent') return true
    }
    if (method === 'pluginInventory/list') return { entries: [{ entryId: 'synthetic-plugin', moduleName: 'synthetic:plugin', enabled: false, fiberPhase: null, diagnostic: 'Synthetic diagnostic' }], agentPresets: [{ id: 'ptc', isDefault: false, rows: [{ entryId: 'conditional', moduleName: 'synthetic:conditional', enabled: 'conditional', condition: '!!js synthetic', fiberPhase: null }] }] }
    throw new Error(`Unapproved fixture method: ${method}`)
  } } as AccountClient
  return <Scroll class="flex-1 bg-background"><View class="p-4 gap-3">
    <Text class="text-foreground">Synthetic host settings fixture · no live computer</Text>
    <View class="flex-row flex-wrap gap-2">{['mac', 'windows', 'legacy-cua', 'offline', 'unsupported', 'conflict', 'lost', 'lost-signout', 'signed-out'].map(m => <View testID={`fixture-${m}`} role="button" class="min-h-[44px] justify-center px-2 bg-secondary" onPress={() => { mode.set(m); if (m === 'signed-out') streams.get('account/watch')?.({ type: 'credentials-changed', state: state() }) }}><Text class="text-foreground">{m}</Text></View>)}</View>
    <View class="flex-row gap-2">{['background', 'resume', 'disconnect', 'reconnect'].map(m => <View testID={`fixture-${m}`} role="button" class="min-h-[44px] justify-center px-2" onPress={() => { if (m === 'background' || m === 'resume') active.set(m === 'resume'); else online.set(m === 'reconnect') }}><Text class="text-foreground">{m}</Text></View>)}</View>
    <View class="flex-row flex-wrap gap-2">{(['en', 'zh', 'zh-Hant', 'es', 'fr', 'ko', 'ja', 'ru'] as Language[]).map(l => <View testID={`fixture-locale-${l}`} role="button" class="min-h-[44px] justify-center px-2" onPress={() => language.set(l)}><Text class="text-foreground">{l}</Text></View>)}</View>
    <HostSettings client={() => client} clientVersion="fixture-1" active={active} online={online} />
    <Text testID="fixture-calls" class="text-muted-foreground text-[10px]">{calls().join('\n')}</Text>
  </View></Scroll>
}
mount(App)
