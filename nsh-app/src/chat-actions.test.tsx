// A chat's actions outside the chat, as DSH Desktop's sidebar has them. Forking (session/fork): the reply puts the
// new chat into the list's one copy (src/chat-store.ts) at once. Pinning (workspace/pinSession, workspace/unpinSession): the reply's pin set
// is the one copy the list, the row's mark and the chat's ⋯ menu read (src/chat-store.ts), and a pin made in DSH
// Desktop arrives as a `pinned` frame on workspace/follow. The fixture never pushes a frame after the phone's own pin,
// so only the reply can change the list. Headless; every chat is made up.
import { expect, open, test, type StubRequest, type StubResponse } from 'nsh/test'

const ORIGIN = 'http://127.0.0.1:40001/dsh'
const paired = { paired: true, origin: ORIGIN, token: 'synthetic-device-token' }
const ok = (value: unknown) => ({ body: { type: 'server-response', rpcId: 'x', result: { ok: true, value } } })
const fail = (code: string) => ({ body: { type: 'server-response', rpcId: 'x', result: { ok: false, error: { code, message: code } } } })
const chat = (sessionId: string, title: string, updatedAt: number) => ({ sessionId, updatedAt, running: false, blank: false, cwd: '/synthetic/acme-api', projections: { asOfSeq: 1, values: { title } } })
const LIST = ok({ items: [chat('s1', 'Move billing to the v2 API', 3_000), chat('s2', 'Backfill old invoices', 2_000), chat('s3', 'Nightly backup check', 1_000)] })
const TITLES = ['Move billing to the v2 API', 'Backfill old invoices', 'Nightly backup check']
// The headless List gives its cells' texts last row first (the workspace header comes last), so the order reads backwards.
const order = (texts: string[]) => TITLES.filter((t) => texts.includes(t)).sort((a, b) => texts.lastIndexOf(b) - texts.lastIndexOf(a))

async function app(pin: (method: string, args: any) => StubResponse, computer: Record<string, any> = {}, hostHandlers: Record<string, unknown> = {}) {
  const asked: { method: string; sessionId: string }[] = []
  const a = await open('./fixtures/pins/App.tsx', {
    host: { handlers: { 'link.state': paired, ...hostHandlers } },
    network: {
      [`POST ${ORIGIN}/api/session/list`]: LIST,
      ...computer,
      [`POST ${ORIGIN}/api/workspace/pinSession`]: (req) => { const args = JSON.parse(req.body!).payload.args; asked.push({ method: 'pin', sessionId: args.request.sessionId }); return pin('pin', args) },
      [`POST ${ORIGIN}/api/workspace/unpinSession`]: (req) => { const args = JSON.parse(req.body!).payload.args; asked.push({ method: 'unpin', sessionId: args.request.sessionId }); return pin('unpin', args) },
    },
  })
  await a.waitFor('text:Nightly backup check')
  return { app: a, asked }
}

test('sidebar replacement preserves draft attachments and failed outbox messages without resending them', async () => {
  const { app: a } = await app(() => ok({}), { [`POST ${ORIGIN}/api/session/prompt`]: fail('unavailable') }, {
    'files.pick': { receiptId: 'reference-file', file: { name: 'reference.txt', bytes: 8 } },
  })
  await a.setViewport(1120, 800)
  const select = async (title: string) => { await a.press(`id:wide-sidebar >> text:${title}`); await a.waitFor('id:composer') }
  await select(TITLES[0]!)
  await a.type('id:composer', 'Keep my caption')
  await a.press('id:attach'); await a.press('id:action-file'); await a.waitFor('id:draft-reference-file')
  await select(TITLES[1]!); expect(a.shows('id:draft-reference-file')).toBe(false)
  await select(TITLES[0]!)
  expect(a.value('id:composer')).toBe('Keep my caption'); expect(a.shows('id:draft-reference-file')).toBe(true)
  await a.press('id:send'); await a.waitFor('text:Not sent. Tap to try again')
  const prompts = () => a.requests().filter((r) => r.url.endsWith('/api/session/prompt')).length
  expect(prompts()).toBe(1)
  await a.type('id:composer', 'Another unfinished draft')
  await select(TITLES[1]!); await select(TITLES[0]!)
  expect(a.shows('text:Not sent. Tap to try again')).toBe(true); expect(a.value('id:composer')).toBe('Another unfinished draft')
  expect(prompts()).toBe(1)
  await a.press('id:discard-outgoing')
  expect(a.shows('id:outgoing-failed')).toBe(false); expect(prompts()).toBe(1)
  expect(a.value('id:composer')).toBe('Another unfinished draft')
})

