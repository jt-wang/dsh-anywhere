// The Progress page's jobs: each chat split into the pieces of work the person asked for, grouped by working folder.
// Event shapes are DSH 0.2.2-rc.1's (session/event: turn/start, user/message, assistant/message, turn/end, tool/call,
// tool/result, approval/asked, goal/change, request/header). Every chat, folder and text here is made up.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createProgress } from '../src/progress.ts';
import type { JudgeInput, Progress, ProgressJob, ProgressRow, ProgressView } from '../src/progress.ts';

type Event = { seq: number; time: number; type: string; data: Record<string, unknown> };

/** A made-up DSH: chats with their event logs, list rows and projections, and a model that answers as told. */
function fakeDsh(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-progress-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logs = new Map<string, Event[]>(), rows = new Map<string, ProgressRow>(), projections = new Map<string, Record<string, unknown>>();
  const turns = new Map<string, number>(), unreadable = new Map<string, unknown>(), reads = new Map<string, number>(), unprojectable = new Set<string>(), held = new Map<string, Promise<void>>();
  let seq = 0, progress: Progress | undefined;
  /** Reads of history and projections out right now, the most at once, and how long each takes (ms). */
  const out = { now: 0, most: 0, ms: 0 };
  /** Every read with the signal it was given, to see which a given-up list aborted. */
  const given: { sessionId: string; kind: 'opening' | 'projections'; signal: AbortSignal }[] = [];
  const calls: JudgeInput[] = [];
  let answer: (input: JudgeInput) => Promise<string> = async () => '{"job":"same","sure":true}';
  const emit = (sessionId: string, type: string, data: Record<string, unknown>) => {
    const event = { seq: ++seq, time: 1_800_000_000_000 + seq * 1000, type, data };
    logs.get(sessionId)!.push(event);
    // As real DSH: a row's updatedAt is max(createdAt, lastPromptAt), and lastPromptAt moves only on a user/message whose
    // source is the person's (dsh-api-session-controller lib/index.js:1874 and :2124-2126 in 0.2.1-rc.3). An earlier
    // fake moved it on every event and hid a stale "needs you" and a wrong "to check".
    if (type === 'user/message' && (data.source as { kind?: string } | undefined)?.kind === 'user') rows.get(sessionId)!.updatedAt = event.time;
    progress?.event(sessionId, event);
    return event;
  };
  const dsh = {
    dir, calls, logs, rows, projections,
    /** opening() throws this for the chat. */
    unreadable, reads,
    /** projections() throws for the chat. */
    unprojectable,
    /** opening() waits for this before it answers. */
    held, out, given,
    answer(f: (input: JudgeInput) => Promise<string>) { answer = f; },
    chat(sessionId: string, cwd: string, title: string, extra: Partial<ProgressRow> = {}) {
      logs.set(sessionId, []); turns.set(sessionId, 0);
      rows.set(sessionId, { sessionId, cwd, title, running: false, updatedAt: 1_800_000_000_000, ...extra });
    },
    /** One turn: its message, the model route, a reply and how it ended (open: still running). */
    turn(sessionId: string, text: string, options: { kind?: string; reply?: string; reason?: string; open?: boolean; callId?: string } = {}) {
      const turn = turns.get(sessionId)! + 1; turns.set(sessionId, turn);
      emit(sessionId, 'turn/start', { turn });
      const message = emit(sessionId, 'user/message', { id: `m-${sessionId}-${turn}`, role: 'user', source: { kind: options.kind ?? 'user', ...(options.callId ? { callId: options.callId } : {}) }, content: [{ type: 'text', text }] });
      // As DSH's agent loop logs it (dsh-agent-loop lib/index.js:1030 in 0.2.2-rc.1, :1226 in 0.2.1-rc.3): the route under
      // `header.config`, once at the chat's first request, again only when the header changes. Seen in real-DSH run
      // receipts on 2026-11-13; an earlier fixture put it at `data.config` on every turn, and real DSH never judged.
      if (turn === 1) emit(sessionId, 'request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-flash', maxTokens: 256 } }, reason: 'initial' });
      if (options.reply !== undefined) emit(sessionId, 'assistant/message', { turn, step: 1, message: { id: `a-${sessionId}-${turn}`, role: 'assistant', content: [{ type: 'text', text: options.reply }] } });
      if (options.open) rows.get(sessionId)!.running = true;
      else emit(sessionId, 'turn/end', { turn, reason: { kind: options.reason ?? 'completed' } });
      return message;
    },
    emit,
    sources: {
      async sessions() { return [...rows.values()].map(row => ({ ...row })); },
      async opening(sessionId: string, signal?: AbortSignal) {
        if (signal) given.push({ sessionId, kind: 'opening', signal });
        reads.set(sessionId, (reads.get(sessionId) ?? 0) + 1); out.now++; out.most = Math.max(out.most, out.now);
        try { await held.get(sessionId); if (out.ms) await new Promise(r => setTimeout(r, out.ms)); if (unreadable.has(sessionId)) throw unreadable.get(sessionId); return [...(logs.get(sessionId) ?? [])]; } finally { out.now--; }
      },
      async projections(sessionId: string, signal?: AbortSignal) {
        if (signal) given.push({ sessionId, kind: 'projections', signal });
        out.now++; out.most = Math.max(out.most, out.now);
        try { if (out.ms) await new Promise(r => setTimeout(r, out.ms)); if (unprojectable.has(sessionId)) throw new Error('socket hang up'); return projections.get(sessionId) ?? {}; } finally { out.now--; }
      },
      async workspaces() { return [{ id: 'ws-web', title: 'web-app', path: '/work/web-app' }, { id: 'ws-api', title: 'acme-api', path: '/work/acme-api' }]; },
      async judge(input: JudgeInput) { calls.push(input); return answer(input); },
    },
    async start(options: { judgeTimeoutMs?: number; readTimeoutMs?: number; listMs?: number; log?: (message: string) => void } = {}) {
      progress = await createProgress({ dir, sources: dsh.sources, judgeTimeoutMs: options.judgeTimeoutMs ?? 2000, ...(options.readTimeoutMs ? { readTimeoutMs: options.readTimeoutMs } : {}), ...(options.listMs ? { listMs: options.listMs } : {}), ...(options.log ? { log: options.log } : {}) });
      t.after(() => progress?.close(), { timeout: 5000 }); // a close() that hangs fails the test instead of stalling the suite
      return progress;
    },
    async restart() { await progress!.close(); progress = undefined; return dsh.start(); },
  };
  return dsh;
}

const jobsOf = (view: ProgressView, sessionId: string): ProgressJob[] => view.projects.flatMap(p => p.jobs).filter(j => j.sessionId === sessionId).sort((a, b) => a.index - b.index);
const signal = () => AbortSignal.timeout(5000);

test('judging is off until the phone turns it on: every chat is one job and the model is never called', async t => {
  const dsh = fakeDsh(t); const progress = await dsh.start();
  assert.deepEqual(progress.settings(), { judge: false, language: 'en' });
  dsh.chat('c1', '/work/acme-api', 'Saved cards endpoint');
  dsh.turn('c1', 'Add a POST /cards endpoint', { reply: 'POST /cards is in.' });
  dsh.turn('c1', 'Now fix the Norway tax rate', { reply: 'Norway is 25% now.' });
  await progress.idle();
  assert.equal(dsh.calls.length, 0);
  const jobs = jobsOf(await progress.list(signal()), 'c1');
  assert.deepEqual(jobs.map(j => [j.title, j.titleBy, j.startTurn, j.endTurn]), [['Saved cards endpoint', 'chat', 1, 2]]);
});

