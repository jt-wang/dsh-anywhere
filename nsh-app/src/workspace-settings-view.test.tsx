import { expect, open, test } from 'nsh/test'
import { Storage } from 'nsh'
import { loadPrefs, moveLocalSession, prefsOf, rememberWorkspaceOrders, setWorkspaceView, workspaceView } from './prefs.ts'
import { DEFAULT_WORKSPACE_VIEW, FLAT_ORDER, localSessionOrder, workspaceParent, workspaceViewOf, workspaceViewRows } from './workspace-settings-view.ts'
import { workspaceViewStrings } from './workspace-settings-view-strings.ts'
import { Workspaces } from './workspaces.ts'

const chat = (sessionId: string, updatedAt = 1) => ({ sessionId, title: sessionId, updatedAt, running: false })
test('phone view values validate independently, preserve old prefs, persist and restore all view choices without DSH', async () => {
  expect(workspaceViewOf({ groupBy: 'made-up', orderBy: 'oldest', archivedFilter: 'all' })).toEqual(DEFAULT_WORKSPACE_VIEW)
  expect(prefsOf(null).workspaceView).toEqual(DEFAULT_WORKSPACE_VIEW)
  rememberWorkspaceOrders({ w: ['b', 'a'], [FLAT_ORDER]: ['b', 'a'] })
  setWorkspaceView({ groupBy: 'workspace-tree', orderBy: 'manual', archivedFilter: 'show', groupExpansion: { w: false } })
  moveLocalSession('w', 'a', 'b')
  await new Promise(resolve => setTimeout(resolve, 20))
  const saved = prefsOf(await Storage.getItem('prefs'))
  expect(saved.workspaceView.sessionOrderByAccount.w).toEqual(['a', 'b'])
  expect(saved.workspaceView.groupBy).toBe('workspace-tree'); expect(saved.workspaceView.orderBy).toBe('manual'); expect(saved.workspaceView.archivedFilter).toBe('show')
  await loadPrefs(); expect(workspaceView()).toEqual(saved.workspaceView)
  setWorkspaceView({ orderBy: 'updated' }); expect(workspaceView().sessionOrderByAccount).toEqual({})
  await Storage.removeItem('prefs'); await loadPrefs()
})

test('rc.5 recency ties, manual saved slots, unseen pins and archives reconcile without changing host order', () => {
  const chats = [chat('b', 4), chat('a', 4), chat('pin', 1), chat('archive', 9), chat('new', 8)]
  expect(localSessionOrder(['b', 'a', 'unknown'], chats)).toEqual(['a', 'b'])
  expect(localSessionOrder(['b', 'a', 'pin', 'archive', 'new'], chats, ['b', 'b', 'gone'], { pinned: ['pin'], archived: new Set(['archive']) })).toEqual(['pin', 'b', 'new', 'a', 'archive'])
})

test('workspace/tree/flat grouping uses nearest real ancestors, child rows before parent sessions, local expansion and archive visibility', () => {
  const registry = new Workspaces()
  registry.apply({ type: 'baseline', value: { items: [
    { workspaceId: 'child', path: '/r/child', title: 'Child', sessionIds: ['child-chat'] },
    { workspaceId: 'root', path: '/r', title: 'Root', sessionIds: ['old', 'new', 'archive'] },
    { workspaceId: 'empty', path: '/empty', title: 'Empty', sessionIds: [] },
  ], archivedSessionIds: ['archive'], pinnedSessionIds: ['old'] } })
  const chats = [chat('old', 1), chat('new', 9), chat('child-chat', 3), chat('archive', 11), chat('loose', 2)]
  const ids = (change: any) => workspaceViewRows(registry, chats, { ...DEFAULT_WORKSPACE_VIEW, ...change }).map(r => r.id)
  expect(ids({})).toEqual(['h:child', 'child-chat', 'h:root', 'old', 'new', 'h:empty', 'h:', 'loose'])
  expect(ids({ groupBy: 'workspace-tree' })).toEqual(['h:root', 'h:child', 'child-chat', 'old', 'new', 'h:empty', 'h:', 'loose'])
  expect(ids({ groupBy: 'workspace-tree', groupExpansion: { root: false } })).toEqual(['h:root', 'h:empty', 'h:', 'loose'])
  expect(ids({ groupBy: 'flat', archivedFilter: 'show' })).toEqual(['old', 'archive', 'new', 'child-chat', 'loose'])
  expect(ids({ groupBy: 'workspace-tree', archivedFilter: 'only' })).toEqual(['h:root', 'archive'])
  expect(ids({ groupBy: 'flat', orderBy: 'manual', sessionOrderByAccount: { [FLAT_ORDER]: ['loose', 'new', 'old', 'archive', 'child-chat'] }, archivedFilter: 'show' })).toEqual(['old', 'loose', 'new', 'archive', 'child-chat'])
  expect(registry.list()[1].sessionIds).toEqual(['old', 'new', 'archive'])
  expect(workspaceParent('C:\\work\\child', ['C:\\', 'C:\\work', 'C:\\worker'])).toBe('C:\\work')
  expect(workspaceParent('/workshop/child', ['/work'])).toBe(undefined)
  expect(workspaceParent('/Work/child', ['/work'])).toBe(undefined)
})

