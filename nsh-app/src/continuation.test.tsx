import { expect, open, test } from 'nsh/test'
import { Continuation, continuationAvailable, continuationSeq, type ContinuationClient } from './continuation.ts'
import { continuationStrings } from './continuation-strings.ts'

const projection = (ending: unknown = 5) => ({ kind: 'sequenced', asOfSeq: 5, values: { conversationContinuation: ending, inbox: { 'next-turn': [], 'next-step': [] } } })
const state = { running: false, cursor: 5 }
test('continuation wire is exactly SessionSeq|null, including seq zero; truthiness never grants permission', () => {
  expect(continuationSeq(0)).toBe(0); expect(continuationSeq(null)).toBe(null)
  for (const v of [true, false, {}, { ending: 5 }, '5', -1, -0, 0.5, NaN, Infinity, undefined, []]) expect(continuationSeq(v)).toBe(undefined)
  expect(continuationAvailable(projection(5), state, 5)).toBe(true)
  expect(continuationAvailable({ ...projection(0), asOfSeq: 0 }, { ...state, cursor: 0 }, 0)).toBe(true)
  for (const v of [null, {}, true, '5', 4]) expect(continuationAvailable(projection(v), state, 5)).toBe(false)
  expect(continuationAvailable({ ...projection(), kind: 'migration-required' }, state, 5)).toBe(false)
  expect(continuationAvailable(projection(), { ...state, running: true }, 5)).toBe(false)
  expect(continuationAvailable(projection(), { ...state, cursor: 4 }, 5)).toBe(false)
  for (const target of ['next-turn', 'next-step']) {
    const p = projection(); (p.values.inbox as Record<string, unknown>)[target] = [{ source: { kind: 'user' } }]
    expect(continuationAvailable(p, state, 5)).toBe(false)
  }
})

test('continuation outbox never writes on refresh; unconfirmed manual retries retain requestId; receipt settles even after failure', async () => {
  const writes: any[] = []
  const client: ContinuationClient = { computer: async () => ({ dshVersion: '0.2.2-rc.5' }), rpc: async <T,>(method: string, args: any): Promise<T> => {
    if (method === 'session/prompt') { writes.push(args); throw new Error('uncertain') }
    return (method === 'session/projections' ? projection() : state) as T
  } }
  const c = new Continuation(client, 's', () => {})
  await c.refresh(5); expect(c.view.status).toBe('ready'); expect(writes.length).toBe(0)
  await c.send(5, () => false); expect(writes.length).toBe(0)
  await c.send(5, () => true, () => 'unique-request')
  expect(c.view.status).toBe('unconfirmed')
  await c.refresh(5); expect(writes.length).toBe(1)
  await c.send(5, () => true, () => 'must-not-be-used')
  expect(writes).toEqual([1, 2].map(() => ({ request: { requestId: 'unique-request', sessionId: 's', mode: 'queue', content: [] } })))
  c.receipt('other'); expect(c.view.status).toBe('unconfirmed')
  c.receipt('unique-request'); expect(c.view.status).toBe('unavailable')
  expect(c.view.requestId).toBe(undefined)
})

test('continuation admits the exact inspected alpha without enabling writes on unverified alphas', async () => {
  for (const [dshVersion, status] of [['0.2.3-alpha.2', 'queued'], ['0.2.3-alpha.3', 'unknown']]) {
    const calls: string[] = []
    const client: ContinuationClient = { computer: async () => ({ dshVersion }), rpc: async <T,>(method: string): Promise<T> => {
      calls.push(method)
      return (method === 'session/projections' ? projection() : method === 'session/state' ? state : { accepted: true }) as T
    } }
    const c = new Continuation(client, 's', () => {})
    await c.send(5, () => true)
    expect(c.view.status).toBe(status)
    expect(calls).toEqual(status === 'queued' ? ['session/projections', 'session/state', 'session/prompt'] : [])
  }
})

