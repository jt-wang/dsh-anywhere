import { expect, open, test } from 'nsh/test'
import { DshError, type Dsh } from './dsh.ts'
import { WorkspaceSettingsModel } from './workspace-settings.ts'
import { workspaceSettingsStrings } from './workspace-settings-strings.ts'

function harness() {
  let items = [
    { workspaceId: 'a', title: 'Alpha', path: '/synthetic/a', sessionIds: ['s1', 's2', 's3'] },
    { workspaceId: 'b', title: 'Beta', path: '/synthetic/b', sessionIds: [] as string[] },
  ]
  const calls: { method: string; args: any }[] = []
  let lost = false, refused = false, offline = false, accept = true, reads = 0, stopped = 0
  let publish: (frame: unknown) => void = () => {}
  const client = {
    async rpc(method: string, args: any) {
      calls.push({ method, args })
      if (refused) throw new DshError('workspace/name-conflict', 'Synthetic conflict')
      if (offline) throw new DshError('network', 'Synthetic offline')
      const r = args.request, row = items.find(w => w.workspaceId === r.workspaceId)!
      if (accept) {
        if (method === 'workspace/rename') row.title = r.title
        if (method === 'workspace/delete') items = items.filter(w => w !== row)
        if (method === 'workspace/insertBefore') { items = items.filter(w => w !== row); items.splice(r.beforeWorkspaceId ? items.findIndex(w => w.workspaceId === r.beforeWorkspaceId) : items.length, 0, row) }
        if (method === 'workspace/insertSessionBefore') { row.sessionIds = row.sessionIds.filter(id => id !== r.sessionId); row.sessionIds.splice(r.beforeSessionId ? row.sessionIds.indexOf(r.beforeSessionId) : row.sessionIds.length, 0, r.sessionId) }
      }
      if (lost) throw new DshError('network', 'Synthetic lost acknowledgement')
      return null
    },
    stream(method: string, args: unknown, item: (frame: unknown) => void, error: (err: DshError) => void) {
      expect(method).toBe('workspace/follow'); expect(args).toEqual({}); reads++
      publish = item
      if (offline) error(new DshError('network', 'Synthetic offline'))
      else item({ type: 'baseline', value: JSON.parse(JSON.stringify({ items, archivedSessionIds: ['archived'], pinnedSessionIds: ['s2'] })) })
      return () => { stopped++ }
    },
  } as unknown as Pick<Dsh, 'rpc' | 'stream'>
  const model = new WorkspaceSettingsModel(() => client)
  return { model, calls, get reads() { return reads }, get stopped() { return stopped },
    lost: () => { lost = true }, refuse: () => { refused = true }, offline: () => { offline = true }, ignore: () => { accept = false },
    emit: (frame: unknown) => publish(frame),
  }
}

test('workspace editor sends exact official rename/remove/order requests, confirms fresh baselines and follows external changes', async () => {
  const h = harness(); await h.model.refresh()
  await h.model.edit({ kind: 'rename', workspaceId: 'a', title: '  Renamed  ' })
  expect(h.model.registry.list()[0].title).toBe('Renamed'); expect(h.model.outcome).toBe('confirmed')
  await h.model.edit({ kind: 'workspace-order', workspaceId: 'b', beforeWorkspaceId: 'a' })
  expect(h.model.registry.list().map(w => w.workspaceId)).toEqual(['b', 'a'])
  await h.model.edit({ kind: 'session-order', workspaceId: 'a', sessionId: 's1' })
  expect(h.model.registry.list()[1].sessionIds).toEqual(['s2', 's3', 's1'])
  await h.model.edit({ kind: 'session-order', workspaceId: 'a', sessionId: 's1', beforeSessionId: 's2' })
  await h.model.edit({ kind: 'remove', workspaceId: 'b' })
  expect(h.model.registry.list().map(w => w.workspaceId)).toEqual(['a'])
  expect(h.calls).toEqual([
    { method: 'workspace/rename', args: { request: { workspaceId: 'a', title: 'Renamed' } } },
    { method: 'workspace/insertBefore', args: { request: { workspaceId: 'b', beforeWorkspaceId: 'a' } } },
    { method: 'workspace/insertSessionBefore', args: { request: { workspaceId: 'a', sessionId: 's1' } } },
    { method: 'workspace/insertSessionBefore', args: { request: { workspaceId: 'a', sessionId: 's1', beforeSessionId: 's2' } } },
    { method: 'workspace/delete', args: { request: { workspaceId: 'b' } } },
  ])
  expect(h.reads).toBe(6); expect(h.stopped).toBe(5)
  expect([...h.model.registry.archived]).toEqual(['archived']); expect(h.model.registry.pinned).toEqual(['s2'])
  h.emit({ type: 'order', workspaceIds: ['a'] })
  h.emit({ type: 'upsert', workspace: { workspaceId: 'a', path: '/synthetic/a', title: 'Edited on desktop', sessionIds: ['s3'] } })
  expect(h.model.registry.list()[0].title).toBe('Edited on desktop')
  h.model.dispose(); expect(h.stopped).toBe(6)
})

