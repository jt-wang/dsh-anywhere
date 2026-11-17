// What the Progress page makes of the companion's progress/list (host/src/progress.ts): the order of a project's jobs,
// which finished jobs are still for you to check, and the lines under each job. Made-up jobs only.
import { expect, test } from 'nsh/test'
import { cardOf, jobLines, kindOf, oneAtATime, sectionsOf, seenAfterOpen, viewOf, type Job } from './progress.ts'

const NOW = 1_800_000_000_000
const job = (over: Partial<Job>): Job => ({ sessionId: 's', chatTitle: 'Chat', title: 'Job', titleBy: 'chat', index: 1, of: 1, startTurn: 1, endTurn: 1, status: 'idle', at: NOW - 60_000, ...over })

test('a reply the phone cannot read is no view; a good one keeps only what it knows', () => {
  expect(viewOf(undefined)).toBe(undefined)
  expect(viewOf({ projects: 'x' })).toBe(undefined)
  const v = viewOf({ judge: true, language: 'ko', chats: 1, needsYou: 0, extra: 1, projects: [{ id: '/w/a', title: 'a', chats: 1, jobs: [{ sessionId: 's', chatTitle: 'C', title: 'T', titleBy: 'judge', index: 1, of: 1, startTurn: 2, endTurn: 3, status: 'weird', at: 5 }, { nonsense: true }] }] })!
  expect(v.judge).toBe(true)
  expect(v.projects[0]!.jobs.length).toBe(1)
  expect(v.projects[0]!.jobs[0]!.status).toBe('idle')
})

test('a finished job is for you to check until you open its chat after it finished', () => {
  const done = job({ sessionId: 'a', status: 'done', at: NOW - 60_000 })
  expect(kindOf(done, {}, NOW - 86_400_000)).toBe('check')
  expect(kindOf(done, { a: NOW - 30_000 }, 0)).toBe('idle')
  expect(kindOf(done, { a: NOW - 90_000 }, 0)).toBe('check')
  expect(kindOf(done, {}, NOW)).toBe('idle') // finished before the phone started watching
  expect(kindOf(job({ status: 'needs-you' }), {}, 0)).toBe('ask')
  expect(kindOf(job({ status: 'running' }), {}, 0)).toBe('run')
  expect(seenAfterOpen({ a: 1 }, 'b', NOW)).toEqual({ a: 1, b: NOW })
})

test('a project lists what needs you, then what is done for you to check, then what works, then the rest, newest first', () => {
  const project = { id: '/w/infra', title: 'infra', chats: 3, jobs: [
    job({ sessionId: 'i1', title: 'Old idle', at: NOW - 900_000 }), job({ sessionId: 'r1', title: 'Running', status: 'running', at: NOW - 5_000 }),
    job({ sessionId: 'a1', title: 'Asks', status: 'needs-you', ask: { kind: 'question', text: 'Run it now?' } }), job({ sessionId: 'd1', title: 'Done', status: 'done' }),
    job({ sessionId: 'i2', title: 'New idle', at: NOW - 100_000 }),
  ] }
  expect(sectionsOf(project, {}, 0).map((s) => [s.kind, s.jobs.map((j) => j.title)])).toEqual([['ask', ['Asks']], ['check', ['Done']], ['run', ['Running']], ['idle', ['New idle', 'Old idle']]])
  const card = cardOf(project, {}, 0)
  expect([card.asks.length, card.checks.length, card.working, card.idle, card.jobs, card.chats]).toEqual([1, 1, 1, 2, 5, 3])
})

test('the lines under a job: which job of the chat, its turns, the goal round, the to-dos, and a judgement still out', () => {
  expect(jobLines(job({ index: 3, of: 3, chatTitle: 'Seed data for billing staging', startTurn: 7, endTurn: 9, status: 'running' }))).toEqual(['Job 3 of 3 in Seed data for billing staging', 'Turns 7–9, turn 9 running'])
  expect(jobLines(job({ index: 2, of: 3, chatTitle: 'Seed', startTurn: 5, endTurn: 6 }))).toEqual(['Job 2 of 3 in Seed', 'Turns 5–6'])
  expect(jobLines(job({ status: 'running', todos: { done: 4, total: 6 } }))).toEqual(['to-dos 4 of 6'])
  expect(jobLines(job({ status: 'running', goal: { phase: 'active', round: 2, max: 8 } }))).toEqual(['Goal round 2 of 8'])
  expect(jobLines(job({ status: 'running', checking: true }))).toEqual(['New message: checking whether it starts a new job'])
})

// On a slow computer the 5 s refresh and opening a project asked for the list again while it was still out.
test('one list at a time: asked again while one is out, it asks once more after that one, never alongside it', async () => {
  let out = 0, most = 0, calls = 0
  const answers: (() => void)[] = []
  const list = oneAtATime(() => { calls++; out++; most = Math.max(most, out); return new Promise<void>((done) => answers.push(() => { out--; done() })) })
  const first = list()
  void list(); void list(); void list()
  const whileOut = { calls, most }
  answers.shift()!(); await first; await Promise.resolve(); await Promise.resolve()
  const afterFirst = { calls, most }
  answers.shift()!(); await new Promise((done) => setTimeout(done, 0))
  expect({ whileOut, afterFirst, last: { calls, most, out } }).toEqual({ whileOut: { calls: 1, most: 1 }, afterFirst: { calls: 2, most: 1 }, last: { calls: 2, most: 1, out: 0 } })
})

test('one list at a time: a list that fails does not stop the next', async () => {
  let calls = 0
  const list = oneAtATime(async () => { calls++; if (calls === 1) throw new Error('unreachable') })
  await list().catch(() => {})
  await list()
  expect(calls).toBe(2)
})
