import { expect, open, test } from 'nsh/test'
import { Dsh, DshError } from './dsh.ts'
import { capabilityBase, capabilityNamespace, capabilityRefreshBoundary, capabilityText, capabilityValue, readCapabilities, saveCapability, translationOptions } from './capability-settings.ts'
import { capabilitySettingsStrings } from './capability-settings-strings.ts'
import { capabilityFixture } from './capability-settings-fixture.ts'

function harness() {
  const state = capabilityFixture(), calls: { method: string; args: any }[] = []
  let lose = false, conflict = false, absent = false, writable = true
  const ok = (value: unknown) => ({ result: { ok: true, value } }), fail = (code: string) => ({ result: { ok: false, error: { code, message: 'synthetic failure' } } })
  const dispatch = async (method: string, args: any) => {
    calls.push({ method, args })
    if (method === 'settings/describe') return ok({ ...state.configuration, writable })
    if (method === 'web/listProviders') return ok(state.web)
    if (method === 'cotTranslation/limits') return absent ? fail('gateway/not-found') : ok(state.translation)
    if (method === 'settings/mutate') {
      const ns = state.configuration.namespaces.find(n => n.ns === args.ns)!
      if (conflict || args.expectedRevision !== ns.revision) return fail('settings/conflict')
      for (const edit of args.ops) {
        const field = edit.path[0]
        if (edit.op === 'set') { (ns.value as any)[field] = edit.value; (ns.user as any)[field] = edit.value }
        else { delete (ns.user as any)[field]; if ((ns.base as any)[field] === undefined) delete (ns.value as any)[field]; else (ns.value as any)[field] = (ns.base as any)[field] }
        if (ns.ns === 'mounted-translation') state.translation.preferences = { ...(ns.value as any) }
      }
      ns.revision++
      if (lose) { lose = false; throw new Error('synthetic lost acknowledgement') }
      return ok(null)
    }
    throw new Error(`Unexpected capability operation ${method}`)
  }
  const client = new Dsh('https://synthetic.invalid/dsh', 'synthetic', { fetch: async (_url, init) => { const frame = JSON.parse(String(init?.body)); return new Response(JSON.stringify(await dispatch(frame.method, frame.payload.args))) } })
  return { state, calls, dispatch, client, lost: () => { lose = true }, conflict: () => { conflict = true }, absent: () => { absent = true }, readOnly: () => { writable = false } }
}
type Harness = ReturnType<typeof harness>
const appFor = (h: Harness, locale = 'en-US') => open('./capability-settings.fixture.tsx', { locale, host: { handlers: { 'link.state': null, 'app.state': { active: true }, 'network.state': { online: false } } }, network: {
  'POST https://synthetic.invalid/dsh/api/*': async (request: any) => { const frame = JSON.parse(request.body); return { body: await h.dispatch(frame.method, frame.payload.args) } },
} })

