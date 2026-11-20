import { expect, open, test } from 'nsh/test'
import { DiagnosticJournal, diagnosticEvent, diagnosticExport, JOURNAL_BYTES, JOURNAL_EVENTS, type DiagnosticPrefs } from './diagnostics.ts'
import { diagnostics } from './diagnostics.ts'
import { Dsh } from './dsh.ts'

const enabled: DiagnosticPrefs = { enabled: true, categories: { interaction: true, performance: true, network: true, resources: true } }
const bait = 'PRIVATE_BAIT_prompt_reply_think_terminal_keyboard_token_Authorization_https://private.invalid/x?secret=value#fragment_/Users/private/home'
const pause = () => new Promise((resolve) => setTimeout(resolve, 10))

test('diagnostics is opt-in, category scoped and suspended in background, including in-flight requests', async () => {
  let disk: string | null = null
  const journal = new DiagnosticJournal({ read: async () => disk, write: async (text) => { disk = text }, clear: async () => { disk = null } })
  expect(journal.prefs()).toEqual({ enabled: false, categories: { interaction: false, performance: false, network: false, resources: false } })
  journal.record('interaction', 'ui.action', { action: 'menu' }); journal.callback()
  await journal.flush(); expect(disk).toBe(null)
  journal.configure({ ...enabled, categories: { ...enabled.categories, interaction: false } })
  journal.record('interaction', 'ui.action', { action: 'menu' })
  journal.record('resources', 'os.snapshot', { thermal: 'fair' })
  const end = journal.request('session/list')
  journal.foreground(false); end('ok', 200)
  journal.record('resources', 'os.snapshot', { thermal: 'critical' }); journal.callback()
  await pause(); await journal.flush()
  expect(JSON.parse(disk!)).toEqual([{ at: JSON.parse(disk!)[0].at, category: 'resources', event: 'os.snapshot', fields: { thermal: 'fair' } }])
  journal.foreground(true); journal.configure({ ...enabled, enabled: false })
  journal.record('network', 'rpc.complete', { operation: 'list', outcome: 'ok', durationMs: 12 })
  expect(journal.snapshot(0, enabled.categories).length).toBe(1)
})

test('diagnostics rolls by bytes/events, restores without collecting, filters time and clears persistent data', async () => {
  let disk: string | null = null
  const io = { read: async () => disk, write: async (text: string) => { disk = text }, clear: async () => { disk = null } }
  const journal = new DiagnosticJournal(io); await journal.load(); journal.configure(enabled)
  for (let i = 0; i < 1800; i++) journal.record('network', 'rpc.complete', { operation: 'history', outcome: 'ok', durationMs: i, status: 200, bytesReceived: 999999 })
  await journal.flush()
  expect(disk!.length <= JOURNAL_BYTES).toBe(true)
  expect(JSON.parse(disk!).length <= JOURNAL_EVENTS).toBe(true)
  expect(JSON.parse(disk!).at(-1).fields.durationMs).toBe(1799)
  const cold = new DiagnosticJournal(io); await cold.load()
  expect(cold.prefs().enabled).toBe(false)
  expect(cold.snapshot(0, enabled.categories)).toEqual(journal.snapshot(0, enabled.categories))
  expect(cold.snapshot(Date.now() + 1, enabled.categories)).toEqual([])
  const old = diagnosticEvent('interaction', 'ui.action', { action: 'menu' }, Date.now() - 86400001)!
  const recent = diagnosticEvent('interaction', 'ui.action', { action: 'settings' }, Date.now())!
  disk = JSON.stringify([old, recent])
  const ranged = new DiagnosticJournal(io); await ranged.load()
  expect(ranged.snapshot(0, enabled.categories)).toEqual([recent])
  await cold.clear(); expect(disk).toBe(null)
  const cleared = new DiagnosticJournal(io); await cleared.load(); expect(cleared.snapshot(0, enabled.categories)).toEqual([])
})

test('diagnostic export is event-specific allowlisted metadata, with fresh identity and no bait or arbitrary identifiers', () => {
  const at = Date.now()
  const e = diagnosticEvent('network', 'rpc.complete', { operation: 'list', outcome: 'http_error', durationMs: 31.4, status: 503, bytesReceived: 55, prompt: bait, url: bait, error: bait, requestId: bait }, at)!
  expect(e.fields).toEqual({ operation: 'list', outcome: 'http_error', durationMs: 31, status: 503, bytesReceived: 55, bytesSource: 'content_length' })
  expect(diagnosticEvent('interaction', 'ui.action', { action: bait }, at)).toBe(undefined)
  expect(diagnosticEvent('network', bait, { operation: 'list' }, at)).toBe(undefined)
  const forged = { ...e, fields: { ...e.fields, keyboard: bait }, sessionId: bait }
  const info = { version: '2.4.9', build: '314', os: '27.2', deviceClass: 'phone', runtime: bait }
  const text = diagnosticExport([forged], enabled.categories, info, 'ios')
  expect(text).not.toContain(bait)
  const exported = JSON.parse(text)
  expect(exported.app).toEqual({ version: '2.4.9', build: '314', platform: 'ios', os: '27.2', deviceClass: 'phone', runtime: null })
  expect(exported.schemaVersion).toBe(1)
  expect(exported.exportId === JSON.parse(diagnosticExport([e], enabled.categories, info, 'ios')).exportId).toBe(false)
  expect(JSON.parse(diagnosticExport([e], { ...enabled.categories, network: false }, info, 'ios')).events).toEqual([])
})