test('the first message never calls the model; a new piece of work starts a new job at its turn', async t => {
  const dsh = fakeDsh(t); const progress = await dsh.start();
  await progress.configure({ judge: true, language: 'en' });
  dsh.chat('c1', '/work/acme-api', 'Saved cards endpoint');
  dsh.turn('c1', 'Add a POST /cards endpoint', { reply: 'POST /cards and GET /cards are in.\nDetails follow.' });
  await progress.idle();
  assert.equal(dsh.calls.length, 0, 'the first message is always a new job');
  dsh.answer(async () => '{"job":"same","sure":true}');
  dsh.turn('c1', 'Return 409 when the card is already saved', { reply: 'Done: 409 on duplicates.' });
  await progress.idle();
  dsh.answer(async () => '```json\n{"job":"new","title":"Fix Norway tax rate to 25%","sure":true}\n```');
  const third = dsh.turn('c1', 'Unrelated: the Norway tax rate is wrong, it should be 25%', { reply: 'Norway now uses 25%.' });
  await progress.idle();
  assert.equal(dsh.calls.length, 2);
  const jobs = jobsOf(await progress.list(signal()), 'c1');
  assert.deepEqual(jobs.map(j => [j.index, j.of, j.title, j.titleBy, j.startTurn, j.endTurn]), [
    [1, 2, 'Saved cards endpoint', 'chat', 1, 2],
    [2, 2, 'Fix Norway tax rate to 25%', 'judge', 3, 3],
  ]);
  assert.equal(jobs[1]!.messageId, third.data.id, 'opening the job lands on the message that started it');
  assert.equal(jobs[1]!.sure, true);
  assert.deepEqual(jobs[0]!.result, { turn: 2, text: 'Done: 409 on duplicates.' }, 'an earlier job keeps the result of its own last turn');
  assert.deepEqual([jobs[0]!.status, jobs[1]!.status], ['idle', 'done']);
});

test('answers to the agent and goal rounds are never judged; a DSH goal sets the job and its name', async t => {
  const dsh = fakeDsh(t); const progress = await dsh.start();
  await progress.configure({ judge: true, language: 'en' });
  dsh.chat('c1', '/work/infra', 'Postgres replica lag');
  dsh.turn('c1', 'Why is the replica lagging?', { reply: 'WAL replay is slow.' });
  dsh.turn('c1', 'us-east-1', { kind: 'user-question-reply', callId: 'call-1', reply: 'Using us-east-1.' });
  dsh.emit('c1', 'goal/change', { operation: 'create', goal: { id: 'g1', revision: 1, objective: 'Upgrade Postgres to 17', phase: 'active', maxGoalRounds: 8 }, roundsStarted: 0 });
  dsh.turn('c1', 'Continue working toward the goal', { kind: 'goal', reply: 'Round 1 done.' });
  dsh.turn('c1', 'Also check the extensions', { reply: 'Extensions are fine.' });
  await progress.idle();
  assert.equal(dsh.calls.length, 0, 'reply, goal round and a message inside a goal: none is judged');
  const jobs = jobsOf(await progress.list(signal()), 'c1');
  assert.deepEqual(jobs.map(j => [j.title, j.titleBy, j.startTurn, j.endTurn]), [['Postgres replica lag', 'chat', 1, 2], ['Upgrade Postgres to 17', 'goal', 3, 4]]);
});

test('a judgement that fails, times out or answers nonsense counts as the same job; the next message is judged again', async t => {
  const dsh = fakeDsh(t); const progress = await dsh.start({ judgeTimeoutMs: 100 });
  await progress.configure({ judge: true, language: 'en' });
  dsh.chat('c1', '/work/web-app', 'Checkout dark mode');
  dsh.turn('c1', 'Add dark mode to checkout', { reply: 'Done.' });
  dsh.answer(async () => { throw new Error('quota'); });
  dsh.turn('c1', 'Make the totals readable', { reply: 'Better contrast.' });
  await progress.idle();
  dsh.answer(input => new Promise((_, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason))));
  dsh.turn('c1', 'And the buttons', { reply: 'Buttons fixed.' });
  await progress.idle();
  dsh.answer(async () => 'I think this is a new job.');
  dsh.turn('c1', 'And the links', { reply: 'Links fixed.' });
  await progress.idle();
  assert.equal(jobsOf(await progress.list(signal()), 'c1').length, 1);
  dsh.answer(async () => '{"job":"new","title":"Address autocomplete","sure":false}');
  dsh.turn('c1', 'Add address autocomplete to the form', { reply: 'Autocomplete works for 12 countries.' });
  await progress.idle();
  assert.equal(dsh.calls.length, 4);
  const jobs = jobsOf(await progress.list(signal()), 'c1');
  assert.deepEqual(jobs.map(j => [j.title, j.startTurn, j.sure]), [['Checkout dark mode', 1, undefined], ['Address autocomplete', 5, false]]);
});

