import { expect, open, test } from 'nsh/test'
import { Dsh, DshError } from './dsh.ts'
import { readDesktopSettings, saveDesktopSetting, settingFields, settingValue, type DesktopConfiguration, type SettingsNamespace } from './desktop-settings.ts'
import { desktopSettingsStrings } from './desktop-settings-strings.ts'

// The real Schemastery envelope shape, not JSON Schema. Asymmetric values detect clobbering siblings/secrets.
export const namespace = (): SettingsNamespace => ({
  ns: 'shell', revision: 3, applies: 'live', autoGenerate: true,
  schema: { uid: 8, refs: { 1: { type: 'number', meta: { default: 1000 } }, 2: { type: 'string', meta: { role: 'secret' } }, 3: { type: 'const', value: 'auto' }, 4: { type: 'const', value: 'always' }, 5: { type: 'union', list: [3, 4] }, 6: { type: 'object', dict: { timeoutMs: 1, password: 2, mode: 5 } }, 7: { type: 'dict', inner: 6 }, 8: { type: 'object', dict: { timeoutMs: 1, nested: 7 } } } },
  value: { timeoutMs: 3200, nested: { a: { timeoutMs: 8100, mode: 'auto' } } }, base: { timeoutMs: 1000 }, user: { timeoutMs: 3200 }, secrets: [{ path: ['nested', 'a', 'password'], set: true }],
})
function harness() {
  const n = namespace(), writes: unknown[] = []
  let conflict = false, lostAck = false
  const configuration: DesktopConfiguration = { writable: true, hasDocument: true, namespaces: [n] }
  const client = new Dsh('https://synthetic.invalid', 'synthetic', { fetch: async (_url, init) => {
    const frame = JSON.parse(String(init?.body)), args = frame.payload.args
    if (frame.method === 'settings/mutate') {
      writes.push(args)
      if (conflict) return new Response(JSON.stringify({ result: { ok: false, error: { code: 'settings/conflict', message: 'changed' } } }))
      const op = args.ops[0]
      if (op.op === 'set') (n.value as any).timeoutMs = op.value
      else { n.user = { timeoutMs: 1000 }; (n.value as any).timeoutMs = 1000 }
      n.revision++
      if (lostAck) throw new Error('lost acknowledgement')
    }
    return new Response(JSON.stringify({ result: { ok: true, value: frame.method === 'settings/describe' ? configuration : null } }))
  } })
  return { n, client, writes, conflict: () => { conflict = true }, lost: () => { lostAck = true } }
}

test('desktop settings edit exact paths with revision and confirm remote state without replacing redacted siblings', async () => {
  const h = harness(), original = await readDesktopSettings(h.client)
  const result = await saveDesktopSetting(h.client, original.namespaces[0], { op: 'set', path: ['timeoutMs'], value: 4700 })
  expect(result.confirmed).toBe(true)
  expect((result.configuration.namespaces[0].value as any).timeoutMs).toBe(4700)
  expect((result.configuration.namespaces[0].value as any).nested.a.mode).toBe('auto')
  expect(h.writes).toEqual([{ ns: 'shell', expectedRevision: 3, ops: [{ op: 'set', path: ['timeoutMs'], value: 4700 }] }])
  expect(JSON.stringify(h.writes).includes('password')).toBe(false)
  const reset = await saveDesktopSetting(h.client, result.configuration.namespaces[0], { op: 'unset', path: ['timeoutMs'] })
  expect(reset.confirmed).toBe(true)
  expect((reset.configuration.namespaces[0].value as any).timeoutMs).toBe(1000)
  expect((reset.configuration.namespaces[0].user as any).timeoutMs).toBe(1000)
})

test('resetting a masked secret is not confirmed merely because both redacted values are absent', async () => {
  const h = harness(), edit = { op: 'unset' as const, path: ['nested', 'a', 'password'] }
  expect((await saveDesktopSetting(h.client, h.n, edit)).confirmed).toBe(false)
  h.n.secrets[0].set = false
  expect((await saveDesktopSetting(h.client, h.n, edit)).confirmed).toBe(true)
})

test('lost settings acknowledgement reads authority once and does not repeat writes; conflict stays an error', async () => {
  const h = harness(); h.lost()
  const result = await saveDesktopSetting(h.client, h.n, { op: 'set', path: ['timeoutMs'], value: 4700 })
  expect(result.confirmed).toBe(true); expect(h.writes.length).toBe(1)
  const conflict = harness(); conflict.conflict()
  let code = ''
  try { await saveDesktopSetting(conflict.client, conflict.n, { op: 'set', path: ['timeoutMs'], value: 9 }) } catch (e) { code = (e as DshError).code }
  expect(code).toBe('settings/conflict'); expect(conflict.writes.length).toBe(1)
})

test('settings schema produces nested editable paths, redacted secret rows, dictionaries and enum values', () => {
  const fields = settingFields(namespace())
  const secret = fields.find(f => f.path.join('.') === 'nested.a.password')!
  expect(secret.secret).toBe(true); expect(secret.configured).toBe(true); expect(secret.value).toBe(undefined)
  expect(fields.find(f => f.path.join('.') === 'nested')!.add).toBe('dict')
  expect(settingValue(fields.find(f => f.path.join('.') === 'nested.a.mode')!, 'always')).toBe('always')
  expect(settingValue(fields[0], '7100')).toBe(7100)
  for (const locale of ['zh', 'zh-Hant', 'es', 'fr', 'ko', 'ja', 'ru']) {
    const words = desktopSettingsStrings(locale)
    expect(words.title === desktopSettingsStrings('en').title).toBe(false)
    expect(Object.values(words).every(v => typeof v === 'string' && v.length > 0)).toBe(true)
  }
  expect(desktopSettingsStrings('de')).toEqual(desktopSettingsStrings('en'))
})