test('a journal write failure visibly stops recording; clearing while a write is in flight cannot resurrect old logs', async () => {
  const failed = new DiagnosticJournal({ read: async () => null, write: async () => { throw new Error(bait) }, clear: async () => {} })
  failed.configure(enabled); failed.record('interaction', 'ui.action', { action: 'menu' }); await failed.flush()
  expect(failed.failed()).toBe(true); expect(failed.prefs().enabled).toBe(false)
  failed.record('interaction', 'ui.action', { action: 'settings' })
  expect(failed.snapshot(0, enabled.categories).length).toBe(1)
  let disk: string | null = null, release: () => void = () => {}
  const wait = new Promise<void>((resolve) => { release = resolve })
  const journal = new DiagnosticJournal({ read: async () => null, write: async (text) => { await wait; disk = text }, clear: async () => { disk = null } })
  await journal.load(); journal.configure(enabled); journal.record('interaction', 'ui.action', { action: 'menu' })
  const write = journal.flush(); const clear = journal.clear()
  release(); await write; await clear
  expect(disk).toBe(null); expect(journal.snapshot(0, enabled.categories)).toEqual([])
})

test('existing RPC outcomes are measured without reading/cloning extra bodies or adding requests; business bait never reaches export', async () => {
  diagnostics.configure(enabled)
  let requests = 0, reads = 0
  const dsh = new Dsh(`http://synthetic.invalid/${bait}`, bait, { fetch: (async () => {
    requests++
    return { status: 200, ok: true, headers: { get: (name: string) => name === 'content-length' ? '123' : null },
      json: async () => { reads++; return { result: { ok: true, value: { reply: bait, terminal: bait, path: bait } } } },
      clone: () => { throw new Error('must not clone') }, text: () => { throw new Error('must not read') } } as any
  }) })
  expect(await dsh.rpc('session/prompt', { request: { content: bait } })).toEqual({ reply: bait, terminal: bait, path: bait })
  expect([requests, reads]).toEqual([1, 1])
  const events = diagnostics.snapshot(0, enabled.categories)
  expect(events.map((e) => [e.event, e.fields.operation, e.fields.outcome, e.fields.bytesReceived])).toEqual([['rpc.complete', 'command', 'ok', 123]])
  expect(diagnosticExport(events, enabled.categories, { version: '1', build: '2' }, 'android')).not.toContain(bait)
  diagnostics.configure({ ...enabled, enabled: false }); dsh.close()
})

test('settings previews frozen metadata and only explicit Share opens the OS sheet, with persisted opt-in and clear', async () => {
  let disk: string | null = null
  let prefsDisk: string | null = null
  const handlers = { 'link.state': { paired: false }, 'network.state': { online: false }, 'app.state': { active: true },
    'app.info': { version: '2.4.9', build: '314', os: '27.2', deviceClass: 'phone' },
    'diagnostics.preferences.read': () => prefsDisk, 'diagnostics.preferences.write': (v: any) => { prefsDisk = v.text },
    'diagnostics.read': () => disk, 'diagnostics.write': (v: any) => { disk = v.text }, 'diagnostics.clear': () => { disk = null }, 'diagnostics.share': null, 'diagnostics.resources': null }
  const app = await open('./fixtures/diagnostics/App.tsx', { locale: 'en-US', host: { handlers } })
  await app.waitFor('text:Local diagnostics')
  expect(app.host.calls().some((c) => c.name === 'diagnostics.share')).toBe(false)
  await app.press('id:diagnostics-enabled')
  await app.press('id:diagnostics-interaction')
  await app.waitFor('text:Recording selected categories on this phone.')
  await app.host.send('fixture.action', { action: 'menu', prompt: bait })
  await app.press('id:diagnostics-preview'); await app.waitFor('id:diagnostics-export-preview')
  expect(app.texts().includes('1 events')).toBe(true)
  expect(app.host.calls().some((c) => c.name === 'diagnostics.share')).toBe(false)
  await app.press('id:diagnostics-share')
  await app.waitUntil(() => app.host.calls().some((c) => c.name === 'diagnostics.share'))
  const shared = app.host.calls().find((c) => c.name === 'diagnostics.share')!.data as any
  expect(JSON.stringify(shared)).not.toContain(bait)
  expect(app.requests().length).toBe(0)
  const cold = await open('./fixtures/diagnostics/App.tsx', { locale: 'en-US', storage: app.storage(), host: { handlers } })
  await cold.waitFor('text:Recording selected categories on this phone.')
  await cold.press('id:diagnostics-preview'); await cold.waitFor('text:1 events')
  await cold.press('id:diagnostics-clear')
  await cold.press('id:diagnostics-preview'); await cold.waitFor('text:No events in this range.')
  expect(disk).toBe(null)
})