test('while a judgement is out, the newest job says so', async t => {
  const dsh = fakeDsh(t); const progress = await dsh.start();
  await progress.configure({ judge: true, language: 'en' });
  dsh.chat('c1', '/work/infra', 'CI cache cleanup');
  dsh.turn('c1', 'Clean the CI cache', { reply: 'Cleaned.' });
  let release!: (text: string) => void;
  dsh.answer(() => new Promise(resolve => { release = resolve; }));
  dsh.turn('c1', 'Remove the old runners too', { open: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(jobsOf(await progress.list(signal()), 'c1').at(-1)!.checking, true);
  release('{"job":"new","title":"Remove old CI runners","sure":true}');
  await progress.idle();
  const jobs = jobsOf(await progress.list(signal()), 'c1');
  assert.deepEqual(jobs.map(j => [j.title, j.checking, j.status]), [['CI cache cleanup', undefined, 'idle'], ['Remove old CI runners', undefined, 'running']]);
});

test('the split and the setting are kept in the plugin’s own file and read back after a restart', async t => {
  const dsh = fakeDsh(t); const progress = await dsh.start();
  await progress.configure({ judge: true, language: 'zh-Hans' });
  dsh.chat('c1', '/work/acme-api', '保存银行卡的接口');
  dsh.turn('c1', '加一个 POST /cards 接口', { reply: '加好了。' });
  dsh.answer(async () => '{"job":"new","title":"排查数据库连接池耗尽问题","sure":true}');
  dsh.turn('c1', '另外，线上报连接池耗尽了', { reply: '连接没有释放。' });
  await progress.idle();
  const before = jobsOf(await progress.list(signal()), 'c1');
  const file = join(dsh.dir, 'jobs.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.match(readFileSync(file, 'utf8'), /排查数据库连接池耗尽问题/);
  const again = await dsh.restart();
  assert.deepEqual(again.settings(), { judge: true, language: 'zh-Hans' });
  assert.deepEqual(jobsOf(await again.list(signal()), 'c1'), before);
  assert.match(dsh.calls[0]!.system, /Simplified Chinese/);
});

test('each job’s state: needs you with the question as asked, done with its result’s first line, running, idle', async t => {
  const dsh = fakeDsh(t); const progress = await dsh.start();
  dsh.chat('ask', '/work/acme-api', 'Move billing to the v2 API');
  dsh.turn('ask', 'Move billing to v2', { open: true });
  dsh.emit('ask', 'tool/call', { turn: 1, step: 1, callId: 'q1', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'run', question: 'Run the migration on staging now?', options: [{ label: 'Run it' }, { label: 'Not yet' }] }] }) });
  dsh.chat('answered', '/work/acme-api', 'Billing client tests');
  dsh.turn('answered', 'Write the tests', { open: true });
  dsh.emit('answered', 'tool/call', { turn: 1, step: 1, callId: 'q2', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'x', question: 'Which region?' }] }) });
  dsh.emit('answered', 'tool/result', { turn: 1, step: 1, message: { id: 'r', role: 'tool', toolCallId: 'q2', content: [{ type: 'text', text: 'us-east-1' }] } });
  dsh.chat('allow', '/work/web-app', 'Fix flaky checkout test');
  dsh.turn('allow', 'Fix the flaky test', { open: true });
  dsh.emit('allow', 'approval/asked', { id: 'ap1', toolName: 'bash', callId: 'b1', reason: 'npx playwright install chromium' });
  dsh.chat('blocked', '/work/infra', 'Nightly backup check');
  dsh.turn('blocked', 'Check the nightly backup', { reply: 'Blocked.' });
  dsh.projections.set('blocked', { goal: { goal: { id: 'g', revision: 2, objective: 'Nightly backup check', phase: 'blocked', maxGoalRounds: 5, blockedReason: { code: 'needs-human', message: 'the backup bucket says access denied' } }, roundsStarted: 2 } });
  dsh.chat('done', '/work/infra', 'Rotate API keys');
  dsh.turn('done', 'Rotate the keys', { reply: '\n  Keys rotated in all 3 services. The old keys stop working on Nov 12.\n\nDetails below.' });
  dsh.chat('failed', '/work/infra', 'Remove old CI runners');
  dsh.turn('failed', 'Remove them', { reply: 'Partial.', reason: 'error' });
  dsh.projections.set('failed', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }] });
  const view = await progress.list(signal());
  const one = (id: string) => jobsOf(view, id)[0]!;
  assert.deepEqual([one('ask').status, one('ask').ask], ['needs-you', { kind: 'question', text: 'Run the migration on staging now?' }]);
  assert.equal(one('answered').status, 'running', 'a question with a result is answered');
  assert.deepEqual([one('allow').status, one('allow').ask], ['needs-you', { kind: 'approval', text: 'npx playwright install chromium', tool: 'bash' }]);
  assert.deepEqual([one('blocked').status, one('blocked').ask, one('blocked').goal], ['needs-you', { kind: 'goal', text: 'the backup bucket says access denied' }, { phase: 'blocked', round: 2, max: 5 }]);
  assert.deepEqual([one('done').status, one('done').result], ['done', { turn: 1, text: 'Keys rotated in all 3 services. The old keys stop working on Nov 12.' }]);
  assert.deepEqual([one('failed').status, one('failed').result, one('failed').todos], ['idle', undefined, { done: 1, total: 3 }]);
  assert.equal(view.needsYou, 3);
});

test('projects are the chats’ working folders, in DSH’s workspace order and names; subagents and blank chats stay out', async t => {
  const dsh = fakeDsh(t); const progress = await dsh.start();
  dsh.chat('a1', '/work/acme-api', 'Saved cards endpoint'); dsh.turn('a1', 'go', { reply: 'ok' });
  dsh.chat('w1', '/work/web-app', 'Checkout dark mode'); dsh.turn('w1', 'go', { reply: 'ok' });
  dsh.chat('w2', '/work/web-app', 'Saved cards UI'); dsh.turn('w2', 'go', { reply: 'ok' });
  dsh.chat('x1', '/work/scratch', 'Try a thing'); dsh.turn('x1', 'go', { reply: 'ok' });
  dsh.chat('sub', '/work/web-app', 'Explore the repo', { origin: 'subagent' }); dsh.turn('sub', 'go', { reply: 'ok' });
  dsh.chat('blank', '/work/web-app', 'New chat', { blank: true });
  const view = await progress.list(signal());
  assert.deepEqual(view.projects.map(p => [p.title, p.workspaceId, p.chats, p.jobs.map(j => j.sessionId).sort()]), [
    ['web-app', 'ws-web', 2, ['w1', 'w2']], ['acme-api', 'ws-api', 1, ['a1']], ['scratch', undefined, 1, ['x1']],
  ]);
  assert.equal(view.chats, 4);
});

test('a chat the plugin never heard about is read from its history: one job, split where its goals start', async t => {
  const dsh = fakeDsh(t);
  dsh.chat('old', '/work/infra', 'Seed data for billing staging');
  dsh.turn('old', 'Seed the staging database', { reply: 'Staging seeded with 40 customers and 1,300 invoices.' });
  dsh.emit('old', 'goal/change', { operation: 'create', goal: { id: 'g1', revision: 1, objective: 'Dry run of the invoice backfill', phase: 'active', maxGoalRounds: 3 }, roundsStarted: 0 });
  dsh.turn('old', 'goal round', { kind: 'goal', reply: 'Backfill dry run on staging: 1,284 invoices, totals match.' });
  const progress = await dsh.start();
  const jobs = jobsOf(await progress.list(signal()), 'old');
  assert.deepEqual(jobs.map(j => [j.title, j.titleBy, j.startTurn, j.endTurn, j.result?.text]), [
    ['Seed data for billing staging', 'chat', 1, 1, 'Staging seeded with 40 customers and 1,300 invoices.'],
    ['Dry run of the invoice backfill', 'goal', 2, 2, 'Backfill dry run on staging: 1,284 invoices, totals match.'],
  ]);
  assert.equal(dsh.calls.length, 0, 'history is never judged');
});

test('the judgement sees the folder, earlier jobs, the current job’s requests and the agent’s last reply, on the chat’s own model', async t => {
  const dsh = fakeDsh(t); const progress = await dsh.start();
  await progress.configure({ judge: true, language: 'en' });
  dsh.chat('c1', '/work/acme-api', 'Saved cards endpoint');
  dsh.turn('c1', 'Add a POST /cards endpoint that stores a Stripe payment method', { reply: 'POST /cards and GET /cards are in, with 12 tests passing.\nMore.' });
  dsh.turn('c1', 'Rename the field to card_id');
  await progress.idle();
  const input = dsh.calls[0]!;
  assert.deepEqual(input.route, { provider: 'deepseek', model: 'deepseek-flash' });
  assert.match(input.system, /Write the title in English/);
  assert.equal(input.user, [
    'Folder: acme-api', 'Earlier jobs: none', 'Current job: Saved cards endpoint (turns 1–1)', 'The user asked in it:',
    '- Add a POST /cards endpoint that stores a Stripe payment method', 'Agent\'s last reply starts: POST /cards and GET /cards are in, with 12 tests passing.', '',
    'New message: Rename the field to card_id',
  ].join('\n'));
});