test('lost acknowledgements never replay writes, refusals remain refusals, and mismatched success is not confirmation', async () => {
  for (const scenario of ['lost', 'refused', 'ignored', 'offline']) {
    const h = harness(); await h.model.refresh()
    if (scenario === 'lost') h.lost()
    if (scenario === 'refused') h.refuse()
    if (scenario === 'ignored') h.ignore()
    if (scenario === 'offline') h.offline()
    await h.model.edit({ kind: 'rename', workspaceId: 'a', title: 'New' })
    expect(h.calls.length).toBe(1); expect(h.reads).toBe(2)
    expect(h.model.outcome).toBe(scenario === 'lost' ? 'confirmed' : scenario === 'refused' ? 'rejected' : 'uncertain')
    if (scenario === 'offline') { expect(h.model.status).toBe('offline'); await h.model.edit({ kind: 'remove', workspaceId: 'a' }); expect(h.calls.length).toBe(1) }
    h.model.dispose()
  }
})

test('invalid moves do not invent cross-directory membership or write; pause/reopen discards stale generations', async () => {
  const h = harness(); await h.model.refresh()
  await h.model.edit({ kind: 'session-order', workspaceId: 'b', sessionId: 's1' })
  await h.model.edit({ kind: 'session-order', workspaceId: 'a', sessionId: 's1', beforeSessionId: 'absent' })
  await h.model.edit({ kind: 'workspace-order', workspaceId: 'a', beforeWorkspaceId: 'absent' })
  await h.model.edit({ kind: 'rename', workspaceId: 'a', title: ' ' })
  expect(h.calls.length).toBe(0)
  h.model.pause(); h.emit({ type: 'remove', workspaceId: 'a' })
  expect(h.model.registry.list().length).toBe(2)
  expect(await h.model.refresh()).toBe(true); expect(h.model.status).toBe('ready'); h.model.dispose()
})

test('opening needs a baseline, times out safely, and a second concurrent edit cannot send another write', async () => {
  let item: (v: unknown) => void = () => {}, release: () => void = () => {}, writes = 0
  const client = {
    stream(_method: string, _args: unknown, next: (v: unknown) => void) { item = next; return () => {} },
    async rpc() { writes++; await new Promise<void>(resolve => { release = resolve }) },
  } as unknown as Pick<Dsh, 'rpc' | 'stream'>
  const model = new WorkspaceSettingsModel(() => client, () => {}, 5)
  const loading = model.refresh()
  item({ type: 'upsert', workspace: { workspaceId: 'a', path: '/synthetic/a', title: 'Not a baseline', sessionIds: [] } })
  expect(model.status).toBe('loading'); expect(await loading).toBe(false); expect(model.status).toBe('offline')
  const ready = model.refresh()
  const baseline = { type: 'baseline', value: { items: [{ workspaceId: 'a', title: 'Alpha', path: '/synthetic/a', sessionIds: [] }], pinnedSessionIds: [], archivedSessionIds: [] } }
  item(baseline); await ready
  const first = model.edit({ kind: 'rename', workspaceId: 'a', title: 'New' })
  await model.edit({ kind: 'remove', workspaceId: 'a' }); expect(writes).toBe(1)
  release(); await first
  expect(model.outcome).toBe('uncertain'); expect(model.busy).toBe(false); model.dispose()
})

