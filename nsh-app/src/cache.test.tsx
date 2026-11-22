import { expect, open, test } from 'nsh/test'
import { Storage } from 'nsh'
import { OfflineCache } from './cache.ts'

const ORIGIN = 'http://127.0.0.1:40001/dsh'
const paired = { paired: true, origin: ORIGIN, token: 'synthetic-device-token', cacheId: 'synthetic-pair-a' }
const handlers = { 'link.state': paired, 'network.state': { online: true }, 'app.state': { active: true }, 'link.path': {}, 'link.diagnose': {}, 'link.forget': null }
const ok = (value: unknown) => ({ body: { result: { ok: true, value } } })
const listing = (title = 'First chat') => ok({ items: [
  { sessionId: 's1', updatedAt: 2000, running: true, projections: { values: { title } } },
  { sessionId: 's2', updatedAt: 1000, running: false, projections: { values: { title: 'Second chat' } } },
] })
const fixture = './fixtures/cached/App.tsx'

test('cached lists, projects, history and separate drafts survive page changes and an offline cold start on a new bridge port', async () => {
  const app = await open(fixture, { host: { handlers }, network: { [`POST ${ORIGIN}/api/session/list`]: listing() } })
  await app.waitFor('text:Project-v1')
  await app.press('text:First chat'); await app.waitFor('text:History-s1-v1')
  await app.type('id:composer', 'First unsent draft')
  await app.back()
  await app.press('text:Second chat'); await app.waitFor('text:History-s2-v1')
  await app.type('id:composer', 'Second unsent draft')
  await app.host.send('network', { online: false }); await app.host.send('fixture.connection', { online: false })
  await app.back(); await app.press('text:First chat')
  await app.waitFor('text:History-s1-v1')
  expect(app.value('id:composer')).toBe('First unsent draft')
  await app.host.send('app.state', { active: false })
  await app.waitUntil(() => Object.values(app.storage()).some((v) => v.includes('First unsent draft')))
  const storage = app.storage()
  expect(JSON.stringify(storage)).not.toContain(paired.token)
  const cold = await open(fixture, { storage, host: { params: { offline: true }, handlers: {
    ...handlers, 'link.state': { ...paired, origin: 'http://127.0.0.1:40002/dsh' }, 'network.state': { online: false },
  } } })
  await cold.waitFor('text:Project-v1')
  expect(cold.texts().indexOf('Second chat') < cold.texts().indexOf('First chat')).toBe(true) // pin survives
  await cold.press('text:First chat'); await cold.waitFor('text:History-s1-v1')
  expect(cold.value('id:composer')).toBe('First unsent draft')
  expect(cold.shows('id:saved-copy')).toBe(true)
  await cold.back(); await cold.press('text:Second chat'); await cold.waitFor('text:History-s2-v1')
  expect(cold.value('id:composer')).toBe('Second unsent draft')
  expect(cold.requests().some((r) => /prompt|execute/.test(r.url))).toBe(false)

  // A slow computer must not hold the saved list behind its response.
  const slow = await open(fixture, { storage, host: { params: { offline: true }, handlers }, network: {
    [`POST ${ORIGIN}/api/session/list`]: { ...listing('New remote title'), delay: 2000 },
  } })
  await slow.waitFor('text:First chat', { timeout: 1000 })
  expect(slow.shows('id:saved-copy')).toBe(true)
  await slow.waitFor('text:New remote title')

  const other = await open(fixture, { storage, host: { params: { offline: true }, handlers: {
    ...handlers, 'link.state': { ...paired, cacheId: 'synthetic-pair-b' }, 'network.state': { online: false },
  } } })
  await other.waitFor('text:No chats saved on this phone yet. Connect to your computer to load them.')
  expect(JSON.stringify(other.storage())).not.toContain('First unsent draft')
  const unpaired = await open(fixture, { storage, host: { handlers: { ...handlers, 'link.state': { paired: false } } } })
  await unpaired.waitFor('text:Link your computer')
  expect(unpaired.storage()['offline-v1']).toBe(undefined)
})

