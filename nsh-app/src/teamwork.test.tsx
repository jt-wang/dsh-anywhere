import { expect, open, test } from 'nsh/test'
import { teamModeOf } from './models.ts'
import { stringsFor } from './strings.ts'

const API = 'http://127.0.0.1:40001/dsh/api'
const ok = (value?: unknown) => ({ body: { type: 'server-response', rpcId: 'x', result: { ok: true, value } } })
const refused = () => ({ body: { type: 'server-response', rpcId: 'x', result: { ok: false, error: { code: 'timeout', message: 'Unconfirmed' } } } })
const projection = (enabled: boolean, failure?: string) => ({ kind: 'sequenced', asOfSeq: 4, values: { agentTeam: { enabled, tasks: [], ...(failure ? { failure } : {}) } } })
const catalog = { default: { provider: 'sample', model: 'reasoner' }, groups: [{ id: 'sample', name: 'Sample provider', models: [
  { id: 'reasoner', name: 'Sample Reasoner', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } },
  { id: 'plain', name: 'Sample Plain' },
] }] }

function computer(overrides: Record<string, (args: any) => unknown> = {}) {
  let enabled = false
  const asked: { call: string; args: any }[] = []
  const routes = {
    'session/modelCatalog': () => ok(catalog),
    'session/selectModel': () => ok(),
    'session/projections': () => ok(projection(enabled)),
    'agentTeams/setEnabled': (args: any) => { enabled = args.enabled; return ok() },
    ...overrides,
  }
  const network: Record<string, any> = {}
  for (const [call, answer] of Object.entries(routes)) network[`POST ${API}/${call}`] = (req: { body?: string }) => {
    const args = JSON.parse(req.body ?? '{}').payload.args
    asked.push({ call, args }); return answer(args)
  }
  return { network, asked, calls: () => asked.map((a) => a.call), writes: () => asked.filter((a) => a.call === 'agentTeams/setEnabled') }
}
const picker = async (c: ReturnType<typeof computer>) => {
  const app = await open('./fixtures/teamwork/App.tsx', { host: { params: { network: true } }, network: c.network })
  await app.press('id:model')
  return app
}

test('Teamwork reads the exact root projection on open; one direct void write is followed by authoritative readback in both directions', async () => {
  const c = computer(), app = await picker(c)
  await app.waitFor('text:Teamwork is off')
  expect(c.asked.find((a) => a.call === 'session/projections')?.args).toEqual({ request: { sessionId: 'sample-root' } })
  await app.press('id:teamwork')
  await app.waitFor('text:Teamwork is on')
  await app.press('id:teamwork')
  await app.waitFor('text:Teamwork is off')
  expect(c.writes().map((a) => a.args)).toEqual([{ agentId: 'sample-root', enabled: true }, { agentId: 'sample-root', enabled: false }])
  expect(c.calls().filter((s) => s !== 'session/modelCatalog')).toEqual(['session/projections', 'agentTeams/setEnabled', 'session/projections', 'agentTeams/setEnabled', 'session/projections'])
  expect(app.texts()).toContain(stringsFor('en').team.hint)
})

test('a void acknowledgement does not fake enabled: readback can still report off; repeated taps during the request do not write twice', async () => {
  const c = computer({ 'agentTeams/setEnabled': () => ({ ...ok(), delay: 350 }) })
  const app = await picker(c)
  await app.waitFor('text:Teamwork is off')
  await app.press('id:teamwork')
  await app.waitFor('text:Switching…')
  expect(app.texts().includes('Teamwork is on')).toBe(false)
  let blocked = false
  try { await app.press('id:teamwork') } catch (e) { blocked = String(e).includes('disabled') }
  expect(blocked).toBe(true)
  await app.waitFor('text:Teamwork is off')
  expect(c.writes().length).toBe(1)
  expect(c.calls().slice(-2)).toEqual(['agentTeams/setEnabled', 'session/projections'])
})

test('reopening refreshes Teamwork rather than reusing the cached model catalog or the previous selection', async () => {
  let enabled = false
  const c = computer({ 'session/projections': () => ok(projection(enabled)) }), app = await picker(c)
  await app.waitFor('text:Teamwork is off')
  await app.back()
  enabled = true
  await app.press('id:model')
  await app.waitFor('text:Teamwork is on')
  expect(c.calls().filter((s) => s === 'session/projections').length).toBe(2)
  expect(c.writes().length).toBe(0)
})