test('a list rename retains its edited input across phone and sidebar layouts', async () => {
  const { app: a } = await app(() => ok({}))
  await a.longPress('text:Nightly backup check'); await a.press('id:action-rename'); await a.waitFor('id:rename')
  await a.clear('id:rename'); await a.type('id:rename', 'Unfinished rename')
  await a.setViewport(1120, 800)
  expect(a.value('id:rename')).toBe('Unfinished rename'); expect(a.count('id:sessions')).toBe(1)
  await a.setViewport(390, 844)
  expect(a.value('id:rename')).toBe('Unfinished rename')
})

test('replacing the Tailcat transport keeps unsent attachments for the same paired identity', async () => {
  let only = false, states = 0
  const { app: a } = await app(() => ok({}), {}, {
    'link.state': () => { states++; return { ...paired, cacheId: 'reference-paired-identity' } },
    'link.tailcatOnly': (data?: { on?: boolean }) => { if (typeof data?.on === 'boolean') only = data.on; return { on: only } },
    'files.pick': { receiptId: 'transport-file', file: { name: 'transport-reference.txt', bytes: 8 } },
  })
  await a.setViewport(1120, 800)
  await a.press(`id:wide-sidebar >> text:${TITLES[0]}`); await a.waitFor('id:composer')
  await a.type('id:composer', 'Same paired computer')
  await a.press('id:attach'); await a.press('id:action-file'); await a.waitFor('id:draft-transport-file')
  await a.press('id:more'); await a.press('id:menu-settings'); await a.waitFor('id:tailcat-only')
  const before = states
  await a.press('id:tailcat-only')
  await a.waitUntil(() => only && states > before)
  await a.back()
  await a.press(`id:wide-sidebar >> text:${TITLES[1]}`); await a.waitFor('id:composer')
  expect(a.shows('id:draft-transport-file')).toBe(false)
  await a.press(`id:wide-sidebar >> text:${TITLES[0]}`); await a.waitFor('id:composer')
  expect(a.value('id:composer')).toBe('Same paired computer'); expect(a.shows('id:draft-transport-file')).toBe(true)
})

test('a typed new-workspace path survives unfolding and folding without restarting the picker', async () => {
  const { app: a } = await app(() => ok({}))
  await a.press('id:new-chat'); await a.press('id:add-workspace'); await a.waitFor('id:folder-search')
  await a.type('id:folder-search', '~/unfinished-project')
  await a.setViewport(1120, 800)
  expect(a.value('id:folder-search')).toBe('~/unfinished-project'); expect(a.count('id:sessions')).toBe(1)
  await a.setViewport(390, 844)
  expect(a.value('id:folder-search')).toBe('~/unfinished-project')
})

test('Pin in a chat\'s ⋯ menu pins it on the computer; the reply alone moves it to the top, marks it and turns the menu to Unpin', async () => {
  const { app: a, asked } = await app((m) => ok({ pinnedSessionIds: m === 'pin' ? ['s3'] : [] }))
  expect(order(a.texts())).toEqual(TITLES)
  expect(a.shows('id:row-pinned')).toBe(false)
  await a.press('text:Nightly backup check')
  await a.press('id:chat-more')
  await a.press('id:menu-pin')
  await a.waitUntil(() => asked.length === 1)
  expect(asked[0]).toEqual({ method: 'pin', sessionId: 's3' })
  // The reply has landed: the menu reads the same store, so it says Unpin now.
  await a.wait(350) // the header button ignores a press right after its menu closed
  await a.press('id:chat-more')
  await a.waitFor('id:menu-unpin')
  expect(a.shows('id:menu-pin')).toBe(false)
  await a.press('id:menu-unpin')
  await a.waitUntil(() => asked.length === 2)
  expect(asked[1]).toEqual({ method: 'unpin', sessionId: 's3' })
})