test('cold offline with no saved list does not claim the computer has no chats', async () => {
  const app = await open(fixture, { host: { params: { offline: true }, handlers: { ...handlers, 'network.state': { online: false } } }, network: {
    [`POST ${ORIGIN}/api/session/list`]: { error: 'synthetic network failure' },
  } })
  await app.waitFor('text:No chats saved on this phone yet. Connect to your computer to load them.')
  expect(app.shows('text:No chats yet')).toBe(false)

  // The phone still has Wi-Fi, but its companion returns 503 before the socket drops.
  const unavailable = await open(fixture, { host: { params: { offline: true }, handlers }, network: {
    [`POST ${ORIGIN}/api/session/list`]: { status: 503, body: {} },
  } })
  await unavailable.host.send('fixture.connection', { online: false })
  await unavailable.waitFor('text:No chats saved on this phone yet. Connect to your computer to load them.')
  expect(unavailable.shows('text:No chats yet')).toBe(false)
})

test('reconnecting replaces saved history and projects and refreshes the list immediately without replaying a draft', async () => {
  let title = 'First chat'
  const app = await open(fixture, { host: { handlers }, network: { [`POST ${ORIGIN}/api/session/list`]: () => listing(title) } })
  await app.press('text:First chat'); await app.waitFor('text:History-s1-v1')
  await app.type('id:composer', 'Keep this draft')
  await app.host.send('network', { online: false }); await app.host.send('fixture.connection', { online: false })
  await app.back(); await app.press('text:First chat'); await app.waitFor('text:History-s1-v1')
  title = 'Changed remotely'
  await app.host.send('fixture.connection', { online: true, version: 2 }); await app.host.send('network', { online: true })
  await app.waitFor('text:History-s1-v2', { timeout: 2000 })
  expect(app.shows('text:History-s1-v1')).toBe(false)
  expect(app.texts().filter((s) => s === 'History-s1-v2').length).toBe(1)
  expect(app.value('id:composer')).toBe('Keep this draft')
  expect(app.shows('id:saved-copy')).toBe(false)
  await app.back(); await app.waitFor('text:Changed remotely', { timeout: 2000 })
  await app.waitFor('text:Project-v2')
  expect(app.requests().some((r) => /prompt|execute/.test(r.url))).toBe(false)
})

test('a temporary search network failure does not disable the next full-text query', async () => {
  let searches = 0
  const app = await open(fixture, { host: { handlers }, network: {
    [`POST ${ORIGIN}/api/session/list`]: listing(),
    [`POST ${ORIGIN}/api/session/search`]: () => { searches++; return searches === 1 ? { error: 'synthetic network failure' } : ok({ items: [{ sessionId: 's1', snippet: 'Remote content match' }] }) },
  } })
  await app.type('id:search', 'first query'); await app.waitUntil(() => searches === 1)
  await app.type('id:search', 'second query'); await app.waitFor('text:Remote content match')
  expect(searches).toBe(2)
})

test('changing pairing at the same origin clears old history and drafts, and unlink clears the persistent copies', async () => {
  const app = await open(fixture, { host: { handlers: { ...handlers, 'link.pair': { ...paired, token: 'synthetic-other-token', cacheId: 'synthetic-pair-b' } } }, network: {
    [`POST ${ORIGIN}/api/session/list`]: listing(),
  } })
  await app.press('text:First chat'); await app.waitFor('text:History-s1-v1')
  await app.type('id:composer', 'Private draft for A')
  await app.host.send('network', { online: false }); await app.host.send('fixture.connection', { online: false })
  await app.host.send('pair', { text: 'synthetic-pair-b' })
  await app.waitFor('text:No chats saved on this phone yet. Connect to your computer to load them.')
  expect(app.shows('text:History-s1-v1')).toBe(false)
  await app.waitUntil(() => !JSON.stringify(app.storage()).includes('Private draft for A'))
  await app.press('id:more'); await app.press('id:menu-settings'); await app.press('id:settings-unlink')
  await app.type('id:danger-word', 'DSH Anywhere'); await app.press('id:danger-confirm')
  await app.waitFor('text:Link your computer')
  await app.waitUntil(() => !Object.keys(app.storage()).includes('offline-v1'))
  await app.wait(600) // an old page's delayed save must not recreate the deleted key
  expect(Object.keys(app.storage()).includes('offline-v1')).toBe(false)
})