test('every phone-local choice and explicit scope is localized in eight languages, unknown language reads English', () => {
  for (const tag of ['en', 'zh', 'zh-Hant', 'es', 'fr', 'ko', 'ja', 'ru']) {
    expect(Object.values(workspaceViewStrings(tag)).every(v => typeof v === 'string' && v.length > 0)).toBe(true)
    if (tag !== 'en') expect(workspaceViewStrings(tag).scope === workspaceViewStrings('en').scope).toBe(false)
  }
  expect(workspaceViewStrings('de')).toEqual(workspaceViewStrings('en'))
})

test('native phone grouping/filter/manual controls change real SessionsScreen and survive cold start without remote writes', async () => {
  const app = await open('./workspace-settings-view-fixture.tsx', { locale: 'en-US' })
  await app.waitFor('text:Chat old'); await app.waitFor('text:Root workspace')
  await app.press('id:workspace-view-group-flat')
  await app.waitUntil(() => !app.texts().includes('Root workspace'))
  // Virtual List cells are absolutely positioned; texts() traverses insertion order, not their y positions.
  // Exact render ordering is covered by workspaceViewRows above and the rc.5 differential check.
  await app.waitFor('text:Chat pin'); await app.waitFor('text:Chat new')
  await app.press('id:workspace-view-filter-only'); await app.waitFor('text:Chat archive')
  expect(app.texts().includes('Chat new')).toBe(false)
  await app.type('id:search', 'new'); expect(app.texts().includes('Chat new')).toBe(false)
  await app.clear('id:search')
  await app.press('id:workspace-view-filter-default'); await app.waitFor('text:Chat new')
  await app.press('id:workspace-view-order-manual'); await app.waitFor('id:local-chat-up-old')
  await app.press('id:local-chat-up-old')
  await app.waitUntil(() => {
    const order = prefsOf(app.storage().prefs ?? null).workspaceView.sessionOrderByAccount[FLAT_ORDER] ?? []
    return order.includes('old') && order.includes('loose') && order.indexOf('old') < order.indexOf('loose')
  })
  await app.press('id:workspace-view-group-workspace-tree'); await app.waitFor('text:Root workspace')
  await app.waitFor('text:Child workspace')
  await app.press('id:workspace-group-h:root')
  await app.waitUntil(() => !app.texts().includes('Child workspace'))
  await app.waitUntil(() => JSON.stringify(app.storage()).includes('workspace-tree'))
  const cold = await open('./workspace-settings-view-fixture.tsx', { locale: 'en-US', storage: app.storage() })
  await cold.waitFor('text:Root workspace'); expect(cold.texts().includes('Child workspace')).toBe(false)
  await cold.press('id:workspace-group-h:root'); await cold.waitFor('text:Child workspace')
  expect(JSON.stringify(cold.storage())).toContain('workspace-tree')
  expect(app.texts().find(t => t.includes('session/list'))?.includes('workspace/')).toBe(false)
})

test('cold offline cached subset never prunes manual slots for chats not cached on this phone', async () => {
  const view = { ...DEFAULT_WORKSPACE_VIEW, groupBy: 'flat', orderBy: 'manual', sessionOrderByAccount: { [FLAT_ORDER]: ['loose', 'old', 'new'], root: ['new', 'old', 'archive', 'pin'] } }
  const app = await open('./workspace-settings-view-fixture.tsx', { storage: { prefs: JSON.stringify({ workspaceView: view }), 'workspace-view-fixture-offline': 'true' } })
  await app.waitFor('text:Chat old')
  await app.waitFor('id:local-chat-up-old')
  expect(app.texts().includes('Chat new')).toBe(false)
  expect(prefsOf(app.storage().prefs ?? null).workspaceView.sessionOrderByAccount).toEqual(view.sessionOrderByAccount)
})
