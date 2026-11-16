// The Progress page's jobs: each chat split into the pieces of work the person asked for, grouped by
// working folder, with each job's state. A job starts at the chat's first message, where a DSH goal is created, or, when
// the owner turned judging on, where a model call through DSH's own llm service says a new message starts other work.
// Messages that answer the agent, goal rounds and messages inside a goal are never judged. A judgement that fails or
// does not come back counts as the same job. The split is kept in one file of the plugin's own; nothing goes into DSH.
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { HostError } from './errors.ts';

export type Route = { provider: string; model: string };
export interface JudgeInput { route: Route; system: string; user: string; signal: AbortSignal }
/** A session/list row, as the plugin glue reads it. */
export interface ProgressRow { sessionId: string; cwd?: string; title: string; running: boolean; updatedAt: number; origin?: string; blank?: boolean }
export interface ProgressSources {
  sessions(signal: AbortSignal): Promise<ProgressRow[]>;
  /** The chat's recent events, from the first frame of a cold-safe follow. */
  opening(sessionId: string, signal: AbortSignal): Promise<unknown[]>;
  /** The chat's projection values (goal, todos), recomputed by DSH from the log. */
  projections(sessionId: string, signal: AbortSignal): Promise<Record<string, unknown> | undefined>;
  workspaces?(signal: AbortSignal): Promise<{ id: string; title: string; path: string }[]>;
  /** One model call; resolves with the reply's text. */
  judge?(input: JudgeInput): Promise<string>;
}
export type JobStatus = 'needs-you' | 'done' | 'running' | 'idle';
export interface ProgressJob {
  sessionId: string; chatTitle: string; title: string; titleBy: 'chat' | 'goal' | 'judge'; sure?: boolean;
  /** 1-based place among the chat's jobs, and how many it has. */
  index: number; of: number; startTurn: number; endTurn: number;
  /** The user message the job started with, when the plugin saw it. */
  messageId?: string;
  status: JobStatus;
  ask?: { kind: 'question'; text: string } | { kind: 'approval'; text: string; tool: string } | { kind: 'goal'; text: string };
  result?: { turn: number; text: string };
  checking?: true;
  goal?: { phase: string; round: number; max: number };
  todos?: { done: number; total: number };
  at: number;
}
export interface ProgressProject { id: string; title: string; workspaceId?: string; chats: number; jobs: ProgressJob[] }
export interface ProgressView { judge: boolean; language: string; chats: number; needsYou: number; projects: ProgressProject[] }
export interface ProgressSettings { judge: boolean; language: string }
export interface Progress {
  /** Every session/event DSH emits, as `ctx.on('session/event')` hears it. */
  event(sessionId: string, event: unknown): void;
  list(signal: AbortSignal): Promise<ProgressView>;
  settings(): ProgressSettings;
  configure(change: Partial<ProgressSettings>): Promise<ProgressSettings>;
  /** Resolves when every history read, judgement and write started so far has finished. */
  idle(): Promise<void>;
  close(): Promise<void>;
}

/** The page's languages; the model writes new jobs' names in the one the phone set. */
const LANGUAGE_NAMES: Record<string, string> = { en: 'English', 'zh-Hans': 'Simplified Chinese', 'zh-Hant': 'Traditional Chinese', es: 'Spanish', fr: 'French', ko: 'Korean', ja: 'Japanese', ru: 'Russian' };
export const PROGRESS_LANGUAGES = Object.keys(LANGUAGE_NAMES);

/** The judgement's instructions, as evaluated on DSH 0.2.2-rc.1 (2026-11-09: 20 cases, English and Simplified Chinese, 3 runs). */
export const judgeSystem = (language: string) => `You keep the list of jobs in a coding-agent chat for a progress page. A job is one piece of work the user asked for, and the turns spent on it, until the chat moves on to other work.

You get the chat's folder, its earlier jobs, its current job with what the user asked in it and the start of the agent's last reply, and the user's new message. Decide whether the new message goes on with the current job or starts a new one.
- Same job: follow-ups, fixes and changes to what the current job made, tests or reviews of it, retries, questions about it, answers to the agent, "continue", "ok", "thanks", and committing or shipping it.
- New job: work the current job does not need in order to be done, even in the same folder, on the same feature or the same kind of change somewhere else. An error or report about another part of the system is a new job.
- sure is false when the message could be read either way.

Reply with only one JSON object, no other text:
{"job":"same","sure":true}
or
{"job":"new","title":"<the new job in at most 8 words>","sure":true}
Write the title in ${LANGUAGE_NAMES[language] ?? 'English'}, whatever language the message is in. Keep names, file names, numbers and commands as written.`;

