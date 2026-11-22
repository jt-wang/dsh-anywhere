// The Progress page next to the chat list (src/progress.tsx): a card per project, a project's jobs by state, a job
// opening its chat, the states of a page that is loading, empty, offline or failed, and its setting. Headless: the test
// plays the shell and the computer; every project, chat and job is made up.
import { expect, open, test } from 'nsh/test'

const ORIGIN = 'http://127.0.0.1:40001/dsh'
const CAPS = 'GET http://127.0.0.1:40001/v1/capabilities'
const paired = { paired: true, origin: ORIGIN, token: 'synthetic-device-token' }
const ok = (value: unknown) => ({ body: { type: 'server-response', rpcId: 'x', result: { ok: true, value } } })
const NOW = Date.now()
const job = (over: Record<string, unknown>) => ({ chatTitle: 'Chat', titleBy: 'chat', index: 1, of: 1, startTurn: 1, endTurn: 1, status: 'idle', at: NOW - 600_000, ...over })
const VIEW = { judge: false, language: 'en', chats: 4, needsYou: 2, projects: [
  { id: '/w/acme-api', title: 'acme-api', workspaceId: 'ws1', chats: 2, jobs: [
    job({ sessionId: 's1', chatTitle: 'Move billing to the v2 API', title: 'Move billing to the v2 API', status: 'needs-you', ask: { kind: 'question', text: 'Run the migration on staging now?' }, at: NOW - 60_000 }),
    job({ sessionId: 's2', chatTitle: 'Backfill old invoices', title: 'Backfill old invoices', status: 'done', result: { turn: 4, text: '1,284 invoices moved to v2. 3 skipped (no customer id).' }, at: NOW - 120_000 }),
  ] },
  { id: '/w/infra', title: 'infra', chats: 2, jobs: [
    job({ sessionId: 's3', chatTitle: 'Nightly backup check', title: 'Nightly backup check', status: 'needs-you', ask: { kind: 'goal', text: 'the backup bucket says access denied' } }),
    job({ sessionId: 's4', chatTitle: 'Seed data for billing staging', title: 'Seed the billing staging database', index: 1, of: 2, startTurn: 1, endTurn: 4, result: { turn: 4, text: 'Staging seeded with 40 customers.' }, messageId: 'm1' }),
    job({ sessionId: 's4', chatTitle: 'Seed data for billing staging', title: 'Dry run of the v2 migration', titleBy: 'judge', index: 2, of: 2, startTurn: 5, endTurn: 7, status: 'running', messageId: 'm5', at: NOW - 5_000 }),
  ] },
] }

async function home(options: { hidden?: boolean; capabilities?: Record<string, unknown>; list?: () => unknown; settings?: (args: Record<string, unknown>) => unknown; locale?: string; colorScheme?: 'dark' | 'light' } = {}) {
  const asked: Record<string, unknown>[] = []
  const app = await open(options.hidden ? '../App.tsx' : './fixtures/progress-on/App.tsx', {
    locale: options.locale ?? 'en-US', ...(options.colorScheme ? { colorScheme: options.colorScheme } : {}),
    host: { handlers: { 'link.state': paired, 'app.state': { active: true }, 'notify.watch': null, 'notify.clear': null, 'notify.permission': { granted: true }, 'link.path': { route: 'direct' } } },
    network: {
      [`POST ${ORIGIN}/api/session/list`]: () => ok({ items: [{ sessionId: 's1', updatedAt: NOW, running: false, cwd: '/w/acme-api', projections: { values: { title: 'Move billing to the v2 API' } } }] }),
      [CAPS]: () => ({ body: { hostName: 'Companion', computerName: 'Studio', hostVersion: '0.8.0', upstreamVersion: '0.2.2-rc.1', capabilities: options.capabilities ?? { sessions: true, progress: true } } }),
      [`POST ${ORIGIN}/companion/progress/list`]: () => (options.list ? options.list() : ok(VIEW)),
      [`POST ${ORIGIN}/companion/progress/settings`]: (req) => { const args = JSON.parse(req.body!).payload.args; asked.push(args); return options.settings ? options.settings(args) : ok({ judge: args.judge ?? false, language: args.language ?? 'en' }) },
    },
  })
  return { app, asked }
}

test('with a companion that has Progress, the list gets a Progress tab with how many jobs need you', async () => {
  const { app } = await home()
  await app.waitFor('id:tab-progress')
  await app.waitFor('label:Progress, 2 need you')
  expect(app.shows('id:tab-chats')).toBe(true)
})

test('the shipped app hides Progress: even a companion that has it gets the chat list alone, no setting and no list call', async () => {
  const { app } = await home({ hidden: true })
  await app.waitFor('text:Move billing to the v2 API')
  await app.wait(300)
  expect(app.shows('id:tab-progress')).toBe(false)
  expect(app.shows('id:tab-chats')).toBe(false)
  await app.press('id:more')
  await app.press('text:Settings')
  await app.waitFor('text:Banners while in the app')
  expect(app.texts().some((s) => s.includes('Split chats into jobs'))).toBe(false)
  expect(app.requests().some((r) => r.url.includes('/companion/progress/'))).toBe(false)
})