test('preference write failure never starts metrics; opting out stops them even when saving fails', async () => {
  let fail = true
  const app = await open('./fixtures/diagnostics/App.tsx', { locale: 'en-US', host: { handlers: {
    'diagnostics.preferences.read': null,
    'diagnostics.preferences.write': () => { if (fail) throw new Error(bait) },
    'diagnostics.read': null, 'diagnostics.write': null, 'diagnostics.resources': null,
  } } })
  await app.waitFor('id:diagnostics-enabled')
  await app.press('id:diagnostics-enabled')
  await app.waitFor('id:diagnostics-error')
  expect(app.shows('text:Recording selected categories on this phone.')).toBe(false)
  expect(app.host.calls().filter((c) => c.name === 'diagnostics.resources').some((c) => (c.data as any).enabled)).toBe(false)
  fail = false
  await app.press('id:diagnostics-enabled')
  await app.press('id:diagnostics-resources')
  await app.waitFor('text:Recording selected categories on this phone.')
  await app.waitUntil(() => app.host.calls().some((c) => c.name === 'diagnostics.resources' && (c.data as any).enabled))
  fail = true
  await app.press('id:diagnostics-enabled')
  await app.waitFor('text:Off. Previously saved logs remain until cleared or replaced.')
  await app.waitUntil(() => (app.host.calls().filter((c) => c.name === 'diagnostics.resources').at(-1)?.data as any)?.enabled === false)
  expect(app.requests().length).toBe(0)
})

for (const platform of ['ios', 'android'] as const) {
  test(`${platform}: fresh and previously disabled diagnostics stay off; enabling requires individual category consent`, async () => {
    for (const saved of [null, JSON.stringify({ ...enabled, enabled: false })]) {
      let preferences = saved, disk: string | null = null
      const handlers = {
        'diagnostics.preferences.read': () => preferences,
        'diagnostics.preferences.write': (v: any) => { preferences = v.text },
        'diagnostics.read': () => disk, 'diagnostics.write': (v: any) => { disk = v.text },
        'diagnostics.resources': null, 'app.info': { version: '1.0', build: '1' },
      }
      const app = await open('./fixtures/diagnostics/App.tsx', { platform, locale: 'en-US', host: { handlers } })
      await app.waitFor('id:diagnostics-enabled')
      expect(app.shows('text:Recording selected categories on this phone.')).toBe(false)
      for (const category of ['interaction', 'performance', 'network', 'resources']) {
        expect(app.enabled(`id:diagnostics-${category}`)).toBe(false)
      }
      expect(preferences).toBe(saved) // Upgrading or viewing never rewrites existing consent.
      await app.host.send('fixture.action', { action: 'menu' })
      await app.host.send('diagnostics.resource', { thermal: 'fair' })
      await app.press('id:diagnostics-preview'); await app.waitFor('text:No events in this range.')
      expect(disk).toBe(null)
      expect(app.host.calls().filter(c => c.name === 'diagnostics.resources').some(c => (c.data as any).enabled)).toBe(false)
      await app.press('id:diagnostics-enabled')
      await app.waitUntil(() => preferences !== saved)
      expect(JSON.parse(preferences!)).toEqual({ enabled: true, categories: { interaction: false, performance: false, network: false, resources: false } })
      expect(app.texts()).toContain('Choose categories to start recording.')
      for (const category of ['interaction', 'performance', 'network', 'resources']) expect(app.enabled(`id:diagnostics-${category}`)).toBe(true)
      await app.host.send('fixture.action', { action: 'menu' })
      await app.press('id:diagnostics-preview'); await app.waitFor('text:No events in this range.')
      expect(disk).toBe(null)
      await app.press('id:diagnostics-interaction')
      await app.waitFor('text:Recording selected categories on this phone.')
      await app.host.send('fixture.action', { action: 'menu' })
      await app.press('id:diagnostics-preview'); await app.waitFor('text:1 events')
      expect(app.host.calls().filter(c => c.name === 'diagnostics.resources').some(c => (c.data as any).enabled)).toBe(false)
    }
  })

  test(`${platform}: upgrade and restart preserve an existing explicit category selection`, async () => {
    const saved = JSON.stringify({ enabled: true, categories: { interaction: true, performance: false, network: true, resources: false } })
    let preferences = saved
    const app = await open('./fixtures/diagnostics/App.tsx', { platform, host: { handlers: {
      'diagnostics.preferences.read': saved, 'diagnostics.read': null, 'diagnostics.resources': null,
      'diagnostics.preferences.write': (v: any) => { preferences = v.text },
    } } })
    await app.waitFor('text:Recording selected categories on this phone.')
    expect(app.host.calls().some(c => c.name === 'diagnostics.preferences.write')).toBe(false)
    expect(app.host.calls().filter(c => c.name === 'diagnostics.resources').some(c => (c.data as any).enabled)).toBe(false)
    await app.press('id:diagnostics-network')
    await app.waitUntil(() => preferences !== saved)
    expect(JSON.parse(preferences)).toEqual({ enabled: true, categories: { interaction: true, performance: false, network: false, resources: false } })
  })
}
