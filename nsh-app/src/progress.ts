// The Progress page's data: the companion's progress/list (host/src/progress.ts) read defensively, and what the page
// makes of it. A finished job is "for you to check" until its chat is opened on this phone after it finished; the phone
// keeps when it last opened each chat (Storage), starting from a day before it first showed the page.
import { signal, Storage, untracked } from 'nsh'
import { S } from './strings.ts'

export type Status = 'needs-you' | 'done' | 'running' | 'idle'
export type Ask = { kind: 'question'; text: string } | { kind: 'approval'; text: string; tool: string } | { kind: 'goal'; text: string }
export interface Job {
  sessionId: string; chatTitle: string; title: string; titleBy: 'chat' | 'goal' | 'judge'; sure?: boolean
  index: number; of: number; startTurn: number; endTurn: number; messageId?: string; status: Status
  ask?: Ask; result?: { turn: number; text: string }; checking?: true
  goal?: { phase: string; round: number; max: number }; todos?: { done: number; total: number }; at: number
}
export interface Project { id: string; title: string; workspaceId?: string; chats: number; jobs: Job[] }
export interface View { judge: boolean; language: string; chats: number; needsYou: number; projects: Project[] }
export type Kind = 'ask' | 'check' | 'run' | 'idle'

const obj = (v: unknown): Record<string, any> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : undefined)
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const int = (v: unknown) => (Number.isSafeInteger(v) ? (v as number) : 0)
const STATUSES: Status[] = ['needs-you', 'done', 'running', 'idle']

function askOf(v: unknown): Ask | undefined {
  const a = obj(v)
  if (a?.kind === 'question' || a?.kind === 'goal') return { kind: a.kind, text: str(a.text) }
  if (a?.kind === 'approval') return { kind: 'approval', text: str(a.text), tool: str(a.tool) }
  return undefined
}
function jobOf(v: unknown): Job | undefined {
  const j = obj(v)
  if (!j || typeof j.sessionId !== 'string' || typeof j.title !== 'string') return undefined
  const ask = askOf(j.ask), result = obj(j.result), goal = obj(j.goal), todos = obj(j.todos)
  return {
    sessionId: j.sessionId, chatTitle: str(j.chatTitle), title: j.title || str(j.chatTitle), titleBy: j.titleBy === 'goal' || j.titleBy === 'judge' ? j.titleBy : 'chat',
    ...(typeof j.sure === 'boolean' ? { sure: j.sure } : {}), index: int(j.index) || 1, of: int(j.of) || 1, startTurn: int(j.startTurn) || 1, endTurn: int(j.endTurn) || 1,
    ...(typeof j.messageId === 'string' ? { messageId: j.messageId } : {}), status: STATUSES.includes(j.status) ? j.status : 'idle',
    ...(ask ? { ask } : {}), ...(result && typeof result.text === 'string' ? { result: { turn: int(result.turn), text: result.text } } : {}),
    ...(j.checking === true ? { checking: true as const } : {}),
    ...(goal ? { goal: { phase: str(goal.phase), round: int(goal.round), max: int(goal.max) } } : {}),
    ...(todos && int(todos.total) > 0 ? { todos: { done: int(todos.done), total: int(todos.total) } } : {}),
    at: Number(j.at) || 0,
  }
}

/** The companion's answer, or undefined when it is not one. */
export function viewOf(v: unknown): View | undefined {
  const o = obj(v)
  if (!o || !Array.isArray(o.projects)) return undefined
  const projects = o.projects.flatMap((p: unknown): Project[] => {
    const q = obj(p)
    if (!q || typeof q.id !== 'string') return []
    return [{ id: q.id, title: str(q.title) || q.id, ...(typeof q.workspaceId === 'string' ? { workspaceId: q.workspaceId } : {}), chats: int(q.chats), jobs: (Array.isArray(q.jobs) ? q.jobs : []).flatMap((j: unknown) => { const x = jobOf(j); return x ? [x] : [] }) }]
  })
  return { judge: o.judge === true, language: str(o.language) || 'en', chats: int(o.chats), needsYou: int(o.needsYou), projects }
}