test('an opening projection read has no off default or usable switch until the host answers', async () => {
  // Keep the read pending beyond the sheet's opening transition so the loading UI is observable.
  const c = computer({ 'session/projections': () => ({ ...ok(projection(true)), delay: 1000 }) }), app = await picker(c)
  await app.waitFor('text:Switching…')
  expect(app.count('id:teamwork')).toBe(0)
  expect(app.texts().includes('Teamwork is off')).toBe(false)
  await app.waitFor('text:Teamwork is on')
  expect(c.writes().length).toBe(0)
})

for (const [name, values] of [['missing', {}], ['rc.1 roster-only', { agentTeam: { members: [{ id: 'sample-root', name: 'lead', role: 'lead', phase: 'active' }], tasks: [] } }]] as const) {
  test(`an old host with ${name} projection explicitly says unsupported, not off, and never sends a Teamwork write`, async () => {
    const c = computer({ 'session/projections': () => ok({ kind: 'sequenced', asOfSeq: 1, values }) }), app = await picker(c)
    await app.waitFor(`text:${stringsFor('en').team.unsupported}`)
    expect(app.count('id:teamwork')).toBe(0)
    expect(app.texts().includes('Teamwork is off')).toBe(false)
    expect(c.writes().length).toBe(0)
    // Existing model/effort selection is independent of Teamwork support.
    await app.press('id:effort-high')
    await app.waitFor('text:Sample Reasoner (High)')
    expect(c.asked.find((a) => a.call === 'session/selectModel')?.args).toEqual({ request: { sessionId: 'sample-root', provider: 'sample', model: 'reasoner', reasoningEffort: 'high' } })
  })
}

test('read errors are not unsupported; checking again retries only the read and restores actual state', async () => {
  let broken = true
  const c = computer({ 'session/projections': () => broken ? { status: 503, body: '' } : ok(projection(true)) }), app = await picker(c)
  await app.waitFor(`text:${stringsFor('en').team.readFailed}`)
  expect(app.texts().includes(stringsFor('en').team.unsupported)).toBe(false)
  expect(app.count('id:teamwork')).toBe(0)
  broken = false
  await app.press('id:teamwork-refresh')
  await app.waitFor('text:Teamwork is on')
  expect(c.writes().length).toBe(0)
})

for (const applied of [false, true]) {
  test(`an uncertain write (${applied ? 'applied' : 'not applied'}) is never blindly retried and still reads the actual selection`, async () => {
    let enabled = false
    const c = computer({
      'session/projections': () => ok(projection(enabled)),
      'agentTeams/setEnabled': (args) => { if (applied) enabled = args.enabled; return refused() },
    }), app = await picker(c)
    await app.waitFor('text:Teamwork is off')
    await app.press('id:teamwork')
    await app.waitFor('id:teamwork-write-error')
    await app.waitFor(`text:Teamwork is ${applied ? 'on' : 'off'}`)
    expect(app.texts().some((s) => s.includes(stringsFor('en').team.unconfirmed))).toBe(true)
    await app.back(); await app.press('id:model')
    await app.waitFor(`text:Teamwork is ${applied ? 'on' : 'off'}`)
    expect(c.writes().length).toBe(1)
    expect(c.calls().filter((s) => s === 'session/projections').length).toBe(3)
  })
}

test('a successful write with failed readback has unknown state, not optimistic success; refresh is read-only', async () => {
  let reads = 0
  const c = computer({ 'session/projections': () => ++reads === 2 ? refused() : ok(projection(reads > 1)) }), app = await picker(c)
  await app.waitFor('text:Teamwork is off')
  await app.press('id:teamwork')
  await app.waitFor(`text:${stringsFor('en').team.readFailed}`)
  expect(app.count('id:teamwork')).toBe(0)
  expect(app.texts().includes('Teamwork is on')).toBe(false)
  await app.press('id:teamwork-refresh')
  await app.waitFor('text:Teamwork is on')
  expect(c.writes().length).toBe(1)
})

