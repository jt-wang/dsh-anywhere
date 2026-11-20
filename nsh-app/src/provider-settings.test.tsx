import { expect, open, test } from 'nsh/test'
import { Dsh, DshError } from './dsh.ts'
import { atPath, deleteProvider, discoverProviderModels, ProviderCreation, providerChoices, readProviders, removeProviderKey, saveProviderField, validateModels, writeProviderKey } from './provider-settings.ts'
import { providerFixtureDirectory, providerFixtureNamespace } from './provider-settings-fixture.ts'
import { providerSettingsStrings } from './provider-settings-strings.ts'

function harness() {
  const ns = providerFixtureNamespace(), calls: { method: string; args: any }[] = []
  let conflict = false, keyFailure = false, lost = false, configured = true
  const result = (value: unknown) => new Response(JSON.stringify({ result: { ok: true, value } }))
  const client = new Dsh('https://synthetic.invalid/dsh', 'synthetic', { fetch: async (_url, init) => {
    const frame = JSON.parse(String(init?.body)), args = frame.payload.args; calls.push({ method: frame.method, args })
    if (frame.method === 'settings/describe') return result({ writable: true, hasDocument: true, namespaces: [ns] })
    if (frame.method === 'llm/listProviders') return result([{ id: 'local', name: 'Synthetic local' }, { id: 'read-only', name: 'No settings owner' }])
    if (frame.method === 'llm/listConfigurableProviders') return result(providerFixtureDirectory)
    if (frame.method === 'llm/discoverModels') return result([{ id: 'discovered', inputModalities: ['text', 'image'] }])
    if (frame.method === 'credentials/describe') return result(Object.fromEntries(args.refs.map((ref: string) => [ref, { configured, writable: true, source: 'local', masked: 'syn…tic' }])))
    if (frame.method === 'credentials/set') { if (keyFailure) throw new Error('synthetic key failure'); configured = true; return result(null) }
    if (frame.method === 'credentials/unset') { configured = false; return result(null) }
    if (frame.method === 'settings/mutate') {
      if (conflict) return new Response(JSON.stringify({ result: { ok: false, error: { code: 'settings/conflict', message: 'changed' } } }))
      for (const target of [ns.value, ns.user]) for (const op of args.ops) {
        let at = target as any
        for (const part of op.path.slice(0, -1)) { at[part] ??= {}; at = at[part] }
        if (op.op === 'unset') delete at[op.path.at(-1)]
        else at[op.path.at(-1)] = JSON.parse(JSON.stringify(op.value))
      }
      ns.revision++
      if (lost) throw new Error('synthetic lost acknowledgement')
      return result(null)
    }
    throw new Error(`Unexpected method ${frame.method}`)
  } })
  return { ns, client, calls, conflict: () => { conflict = true }, keyFailure: (value: boolean) => { keyFailure = value }, lost: () => { lost = true } }
}
test('provider directory joins dormant, registered and dynamic owner paths with credential status', async () => {
  const h = harness(), view = await readProviders(h.client)
  expect(view.rows.map(r => [r.provider, r.active, r.removable])).toEqual([['local', true, true], ['dormant', false, false], ['read-only', true, false]])
  expect(view.rows[0].ref).toBe('LOCAL_API_KEY'); expect(view.rows[0].credential?.masked).toBe('syn…tic')
  expect(providerChoices(h.ns, ['providers', 'anything', 'api'])).toEqual(['openai-completions', 'google-generative-ai'])
})
test('provider field edit fences exact path and preserves unknown compat; lost ACK reads once without replay', async () => {
  const h = harness(), row = (await readProviders(h.client)).rows[0]; h.lost()
  await saveProviderField(h.client, row, 'baseURL', 'https://synthetic.invalid/changed')
  const writes = h.calls.filter(c => c.method === 'settings/mutate')
  expect(writes).toEqual([{ method: 'settings/mutate', args: { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'local', 'baseURL'], value: 'https://synthetic.invalid/changed' }], expectedRevision: 7 } }])
  expect(atPath(h.ns.value, ['providers', 'local', 'compat'])).toEqual({ supportsStore: false })
})
test('provider conflicts are explicit and never retried; invalid retry cross-fields never reach mutation', async () => {
  const h = harness(), row = (await readProviders(h.client)).rows[0]; h.conflict()
  let code = ''
  try { await saveProviderField(h.client, row, 'baseURL', 'x') } catch (e) { code = (e as DshError).code }
  expect(code).toBe('settings/conflict'); expect(h.calls.filter(c => c.method === 'settings/mutate').length).toBe(1)
  try { await saveProviderField(h.client, row, 'retryPolicy', { mode: 'normal', backoff: { initialDelayMs: 20000, maxDelayMs: 1000 } }) } catch {}
  expect(h.calls.filter(c => c.method === 'settings/mutate').length).toBe(1)
})
test('custom provider creation commits config before key, key failure retries key alone and native auth remains keyless', async () => {
  const h = harness(), create = new ProviderCreation(), draft = { route: 'custom-route', displayName: 'Local', api: 'openai-completions', baseURL: 'https://synthetic.invalid/v1', models: [{ id: 'only' }] }
  h.keyFailure(true)
  try { await create.create(h.client, h.ns, ['local'], draft, 'synthetic-key') } catch {}
  expect(create.committed).toBe(true)
  expect(h.calls.filter(c => c.method === 'settings/mutate' || c.method === 'credentials/set').map(c => c.method)).toEqual(['settings/mutate', 'credentials/set'])
  h.keyFailure(false); await create.create(h.client, h.ns, ['local'], draft, 'replacement-synthetic')
  expect(h.calls.filter(c => c.method === 'settings/mutate').length).toBe(1)
  await new ProviderCreation().create(h.client, h.ns, [], { ...draft, route: 'native-route' }, '')
  expect(atPath(h.ns.value, ['providers', 'native-route', 'apiKeyEnv'])).toBe(undefined)
})
test('provider discovery is draft only; credential deletion precedes profile removal and shared aliases survive', async () => {
  const h = harness(), row = (await readProviders(h.client)).rows[0], before = h.calls.length
  expect(await discoverProviderModels(h.client, 'llm-pi-ai', { baseURL: 'https://synthetic.invalid', apiKey: 'temporary' })).toEqual([{ id: 'discovered', inputModalities: ['text', 'image'] }])
  expect(h.calls.slice(before).map(c => c.method)).toEqual(['llm/discoverModels'])
  await deleteProvider(h.client, row)
  expect(h.calls.filter(c => c.method === 'credentials/unset' || c.method === 'settings/mutate').map(c => c.method)).toEqual(['credentials/unset', 'settings/mutate'])
  const alias = harness(), aliasRow = (await readProviders(alias.client)).rows[0]; aliasRow.ref = 'SHARED_ALIAS'
  await deleteProvider(alias.client, aliasRow); expect(alias.calls.some(c => c.method === 'credentials/unset')).toBe(false)
})
test('provider credential write targets existing reference and describes after; read-only cannot write', async () => {
  const h = harness(), row = (await readProviders(h.client)).rows[0]
  await writeProviderKey(h.client, row, ' synthetic-only ')
  expect(h.calls.slice(-2)).toEqual([{ method: 'credentials/set', args: { ref: 'LOCAL_API_KEY', value: 'synthetic-only' } }, { method: 'credentials/describe', args: { refs: ['LOCAL_API_KEY'] } }])
  row.credential!.writable = false
  const before = h.calls.length; try { await writeProviderKey(h.client, row, 'never') } catch {}
  expect(h.calls.length).toBe(before)
  row.credential!.writable = true; await removeProviderKey(h.client, row)
  expect(h.calls.at(-1)?.method).toBe('credentials/describe')
})
test('provider translations cover eight languages and unsupported locales use English; model validation catches duplicates and bad token limits', () => {
  for (const locale of ['zh', 'zh-Hant', 'en', 'es', 'fr', 'ko', 'ja', 'ru']) expect(Object.values(providerSettingsStrings(locale)).every(v => typeof v === 'string' && v.length > 0)).toBe(true)
  expect(providerSettingsStrings('de')).toEqual(providerSettingsStrings('en'))
  for (const models of [[{ id: 'x' }, { id: 'x' }], [{ id: 'x', contextWindow: 100, maxTokens: 200 }], [{ id: 'x', maxTokens: -1 }]]) {
    let rejected = false; try { validateModels(models) } catch { rejected = true }; expect(rejected).toBe(true)
  }
})