export function judgeUser(input: { folder: string; earlier: string[]; job: string; turns: string; asked: string[]; replied?: string; text: string }): string {
  return [
    `Folder: ${input.folder}`,
    `Earlier jobs: ${input.earlier.length ? input.earlier.join('; ') : 'none'}`,
    `Current job: ${input.job} (turns ${input.turns})`,
    'The user asked in it:',
    ...input.asked.map(a => `- ${a}`),
    `Agent's last reply starts: ${input.replied ?? 'none'}`,
    '',
    `New message: ${input.text}`,
  ].join('\n');
}

/** The one JSON object the prompt asks for, in or out of a code fence; anything else is no answer. */
export function parseJudgement(text: string): { job: 'same'; sure: boolean } | { job: 'new'; title: string; sure: boolean } | undefined {
  const trimmed = text.trim(), fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  let value: unknown;
  try { value = JSON.parse(fenced ? fenced[1]! : trimmed); } catch { return undefined; }
  const v = value as { job?: unknown; title?: unknown; sure?: unknown } | null;
  if (!v || typeof v !== 'object' || typeof v.sure !== 'boolean') return undefined;
  if (v.job === 'same') return { job: 'same', sure: v.sure };
  if (v.job === 'new' && typeof v.title === 'string' && v.title.trim()) return { job: 'new', title: v.title.trim().slice(0, 120), sure: v.sure };
  return undefined;
}

interface Mark { start: number; by: 'chat' | 'goal' | 'judge'; title?: string; goalId?: string; sure?: boolean; messageId?: string }
interface ChatRecord { marks: Mark[]; turn: number; open: boolean; asked: string[]; replied?: string | undefined; route?: Route; goalId?: string | undefined; lastSeq: number; first?: string | undefined }
interface StoreFile { version: 1; settings: ProgressSettings; chats: Record<string, ChatRecord> }
interface Event { seq: number; time: number; type: string; data: Record<string, any> }