test('when both the write and readback fail, the uncertainty remains explicit and checking again only reads', async () => {
  let reads = 0
  const c = computer({
    'session/projections': () => ++reads === 2 ? refused() : ok(projection(reads > 1)),
    'agentTeams/setEnabled': () => refused(),
  }), app = await picker(c)
  await app.waitFor('text:Teamwork is off')
  await app.press('id:teamwork')
  await app.waitFor(`text:${stringsFor('en').team.readFailed}`)
  expect(app.count('id:teamwork-write-error')).toBe(1)
  expect(app.count('id:teamwork')).toBe(0)
  await app.press('id:teamwork-refresh')
  await app.waitFor('text:Teamwork is on')
  expect(c.writes().length).toBe(1)
  expect(reads).toBe(3)
})

test('projection task failure is surfaced without inventing members or discarding the independently saved Teamwork selection', async () => {
  const c = computer({ 'session/projections': () => ok(projection(true, 'invalid team/task at seq 3')) }), app = await picker(c)
  await app.waitFor('text:Teamwork is on')
  expect(app.texts()).toContain(stringsFor('en').team.taskFailure)
  expect(app.count('id:teamwork')).toBe(1)
})

test('model and effort selection keep their existing request shape and close behavior alongside Teamwork', async () => {
  const c = computer(), app = await picker(c)
  await app.waitFor('text:Teamwork is off')
  await app.press('id:effort-high')
  await app.waitFor('text:Sample Reasoner (High)')
  await app.press('id:model-sample-plain')
  await app.waitUntil(() => !app.shows('id:teamwork'))
  await app.press('id:model')
  await app.waitFor('text:Teamwork is off')
  await app.press('id:model-sample-reasoner')
  await app.waitFor('text:Sample Reasoner (Low)')
  expect(c.asked.filter((a) => a.call === 'session/selectModel').map((a) => a.args)).toEqual([
    { request: { sessionId: 'sample-root', provider: 'sample', model: 'reasoner', reasoningEffort: 'high' } },
    { request: { sessionId: 'sample-root', provider: 'sample', model: 'plain' } },
    { request: { sessionId: 'sample-root', provider: 'sample', model: 'reasoner', reasoningEffort: 'low' } },
  ])
  expect(c.writes().length).toBe(0)
})

test('malformed, absent-session and migration/cache hints are read errors, not unsupported or false', () => {
  for (const value of [null, {}, { kind: 'sequenced', values: null }, { kind: 'sequenced', values: { agentTeam: null } },
    { kind: 'sequenced', values: { agentTeam: { enabled: 'false', tasks: [] } } },
    { kind: 'sequenced', values: { agentTeam: { enabled: false } } }, { kind: 'sequenced', values: { agentTeam: { enabled: true, tasks: [], failure: 3 } } },
    { ...projection(true), kind: 'migration-required' }, { ...projection(true), kind: 'cached' }, { ...projection(true), kind: 'unknown' },
    { values: projection(true).values }]) expect(teamModeOf(value)).toEqual({ kind: 'error' })
  expect(teamModeOf(projection(false))).toEqual({ kind: 'available', enabled: false, failure: undefined })
})

test('the native fixture uses synthetic RPC envelopes without a linked host; its events exercise supported and unsupported states', async () => {
  const app = await open('./fixtures/teamwork/App.tsx')
  await app.press('id:model')
  await app.waitFor('text:Teamwork is off')
  await app.press('id:teamwork')
  await app.waitFor('text:Teamwork is on')
  await app.back()
  await app.host.send('fixture.team', { mode: 'legacy' })
  await app.press('id:model')
  await app.waitFor(`text:${stringsFor('en').team.unsupported}`)
})

for (const tag of ['en', 'ru', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'ko', 'ja', 'de']) {
  test(`Teamwork copy is complete in ${tag}, with English fallback for other languages`, () => {
    const words = stringsFor(tag).team
    expect(Object.keys(words).sort()).toEqual(Object.keys(stringsFor('en').team).sort())
    expect(Object.values(words).every((s) => typeof s === 'string' && s.length > 0)).toBe(true)
    if (tag === 'de') expect(words).toEqual(stringsFor('en').team)
    else if (tag !== 'en') expect(words.title === stringsFor('en').team.title).toBe(false)
  })
}
