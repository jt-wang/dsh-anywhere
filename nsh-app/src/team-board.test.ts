import { expect, open, test } from 'nsh/test'
import { teamBoardOf, teamBoardOffline, teamCounts } from './team-board.ts'
import { fixtureProjection, fixtureTasks } from './team-board-fixture.ts'
import { teamStringsFor } from './team-board-strings.ts'
import { shows, activeOf } from './activity.ts'

test('agentTeam tasks retain source order, readiness, revision, immutable owner path and warnings', () => {
  const b = teamBoardOf(fixtureProjection())
  expect(b.kind).toBe('ready')
  if (b.kind !== 'ready') return
  expect(b.tasks).toEqual(fixtureTasks)
  expect(b.members.map(m => m.agentName)).toEqual(['reviewer', 'builder', 'inspector'])
  expect(teamCounts(b.tasks)).toEqual({ pending: 2, active: 1, completed: 1 })
  expect(b.tasks[2].ready).toBe(false)
  expect(b.tasks[3].ready).toBe(true)
})

test('missing capability differs from disabled and empty, without probing a mutation', () => {
  expect(teamBoardOf(fixtureProjection('old'))).toEqual({ kind: 'unavailable' })
  for (const input of [undefined, null, {}, { values: {} }]) expect(teamBoardOf(input)).toEqual({ kind: 'unavailable' })
  const disabled = teamBoardOf(fixtureProjection('disabled')), empty = teamBoardOf(fixtureProjection('empty'))
  expect(disabled.kind === 'ready' && disabled.enabled).toBe(false)
  expect(disabled.kind === 'ready' && disabled.tasks.length).toBe(4)
  expect(empty.kind === 'ready' && empty.tasks.length).toBe(0)
})

test('members come from subagentCatalog, never legacy agentTeam.members', () => {
  const b = teamBoardOf({ values: { agentTeam: { enabled: true, tasks: [], members: [{ id: 'fake' }] } } })
  expect(b.kind === 'ready' && b.members).toEqual([])
})

test('malformed projections fail as a whole rather than hiding a rejected task as an empty board', () => {
  for (const task of [{ ...fixtureTasks[0], revision: 0 }, { ...fixtureTasks[0], status: 'failed' }, { ...fixtureTasks[0], ready: 1 }, { ...fixtureTasks[0], blockedBy: [1] }, { ...fixtureTasks[0], writeScopeWarnings: null }]) {
    expect(teamBoardOf({ values: { agentTeam: { enabled: true, tasks: [fixtureTasks[1], task] } } })).toEqual({ kind: 'error' })
  }
  for (const agentTeam of [null, {}, { enabled: true }, { enabled: 'true', tasks: [] }, { enabled: true, tasks: [], failure: {} }, { enabled: true, tasks: [fixtureTasks[0], fixtureTasks[0]] }]) {
    expect(teamBoardOf({ values: { agentTeam } })).toEqual({ kind: 'error' })
  }
})

test('deleted tasks are not rendered and failure retains the official last valid tasks', () => {
  const b = teamBoardOf({ values: { agentTeam: { enabled: true, tasks: [...fixtureTasks, { ...fixtureTasks[0], id: 'deleted', status: 'deleted' }], failure: 'Rejected revision' } } })
  expect(b.kind === 'ready' && b.tasks).toEqual(fixtureTasks)
  expect(b.kind === 'ready' && b.failure).toBe('Rejected revision')
})

test('offline retains last received board with an explicit stale marker; fresh read clears it', () => {
  const b = teamBoardOf(fixtureProjection())
  expect(teamBoardOffline(b)).toEqual({ ...b, stale: true })
  expect(teamBoardOffline({ kind: 'loading' })).toEqual({ kind: 'error' })
  expect(teamBoardOf(fixtureProjection())).toEqual(b)
})

test('team-only activity remains reachable without double-counting tasks as another Progress', () => {
  const base = { todos: [], jobs: [], children: [] }
  expect(shows({ ...base, team: teamBoardOf(fixtureProjection()) })).toBe(true)
  expect(activeOf({ ...base, team: teamBoardOf(fixtureProjection()) }).total).toBe(0)
  expect(shows({ ...base, team: { kind: 'unavailable' } })).toBe(false)
  expect(shows({ ...base, team: { kind: 'error' } })).toBe(true)
})