/** Where a job goes on the page. `seen`: when this phone last opened each chat; `baseline`: anything finished before it is old. */
export function kindOf(job: Job, seen: Record<string, number>, baseline: number): Kind {
  if (job.status === 'needs-you') return 'ask'
  if (job.status === 'running') return 'run'
  if (job.status === 'done' && job.at > (seen[job.sessionId] ?? baseline)) return 'check'
  return 'idle'
}
export const seenAfterOpen = (seen: Record<string, number>, sessionId: string, at: number) => ({ ...seen, [sessionId]: at })

const ORDER: Kind[] = ['ask', 'check', 'run', 'idle']
export function sectionsOf(project: Project, seen: Record<string, number>, baseline: number): { kind: Kind; jobs: Job[] }[] {
  return ORDER.map((kind) => ({ kind, jobs: project.jobs.filter((j) => kindOf(j, seen, baseline) === kind).sort((a, b) => b.at - a.at) })).filter((s) => s.jobs.length)
}
export function cardOf(project: Project, seen: Record<string, number>, baseline: number) {
  const of = (k: Kind) => project.jobs.filter((j) => kindOf(j, seen, baseline) === k).sort((a, b) => b.at - a.at)
  return { asks: of('ask'), checks: of('check'), working: of('run').length, idle: of('idle').length, jobs: project.jobs.length, chats: project.chats }
}

/** The muted lines under a job's title. */
export function jobLines(job: Job): string[] {
  const t = S.progress, lines: string[] = []
  if (job.of > 1) {
    lines.push(t.jobOf(job.index, job.of, job.chatTitle))
    lines.push(job.status === 'running' ? t.turnsRunning(job.startTurn, job.endTurn) : t.turns(job.startTurn, job.endTurn))
  }
  if (job.goal && job.goal.phase === 'active' && job.goal.max) lines.push(t.goalRound(job.goal.round, job.goal.max))
  if (job.todos && job.status === 'running') lines.push(t.todos(job.todos.done, job.todos.total))
  if (job.checking) lines.push(t.checking)
  return lines
}

/** What the job waits on, as the page says it. */
export function askText(ask: Ask): string {
  return ask.kind === 'approval' ? S.progress.allow(ask.text || ask.tool) : ask.kind === 'goal' ? S.progress.goalBlocked(ask.text) : ask.text || S.progress.question
}

const KEY = 'progress-seen'
/** When this phone last opened each chat, and the time before which a finished job is not news. */
export const seen = signal<{ baseline: number; chats: Record<string, number> }>({ baseline: 0, chats: {} })
let loaded = false
export async function loadSeen(now = Date.now()) {
  if (loaded) return
  loaded = true
  let v: Record<string, any> | undefined
  try { v = obj(JSON.parse((await Storage.getItem(KEY)) ?? 'null')) } catch {}
  const chats = Object.fromEntries(Object.entries(obj(v?.chats) ?? {}).filter(([, t]) => typeof t === 'number')) as Record<string, number>
  seen.set({ baseline: typeof v?.baseline === 'number' ? v.baseline : now - 86_400_000, chats })
  if (typeof v?.baseline !== 'number') save()
}
const save = () => { Storage.setItem(KEY, JSON.stringify(seen())).catch(() => {}) }
/** A chat opened on this phone: its finished jobs are no longer for you to check. */
export function markSeen(sessionId: string, at = Date.now()) {
  untracked(() => {
    const now = seen(), keep = Object.entries(now.chats).sort((a, b) => b[1] - a[1]).slice(0, 499)
    seen.set({ baseline: now.baseline, chats: seenAfterOpen(Object.fromEntries(keep), sessionId, at) })
    save()
  })
}

/** Runs `run` one at a time: asked while a run is out, it runs once more after that one. */
export const oneAtATime = (run: () => Promise<void>) => {
  let out: Promise<void> | undefined, again = false
  const next = (): Promise<void> => {
    if (out) { again = true; return out }
    out = run().finally(() => { out = undefined; if (again) { again = false; void next().catch(() => {}) } })
    return out
  }
  return next
}