// DSH 0.2.1-rc.3 after a restart (observed 2026-11-13): the list
// rows of cold chats come from dsh-session-projection-cache, which had stopped at the chat's creation — `blank: true`
// and no title — or had no entry at all. sessionController.projections() per chat still reads the chat itself.
test('after a restart, stale list rows (blank, no title) do not hide or unname chats the plugin saw run', async t => {
  const dsh = fakeDsh(t); let progress = await dsh.start();
  await progress.configure({ judge: true });
  dsh.answer(async input => (input.user.includes('Now rotate') ? '{"job":"new","title":"Rotate the webhook secret","sure":true}' : '{"job":"same","sure":true}'));
  dsh.chat('billing', '/work/acme-api', 'Move billing to the v2');
  dsh.turn('billing', 'Move billing to the v2 API', { reply: 'Moved.' });
  dsh.turn('billing', 'Now rotate the webhook secret', { reply: 'Rotated.' });
  dsh.chat('seed', '/work/acme-api', 'Seed the staging database');
  dsh.turn('seed', 'Seed the staging database with made-up customers\nand invoices', { reply: 'Seeded.' });
  dsh.chat('empty', '/work/acme-api', '', { blank: true });
  await progress.idle();

  progress = await dsh.restart();
  for (const id of ['billing', 'seed']) Object.assign(dsh.rows.get(id)!, { blank: true, title: '' });
  dsh.projections.set('billing', { title: 'Move billing to the v2' }); // DSH still knows this one's name per chat
  const view = await progress.list(signal());
  assert.deepEqual(jobsOf(view, 'billing').map(j => [j.chatTitle, j.title, j.titleBy]), [['Move billing to the v2', 'Move billing to the v2', 'chat'], ['Move billing to the v2', 'Rotate the webhook secret', 'judge']]);
  assert.deepEqual(jobsOf(view, 'seed').map(j => [j.chatTitle, j.title]), [['Seed the staging database with made-up customers', 'Seed the staging database with made-up customers']]);
  assert.deepEqual(jobsOf(view, 'empty'), [], 'a chat that never ran is still left out');
  assert.equal(view.chats, 2);
});

// An Agent Teams teammate is a subagent Session with a list row of its own (origin: subagent, parent the Lead). DSH
// refuses to read its history at a plain session address: RemoteError code session/agent-busy, details.reason "use
// subagent delivery for this child session" (dsh-api-session-controller lib/index.js:1156 in 0.2.2-rc.1, :1693 in
// 0.2.1-rc.3; met on real DSH, 2026-11-13).
const subagentRefusal = () => Object.assign(new Error('subagent Sessions require their durable parent address'), { code: 'session/agent-busy', details: { reason: 'use subagent delivery for this child session' }, isDSHRemoteError: true });
const recorded = (dsh: ReturnType<typeof fakeDsh>) => Object.keys(JSON.parse(readFileSync(join(dsh.dir, 'jobs.json'), 'utf8')).chats).sort();

test('a teammate DSH will not let us read is not recorded; an ordinary chat whose history read fails still is', async t => {
  const dsh = fakeDsh(t); const progress = await dsh.start();
  dsh.chat('lead', '/work/acme-api', 'Billing v2 lead'); dsh.turn('lead', 'Split the review', { reply: 'Team started.' });
  dsh.chat('mate', '/work/acme-api', 'REVIEW: read the plan', { origin: 'subagent' }); dsh.unreadable.set('mate', subagentRefusal());
  dsh.turn('mate', 'REVIEW: read the plan', { reply: 'Sent my finding.' });
  await progress.idle();
  dsh.turn('mate', 'Team message from lead: also check the rollback', { kind: 'agent-message', reply: 'Checked.' });
  dsh.chat('flaky', '/work/web-app', 'Fix flaky checkout test'); dsh.unreadable.set('flaky', new Error('socket hang up'));
  dsh.turn('flaky', 'Fix the flaky checkout test', { reply: 'It waits for the order row now.' });
  await progress.idle();
  assert.deepEqual(recorded(dsh), ['flaky', 'lead'], 'no record for the teammate; the chat whose read failed for another reason keeps one');
  const view = await progress.list(signal());
  // Listed with its name; its state comes from the history read at list time, which fails here too, so it shows idle.
  assert.deepEqual(jobsOf(view, 'flaky').map(j => j.title), ['Fix flaky checkout test']);
  assert.deepEqual(jobsOf(view, 'mate'), []);
  assert.equal(dsh.reads.get('mate'), 1, 'asked once: later events of a refused teammate are not read again');
});

test('a record left for a subagent row (its read failed some other way, or from an older plugin) goes when the list shows it', async t => {
  const dsh = fakeDsh(t); const progress = await dsh.start();
  dsh.chat('lead', '/work/acme-api', 'Billing v2 lead'); dsh.turn('lead', 'Split the review', { reply: 'Team started.' });
  dsh.chat('mate', '/work/acme-api', 'REVIEW: read the plan', { origin: 'subagent' }); dsh.unreadable.set('mate', new Error('socket hang up'));
  dsh.turn('mate', 'REVIEW: read the plan', { reply: 'Sent my finding.' });
  await progress.idle();
  assert.deepEqual(recorded(dsh), ['lead', 'mate'], 'precondition: a failed read that is not the subagent refusal still records');
  const view = await progress.list(signal()); await progress.idle();
  assert.equal(view.chats, 1);
  assert.deepEqual(recorded(dsh), ['lead']);
});

test('a question or approval asked mid-turn, after the page listed the running turn, shows as needs you', async t => {
  const dsh = fakeDsh(t); const progress = await dsh.start();
  dsh.chat('q', '/work/acme-api', 'Move billing to the v2 API'); dsh.turn('q', 'Move billing to v2', { open: true });
  dsh.chat('a', '/work/web-app', 'Browser tests'); dsh.turn('a', 'Set up the browser tests', { open: true });
  const before = await progress.list(signal());
  assert.deepEqual([jobsOf(before, 'q')[0]!.status, jobsOf(before, 'a')[0]!.status, before.needsYou], ['running', 'running', 0]);
  dsh.emit('q', 'tool/call', { turn: 1, step: 2, callId: 'q1', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'run', question: 'Run the migration on staging now?' }] }) });
  dsh.emit('a', 'approval/asked', { id: 'ap1', toolName: 'bash', callId: 'b1', reason: 'npx playwright install chromium' });
  await progress.idle();
  const after = await progress.list(signal());
  assert.deepEqual(jobsOf(after, 'q').map(j => [j.status, j.ask]), [['needs-you', { kind: 'question', text: 'Run the migration on staging now?' }]]);
  assert.deepEqual(jobsOf(after, 'a').map(j => [j.status, j.ask]), [['needs-you', { kind: 'approval', text: 'npx playwright install chromium', tool: 'bash' }]]);
  assert.equal(after.needsYou, 2);
});