test('eight feature dictionaries cover every key, Traditional regions and English fallback', () => {
  const en = teamStringsFor('en-US')
  for (const tag of ['zh-CN', 'zh-TW', 'en', 'es', 'fr', 'ko', 'ja', 'ru']) {
    const words = teamStringsFor(tag)
    expect(Object.keys(words)).toEqual(Object.keys(en))
    expect(Object.values(words).every(v => typeof v === 'string' && v.length > 0)).toBe(true)
  }
  expect(teamStringsFor('zh-HK')).toEqual(teamStringsFor('zh-Hant'))
  expect(teamStringsFor('de-DE')).toEqual(en)
})

const fixture = () => open('./fixtures/team-board/App.tsx', { locale: 'en-US', host: { handlers: { haptic: null } } })

test('team board expands source tasks, shows blocked and ready states and the immutable owner path', async () => {
  const app = await fixture()
  await app.waitFor('id:team-task-build')
  expect(app.texts()).toContain('Pending · Blocked')
  expect(app.texts()).toContain('Pending · Ready')
  expect(app.texts()).toContain('Pending: 2 · In progress: 1 · Completed: 1')
  await app.press('id:team-task-build')
  await app.waitFor('id:team-task-details-build')
  expect(app.texts()).toContain('Owner: builder')
  expect(app.texts()).toContain('Dependencies: plan')
  expect(app.texts()).toContain('Write scope warnings: Synthetic overlapping write scope')
  await app.press('id:team-task-build')
  await app.waitUntil(() => !app.shows('id:team-task-details-build'))
})

test('projection refresh distinguishes failure, offline, disabled, empty and an old host', async () => {
  const app = await fixture()
  await app.waitFor('id:team-task-build')
  await app.press('id:fixture-failure')
  await app.waitFor('id:team-board-failure')
  expect(app.shows('id:team-task-build')).toBe(true)
  await app.press('id:fixture-offline')
  await app.waitFor('id:team-board-stale')
  expect(app.shows('id:team-task-build')).toBe(true)
  await app.press('id:fixture-disabled')
  await app.waitFor('text:Teamwork off')
  expect(app.shows('id:team-board-stale')).toBe(false)
  expect(app.shows('id:team-task-build')).toBe(true)
  await app.press('id:fixture-network-offline')
  await app.waitFor('id:team-board-stale')
  expect(app.shows('id:team-task-build')).toBe(true)
  await app.press('id:fixture-empty')
  await app.waitFor('id:team-board-empty')
  await app.press('id:fixture-old')
  await app.waitFor('text:This host does not provide the team board.')
  expect(app.shows('id:team-task-build')).toBe(false)
})

test('member navigation uses catalog identity and external members remain read-only', async () => {
  const app = await fixture()
  await app.waitFor('id:team-member-child-build')
  await app.press('id:team-member-child-build')
  await app.waitFor('text:child child-build')
  let rejected = false
  try { await app.press('id:team-member-external') } catch (e) { rejected = String(e).includes('no pressable view') }
  expect(rejected).toBe(true)
  expect(app.texts()).toContain('child child-build')
  expect(app.texts()).not.toContain('child external')
})

test('subagent sheet shows the catalog name alongside its descriptive label', async () => {
  const app = await fixture()
  await app.press('id:fixture-subagents')
  await app.waitFor('id:subagents-sheet')
  await app.waitFor('id:subagent-name-child-build')
  expect(app.texts()).toContain('Native implementation')
  expect(app.texts()).toContain('builder')
  await app.press('id:subagent-child-build')
  await app.waitFor('text:child child-build')
})

test('feature language updates in place without rewriting shared strings', async () => {
  const app = await fixture()
  await app.waitFor('text:Team tasks')
  for (const [locale, title] of [['zh', '团队任务'], ['zh-Hant', '團隊任務'], ['ja', 'チームタスク'], ['en', 'Team tasks']]) {
    await app.press(`id:locale-${locale}`)
    await app.waitFor(`text:${title}`)
  }
})

test('the existing activity panel contains the same team board and member navigation', async () => {
  const app = await fixture()
  await app.waitFor('id:team-task-build')
  await app.press('id:activity')
  await app.waitFor('id:activity-panel')
  expect(app.count('id:team-board')).toBe(2)
  await app.press('id:activity-pin')
  await app.waitFor('id:activity-dock')
  expect(app.count('id:team-board')).toBe(2)
})
