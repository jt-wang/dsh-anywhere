// A chat's subagents, as DSH 0.2.1-rc.3 publishes them: the parent's subagentCatalog projection lists the children;
// session/list says which run (dsh-subagent, dsh-client-ui-subagent).
import { expect, open, test } from 'nsh/test'
import { Dsh } from './dsh.ts'
import { addressOf, catalogAdd, catalogOf, children, composerOf, followUp, interruptChild, opens } from './subagents.ts'

test('the catalog lists children with their mode; malformed entries are dropped', () => {
  expect(catalogOf([{ id: 'c1', createdAt: 5, mode: 'continuable', label: 'Review' }, { id: 'c2', createdAt: 9, mode: 'nope' }, { createdAt: 1 }]))
    .toEqual([{ id: 'c1', createdAt: 5, mode: 'continuable', label: 'Review' }, { id: 'c2', createdAt: 9, mode: 'unknown' }])
  expect(catalogOf(null)).toEqual([])
})

test('children run as session/list says; newest first', () => {
  const list = { items: [{ sessionId: 'c1', parentSessionId: 'p', origin: 'subagent', running: true }, { sessionId: 'c2', parentSessionId: 'p', origin: 'subagent', running: false }, { sessionId: 'x', running: true }] }
  const kids = children(catalogOf([{ id: 'c1', createdAt: 5, mode: 'one-shot' }, { id: 'c2', createdAt: 9, mode: 'continuable' }]), list)
  expect(kids.map((k) => [k.id, k.running])).toEqual([['c2', false], ['c1', true]])
})

test('a child row is named by its label, else its own title, else its id', () => {
  const list = { items: [{ sessionId: 'c2', projections: { values: { title: 'Scan the logs' } } }] }
  const kids = children(catalogOf([{ id: 'c1', createdAt: 3, mode: 'continuable', label: 'Review' }, { id: 'c2', createdAt: 2, mode: 'one-shot' }, { id: 'c3', createdAt: 1, mode: 'one-shot' }]), list)
  expect(kids.map((k) => k.name)).toEqual(['Review', 'Scan the logs', 'c3'])
})

test('rc.5 catalog snapshot and v3 discovery retain immutable name separately from the creation label', () => {
  const event = { version: 3, childId: 'c', childCreatedAt: 5, mode: 'continuable', label: 'Review the contract', name: 'reviewer' }
  const snapshot = catalogOf([{ id: 'c', createdAt: 5, mode: event.mode, label: event.label, name: event.name }])
  expect(catalogAdd([], event)).toEqual(snapshot)
  expect(catalogAdd(snapshot, event)).toEqual(snapshot)
  // A catalog record is discovery, not an update/rename instruction. Replay cannot mutate the name.
  expect(catalogAdd(snapshot, { ...event, name: 'other' })).toEqual(snapshot)
  const row = children(snapshot, { items: [{ sessionId: 'c', projections: { values: { title: 'A later title' } } }] })[0]
  expect(row.name).toBe('Review the contract')
  expect(row.agentName).toBe('reviewer')
  expect(children(catalogOf([{ id: 'c', mode: 'external', name: 'inspector' }]), {}).map(c => c.name)).toEqual(['inspector'])
})

test('historical catalogs stay unnamed and unsupported name fields do not fabricate identities', () => {
  expect(catalogAdd([], { version: 1, childId: 'old', childCreatedAt: 1, mode: 'one-shot' })[0].agentName).toBe(undefined)
  for (const entry of [{ mode: 'one-shot', name: 'reviewer' }, { mode: 'unknown', name: 'reviewer' },
    { mode: 'continuable', name: 'lead' }, { mode: 'continuable', name: 'INVALID' }, { mode: 'continuable', name: '' }]) {
    expect(catalogOf([{ id: 'c', ...entry }])[0].agentName).toBe(undefined)
  }
})

test('a child is read through the subagent address; an external task reads as unknown mode', () => {
  expect(addressOf('p', { id: 'c', createdAt: 0, mode: 'continuable' })).toEqual({ kind: 'subagent', parentSessionId: 'p', childSessionId: 'c', mode: 'continuable' })
  expect(addressOf('p', { id: 'c', createdAt: 0, mode: 'external' }).mode).toBe('unknown')
})

test('as on Desktop, only a continuable child takes follow-ups; a one-shot one is a record and an unknown one is read-only', () => {
  expect(composerOf('continuable')).toBe('compose')
  expect(composerOf('one-shot')).toBe('one-shot')
  expect(composerOf('unknown')).toBe('read-only')
  expect(composerOf('external')).toBe('read-only')
})

test('external tasks are listed but do not open', () => {
  expect(opens({ id: 'e', createdAt: 0, mode: 'external' })).toBe(false)
  expect(opens({ id: 'c', createdAt: 0, mode: 'one-shot' })).toBe(true)
})