test('a finished job is dated by when its turn ended, not when it was asked, so the phone can tell it finished after it last looked', async t => {
  const dsh = fakeDsh(t); const progress = await dsh.start();
  dsh.chat('c', '/work/acme-api', 'Backfill old invoices');
  const asked = dsh.turn('c', 'Backfill the old invoices', { open: true });
  const running = jobsOf(await progress.list(signal()), 'c')[0]!;
  assert.deepEqual([running.status, running.at], ['running', asked.time], 'a running job: when it was asked');
  // The phone opened the chat, sent this, and left it (markSeen at leaving, after asked.time); the turn ends later.
  dsh.emit('c', 'assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '1,284 invoices moved to v2.' }] } });
  const end = dsh.emit('c', 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  dsh.rows.get('c')!.running = false;
  await progress.idle();
  const done = jobsOf(await progress.list(signal()), 'c')[0]!;
  assert.deepEqual([done.status, done.at], ['done', end.time]);
  assert.ok(done.at > asked.time);
});

test('a history or projections read that fails while listing is not kept: the next list reads the chat again', async t => {
  const dsh = fakeDsh(t); const progress = await dsh.start();
  dsh.chat('h', '/work/acme-api', 'Backfill old invoices'); dsh.turn('h', 'Backfill the old invoices', { reply: '1,284 invoices moved to v2.' });
  dsh.chat('p', '/work/web-app', 'Saved cards UI'); dsh.turn('p', 'Add the saved cards list', { reply: 'The list is in.' });
  dsh.projections.set('p', { title: 'Saved cards list' });
  await progress.idle();
  dsh.unreadable.set('h', new Error('socket hang up')); dsh.unprojectable.add('p');
  const failed = await progress.list(signal());
  assert.deepEqual([jobsOf(failed, 'h')[0]!.status, jobsOf(failed, 'p')[0]!.chatTitle], ['idle', 'Saved cards UI'], 'precondition: the failed reads show');
  dsh.unreadable.delete('h'); dsh.unprojectable.delete('p');
  const again = await progress.list(signal());
  assert.deepEqual(jobsOf(again, 'h').map(j => [j.status, j.result?.text]), [['done', '1,284 invoices moved to v2.']]);
  assert.equal(jobsOf(again, 'p')[0]!.chatTitle, 'Saved cards list');
});

test('past the 2,000-chat limit a new chat is read once, not on every event or list', async t => {
  const dsh = fakeDsh(t);
  const chats: Record<string, unknown> = {};
  for (let i = 0; i < 2000; i++) chats[`old${i}`] = { marks: [{ start: 1, by: 'chat' }], turn: 1, open: false, asked: [], lastSeq: 1 };
  writeFileSync(join(dsh.dir, 'jobs.json'), JSON.stringify({ version: 1, settings: { judge: false, language: 'en' }, chats }));
  const progress = await dsh.start();
  dsh.chat('new', '/work/acme-api', 'Rotate API keys');
  dsh.turn('new', 'Rotate the API keys', { open: true }); await progress.idle();
  for (let i = 0; i < 10; i++) { dsh.emit('new', 'tool/result', { turn: 1, step: i + 1, message: { id: `r${i}`, role: 'tool', toolCallId: `c${i}`, content: [] } }); await progress.idle(); }
  assert.equal(dsh.reads.get('new'), 1, 'read once when first heard, not again for each of the 10 events');
  const view = await progress.list(signal()); await progress.list(signal());
  assert.deepEqual(jobsOf(view, 'new').map(j => [j.title, j.status]), [['Rotate API keys', 'running']], 'still listed');
  // Each list may read its facts once (a second, unchanged one hits the cache); none loads it again.
  assert.ok(dsh.reads.get('new')! <= 3, `reads after two lists: ${dsh.reads.get('new')}`);
});

test('a subagent whose first history read is still out when the list marks it gets no record when the read comes back', async t => {
  const dsh = fakeDsh(t); const progress = await dsh.start();
  dsh.chat('lead', '/work/acme-api', 'Billing v2 lead'); dsh.turn('lead', 'Split the review', { reply: 'Team started.' });
  dsh.chat('mate', '/work/acme-api', 'REVIEW: read the plan', { origin: 'subagent' });
  let release!: () => void; dsh.held.set('mate', new Promise<void>(resolve => { release = resolve; }));
  dsh.emit('mate', 'turn/start', { turn: 1 });   // its first event: the history read starts and waits
  await progress.list(signal());                  // the list sees the subagent row; no record to drop yet
  release(); await progress.idle();               // the read comes back (not refused: it could have timed out instead)
  assert.deepEqual(recorded(dsh), ['lead']);
});

test('settings changed while other writes are out all land, and the file stays whole', async t => {
  const dsh = fakeDsh(t); const progress = await dsh.start();
  dsh.chat('c', '/work/acme-api', 'Backfill old invoices'); dsh.turn('c', 'Backfill the old invoices', { reply: 'Done.' }); // a write is due
  await Promise.all([progress.configure({ judge: true }), progress.configure({ language: 'zh-Hans' })]);
  await progress.idle();
  const file = JSON.parse(readFileSync(join(dsh.dir, 'jobs.json'), 'utf8'));
  assert.deepEqual([file.settings, Object.keys(file.chats)], [{ judge: true, language: 'zh-Hans' }, ['c']]);
  assert.deepEqual(readdirSync(dsh.dir).filter(n => n.endsWith('.tmp')), [], 'no temporary file left');
});

test('an unreadable jobs.json is kept aside under another name and logged, then the plugin starts over', async t => {
  const dsh = fakeDsh(t);
  writeFileSync(join(dsh.dir, 'jobs.json'), '{"version":1,"settings":{"judge":tr');
  const logged: string[] = [];
  const progress = await dsh.start({ log: m => logged.push(m) });
  assert.deepEqual(progress.settings(), { judge: false, language: 'en' });
  const kept = readdirSync(dsh.dir).filter(n => n.startsWith('jobs.json.unreadable-'));
  assert.equal(kept.length, 1, `kept: ${readdirSync(dsh.dir)}`);
  assert.equal(readFileSync(join(dsh.dir, kept[0]!), 'utf8'), '{"version":1,"settings":{"judge":tr');
  assert.equal(logged.length, 1); assert.match(logged[0]!, /jobs\.json\.unreadable-/);
  dsh.chat('c', '/work/acme-api', 'Backfill old invoices'); dsh.turn('c', 'Backfill the old invoices', { reply: 'Done.' });
  await progress.idle();
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dsh.dir, 'jobs.json'), 'utf8')).chats), ['c']);
});

// The first list after a start reads every chat it has no record of, and read them all at once.
test('the first list has at most 8 reads out at a time', async t => {
  const dsh = fakeDsh(t);
  for (let i = 0; i < 30; i++) { dsh.chat(`c${i}`, '/work/acme-api', `Chat ${i}`); dsh.turn(`c${i}`, `Task ${i}`, { reply: 'Done.' }); }
  const progress = await dsh.start(); dsh.out.ms = 10;
  const view = await progress.list(signal());
  assert.equal(view.chats, 30);
  assert.ok(dsh.out.most <= 8, `reads out at once: ${dsh.out.most}`);
});

test('a read that never answers does not hold the list, and the chat is read again on the next list', { timeout: 5000 }, async t => {
  const dsh = fakeDsh(t);
  dsh.chat('stuck', '/work/acme-api', 'Backfill old invoices'); dsh.turn('stuck', 'Backfill the old invoices', { reply: '1,284 invoices moved to v2.' });
  dsh.chat('ok', '/work/web-app', 'Saved cards UI'); dsh.turn('ok', 'Add the saved cards list', { reply: 'The list is in.' });
  let release!: () => void; dsh.held.set('stuck', new Promise<void>(resolve => { release = resolve; }));
  t.after(() => release()); // before close(), which waits for the read
  const progress = await dsh.start({ readTimeoutMs: 100 });
  const first = await progress.list(signal());
  assert.deepEqual(jobsOf(first, 'ok').map(j => j.status), ['done']);
  assert.deepEqual(jobsOf(first, 'stuck').map(j => j.title), ['Backfill old invoices'], 'still listed');
  release(); dsh.held.delete('stuck');
  const again = await progress.list(signal());
  assert.deepEqual(jobsOf(again, 'stuck').map(j => [j.status, j.result?.text]), [['done', '1,284 invoices moved to v2.']]);
  await progress.idle();
  assert.deepEqual(recorded(dsh), ['ok', 'stuck']);
});