test('a slow list refresh stays single-flight across repeated network and foreground events', async () => {
  let reads = 0
  const app = await open('./fixtures/cached/List.tsx', { host: { handlers }, network: {
    [`POST ${ORIGIN}/api/session/list`]: () => { reads++; return { ...listing(), delay: 1500 } },
  } })
  await app.waitFor('id:sessions')
  await app.host.send('network', { online: true }); await app.host.send('app.state', { active: true }); await app.host.send('network', { online: true })
  expect(reads).toBe(1)
  await app.waitFor('text:First chat')
  await app.waitUntil(() => reads === 2)
  await app.wait(1600)
  expect(reads).toBe(2)
})

test('a failed foreground list does not retry after the app goes into the background', async () => {
  let reads = 0
  const app = await open('./fixtures/cached/List.tsx', { clock: {}, host: { handlers }, network: {
    [`POST ${ORIGIN}/api/session/list`]: () => { reads++; return { status: 503, body: '', delay: 200 } },
  } })
  await app.clock.runFor(100)
  expect(reads).toBe(1)
  await app.host.send('app.state', { active: false })
  await app.clock.runFor(60_000)
  expect(reads).toBe(1)
})

test('saved copies bound history and recent chats, retain a long draft, and never restore live activity', async () => {
  await OfflineCache.discard()
  const cache = await OfflineCache.open('synthetic-boundary')
  for (let i = 0; i < 21; i++) cache.history(`s${i}`, [{ kind: 'assistant', id: `a${i}`, text: `${i}`, at: i, streaming: true }])
  cache.history('s20', Array.from({ length: 101 }, (_, i) => ({ kind: 'assistant' as const, id: `a${i}`, text: `row${i}`, at: i, streaming: true })))
  const draft = '草稿😀'.repeat(6000)
  cache.draft('s20', draft)
  cache.flush()
  const restored = await OfflineCache.open('synthetic-boundary')
  expect(restored.chat('s0')).toBe(undefined)
  expect(Object.keys(restored.data.chats).length).toBe(20)
  expect(restored.chat('s20')?.draft).toBe(draft)
  expect(restored.chat('s20')?.rows.length).toBe(100)
  expect(restored.chat('s20')?.rows[0]?.id).toBe('a1')
  expect(restored.chat('s20')?.rows.some((r) => r.kind === 'assistant' && r.streaming)).toBe(false)
  restored.history('s20', [
    { kind: 'assistant', id: 'oversized', text: 'x'.repeat(65536), at: 0, streaming: true },
    { kind: 'assistant', id: 'tail', text: 'keep the newest complete row', at: 1, streaming: true },
  ])
  restored.flush()
  const bounded = await OfflineCache.open('synthetic-boundary')
  expect(bounded.chat('s20')?.rows.map((r) => r.id)).toEqual(['tail'])
  bounded.history('s19', [{ kind: 'assistant', id: 'oversized', text: 'x'.repeat(65536), at: 0, streaming: false }])
  expect(bounded.chat('s19')?.at).toBe(0) // no saved history, not a genuinely empty conversation
  bounded.draft('huge', 'x'.repeat(2_097_152))
  bounded.flush()
  await OfflineCache.open('synthetic-boundary') // waits for the queued write
  expect((await Storage.getItem('offline-v1'))!.length <= 2_097_152).toBe(true)
  bounded.clear()
})
