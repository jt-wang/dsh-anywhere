// Synthetic root-only picker. By default all RPCs stay in this process; public interaction tests
// set host.params.network=true to exercise the real Dsh HTTP client against their network handlers.
import { host, mount, signal, Text, View } from 'nsh'
import { ModelPicker } from '../../picker.tsx'
import type { Selection } from '../../models.ts'
import { settings } from '../../state.ts'

const origin = 'http://127.0.0.1:40001/dsh'
let setMode = (_mode: string) => {}
const sample = {
  default: { provider: 'sample', model: 'reasoner' },
  groups: [{ id: 'sample', name: 'Sample provider', models: [
    { id: 'reasoner', name: 'Sample Reasoner', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } },
    { id: 'plain', name: 'Sample Plain' },
  ] }],
}
// The native fixture never opens a network socket, including the global $events subscription.
class SilentSocket { readyState = 0; send(_data: string) {} close() {} }
;(globalThis as any).WebSocket = SilentSocket

if (!(host.params as { network?: boolean } | undefined)?.network) {
  const state = { enabled: false, mode: 'supported', write: 'ok' }
  setMode = (mode) => { state.mode = mode }
  host.on('fixture.team', (v) => Object.assign(state, v))
  // Same wire envelope as DSH, including a void (absent value) write acknowledgement.
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const call = JSON.parse(String(init.body)), args = call.payload.args
    let value: unknown, error: unknown
    if (call.method === 'session/modelCatalog') value = sample
    else if (call.method === 'session/selectModel') value = undefined
    else if (call.method === 'session/projections') {
      if (state.mode === 'read-error') error = { code: 'timeout', message: 'Synthetic read failure' }
      else value = { kind: 'sequenced', asOfSeq: 4, values: state.mode === 'missing' ? {} : { agentTeam: state.mode === 'legacy' ? { members: [], tasks: [] } : {
        enabled: state.enabled, tasks: [], ...(state.mode === 'failure' ? { failure: 'Synthetic invalid task record' } : {}),
      } } }
    } else if (call.method === 'agentTeams/setEnabled') {
      if (state.write !== 'error-before') state.enabled = args.enabled
      if (state.write !== 'ok') error = { code: 'timeout', message: 'Synthetic unconfirmed save' }
    } else error = { code: 'unknown', message: 'Unexpected fixture RPC' }
    return { ok: true, status: 200, json: async () => ({ type: 'server-response', rpcId: call.rpcId, result: error ? { ok: false, error } : { ok: true, value } }) } as Response
  }) as typeof fetch
}

function App() {
  settings.set({ origin, key: 'synthetic-device-token' })
  const selected = signal<Selection | undefined>(undefined), error = signal('')
  return <View class="flex-1 bg-background pt-[env(safe-area-inset-top)] px-4">
    <Text class="text-foreground text-[17px] py-4">Teamwork · sample root chat</Text>
    <Text class="text-muted-foreground text-[13px] pb-4">Synthetic data only. Open Model to change the saved Teamwork setting.</Text>
    <ModelPicker sessionId="sample-root" selection={selected} onSelected={(s) => selected.set(s)} onError={(s) => error.set(s)} />
    {['supported', 'legacy', 'read-error'].map((mode) => <View role="button" testID={`fixture-${mode}`} onPress={() => setMode(mode)} class="py-3"><Text class="text-foreground">{mode}</Text></View>)}
    <Text testID="selection" class="text-foreground">{JSON.stringify(selected())}</Text>
    <Text testID="error" class="text-destructive">{error()}</Text>
  </View>
}
mount(App)
