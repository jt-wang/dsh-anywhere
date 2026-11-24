// Going back from a chat to the list on a phone (WANG-87). The chat is pushed over the list on the list's own stack, so
// the back's transition uncovers the list as it was; the list then refreshes in the background, and "No chats yet"
// only shows once the computer has answered that there are none. Headless; every chat is made up.
import { expect, open, test } from 'nsh/test'

const ORIGIN = 'http://127.0.0.1:40001/dsh'
const paired = { paired: true, origin: ORIGIN, token: 'synthetic-device-token' }
const chat = (sessionId: string, title: string, updatedAt: number) => ({ sessionId, updatedAt, running: false, blank: false, cwd: '/synthetic/acme-api', projections: { asOfSeq: 1, values: { title } } })
const reply = (items: unknown[]) => ({ type: 'server-response', rpcId: 'x', result: { ok: true, value: { items } } })
const CHATS = [chat('s1', 'Move billing to the v2 API', 2_000), chat('s2', 'Backfill old invoices', 1_000)]

async function phone(lists: () => { body: unknown; delay?: number }) {
  const app = await open('../App.tsx', {
    clock: {},
    host: { handlers: { 'link.state': paired, 'network.state': { online: true }, 'app.state': { active: true } } },
    network: { [`POST ${ORIGIN}/api/session/list`]: lists },
  })
  await app.setViewport(390, 844)
  await app.clock.runFor(1_000)
  return app
}

/** What a frame shows of the list: its rows, the empty state, or the wide layout's placeholder page. */
const frame = (app: Awaited<ReturnType<typeof phone>>) => ({
  rows: CHATS.filter((c) => app.shows(`text:${c.projections.values.title}`)).length,
  empty: app.shows('text:No chats yet') || app.shows('text:No chats saved on this phone yet'),
  placeholder: app.shows('id:wide-new-chat'),
})

test('a back from a chat uncovers the list on the chat\'s own stack, and no frame until the refresh lands is empty', async () => {
  let answered = 0
  const app = await phone(() => { answered++; return { body: reply(CHATS), delay: answered > 1 ? 800 : 0 } })
  expect(frame(app)).toEqual({ rows: 2, empty: false, placeholder: false })
  await app.press('text:Move billing to the v2 API')
  await app.clock.runFor(300)
  // The page a back or edge swipe uncovers is the one under the chat on its stack: the live list, not a placeholder.
  expect(app.shows('id:phone-stack >> id:composer')).toBe(true)
  const before = answered
  await app.back()
  const frames = [frame(app)]
  for (let i = 0; i < 90; i++) { await app.clock.runFor(16); frames.push(frame(app)) }
  expect(answered).toBeGreaterThan(before) // the list asked the computer again behind the rows on screen
  const bad = frames.filter((f) => f.rows !== 2 || f.empty || f.placeholder)
  expect({ frames: frames.length, bad: bad.length, first: bad[0] }).toEqual({ frames: 91, bad: 0, first: undefined })
})

test('"No chats yet" shows only after the computer answers that there are none', async () => {
  let items: unknown[] = CHATS
  const app = await phone(() => ({ body: reply(items), delay: 800 }))
  await app.clock.runFor(1_000)
  await app.press('text:Backfill old invoices')
  await app.clock.runFor(300)
  items = []
  await app.back()
  for (let t = 0; t < 640; t += 16) { await app.clock.runFor(16); expect(frame(app)).toEqual({ rows: 2, empty: false, placeholder: false }) }
  await app.clock.runFor(1_000)
  expect(frame(app)).toEqual({ rows: 0, empty: true, placeholder: false })
})

test('a chat open on a phone stays open with its draft through unfolding and folding', async () => {
  const app = await phone(() => ({ body: reply(CHATS) }))
  await app.press('text:Move billing to the v2 API')
  await app.clock.runFor(300)
  await app.type('id:composer', 'Unfinished reply')
  await app.setViewport(1120, 800)
  await app.clock.runFor(300)
  expect(app.value('id:composer')).toBe('Unfinished reply'); expect(app.count('id:sessions')).toBe(1)
  await app.setViewport(390, 844)
  await app.clock.runFor(300)
  expect(app.value('id:composer')).toBe('Unfinished reply'); expect(app.shows('id:phone-stack >> id:composer')).toBe(true)
  await app.back()
  expect(frame(app)).toEqual({ rows: 2, empty: false, placeholder: false })
})