test('Pin from the list: in the same render the row leads its workspace with the pin mark, and its swipe action says Unpin', async () => {
  const { app: a, asked } = await app((m, args) => ok({ pinnedSessionIds: m === 'pin' ? [args.request.sessionId] : [] }))
  await a.press('id:swipe-pin-s3')
  await a.waitUntil(() => a.shows('id:row-pinned'))
  // Checked together, with no wait between: whatever showed the mark shows the new order and the Unpin action too.
  expect(order(a.texts())).toEqual(['Nightly backup check', 'Move billing to the v2 API', 'Backfill old invoices'])
  expect(a.count('id:row-pinned')).toBe(1)
  expect(a.count('label:Unpin')).toBe(1)
  expect(asked).toEqual([{ method: 'pin', sessionId: 's3' }])
  await a.press('id:swipe-pin-s3')
  await a.waitUntil(() => !a.shows('id:row-pinned'))
  expect(order(a.texts())).toEqual(TITLES)
  expect(a.count('label:Unpin')).toBe(0)
})

test('a pin made in DSH Desktop shows on the phone as it arrives, with no refresh', async () => {
  const { app: a } = await app(() => ok({ pinnedSessionIds: [] }))
  await a.host.send('fixture.desktop-pins', { ids: ['s2'] })
  await a.waitUntil(() => a.shows('id:row-pinned'))
  expect(order(a.texts())).toEqual(['Backfill old invoices', 'Move billing to the v2 API', 'Nightly backup check'])
  await a.host.send('fixture.desktop-pins', { ids: [] })
  await a.waitUntil(() => !a.shows('id:row-pinned'))
  expect(order(a.texts())).toEqual(TITLES)
})

test('a pin the computer refuses changes nothing and says why', async () => {
  const { app: a } = await app(() => fail('session/not-found'))
  await a.press('text:Nightly backup check')
  await a.press('id:chat-more')
  await a.press('id:menu-pin')
  await a.waitFor('text:Pin failed. Try again later.')
  await a.wait(350) // the header button ignores a press right after its menu closed
  await a.press('id:chat-more')
  expect(a.shows('id:menu-pin')).toBe(true)
})


test('a forked chat is in the list, in its source\'s workspace and named as DSH Desktop names it, as soon as the fork answers, before any list read brings it', async () => {
  let forked = false, lists = 0, renamed: any
  const { app: a } = await app(() => ok({ pinnedSessionIds: [] }), {
    [`POST ${ORIGIN}/api/session/fork`]: () => { forked = true; return ok({ sessionId: 's4' }) },
    [`POST ${ORIGIN}/api/session/rename`]: (req: StubRequest) => { renamed = JSON.parse(req.body!).payload.args.request; return ok({ title: renamed.title, seq: 3 }) },
    // Every list read after the fork is slow: only the fork's reply can show the new chat in time.
    [`POST ${ORIGIN}/api/session/list`]: () => { lists++; return forked ? { ...LIST, delay: 4000 } : LIST },
  })
  await a.longPress('text:Nightly backup check')
  await a.press('text:Fork session')
  await a.waitUntil(() => forked)
  await a.waitFor('text:Move billing to the v2 API') // the fork opened, as before
  await a.back()
  await a.waitFor('text:Nightly backup check (1)') // DSH Desktop's name for a fork, from the rename's reply
  expect(renamed).toEqual({ sessionId: 's4', title: 'Nightly backup check (1)' })
  expect(a.shows('text:Nightly backup check')).toBe(true)
  expect(lists).toBeGreaterThan(0)
  expect(a.shows('text:Other')).toBe(false) // with its source, under acme-api
})