const ASKED = 4, ASKED_CHARS = 300, REPLY_CHARS = 200, MAX_CHATS = 2000;
const obj = (v: unknown): Record<string, any> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : undefined);
const textOf = (content: unknown) => (Array.isArray(content) ? content : []).filter(b => obj(b)?.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('');
const firstLine = (text: string, max: number) => (text.split('\n').map(line => line.trim()).find(Boolean) ?? '').slice(0, max);
// An Agent Teams teammate (any subagent) has a list row of its own, which the page leaves out; DSH also refuses to read
// its history at a plain session address (dsh-api-session-controller lib/index.js:1156 in 0.2.2-rc.1, :1693 in
// 0.2.1-rc.3, met on real DSH 2026-11-13). The code alone is shared with other refusals, so the reason is checked too.
const subagentRefusal = (error: unknown) => obj(error)?.code === 'session/agent-busy' && obj(obj(error)?.details)?.reason === 'use subagent delivery for this child session';
/** `p`, or nothing once `signal` aborts, whichever comes first. */
function until(p: Promise<unknown>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  let stop!: () => void;
  return Promise.race([p.then(() => {}, () => {}), new Promise<void>(resolve => { stop = resolve; signal.addEventListener('abort', stop, { once: true }); })])
    .finally(() => signal.removeEventListener('abort', stop));
}

function eventOf(value: unknown): Event | undefined {
  const raw = obj(obj(value)?.event) ?? obj(value);
  return raw && typeof raw.type === 'string' && Number.isSafeInteger(raw.seq) ? { seq: raw.seq, time: Number(raw.time) || 0, type: raw.type, data: obj(raw.data) ?? {} } : undefined;
}
const pushAsked = (record: ChatRecord, text: string) => { record.asked = [...record.asked, text.slice(0, ASKED_CHARS)].slice(-ASKED); };
const newRecord = (): ChatRecord => ({ marks: [], turn: 0, open: false, asked: [], lastSeq: -1 });

/** What a chat's recent events say: each turn's end and reply, and what it waits on now. */
interface Facts {
  lastTurn: number;
  /** The chat's name as DSH projects it for this chat (projections()), fresher than a list row. */
  title?: string;
  turns: Map<number, { reason?: string; time?: number; reply?: string }>;
  ask?: ProgressJob['ask'];
  goal?: { phase: string; round: number; max: number; blocked?: string };
  todos?: { done: number; total: number };
}
function factsOf(events: Event[], values: Record<string, unknown> | undefined): Facts {
  const turns: Facts['turns'] = new Map();
  let lastTurn = 0, openTurn: number | undefined;
  const questions = new Map<string, { text: string; turn?: number }>(), approvals = new Map<string, { text: string; tool: string }>();
  for (const e of events) {
    const d = e.data, turn = Number.isSafeInteger(d.turn) ? d.turn as number : undefined;
    if (e.type === 'turn/start' && turn !== undefined) { lastTurn = Math.max(lastTurn, turn); openTurn = turn; turns.set(turn, {}); }
    else if (e.type === 'turn/end' && turn !== undefined) { const t = turns.get(turn) ?? {}; t.reason = obj(d.reason)?.kind; t.time = e.time; turns.set(turn, t); if (openTurn === turn) openTurn = undefined; questions.clear(); approvals.clear(); }
    else if (e.type === 'assistant/message' && turn !== undefined) { const text = textOf(obj(d.message)?.content ?? d.content); if (text.trim()) { const t = turns.get(turn) ?? {}; t.reply = text; turns.set(turn, t); } }
    else if (e.type === 'tool/call' && d.name === 'ask_user_question' && typeof d.callId === 'string') {
      let text = '';
      try { text = String(obj(JSON.parse(String(d.arguments)))?.questions?.[0]?.question ?? ''); } catch { /* an unreadable question still waits */ }
      questions.set(d.callId, { text });
    } else if (e.type === 'tool/result') { const id = obj(d.message)?.toolCallId; if (typeof id === 'string') questions.delete(id); }
    else if (e.type === 'user/message' && obj(d.source)?.kind === 'user-question-reply') { const id = obj(d.source)?.callId; if (typeof id === 'string') questions.delete(id); }
    else if (e.type === 'approval/asked' && typeof d.id === 'string') approvals.set(d.id, { text: typeof d.reason === 'string' && d.reason ? d.reason : String(d.toolName ?? ''), tool: String(d.toolName ?? '') });
    else if (e.type === 'approval/decided' && typeof d.id === 'string') approvals.delete(d.id);
  }
  const facts: Facts = { lastTurn, turns, ...(typeof values?.title === 'string' && values.title.trim() ? { title: values.title } : {}) };
  if (openTurn !== undefined) {
    const question = [...questions.values()].at(-1), approval = [...approvals.values()].at(-1);
    if (approval) facts.ask = { kind: 'approval', text: approval.text, tool: approval.tool };
    else if (question) facts.ask = { kind: 'question', text: question.text };
  }
  const goal = obj(obj(values?.goal)?.goal), rounds = Number(obj(values?.goal)?.roundsStarted) || 0;
  if (goal && typeof goal.phase === 'string') facts.goal = { phase: goal.phase, round: rounds, max: Number(goal.maxGoalRounds) || 0, ...(goal.phase === 'blocked' && typeof obj(goal.blockedReason)?.message === 'string' ? { blocked: goal.blockedReason.message } : {}) };
  const todos = Array.isArray(values?.todos) ? values.todos as unknown[] : [];
  if (todos.length) facts.todos = { done: todos.filter(t => obj(t)?.status === 'completed').length, total: todos.length };
  return facts;
}

/** How many chats' reads (history, projections) are out at once, how long one may take, and how long one
 * list may take in all: under the phone's 20 s (nsh-app/src/dsh.ts), so a chat DSH does not answer for leaves a list
 * with what it has instead of failing the page. */
const READS_AT_ONCE = 8, READ_TIMEOUT_MS = 10_000, LIST_MS = 12_000;

export async function createProgress(options: { dir: string; sources: ProgressSources; judgeTimeoutMs?: number; readTimeoutMs?: number; listMs?: number; log?: (message: string) => void }): Promise<Progress> {
  const { dir, sources } = options, file = join(dir, 'jobs.json'), judgeTimeoutMs = options.judgeTimeoutMs ?? 30_000, readTimeoutMs = options.readTimeoutMs ?? READ_TIMEOUT_MS, listMs = options.listMs ?? LIST_MS;
  let store: StoreFile = { version: 1, settings: { judge: false, language: 'en' }, chats: {} };
  // No file yet starts empty. A file that is there but cannot be read (no permission, a folder) or does
  // not parse is kept aside like an unreadable one, never written over.
  let text: string | undefined, there = false;
  try { text = await readFile(file, 'utf8'); there = true; } catch (error) { there = (error as NodeJS.ErrnoException)?.code !== 'ENOENT'; }
  if (there) {
    let read: StoreFile | undefined;
    try { read = JSON.parse(text ?? '') as StoreFile; } catch { /* below */ }
    if (read?.version === 1 && obj(read.chats) && obj(read.settings)) store = { version: 1, settings: { judge: read.settings.judge === true, language: PROGRESS_LANGUAGES.includes(read.settings.language) ? read.settings.language : 'en' }, chats: read.chats };
    else {
      // Kept aside, not overwritten: the jobs and the setting in it may still be read by hand.
      const aside = `${file}.unreadable-${Date.now()}`;
      await rename(file, aside).then(() => options.log?.(`Progress: ${file} could not be read; kept as ${aside}, starting over`),
        (error: unknown) => options.log?.(`Progress: ${file} could not be read, nor kept aside (${String(error)}); starting over`));
    }
  }
  const closing = new AbortController();
  /** A signal of its own that aborts when the plugin closes, for one list, first read or judgement; `end()` when that is
   * done. Combining closing.signal itself through AbortSignal.any (directly, or through read()) kept every combined signal
   * reachable for as long as the plugin ran: about 0.18 KB a list on Node 24.13.1, never freed
   * (test/progress-memory.test.ts). */
  const scope = () => {
    const own = new AbortController(), stop = () => own.abort(closing.signal.reason);
    if (closing.signal.aborted) stop(); else closing.signal.addEventListener('abort', stop, { once: true });
    return { signal: own.signal, end: () => closing.signal.removeEventListener('abort', stop) };
  };
  // A first list after a start reads every chat it has no record of: at most READS_AT_ONCE at a time, each given up
  // after readTimeoutMs, so one chat DSH does not answer for does not hold the list.
  // A read that finishes hands its slot to the first read still waiting, first come first served; a waiting read whose
  // list or plugin is given up leaves the queue at once. A waiting read used to take a wakeup and drop it, and every
  // read behind it, later lists, judgements and close() waited for good.
  let readsOut = 0;
  const waiting: (() => void)[] = [];
  const timedOut = new Error('progress: read timed out');
  const slot = (outer: AbortSignal) => new Promise<void>((resolve, reject) => {
    outer.throwIfAborted();
    if (readsOut < READS_AT_ONCE && !waiting.length) { readsOut++; resolve(); return; }
    const leave = () => { const i = waiting.indexOf(wake); if (i >= 0) waiting.splice(i, 1); reject(outer.reason); };
    const wake = () => { outer.removeEventListener('abort', leave); resolve(); };
    waiting.push(wake); outer.addEventListener('abort', leave, { once: true });
  });
  const release = () => { const next = waiting.shift(); if (next) next(); else readsOut--; };
  async function read<T>(run: (signal: AbortSignal) => Promise<T>, outer: AbortSignal): Promise<T> {
    await slot(outer);
    const signal = AbortSignal.any([outer, AbortSignal.timeout(readTimeoutMs)]);
    let stop!: () => void;
    try {
      return await Promise.race([run(signal), new Promise<never>((_, reject) => {
        stop = () => reject(outer.aborted ? outer.reason : timedOut);
        if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
      })]);
    } finally { signal.removeEventListener('abort', stop); release(); }
  }
  const work = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>) => { work.add(p); p.finally(() => work.delete(p)).catch(() => {}); return p; };
  const judging = new Map<string, number>();
  const chains = new Map<string, Promise<void>>();
  /** Chats whose history is being read: live events wait in order behind it. */
  const loading = new Map<string, { buffer: Event[]; done: Promise<void> }>();
  /** Subagent sessions seen this run (refused reads, subagent list rows): never recorded or read. */
  const subagents = new Set<string>();
  /** Chats heard after the record limit was reached: listed from their facts, never loaded again this run. */
  const unrecorded = new Set<string>();

  // Every write goes through one chain, each to a temporary file of its own, so two never share a temporary file or
  // land out of order (configure() used to write beside a debounced save).
  // A write that fails removes its temporary file (one was left per failed save) and is logged once.
  let saveTimer: ReturnType<typeof setTimeout> | undefined, saving: Promise<void> = Promise.resolve(), writes = 0, failedLogged = false;
  const write = async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${++writes}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(store), { mode: 0o600 });
      await rename(tmp, file);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      if (!failedLogged) { failedLogged = true; options.log?.(`Progress: ${file} could not be saved (${String(error)}); later saves try again`); }
      throw error;
    }
  };
  /** Queue a write now; the returned promise rejects if this write fails. */
  const writeNext = () => { const next = saving.then(write, write); saving = next.catch(() => {}); return next; };
  const save = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = undefined; track(writeNext()).catch(() => {}); }, 50);
  };
  const flush = async () => { if (saveTimer) { clearTimeout(saveTimer); saveTimer = undefined; writeNext().catch(() => {}); } await saving; };

  const record = (sessionId: string) => store.chats[sessionId] ??= newRecord();
  const insert = (r: ChatRecord, mark: Mark) => {
    const at = r.marks.findIndex(m => m.start >= mark.start);
    if (at < 0) r.marks.push(mark);
    else if (r.marks[at]!.start === mark.start) { if (mark.by === 'goal' || r.marks[at]!.by === 'chat' && !r.marks[at]!.title) r.marks[at] = { ...mark, ...(r.marks[at]!.messageId && !mark.messageId ? { messageId: r.marks[at]!.messageId } : {}) }; }
    else r.marks.splice(at, 0, mark);
  };

  function judgeLater(sessionId: string, r: ChatRecord, text: string, turn: number, messageId: string | undefined) {
    const replied = r.replied;
    judging.set(sessionId, (judging.get(sessionId) ?? 0) + 1);
    const run = async () => {
      // A judgement that starts after close() began (a first read that ended just then applies what it heard) neither asks
      // the model nor writes, and its message is not kept: close() waits only for the work running when it was called, so
      // a save here would land after close() returned. One already running when
      // close() comes is aborted and keeps its message as the same job; close() waits for it and writes it.
      if (closing.signal.aborted) return;
      const own = scope();
      try {
        const current = r.marks.at(-1)!, done = r.marks.slice(0, -1);
        const rows = await sources.sessions(own.signal).catch(() => [] as ProgressRow[]);
        const row = rows.find(x => x.sessionId === sessionId);
        const chatTitle = row?.title || r.first || '';
        const user = judgeUser({ folder: row?.cwd ? basename(row.cwd) : '', earlier: done.map(m => m.title ?? chatTitle), job: current.title ?? chatTitle, turns: `${current.start}–${Math.max(current.start, turn - 1)}`, asked: r.asked, ...(replied ? { replied } : {}), text });
        // The route the chat's next request takes, as DSH projects it (modelSelection.next: dsh-agent lib/index.js:140-173
        // in 0.2.2-rc.1, dsh-api-session-controller lib/index.js:2173-2190 in 0.2.1-rc.3); else the last request header
        // in the history read, which holds only the last 100 messages.
        const values = await read(s => sources.projections(sessionId, s), own.signal).catch(() => undefined);
        const next = obj(obj(values?.modelSelection)?.next);
        const route = typeof next?.provider === 'string' && next.provider && typeof next.model === 'string' && next.model ? { provider: next.provider, model: next.model } : r.route;
        let verdict: ReturnType<typeof parseJudgement>;
        if (!route) { pushAsked(r, text); save(); return; }
        try {
          const signal = AbortSignal.any([own.signal, AbortSignal.timeout(judgeTimeoutMs)]);
          verdict = parseJudgement(await Promise.race([sources.judge!({ route, system: judgeSystem(store.settings.language), user, signal }),
            new Promise<never>((_, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); })]));
        } catch { verdict = undefined; }
        if (verdict?.job === 'new') { insert(r, { start: turn, by: 'judge', title: verdict.title, sure: verdict.sure, ...(messageId ? { messageId } : {}) }); r.asked = [text.slice(0, ASKED_CHARS)]; }
        else pushAsked(r, text);
        save();
      } finally { own.end(); }
    };
    const next = (chains.get(sessionId) ?? Promise.resolve()).then(run).catch(() => {}).finally(() => {
      const n = (judging.get(sessionId) ?? 1) - 1; if (n > 0) judging.set(sessionId, n); else judging.delete(sessionId);
    });
    chains.set(sessionId, next); track(next);
  }

  /** One event into a chat's record. `live`: heard as it happened, so a new message may be judged. */
  function apply(sessionId: string, r: ChatRecord, e: Event, live: boolean) {
    if (e.seq <= r.lastSeq) return;
    r.lastSeq = e.seq;
    const d = e.data;
    if (e.type === 'turn/start' && Number.isSafeInteger(d.turn)) { r.turn = d.turn; r.open = true; }
    else if (e.type === 'turn/end') r.open = false;
    // DSH logs the model route as { header: { config }, reason } (dsh-agent-loop; dsh-agent reads event.data.header).
    else if (e.type === 'request/header') { const c = obj(obj(d.header)?.config); if (typeof c?.provider === 'string' && typeof c.model === 'string') r.route = { provider: c.provider, model: c.model }; }
    else if (e.type === 'assistant/message') { const line = firstLine(textOf(obj(d.message)?.content ?? d.content), REPLY_CHARS); if (line) r.replied = line; }
    else if (e.type === 'goal/change') {
      const goal = obj(d.goal);
      if (d.operation === 'clear') r.goalId = undefined;
      else if (goal && typeof goal.id === 'string' && typeof goal.objective === 'string') {
        if (d.operation === 'create' || (goal.id !== r.goalId && goal.phase === 'active' && !r.marks.some(m => m.goalId === goal.id))) {
          insert(r, { start: r.open ? r.turn : r.turn + 1, by: 'goal', title: goal.objective, goalId: goal.id });
          r.asked = []; r.replied = undefined;
        } else for (const m of r.marks) if (m.goalId === goal.id) m.title = goal.objective;
        r.goalId = goal.phase === 'complete' ? undefined : goal.id;
      }
    } else if (e.type === 'user/message' && obj(d.source)?.kind === 'user') {
      const text = textOf(d.content), messageId = typeof d.id === 'string' ? d.id : undefined, turn = Math.max(1, r.turn);
      if (!r.marks.length) {
        if (turn <= 1) { r.marks.push({ start: 1, by: 'chat', ...(messageId ? { messageId } : {}) }); r.first = firstLine(text, 120) || undefined; pushAsked(r, text); return; }
        r.marks.push({ start: 1, by: 'chat' });
      }
      if (r.goalId || !live || !store.settings.judge || !sources.judge || !text.trim() || r.marks.at(-1)!.start >= turn) { pushAsked(r, text); return; }
      judgeLater(sessionId, r, text, turn, messageId);
    }
  }

  /** A chat heard for the first time: its history first (never judged), then what was heard meanwhile. */
  function load(sessionId: string, first?: Event): { buffer: Event[]; done: Promise<void> } {
    const existing = loading.get(sessionId); if (existing) return existing;
    const entry = { buffer: first ? [first] : [], done: Promise.resolve() };
    loading.set(sessionId, entry);
    entry.done = track((async () => {
      let history: Event[] = [];
      const own = scope();
      try { history = (await read(s => sources.opening(sessionId, s), own.signal)).flatMap(v => { const e = eventOf(v); return e ? [e] : []; }); } catch (error) {
        // A subagent is not one of the page's chats: no record (it would take one of MAX_CHATS), and no further reads.
        if (subagentRefusal(error)) { subagents.add(sessionId); return; }
        // Closing (a stop or reload): no record either, so the next start reads it back. Previously an empty record
        // was saved and the chat's history, its goal jobs and first message, was never read again; a list after
        // close() still wrote one.
        if (closing.signal.aborted) return;
        // Not answered in time and nothing heard meanwhile: no record yet, so the next list or event reads it again.
        if (error === timedOut && !entry.buffer.length) return;
        /* otherwise live events only */
      } finally { own.end(); }
      if (subagents.has(sessionId)) return; // a list saw its subagent row while the read was out
      if (!store.chats[sessionId] && Object.keys(store.chats).length >= MAX_CHATS) { unrecorded.add(sessionId); return; }
      const r = record(sessionId), from = entry.buffer[0]?.seq ?? Infinity;
      for (const e of history) if (e.seq < from) apply(sessionId, r, e, false);
      for (const e of entry.buffer) apply(sessionId, r, e, true);
      save();
    })().finally(() => loading.delete(sessionId)));
    return entry;
  }

  const cache = new Map<string, { key: string; facts: Facts }>();
  async function facts(row: ProgressRow, signal: AbortSignal): Promise<Facts> {
    // A row's updatedAt moves only when the person sends a message (max(createdAt, lastPromptAt): dsh-api-session-controller
    // lib/index.js:2125 in 0.2.1-rc.3, :2920 in 0.2.2-rc.1), and running stays true through a whole turn, so a question
    // or approval asked mid-turn changes neither. The last event this plugin applied to the chat does change.
    const key = `${row.updatedAt}|${row.running}|${store.chats[row.sessionId]?.lastSeq ?? -1}`, hit = cache.get(row.sessionId);
    if (hit?.key === key) return hit.facts;
    // A read that fails (or the list is given up) shows what is left for this list only: kept, it would stand until the
    // person sends another message, since the key would not change.
    let failed = false;
    const [events, values] = await Promise.all([
      read(s => sources.opening(row.sessionId, s), signal).then(list => list.flatMap(v => { const e = eventOf(v); return e ? [e] : []; })).catch(() => { failed = true; return [] as Event[]; }),
      read(s => sources.projections(row.sessionId, s), signal).catch(() => { failed = true; return undefined; }),
    ]);
    const result = factsOf(events, values);
    if (!failed && !signal.aborted) cache.set(row.sessionId, { key, facts: result });
    return result;
  }

  function jobsOf(row: ProgressRow, r: ChatRecord, f: Facts): ProgressJob[] {
    const marks = r.marks.length ? r.marks : [{ start: 1, by: 'chat' as const }];
    const lastTurn = Math.max(f.lastTurn, r.turn, 1);
    // DSH's name for this chat first, read per chat; a list row's title can be stale (it comes from DSH's projection
    // cache), and then the chat's first message, which the plugin keeps.
    const chatTitle = f.title ?? (row.title || r.first || '');
    return marks.map((m, i) => {
      const latest = i === marks.length - 1;
      const endTurn = Math.max(m.start, latest ? lastTurn : marks[i + 1]!.start - 1);
      const end = f.turns.get(endTurn);
      const result = end?.reason === 'completed' && end.reply ? { turn: endTurn, text: firstLine(end.reply, 400) } : undefined;
      const ask = !latest ? undefined : f.ask ?? (f.goal?.blocked ? { kind: 'goal' as const, text: f.goal.blocked } : undefined);
      const status: JobStatus = !latest ? 'idle' : ask ? 'needs-you' : row.running ? 'running' : end?.reason === 'completed' ? 'done' : 'idle';
      return {
        sessionId: row.sessionId, chatTitle, title: m.title ?? chatTitle, titleBy: m.by, ...(m.sure === undefined ? {} : { sure: m.sure }),
        index: i + 1, of: marks.length, startTurn: m.start, endTurn, ...(m.messageId ? { messageId: m.messageId } : {}), status,
        ...(ask ? { ask } : {}), ...(result ? { result } : {}), ...(latest && judging.has(row.sessionId) ? { checking: true as const } : {}),
        ...(latest && f.goal ? { goal: { phase: f.goal.phase, round: f.goal.round, max: f.goal.max } } : {}), ...(latest && f.todos ? { todos: f.todos } : {}),
        // When its last turn ended; while that turn runs, when it was asked (the row's updatedAt is the last prompt). The
        // phone counts a job as to check when this is later than the last time it showed the chat.
        at: end?.time ?? row.updatedAt,
      };
    });
  }

  return {
    event(sessionId, value) {
      if (closing.signal.aborted) return;
      const e = eventOf(value); if (!e) return;
      if (subagents.has(sessionId) || unrecorded.has(sessionId)) return;
      const pending = loading.get(sessionId);
      if (pending) { pending.buffer.push(e); return; }
      const r = store.chats[sessionId];
      if (!r) { load(sessionId, e); return; }
      apply(sessionId, r, e, true);
      save();
    },
    async list(phone) {
      // Given up by the phone (its request closed), the list stops and its reads are aborted. Past listMs it stops waiting:
      // what is not read by then shows with what the plugin has, and is read again on the next list.
      // After close() (a stop or reload) it reads nothing and writes nothing: a save would land after close() returned,
      // on a reload over the new instance's file. A close() while it runs stops it too.
      // The phone gets "unavailable", as for any request while the companion stops.
      const closed = () => { if (closing.signal.aborted) throw new HostError('unavailable'); };
      closed();
      const own = scope();
      try {
        const signal = AbortSignal.any([phone, own.signal, AbortSignal.timeout(listMs)]);
        // A row's `blank` comes from DSH's projection cache, which can be stale (0.2.1-rc.3 after a restart, 2026-11-13):
        // a chat this plugin has seen run a turn is not blank, whatever the row says.
        const all = await sources.sessions(signal);
        closed();
        // A record for a subagent row (its history read failed some other way, or an older plugin kept it) goes.
        let dropped = false;
        for (const row of all) if (row.origin === 'subagent' && typeof row.sessionId === 'string') { subagents.add(row.sessionId); if (store.chats[row.sessionId]) { delete store.chats[row.sessionId]; dropped = true; } }
        if (dropped) save();
        const rows = all.filter(row => row.origin !== 'subagent' && typeof row.sessionId === 'string' && (!row.blank || (store.chats[row.sessionId]?.turn ?? 0) > 0));
        const workspaces = await (sources.workspaces?.(signal) ?? Promise.resolve([])).catch(() => []);
        // First reads of chats with no record are the plugin's (later lists and the chat's events use them): a list stops
        // waiting for them, they go on until their read time limit. Facts are read alongside.
        const loads = Promise.all(rows.filter(row => !store.chats[row.sessionId] && !unrecorded.has(row.sessionId)).map(row => load(row.sessionId).done));
        const listed = Promise.all(rows.map(async row => ({ row, facts: await facts(row, signal) })));
        await until(Promise.all([loads, listed]), signal);
        phone.throwIfAborted(); closed();
        const groups = new Map<string, ProgressProject & { latest: number }>();
        for (const { row, facts: f } of await listed) {
          const cwd = row.cwd ?? '', workspace = workspaces.find(w => w.path === cwd);
          const group = groups.get(cwd) ?? { id: cwd, title: workspace?.title ?? (basename(cwd) || cwd), ...(workspace ? { workspaceId: workspace.id } : {}), chats: 0, jobs: [], latest: 0 };
          group.chats++; group.latest = Math.max(group.latest, row.updatedAt);
          group.jobs.push(...jobsOf(row, store.chats[row.sessionId] ?? newRecord(), f));
          groups.set(cwd, group);
        }
        const order = (g: { workspaceId?: string; latest: number }) => { const i = workspaces.findIndex(w => w.id === g.workspaceId); return i < 0 ? workspaces.length : i; };
        const projects = [...groups.values()].sort((a, b) => order(a) - order(b) || b.latest - a.latest).map(({ latest: _, ...p }) => p);
        return { judge: store.settings.judge, language: store.settings.language, chats: rows.length, needsYou: projects.reduce((n, p) => n + p.jobs.filter(j => j.status === 'needs-you').length, 0), projects };
      } finally { own.end(); }
    },
    settings: () => ({ ...store.settings }),
    async configure(change) {
      if (change.judge !== undefined && typeof change.judge !== 'boolean') throw new HostError('invalid_request');
      if (change.language !== undefined && !PROGRESS_LANGUAGES.includes(change.language)) throw new HostError('invalid_request');
      store.settings = { ...store.settings, ...change };
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = undefined; }
      await writeNext();
      return { ...store.settings };
    },
    async idle() { while (work.size) await Promise.all([...work]); await flush(); },
    async close() {
      if (closing.signal.aborted) return;
      closing.abort();
      await Promise.allSettled([...work]);
      await flush();
    },
  };
}