test('native provider component discovers into draft, edits capacities, retains unknown fields, saves model catalog and confirms deletion', async () => {
  const h = harness()
  const app = await open('./provider-settings.fixture.tsx', { locale: 'en-US', host: { handlers: { 'link.state': null, 'app.state': { active: true }, 'network.state': { online: false } } }, network: {
    'POST https://synthetic.invalid/dsh/api/*': async (request: any) => {
      // Use the same public HTTP envelope handler as the protocol contract tests, not a component-only mock.
      const frame = JSON.parse(request.body)
      try { return { body: { result: { ok: true, value: await h.client.rpc(frame.method, frame.payload.args) } } } }
      catch (e) { return { body: { result: { ok: false, error: { code: (e as DshError).code, message: 'synthetic failure' } } } } }
    },
  } })
  await app.press('id:provider-settings-open'); await app.waitFor('id:provider-local'); await app.press('id:provider-local')
  await app.clear('id:provider-local-models-1-maxTokens'); await app.type('id:provider-local-models-1-maxTokens', '2048')
  await app.press('id:provider-local-discover'); await app.waitFor('id:provider-local-adopt-discovered')
  expect(h.calls.some(c => c.method === 'settings/mutate')).toBe(false)
  await app.press('id:provider-local-adopt-discovered'); await app.waitFor('id:provider-local-models-2-id')
  await app.press('id:provider-local-models-save'); await app.waitFor('id:provider-local'); await app.press('id:provider-local')
  expect(atPath(h.ns.value, ['providers', 'local', 'models', '0', 'maxTokens'])).toBe(2048)
  expect(atPath(h.ns.value, ['providers', 'local', 'models', '0', 'compat'])).toEqual({ supportsStore: false })
  expect(atPath(h.ns.value, ['providers', 'local', 'models', '1', 'input'])).toEqual(['text', 'image'])
  await app.press('id:provider-local-delete')
  expect(h.calls.some(c => c.method === 'credentials/unset')).toBe(false)
  await app.press('id:provider-local-delete-confirm'); await app.waitFor('id:provider-dormant')
  expect(h.calls.filter(c => c.method === 'credentials/unset').length).toBe(1)
})