function transport(version = '0.2.2-rc.1') {
  const state = { version, failRead: false, failWrite: false, reads: 0, writes: [] as { method: string; args: any }[] }
  const client = new Dsh('http://synthetic.invalid/dsh', 'synthetic', { fetch: (async (url: string, init: RequestInit) => {
    if (url.endsWith('/v1/capabilities')) {
      state.reads++
      if (state.failRead) throw new Error('synthetic lost connection')
      return new Response(JSON.stringify({ upstreamVersion: state.version }))
    }
    const frame = JSON.parse(init.body as string)
    state.writes.push({ method: frame.method, args: frame.payload.args })
    if (state.failWrite) throw new Error('synthetic lost acknowledgement')
    return new Response(JSON.stringify({ result: { ok: true, value: frame.method === 'subagents/prompt' ? { messageId: 'accepted-message' } : { accepted: true } } }))
  }) as typeof fetch })
  return { state, client }
}

test('child controls choose the released rc.2 boundary before sending, and re-read when the computer changes', async () => {
  const { state, client } = transport()
  const content = [{ type: 'text', text: 'synthetic follow-up' }]
  for (const [version, modern] of [['0.2.2-rc.1', false], ['0.2.2-rc.2', true], ['0.2.2-rc.3', true], ['0.2.2-rc.4', true], ['0.2.2-rc.5', true], ['0.2.1-rc.3', false]] as const) {
    state.version = version
    expect(await followUp(client, 'parent', 'child', 'request-1', content)).toEqual({ messageId: 'accepted-message' })
    expect(await interruptChild(client, 'parent', 'child')).toEqual({ accepted: true })
    expect(state.writes.slice(-2)).toEqual([
      { method: 'subagents/prompt', args: { request: { requestId: 'request-1', childSessionId: 'child', delivery: 'queue', content,
        ...(!modern ? { parentSessionId: 'parent', mode: 'continuable' } : {}),
      } } },
      modern ? { method: 'subagents/interruptByUser', args: { childSessionId: 'child' } }
        : { method: 'subagents/interruptByParent', args: { childSessionId: 'child', parentSessionId: 'parent', mode: 'continuable' } },
    ])
  }
  expect(state.writes.length).toBe(12)
  expect(state.reads).toBe(12)
})

test('unknown or custom desktop versions never probe a child with a mutation', async () => {
  for (const version of ['', '0.2.2-rc.01', '0.2.2-rc.2-custom', '0.2.2-rc.10', '0.2.3', '0.3.0']) {
    const { state, client } = transport(version)
    for (const run of [() => followUp(client, 'p', 'c', 'r', []), () => interruptChild(client, 'p', 'c')]) {
      let code = ''
      try { await run() } catch (e) { code = (e as any).code }
      expect(code).toBe('client/subagent-controls-unverified')
    }
    expect(state.writes).toEqual([])
  }
})

test('failed capability reads send nothing and uncertain child mutations never retry or fall back', async () => {
  for (const version of ['0.2.2-rc.1', '0.2.2-rc.2']) {
    const { state, client } = transport(version)
    state.failRead = true
    for (const run of [() => followUp(client, 'p', 'c', 'same-id', []), () => interruptChild(client, 'p', 'c')]) {
      let code = ''
      try { await run() } catch (e) { code = (e as any).code }
      expect(code).toBe('network')
    }
    expect(state.writes).toEqual([])
    state.failRead = false; state.failWrite = true
    for (const run of [() => followUp(client, 'p', 'c', 'same-id', []), () => interruptChild(client, 'p', 'c')]) {
      let code = ''
      try { await run() } catch (e) { code = (e as any).code }
      expect(code).toBe('network')
    }
    expect(state.writes.length).toBe(2)
    expect(state.writes[0]!.args.request.requestId).toBe('same-id')
    expect(state.writes[1]!.method).toBe(version.endsWith('.1') ? 'subagents/interruptByParent' : 'subagents/interruptByUser')
  }
})

test('the child composer and stop control use the selected protocol; an interrupt acknowledgement is not a stopped turn', async () => {
  const app = await open('./fixtures/subagents/App.tsx', { locale: 'en-US', host: { handlers: { haptic: null } } })
  await app.waitFor('id:stop')
  await app.press('id:stop')
  await app.waitUntil(() => app.texts().includes('subagents/interruptByUser'))
  expect(app.shows('id:stop')).toBe(true)
  await app.type('id:composer', 'Synthetic follow-up')
  await app.press('id:send')
  await app.waitUntil(() => app.texts().includes('subagents/prompt'))
  expect(app.texts()).toContain('2')
  await app.host.send('fixture.version', { version: '0.2.2-rc.1' })
  await app.press('id:stop')
  await app.waitUntil(() => app.texts().includes('subagents/interruptByParent'))
  expect(app.shows('id:stop')).toBe(true)
  await app.host.send('fixture.version', { version: 'custom' })
  await app.press('id:stop')
  await app.waitFor('text:Subagent controls are unavailable for this DSH version. Update DSH Anywhere.')
  expect(app.texts()).toContain('3')
  expect(app.shows('id:composer')).toBe(true)
})