test('workspace words cover eight languages with English fallback and Traditional Chinese regions', () => {
  for (const tag of ['zh', 'zh-Hant', 'es', 'fr', 'ko', 'ja', 'ru']) {
    const words = workspaceSettingsStrings(tag)
    expect(words.title === workspaceSettingsStrings('en').title).toBe(false)
    for (const key of ['desktopView', 'phoneView', 'registryOrder'] as const) expect(words[key] === workspaceSettingsStrings('en')[key]).toBe(false)
    expect(Object.values(words).every(v => v.length > 0)).toBe(true)
  }
  expect(workspaceSettingsStrings('zh-TW')).toEqual(workspaceSettingsStrings('zh-Hant'))
  expect(workspaceSettingsStrings('zh-Hant-TW')).toEqual(workspaceSettingsStrings('zh-Hant'))
  expect(workspaceSettingsStrings('de')).toEqual(workspaceSettingsStrings('en'))
})

test('native workspace UI distinguishes phone-local view preferences and remote registry order in all eight languages', async () => {
  const app = await open('./workspace-settings-fixture.tsx', { locale: 'en-US' })
  await app.waitFor(`text:${workspaceSettingsStrings('en').desktopView}`)
  await app.waitFor(`text:${workspaceSettingsStrings('en').phoneView}`)
  await app.press('id:workspace-settings-open'); await app.waitFor('id:workspace-row-alpha')
  for (const tag of ['en', 'zh', 'zh-Hant', 'es', 'fr', 'ko', 'ja', 'ru']) {
    await app.press(`id:fixture-${tag}`)
    for (const key of ['desktopView', 'phoneView', 'registryOrder'] as const) await app.waitFor(`text:${workspaceSettingsStrings(tag)[key]}`)
  }
})

test('native workspace component renames, reorders chats and workspaces, confirms registry-only removal, and reopens', async () => {
  const app = await open('./workspace-settings-fixture.tsx', { locale: 'en-US' })
  await app.press('id:workspace-settings-open'); await app.waitFor('id:workspace-row-alpha')
  await app.clear('id:workspace-name-alpha'); await app.type('id:workspace-name-alpha', 'Renamed')
  await app.press('id:workspace-rename-alpha'); await app.waitFor('text:Renamed')
  await app.waitFor('text:Current state confirmed by the computer.')
  await app.press('id:workspace-up-beta'); await app.waitFor('text:workspace/insertBefore')
  await app.press('id:workspace-sessions-alpha'); await app.waitFor('text:First chat')
  await app.press('id:workspace-chat-end-chat-a'); await app.waitFor('text:workspace/insertSessionBefore')
  await app.press('id:workspace-remove-beta'); await app.waitFor('text:Remove this workspace registration from DSH? Its directory, files and chats are NOT deleted.')
  await app.press('id:workspace-cancel-beta'); expect(app.texts().includes('Beta')).toBe(true)
  await app.press('id:workspace-remove-beta'); await app.press('id:workspace-confirm-beta')
  await app.waitFor('text:workspace/delete')
  await app.waitFor('text:Current state confirmed by the computer.')
  expect(app.texts().includes('Beta')).toBe(false)
  await app.press('id:workspace-settings-close'); await app.press('id:workspace-settings-open'); await app.waitFor('id:workspace-row-alpha')
})

test('native workspace component displays uncertain delivery and offline retained rows without replay', async () => {
  const app = await open('./workspace-settings-fixture.tsx', { locale: 'en-US' })
  await app.press('id:workspace-settings-open'); await app.waitFor('id:workspace-row-alpha')
  await app.press('id:fixture-lost-readback')
  await app.clear('id:workspace-name-alpha'); await app.type('id:workspace-name-alpha', 'Changed')
  await app.press('id:workspace-rename-alpha')
  await app.waitFor(`text:${workspaceSettingsStrings('en').uncertain}`)
  await app.waitFor('id:workspace-offline'); expect(app.texts().includes('Alpha')).toBe(true)
  await app.press('id:fixture-normal'); await app.press('id:workspace-settings-open'); await app.waitFor('text:Changed')
})