test('capability catalog reads are exact and independent, use mounted schema namespaces and preserve unavailable preferences', async () => {
  const h = harness(), snapshot = await readCapabilities(h.client)
  expect(h.calls.map(c => [c.method, c.args])).toEqual([['settings/describe', {}], ['web/listProviders', {}], ['cotTranslation/limits', {}]])
  const web = capabilityNamespace(snapshot.configuration, 'web')!, translation = capabilityNamespace(snapshot.configuration, 'translation')!
  expect(web.ns).toBe('mounted-web'); expect(capabilityValue(web, 'searchProvider')).toBe('removed-search')
  expect(translationOptions(translation, h.state.translation)).toEqual(['bing', 'google'])
  expect(capabilityValue(translation, 'provider')).toBe('deepseek-account')
  h.absent(); expect((await readCapabilities(h.client)).web.status).toBe('ready'); expect((await readCapabilities(h.client)).translation.status).toBe('failed')
  expect(capabilityRefreshBoundary).toBe('foreground-reconnect-explicit')
})
test('capability explicit choice vs Auto uses one revision-fenced set/unset, authority readback and preserves other fields', async () => {
  const h = harness(), snapshot = await readCapabilities(h.client), ns = capabilityNamespace(snapshot.configuration, 'web')!
  h.lost(); const configuration = await saveCapability(h.client, ns, 'searchProvider', 'search-local')
  expect(capabilityValue(capabilityNamespace(configuration, 'web'), 'fetchProvider')).toBe('fetch-local')
  const fresh = capabilityNamespace(configuration, 'web')!; await saveCapability(h.client, fresh, 'searchProvider')
  expect(h.calls.filter(c => c.method === 'settings/mutate').map(c => c.args)).toEqual([
    { ns: 'mounted-web', ops: [{ op: 'set', path: ['searchProvider'], value: 'search-local' }], expectedRevision: 3 },
    { ns: 'mounted-web', ops: [{ op: 'unset', path: ['searchProvider'] }], expectedRevision: 4 },
  ])
  expect(capabilityValue(h.state.configuration.namespaces[0], 'searchProvider')).toBe(undefined)
})
test('composition pin is inherited rather than fake Auto and conflicts never replay writes', async () => {
  const h = harness(), ns = h.state.configuration.namespaces[0]; ns.base = { searchProvider: 'search-local' }
  expect(capabilityBase(ns, 'searchProvider')).toBe('search-local')
  await saveCapability(h.client, ns, 'searchProvider', 'search-local')
  expect(h.calls.find(c => c.method === 'settings/mutate')!.args.ops).toEqual([{ op: 'unset', path: ['searchProvider'] }])
  h.conflict(); let code = ''
  try { await saveCapability(h.client, ns, 'fetchProvider', 'other') } catch (e) { code = (e as DshError).code }
  expect(code).toBe('settings/conflict'); expect(h.calls.filter(c => c.method === 'settings/mutate').length).toBe(2)
})
test('translation provider and target language write exact mounted fields, preferences/limit come from limits, no text or credential operations', async () => {
  const h = harness(), ns = capabilityNamespace((await readCapabilities(h.client)).configuration, 'translation')!
  const saved = await saveCapability(h.client, ns, 'provider', 'google')
  await saveCapability(h.client, capabilityNamespace(saved, 'translation')!, 'targetLanguage', 'zh-Hant')
  expect(h.state.translation.preferences).toEqual({ provider: 'google', targetLanguage: 'zh-Hant' })
  expect(h.calls.filter(c => c.method === 'settings/mutate').map(c => c.args.ops)).toEqual([[{ op: 'set', path: ['provider'], value: 'google' }], [{ op: 'set', path: ['targetLanguage'], value: 'zh-Hant' }]])
  expect(h.calls.some(c => /translate$|credentials|account\//.test(c.method))).toBe(false)
})
test('capability copy supports eight languages, localized descriptions fallback to English for unsupported languages', () => {
  for (const locale of ['zh', 'zh-Hant', 'en', 'es', 'fr', 'ko', 'ja', 'ru']) expect(Object.values(capabilitySettingsStrings(locale)).every(v => typeof v === 'string' && v.length > 0)).toBe(true)
  expect(capabilitySettingsStrings('de')).toEqual(capabilitySettingsStrings('en'))
  expect(capabilityText({ en: 'English', zh: '中文', 'zh-hant': '繁體', de: 'Deutsch' }, 'zh_TW')).toBe('繁體')
  expect(capabilityText({ en: 'English', zh: '中文', de: 'Deutsch' }, 'de-DE')).toBe('English')
  expect(capabilityText({ en: 'English' }, 'ko')).toBe('English')
})
test('native capability picker keeps missing IDs, stages choices, renders eligibility and saves provider and target language', async () => {
  const h = harness(), app = await appFor(h)
  await app.press('id:capability-settings-open'); await app.waitFor('id:capability-search-missing')
  expect(app.texts().some(t => t.includes('[removed-search]'))).toBe(true)
  expect(app.shows('id:capability-translation-missing')).toBe(true)
  expect(app.shows('id:capability-translation-option-deepseek-account')).toBe(false)
  expect(app.texts().some(t => t.includes('4000'))).toBe(true)
  await app.press('id:capability-search-option-search-local')
  expect(h.calls.some(c => c.method === 'settings/mutate')).toBe(false)
  await app.press('id:capability-search-save'); await app.waitFor('text:Saved and confirmed by the computer.')
  await app.press('id:capability-search-auto'); await app.press('id:capability-search-save')
  await app.waitFor('text:Saved and confirmed by the computer.')
  await app.press('id:capability-translation-option-google'); await app.press('id:capability-translation-provider-save'); await app.waitFor('text:Saved and confirmed by the computer.')
  await app.clear('id:capability-translation-target'); await app.type('id:capability-translation-target', 'ja-JP'); await app.press('id:capability-translation-target-save'); await app.waitFor('text:Saved and confirmed by the computer.')
  expect(h.state.translation.preferences.targetLanguage).toBe('ja-JP')
  expect(h.calls.filter(c => c.method === 'settings/mutate').length).toBe(4)
  expect(h.calls.some(c => c.method === 'cotTranslation/translate')).toBe(false)
})
test('native refresh handles catalog removal, read-only and unsupported translation without dropping registered providers', async () => {
  const h = harness(), app = await appFor(h)
  await app.press('id:capability-settings-open'); await app.waitFor('id:capability-fetch-option-fetch-local')
  h.state.web.fetch = []; h.absent(); h.readOnly()
  await app.press('id:capability-settings-open'); await app.waitFor('id:capability-fetch-missing')
  expect(app.shows('id:capability-translation-unavailable')).toBe(true)
  expect(app.enabled('id:capability-search-option-search-local')).toBe(false)
  expect(h.calls.some(c => c.method === 'settings/mutate')).toBe(false)
})