// The route came only from a request/header in the history the plugin read, the last 100 messages
// (progress-dsh.ts). DSH logs it at the first request and again only when it changes, so a long chat first heard after
// a restart had none and was never judged. DSH's modelSelection projection ({ lastUsed, next }, each { provider, model,
// reasoningEffort? }: dsh-agent lib/index.js:140-173 in 0.2.2-rc.1, dsh-api-session-controller lib/index.js:2173-2190
// in 0.2.1-rc.3) has the route the chat's next request takes, a model the person just switched to included.
test('the judgement takes the chat’s route from DSH’s modelSelection, also when no request header is in the history read', async t => {
  const dsh = fakeDsh(t);
  dsh.chat('long', '/work/acme-api', 'Saved cards endpoint'); dsh.turn('long', 'Add a POST /cards endpoint', { reply: 'Done.' });
  dsh.logs.set('long', dsh.logs.get('long')!.filter(e => e.type !== 'request/header')); // its header is older than what was read
  dsh.projections.set('long', { modelSelection: { lastUsed: { provider: 'deepseek', model: 'deepseek-flash' }, next: { provider: 'deepseek', model: 'deepseek-flash' } } });
  dsh.chat('switched', '/work/web-app', 'Saved cards UI'); dsh.turn('switched', 'Add the saved cards list', { reply: 'Done.' });
  dsh.projections.set('switched', { modelSelection: { lastUsed: { provider: 'deepseek', model: 'deepseek-flash' }, next: { provider: 'deepseek', model: 'deepseek-pro', reasoningEffort: 'high' } } });
  const progress = await dsh.start();
  await progress.configure({ judge: true });
  await progress.list(signal()); await progress.idle(); // both read from their history, after the restart
  dsh.turn('long', 'Rename the field to card_id'); dsh.turn('switched', 'Now the empty state');
  await progress.idle();
  const routes = Object.fromEntries(dsh.calls.map(c => [c.user.includes('card_id') ? 'long' : 'switched', c.route]));
  assert.deepEqual(routes, { long: { provider: 'deepseek', model: 'deepseek-flash' }, switched: { provider: 'deepseek', model: 'deepseek-pro' } });
});

/** Whether `p` settles within `ms` (a hang is a failed assertion, not a stuck suite). */
const within = (p: Promise<unknown>, ms: number) => Promise.race([p.then(() => true, () => true), new Promise<boolean>(r => setTimeout(() => r(false), ms))]);

// A read waiting for one of the 8 slots, woken after its list was given up, threw without passing the
// wakeup on; the waiters behind it were never woken, and every later list, judgement and close() hung.
test('a list given up while reads wait for a slot does not hold later lists', { timeout: 10_000 }, async t => {
  const dsh = fakeDsh(t);
  for (let i = 0; i < 30; i++) { dsh.chat(`c${i}`, '/work/acme-api', `Chat ${i}`); dsh.turn(`c${i}`, `Task ${i}`, { reply: 'Done.' }); }
  const progress = await dsh.start(); dsh.out.ms = 20;
  await progress.list(signal()); // loads and caches all 30
  for (let i = 0; i < 30; i++) dsh.emit(`c${i}`, 'tool/result', { turn: 1, step: 2, message: { id: `r${i}`, role: 'tool', toolCallId: `x${i}`, content: [] } });
  await progress.idle(); // a new event per chat: the next list reads all 60 facts again
  const given = new AbortController();
  const a = progress.list(given.signal);
  await new Promise(r => setTimeout(r, 5));
  given.abort(new Error('the phone went away'));
  assert.equal(await within(a, 1000), true, 'the list given up settles');
  const b = progress.list(signal());
  assert.equal(await within(b, 3000), true, 'a later list settles');
  assert.equal((await b).chats, 30);
});

test('close() during a first list with reads waiting for a slot finishes', { timeout: 10_000 }, async t => {
  const dsh = fakeDsh(t);
  for (let i = 0; i < 30; i++) { dsh.chat(`c${i}`, '/work/acme-api', `Chat ${i}`); dsh.turn(`c${i}`, `Task ${i}`, { reply: 'Done.' }); }
  const progress = await dsh.start(); dsh.out.ms = 50;
  void progress.list(signal()).catch(() => {});
  await new Promise(r => setTimeout(r, 5));
  assert.equal(await within(progress.close(), 3000), true, 'close() settles');
});

/** The chats in jobs.json now: none when there is no file yet. */
const stored = (dir: string): Record<string, { marks: unknown[] }> => readdirSync(dir).includes('jobs.json') ? JSON.parse(readFileSync(join(dir, 'jobs.json'), 'utf8')).chats : {};

// close() aborts the first reads still out or waiting for a slot. Each fell through to "live events only",
// so an empty record was saved for the chat, and after a restart a chat with a record is never read back: its goal
// jobs and first message were gone for good.
test('close() during a first list saves no record for the chats it had not read; after a restart they are read back', { timeout: 10_000 }, async t => {
  const dsh = fakeDsh(t);
  for (let i = 0; i < 20; i++) {
    dsh.chat(`c${i}`, '/work/acme-api', `Chat ${i}`); dsh.turn(`c${i}`, `Task ${i}`, { reply: 'Done.' });
    dsh.emit(`c${i}`, 'goal/change', { operation: 'create', goal: { id: `g${i}`, objective: `Goal ${i}`, phase: 'active' } });
  }
  const progress = await dsh.start(); dsh.out.ms = 200;
  void progress.list(signal()).catch(() => {});
  await new Promise(r => setTimeout(r, 20));
  await progress.close();
  assert.deepEqual(Object.entries(stored(dsh.dir)).filter(([, r]) => !r.marks.length).map(([id]) => id), [], 'no empty records');
  dsh.out.ms = 0;
  const again = await dsh.start();
  const view = await again.list(signal());
  for (let i = 0; i < 20; i++) assert.deepEqual(jobsOf(view, `c${i}`).map(j => [j.title, j.titleBy]), [[`Chat ${i}`, 'chat'], [`Goal ${i}`, 'goal']], `c${i}`);
});

// A list after close() (one in flight when the companion stops) still read chats and wrote jobs.json.
test('a list after close() writes no records', async t => {
  const dsh = fakeDsh(t);
  for (const id of ['x1', 'x2']) { dsh.chat(id, '/work/acme-api', id); dsh.turn(id, 'Task', { reply: 'Done.' }); }
  const progress = await dsh.start();
  await progress.close();
  await progress.list(signal()).catch(() => {});
  await new Promise(r => setTimeout(r, 200)); // past the 50 ms a save waits
  assert.deepEqual(Object.keys(stored(dsh.dir)), []);
});

// A list after close() still dropped a subagent row's record and saved, and
// that write landed after close() had returned (on a reload, over the new instance's file); it also read DSH.
test('a list after close() neither changes jobs.json nor reads DSH, also when it would drop a subagent record', async t => {
  const dsh = fakeDsh(t); const progress = await dsh.start();
  dsh.chat('lead', '/work/acme-api', 'Billing v2 lead'); dsh.turn('lead', 'Split the review', { reply: 'Team started.' });
  dsh.chat('mate', '/work/acme-api', 'REVIEW: read the plan', { origin: 'subagent' }); dsh.unreadable.set('mate', new Error('socket hang up'));
  dsh.turn('mate', 'REVIEW: read the plan', { reply: 'Sent my finding.' });
  await progress.idle();
  await progress.close();
  assert.deepEqual(Object.keys(stored(dsh.dir)).sort(), ['lead', 'mate'], 'precondition: the subagent row has a record');
  dsh.chat('new', '/work/acme-api', 'Not read yet'); dsh.turn('new', 'Task', { reply: 'Done.' });
  const file = readFileSync(join(dsh.dir, 'jobs.json'), 'utf8'), reads = dsh.given.length;
  await assert.rejects(progress.list(signal()), { code: 'unavailable' });
  await new Promise(r => setTimeout(r, 200)); // past the 50 ms a save waits
  assert.equal(readFileSync(join(dsh.dir, 'jobs.json'), 'utf8'), file, 'jobs.json unchanged');
  assert.deepEqual(dsh.given.slice(reads).map(g => `${g.sessionId} ${g.kind}`), [], 'no reads after close()');
});