test('an older companion: no Progress tab, the chat list as before', async () => {
  const { app } = await home({ capabilities: { sessions: true } })
  await app.waitFor('text:Move billing to the v2 API')
  await app.wait(300)
  expect(app.shows('id:tab-progress')).toBe(false)
})

test('Progress shows a card per project: what needs you with the question, what is done with its result, the rest counted', async () => {
  const { app } = await home()
  await app.press('id:tab-progress')
  await app.waitFor('text:acme-api')
  const t = app.texts()
  for (const s of ['2 projects · 4 chats', '2 need you', 'acme-api', 'Move billing to the v2 API', 'Run the migration on staging now?', 'Backfill old invoices', 'to check',
    '1,284 invoices moved to v2. 3 skipped (no customer id).', 'infra', '3 jobs in 2 chats', 'Goal blocked: the backup bucket says access denied', '1 working, 1 idle']) expect([s, t.includes(s)]).toEqual([s, true])
  expect(t.indexOf('acme-api') < t.indexOf('infra')).toBe(true)
})

test('a project opens to its jobs by state: needs you, done for you to check, working, idle; a job opens its chat', async () => {
  const { app } = await home()
  await app.press('id:tab-progress')
  await app.press('id:project-/w/infra')
  await app.waitFor('text:Needs you')
  const t = app.texts()
  for (const s of ['3 jobs in 2 chats · 1 running', 'Needs you', 'Working', 'Idle', 'Dry run of the v2 migration', 'Job 2 of 2 in Seed data for billing staging', 'Turns 5–7, turn 7 running', 'Running',
    'Seed the billing staging database', 'Job 1 of 2 in Seed data for billing staging', 'Turns 1–4', 'Result · turn 4', 'Staging seeded with 40 customers.']) expect([s, t.includes(s)]).toEqual([s, true])
  expect(t.indexOf('Needs you') < t.indexOf('Working') && t.indexOf('Working') < t.indexOf('Idle')).toBe(true)
  await app.press('id:job-s4-1')
  await app.waitFor('id:chat-more')
  await app.waitUntil(() => app.requests().some((r) => r.url.endsWith('/api/session/projections') && JSON.parse(r.body!).payload.args.request.sessionId === 's4'))
})

test('a finished job is no longer for you to check once its chat was opened', async () => {
  const { app } = await home()
  await app.press('id:tab-progress')
  await app.waitFor('text:to check')
  await app.press('id:job-s2-1')
  await app.waitFor('id:chat-more')
  await app.back()
  await app.waitFor('text:acme-api')
  await app.wait(200)
  expect(app.texts().includes('to check')).toBe(false)
  expect(app.texts()).toContain('0 working, 1 idle')
})

test('loading, no chats yet, and a failure with a retry', async () => {
  let fail = true
  const { app } = await home({ list: () => (fail ? { status: 500, body: 'no' } : ok({ ...VIEW, chats: 0, needsYou: 0, projects: [] })) })
  await app.press('id:tab-progress')
  await app.waitFor('text:Couldn’t load the progress. Try again.')
  fail = false
  await app.press('id:progress-retry')
  await app.waitFor('text:No chats yet')
})

test('while every chat is one job, the page says how to split them; the setting asks the computer, in the app’s language', async () => {
  const { app, asked } = await home()
  await app.press('id:tab-progress')
  await app.waitFor('text:Each chat counts as one job. Turn on “Split chats into jobs” in Settings to split a chat when it moves on to other work.')
  await app.press('id:tab-chats')
  await app.press('id:more')
  await app.press('text:Settings')
  await app.waitFor('text:Split chats into jobs')
  expect(app.texts().some((s) => s.includes('about ¥0.0013 a message'))).toBe(true)
  await app.press('id:progress-judge')
  await app.waitUntil(() => asked.some((a) => a.judge === true))
  expect(asked.find((a) => a.judge === true)).toEqual({ judge: true, language: 'en' })
})

test('a setting the computer refuses stays off and says so', async () => {
  const { app } = await home({ settings: (args) => ('judge' in args ? { status: 403, body: 'no' } : ok({ judge: false, language: 'en' })) })
  await app.waitFor('id:tab-progress')
  await app.press('id:more')
  await app.press('text:Settings')
  await app.press('id:progress-judge')
  await app.waitFor('text:Your computer didn’t take the change. Try again.')
})

test('in Simplified Chinese and in the dark the page reads whole', async () => {
  const { app } = await home({ locale: 'zh-Hans-CN', colorScheme: 'dark' })
  await app.press('id:tab-progress')
  await app.waitFor('text:2 个项目 · 2 个会话'.replace('2 个会话', '4 个会话'))
  for (const s of ['2 件要你处理', 'Run the migration on staging now?', '待查看', '目标受阻：the backup bucket says access denied', '1 件在跑，1 件闲着']) expect([s, app.texts().includes(s)]).toEqual([s, true])
})