test('stale capability read, disposal and double taps cannot write; a queued acknowledgement is not completion', async () => {
  let release = () => {}, writes = 0
  const client: ContinuationClient = { computer: async () => { await new Promise<void>((r) => { release = r }); return { dshVersion: '0.2.2-rc.5' } }, rpc: async <T,>(method: string): Promise<T> => {
    if (method === 'session/prompt') { writes++; return { accepted: true } as T }
    return (method === 'session/projections' ? projection() : state) as T
  } }
  const c = new Continuation(client, 's', () => {})
  const first = c.send(5, () => true); await c.send(5, () => true); c.invalidate(); release(); await first
  expect(writes).toBe(0)
  const second = c.send(5, () => true); c.dispose(); release(); await second
  expect(writes).toBe(0)
  const immediate = new Continuation({ ...client, computer: async () => ({ dshVersion: '0.2.2-rc.5' }) }, 's', () => {})
  await immediate.send(5, () => true); expect(immediate.view.status).toBe('queued')
  await immediate.send(5, () => true); expect(writes).toBe(1)
})

test('native chat continues only by explicit tap, records retry as a compact receipt and never a user bubble', async () => {
  const app = await open('./continuation-fixture/App.tsx', { locale: 'en-US' })
  await app.waitFor('id:continue-generation')
  expect(app.texts()).toContain('eligible · writes: 0')
  expect(app.count('id:bubble')).toBe(1)
  await app.press('id:continue-generation')
  await app.waitFor('id:continuation-receipt')
  expect(app.texts()).toContain(continuationStrings('en').receipt)
  expect(app.count('id:bubble')).toBe(1)
  expect(app.count('id:continue-generation')).toBe(0)
  expect(app.texts()).toContain('eligible · writes: 1')
})

for (const [name, copy] of [['legacy', 'unsupported'], ['unknown', 'unknown'], ['malformed', 'unknown'], ['denied', 'unavailable'], ['busy', 'unavailable'], ['pending', 'unavailable'], ['offline', 'offline']] as const) {
  test(`native continuation ${name} is explicit and does not write`, async () => {
    const app = await open('./continuation-fixture/App.tsx', { locale: 'en-US' })
    await app.waitFor('id:continue-generation'); await app.host.send('fixture.scenario', { name })
    await app.waitFor(`text:${continuationStrings('en')[copy]}`)
    expect(app.count('id:continue-generation')).toBe(0)
    expect(app.texts()).toContain(`${name} · writes: 0`)
  })
}

test('native unconfirmed continuation retries the identical request only on tap', async () => {
  const app = await open('./continuation-fixture/App.tsx', { locale: 'en-US' })
  await app.waitFor('id:continue-generation'); await app.press('id:fixture-unconfirmed')
  await app.waitFor('text:Continue generation'); await app.press('id:continue-generation')
  await app.waitFor(`text:${continuationStrings('en').unconfirmed}`)
  await app.press('id:continue-generation'); await app.waitFor('text:unconfirmed · writes: 2')
  const ids = app.texts().find((t) => t.startsWith('phone-continue-'))!.split(',')
  expect(ids.length).toBe(2); expect(ids[0]).toBe(ids[1])
})

test('lost HTTP response is settled by durable retry receipt without another write', async () => {
  const app = await open('./continuation-fixture/App.tsx', { locale: 'en-US' })
  await app.waitFor('id:continue-generation'); await app.press('id:fixture-lost-response')
  await app.waitFor('text:Continue generation'); await app.press('id:continue-generation')
  await app.waitFor('id:continuation-receipt')
  expect(app.texts()).toContain('lost-response · writes: 1')
  expect(app.count('id:bubble')).toBe(1)
})

test('a draft blocks continuation without clearing the person’s text; child chats have no continuation entry', async () => {
  const app = await open('./continuation-fixture/App.tsx', { locale: 'en-US' })
  await app.waitFor('id:continue-generation'); await app.type('id:composer', 'Keep this draft')
  await app.waitFor(`text:${continuationStrings('en').draft}`)
  expect(app.count('id:continue-generation')).toBe(0)
  const child = await open('./continuation-fixture/App.tsx', { host: { params: { child: true } } })
  await child.waitFor('id:turn-failure'); expect(child.count('id:continuation')).toBe(0)
})