// A first read that answered just as close() began went on to apply what it had heard;
// a new message in it started a judgement that close() did not wait for, and that judgement wrote jobs.json after close()
// returned. Its race also missed an abort that had already happened, so it waited for the model.
test('a judgement started as close() begins writes nothing after close() returned', { timeout: 20_000 }, async t => {
  const changed: number[] = [];
  for (let hops = 0; hops <= 6; hops++) {
    const dsh = fakeDsh(t); const progress = await dsh.start(); await progress.configure({ judge: true });
    const opening = dsh.sources.opening;
    let open!: () => void; const gate = new Promise<void>(r => { open = r; });
    let closed: Promise<void> | undefined;
    // close() comes `hops` microtasks after the first read answers.
    dsh.sources.opening = async (sessionId: string, signal?: AbortSignal) => {
      await gate;
      const events = await opening(sessionId, signal);
      let later = Promise.resolve(); for (let i = 0; i < hops; i++) later = later.then(() => {});
      void later.then(() => { closed ??= progress.close(); });
      return events;
    };
    dsh.sources.judge = async () => { await new Promise(r => setTimeout(r, 30)); return '{"job":"new","title":"Another piece of work","sure":true}'; };
    dsh.chat('c1', '/work/acme-api', 'Saved cards');
    dsh.turn('c1', 'Add a POST /cards endpoint', { reply: 'POST /cards is in.' });
    dsh.turn('c1', 'Now fix the Norway tax rate', { reply: 'Norway is 25% now.' }); // heard while the first read is out
    open();
    while (!closed) await new Promise(r => setTimeout(r, 1));
    await closed;
    const atClose = readdirSync(dsh.dir).includes('jobs.json') ? readFileSync(join(dsh.dir, 'jobs.json'), 'utf8') : '';
    await new Promise(r => setTimeout(r, 200)); // past the judge's 30 ms and the 50 ms a save waits
    const after = readdirSync(dsh.dir).includes('jobs.json') ? readFileSync(join(dsh.dir, 'jobs.json'), 'utf8') : '';
    if (after !== atClose) changed.push(hops);
  }
  assert.deepEqual(changed, [], 'jobs.json changed after close() returned, with close() this many microtasks after the read');
});

// A previous change also stopped a judgement already running when close() came, before it saved,
// so the message it was judging was lost from what the chat was asked (`asked`, which later judgements read). close()
// waits for that judgement; the message counts as the same job and is kept.
test('a judgement running when close() comes keeps its message, as the same job', { timeout: 10_000 }, async t => {
  const dsh = fakeDsh(t); const progress = await dsh.start(); await progress.configure({ judge: true });
  dsh.chat('c1', '/work/acme-api', 'Saved cards');
  dsh.turn('c1', 'Add a POST /cards endpoint', { reply: 'POST /cards is in.' });
  await progress.idle();
  let asked = false;
  // A model that answers only when its signal aborts.
  dsh.sources.judge = ({ signal }: JudgeInput) => { asked = true; return new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); };
  dsh.turn('c1', 'Now fix the Norway tax rate', { reply: 'Norway is 25% now.' });
  while (!asked) await new Promise(r => setTimeout(r, 1));
  await progress.close();
  const chat = JSON.parse(readFileSync(join(dsh.dir, 'jobs.json'), 'utf8')).chats.c1 as { asked: string[]; marks: unknown[] };
  assert.deepEqual(chat.asked, ['Add a POST /cards endpoint', 'Now fix the Norway tax rate']);
  assert.equal(chat.marks.length, 1);
});

test('a list that close() interrupts while DSH lists its chats neither changes jobs.json nor reads DSH', async t => {
  const dsh = fakeDsh(t); const progress = await dsh.start();
  dsh.chat('lead', '/work/acme-api', 'Billing v2 lead'); dsh.turn('lead', 'Split the review', { reply: 'Team started.' });
  dsh.chat('mate', '/work/acme-api', 'REVIEW: read the plan', { origin: 'subagent' }); dsh.unreadable.set('mate', new Error('socket hang up'));
  dsh.turn('mate', 'REVIEW: read the plan', { reply: 'Sent my finding.' });
  await progress.idle();
  const sessions = dsh.sources.sessions; let answer!: () => void;
  dsh.sources.sessions = async () => { await new Promise<void>(r => { answer = r; }); return sessions(); };
  const reads = dsh.given.length;
  const listed = progress.list(signal());
  await new Promise(r => setTimeout(r, 10));
  await progress.close();
  const file = readFileSync(join(dsh.dir, 'jobs.json'), 'utf8');
  answer();
  await assert.rejects(listed, { code: 'unavailable' });
  await new Promise(r => setTimeout(r, 200)); // past the 50 ms a save waits
  assert.equal(readFileSync(join(dsh.dir, 'jobs.json'), 'utf8'), file, 'jobs.json unchanged');
  assert.deepEqual(dsh.given.slice(reads).map(g => `${g.sessionId} ${g.kind}`), [], 'no reads after close()');
});

// A read that finishes hands its slot to the read that has waited longest, so a read that came later
// cannot go before it.
test('reads waiting for a slot are read first come first served', { timeout: 10_000 }, async t => {
  const dsh = fakeDsh(t);
  const releases: (() => void)[] = []; t.after(() => releases.forEach(r => r()));
  // 8 chats whose first reads hold every slot, then 5 more: their first reads wait, then every chat's facts reads.
  for (let i = 0; i < 8; i++) {
    dsh.chat(`b${i}`, '/work/acme-api', `Busy ${i}`); dsh.turn(`b${i}`, 'Task', { reply: 'Done.' });
    dsh.held.set(`b${i}`, new Promise<void>(resolve => { releases.push(resolve); }));
  }
  for (let i = 0; i < 5; i++) { dsh.chat(`q${i}`, '/work/acme-api', `Queued ${i}`); dsh.turn(`q${i}`, 'Task', { reply: 'Done.' }); }
  const progress = await dsh.start();
  const listed = progress.list(signal());
  await new Promise(r => setTimeout(r, 20));
  assert.equal(dsh.given.length, 8, 'the 8 busy chats hold every slot');
  releases.forEach(r => r());
  await listed;
  const next = dsh.given.slice(8, 16).map(g => `${g.sessionId} ${g.kind}`);
  assert.deepEqual(next, ['q0 opening', 'q1 opening', 'q2 opening', 'q3 opening', 'q4 opening', 'b0 opening', 'b0 projections', 'b1 opening']);
});

// list() waited for every first read of a chat, then read every chat's facts, so a chat DSH did not
// answer for cost one read timeout per phase, and more than 8 of them a timeout per wave of 8: about 30 s a list with
// the 15 s timeout, past the phone's 20 s. A list now has a time limit of its own, below the phone's.
test('a list with chats DSH does not answer for comes back within its time limit, and lists what it has', { timeout: 10_000 }, async t => {
  const dsh = fakeDsh(t);
  const releases: (() => void)[] = []; t.after(() => releases.forEach(r => r()));
  for (let i = 0; i < 20; i++) {
    dsh.chat(`stuck${i}`, '/work/acme-api', `Stuck ${i}`); dsh.turn(`stuck${i}`, `Task ${i}`, { reply: 'Done.' });
    dsh.held.set(`stuck${i}`, new Promise<void>(resolve => { releases.push(resolve); }));
  }
  dsh.chat('ok', '/work/web-app', 'Saved cards UI'); dsh.turn('ok', 'Add the saved cards list', { reply: 'The list is in.' });
  const progress = await dsh.start({ readTimeoutMs: 1000, listMs: 400 });
  const started = Date.now();
  const first = await progress.list(signal());
  const took = Date.now() - started;
  assert.ok(took < 700, `the list took ${took} ms`);
  assert.equal(first.chats, 21, 'every chat is listed');
  assert.deepEqual(jobsOf(first, 'stuck0').map(j => [j.title, j.status, j.result?.text]), [['Stuck 0', 'idle', undefined]], 'listed under its name, idle, no result: nothing read yet');
  // 20 chats DSH does not answer for hold all 8 read slots, so this list could not read the one it would answer for.
  assert.deepEqual(jobsOf(first, 'ok').map(j => [j.status, j.result?.text]), [['idle', undefined]]);
});

test('with a few chats DSH does not answer for, the others are read as usual within the time limit', { timeout: 10_000 }, async t => {
  const dsh = fakeDsh(t);
  const releases: (() => void)[] = []; t.after(() => releases.forEach(r => r()));
  for (let i = 0; i < 3; i++) {
    dsh.chat(`stuck${i}`, '/work/acme-api', `Stuck ${i}`); dsh.turn(`stuck${i}`, `Task ${i}`, { reply: 'Done.' });
    dsh.held.set(`stuck${i}`, new Promise<void>(resolve => { releases.push(resolve); }));
  }
  for (let i = 0; i < 10; i++) { dsh.chat(`ok${i}`, '/work/web-app', `Fine ${i}`); dsh.turn(`ok${i}`, `Task ${i}`, { reply: `Done ${i}.` }); }
  const progress = await dsh.start({ readTimeoutMs: 1000, listMs: 400 });
  const started = Date.now();
  const first = await progress.list(signal());
  assert.ok(Date.now() - started < 700, `the list took ${Date.now() - started} ms`);
  for (let i = 0; i < 10; i++) assert.deepEqual(jobsOf(first, `ok${i}`).map(j => [j.status, j.result?.text]), [['done', `Done ${i}.`]]);
  assert.deepEqual(jobsOf(first, 'stuck0').map(j => [j.status, j.result?.text]), [['idle', undefined]]);
});

// A list the phone gave up on kept running on the computer, and the next poll started another beside it.
test('a list the phone gives up on stops: it returns at once and the reads it was waiting on are aborted', { timeout: 10_000 }, async t => {
  const dsh = fakeDsh(t);
  for (let i = 0; i < 20; i++) { dsh.chat(`c${i}`, '/work/acme-api', `Chat ${i}`); dsh.turn(`c${i}`, `Task ${i}`, { reply: 'Done.' }); }
  const progress = await dsh.start({ readTimeoutMs: 5000 });
  await progress.list(signal()); // every chat has a record now
  for (let i = 0; i < 20; i++) dsh.emit(`c${i}`, 'tool/result', { turn: 1, step: 2, message: { id: `r${i}`, role: 'tool', toolCallId: `x${i}`, content: [] } });
  await progress.idle();
  dsh.out.ms = 3000; dsh.given.length = 0;
  const phone = new AbortController();
  const listed = progress.list(phone.signal).then(() => 'answered', () => 'given up');
  await new Promise(r => setTimeout(r, 30));
  phone.abort(new Error('the phone gave up'));
  const at = Date.now();
  assert.equal(await listed, 'given up');
  assert.ok(Date.now() - at < 100, 'returns at once');
  assert.ok(dsh.given.length > 0, 'the list had reads out');
  assert.deepEqual(dsh.given.filter(g => !g.signal.aborted).map(g => g.sessionId), [], 'every read of the list given up is aborted');
});

// Loads, the first read of a chat the plugin has no record of, are the plugin's, not one list's: a list given up stops
// waiting for them, and they go on for the next list and for the chat's events, each until its read time limit.
test('a first list given up stops waiting for the chats it was reading for the first time', { timeout: 10_000 }, async t => {
  const dsh = fakeDsh(t);
  for (let i = 0; i < 20; i++) { dsh.chat(`c${i}`, '/work/acme-api', `Chat ${i}`); dsh.turn(`c${i}`, `Task ${i}`, { reply: 'Done.' }); }
  const progress = await dsh.start({ readTimeoutMs: 5000 }); dsh.out.ms = 300;
  const phone = new AbortController();
  const listed = progress.list(phone.signal).then(() => 'answered', () => 'given up');
  await new Promise(r => setTimeout(r, 30));
  phone.abort(new Error('the phone gave up'));
  const at = Date.now();
  assert.equal(await listed, 'given up');
  assert.ok(Date.now() - at < 100, `returned after ${Date.now() - at} ms`);
  await progress.idle();
  assert.equal(recorded(dsh).length, 20, 'the first reads went on and every chat has its record');
});

// Each write has a temporary file of its own, and one whose write or rename failed stayed behind, a new
// one per save (up to one every 50 ms while chats are active).
test('a write that fails leaves no temporary file behind, and is logged once', async t => {
  const dsh = fakeDsh(t);
  const logged: string[] = [];
  const progress = await dsh.start({ log: m => logged.push(m) });
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(dsh.dir, 'jobs.json', 'in-the-way'), { recursive: true }); // jobs.json is a folder now: every rename fails
  for (let i = 0; i < 5; i++) { dsh.chat(`c${i}`, '/work/acme-api', `Chat ${i}`); dsh.turn(`c${i}`, `Task ${i}`, { reply: 'Done.' }); await progress.idle(); }
  assert.deepEqual(readdirSync(dsh.dir).filter(n => n.endsWith('.tmp')), []);
  assert.equal(logged.filter(m => /could not be saved/.test(m)).length, 1, `logged: ${logged.join(' | ')}`);
});

// A jobs.json that is there but cannot be read (here: no read permission) counted as no file, and the
// first save wrote over it.
test('a jobs.json that cannot be read is kept aside and logged, not written over', { skip: process.getuid?.() === 0 }, async t => {
  const dsh = fakeDsh(t);
  const { chmodSync } = await import('node:fs');
  const file = join(dsh.dir, 'jobs.json'), was = JSON.stringify({ version: 1, settings: { judge: true, language: 'ko' }, chats: {} });
  writeFileSync(file, was); chmodSync(file, 0o000);
  const logged: string[] = [];
  const progress = await dsh.start({ log: m => logged.push(m) });
  dsh.chat('c', '/work/acme-api', 'Backfill old invoices'); dsh.turn('c', 'Backfill the old invoices', { reply: 'Done.' });
  await progress.idle();
  const kept = readdirSync(dsh.dir).filter(n => n.startsWith('jobs.json.unreadable-'));
  assert.equal(kept.length, 1, `files: ${readdirSync(dsh.dir)}`);
  chmodSync(join(dsh.dir, kept[0]!), 0o600);
  assert.equal(readFileSync(join(dsh.dir, kept[0]!), 'utf8'), was, 'the old file is kept as it was');
  assert.equal(logged.length, 1); assert.match(logged[0]!, /jobs\.json\.unreadable-/);
});