test('discarding a retained failed prompt unlocks generation recovery without resending that prompt', async () => {
  const app = await open('./continuation-fixture/App.tsx', { locale: 'en-US' })
  await app.waitFor('id:continue-generation')
  await app.press('id:fixture-unconfirmed'); await app.waitFor('id:continue-generation')
  await app.type('id:composer', 'Unsent follow-up'); await app.press('id:send')
  await app.waitFor('id:outgoing-failed')
  expect(app.count('id:continue-generation')).toBe(0)
  expect(app.texts()).toContain('unconfirmed · writes: 1')
  await app.press('id:discard-outgoing')
  await app.waitFor('id:continue-generation')
  expect(app.count('id:outgoing-failed')).toBe(0)
  expect(app.texts()).toContain('unconfirmed · writes: 1')
  await app.press('id:fixture-eligible'); await app.waitFor('id:continue-generation')
  await app.press('id:continue-generation'); await app.waitFor('id:continuation-receipt')
  expect(app.texts()).toContain('eligible · writes: 2')
  expect(app.texts()).not.toContain('Unsent follow-up')
})

test('continuation copy covers eight languages and all other languages fall back to English', () => {
  for (const tag of ['zh-CN', 'zh-TW', 'en', 'es', 'fr', 'ko', 'ja', 'ru']) for (const text of Object.values(continuationStrings(tag))) expect(text.length > 0).toBe(true)
  expect(continuationStrings('de')).toEqual(continuationStrings('en'))
  expect(continuationStrings('zh-HK')).toEqual(continuationStrings('zh-Hant'))
})

for (const tag of ['zh-CN', 'zh-TW', 'en', 'es', 'fr', 'ko', 'ja', 'ru', 'de']) {
  test(`native continuation action and retry source render in ${tag}`, async () => {
    const app = await open('./continuation-fixture/App.tsx', { locale: tag })
    await app.waitFor(`text:${continuationStrings(tag).ready}`)
    await app.press('id:continue-generation')
    await app.waitFor(`text:${continuationStrings(tag).receipt}`)
    expect(app.count('id:bubble')).toBe(1)
  })
}

test('a queued acknowledgement waits for the stream, and reconnect refresh never repeats a write', async () => {
  const app = await open('./continuation-fixture/App.tsx', { locale: 'en' })
  await app.waitFor('id:continue-generation'); await app.host.send('fixture.scenario', { name: 'ack-only' })
  await app.waitFor('id:continue-generation'); await app.press('id:continue-generation')
  await app.waitFor(`text:${continuationStrings('en').queued}`)
  expect(app.count('id:continue-generation')).toBe(0)
  expect(app.count('id:continuation-receipt')).toBe(0)
  await app.host.send('fixture.scenario', { name: 'offline' })
  await app.waitFor(`text:${continuationStrings('en').offline}`)
  await app.host.send('fixture.scenario', { name: 'eligible' })
  await app.waitFor(`text:${continuationStrings('en').queued}`)
  expect(app.texts()).toContain('eligible · writes: 1')
})

test('chat invalidates the authoritative activity loader on snapshots and official team/catalog follow records', async () => {
  const app = await open('./continuation-fixture/App.tsx', { locale: 'en', host: { params: { activity: true } } })
  await app.waitFor('text:false')
  let enabled = false
  for (const type of ['team/task', 'team/mode', 'subagent/catalog', 'snapshot']) {
    enabled = !enabled
    // Follow data intentionally has no team state; only the RPC projection contains the changed value.
    await app.host.send('fixture.activity', { type, enabled })
    await app.waitFor(`text:${enabled}`)
  }
  expect(app.texts()).toContain('eligible · writes: 0')
})
