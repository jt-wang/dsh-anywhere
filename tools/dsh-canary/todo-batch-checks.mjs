import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// To-dos for many chats in one pass. Every SessionController
// method of 0.2.2 (`projections`, `state`, `observeProjections`, `observeState`, `wait`, `events`, `observeEvent`)
// takes one sessionId, and `list` takes only a cursor, so over the remote API N chats cost N `projections` calls.
// Inside the Host a plugin can do what `list` itself does per row (dsh-api-session-controller `projectionsFor`):
// `sessionQuery.listSessions`, then for a live Session `sessionProjections.snapshot(session, keys)` and for a cold one
// `sessionProjectionCache.cachedSnapshot(header, keys)`, with an explicitly named key, which 0.2.2 still serves
// (dsh-session-projection README, "Session summaries"). Both faces take a key list on 0.2.1-rc.3 too. These phases
// check that pass against per-chat `projections()` on many chats, live and after a remount, attaching nothing and
// calling no model.
const COUNT = 24;
const signal = () => AbortSignal.timeout(20000);
const todosOf = i => [{ content: `Synthetic to-do ${i}a`, status: i % 3 === 0 ? 'completed' : 'in_progress' }, { content: `Synthetic to-do ${i}b`, status: 'pending' }];

/** One in-process pass: every listed Session's `todos`, without attaching any of them. A live Session answers from its
 * projections; a cold one from `projections()`, which folds its log without attaching (the cold checks prove it). The
 * persisted cache is read only to report how far it agrees: its cells are hints that may trail the log
 * (dsh-session-projection-cache README; `cachedSnapshot` is "never use it to decide behavior"), and here it gave `null`
 * for to-dos written after the chat's last checkpoint. */
export async function batchTodos(ctx, abort) {
  const records = await ctx.sessionQuery.listSessions(abort);
  const cache = ctx.get('sessionProjectionCache');
  const out = new Map();
  for (const { header } of records) {
    const live = ctx.sessions.get(header.id);
    if (live !== undefined) { out.set(header.id, { todos: ctx.sessionProjections.snapshot(live, ['todos']).values?.todos, source: 'live' }); continue; }
    const cached = cache?.cachedSnapshot(header, ['todos']);
    const todos = (await ctx.sessionController.projections({ sessionId: header.id }, abort))?.values?.todos;
    out.set(header.id, { todos, source: 'projections', cache: cached === undefined ? 'none' : JSON.stringify(cached.values?.todos) === JSON.stringify(todos) ? 'agrees' : 'differs' });
  }
  return out;
}

async function mountTodo(ctx, loader) {
  const module = await loader.load('dsh-tool-todo');
  const fiber = ctx.plugin(module.default ?? module, { allowParallelInProgress: false });
  await fiber.await();
  for (let waited = 0; fiber.state !== 2 && waited < 2000; waited += 25) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(fiber.state, 2, 'dsh-tool-todo active');
  return fiber;
}

// The shipped base's cache config (dsh-base/cordis.patch.yml). Mounted from the live batch
// phase on and left mounted, so its mandatory writes (creation, turn/end, disposal at the remount) all happen, then
// mounted again after the remount: a real profile has it, and cold reads should come from it, not from the logs.
async function mountCache(ctx, loader) {
  if (ctx.get('sessionProjectionCache')) return 'already';
  const module = await loader.load('dsh-session-projection-cache');
  const fiber = ctx.plugin(module.default ?? module, { writeEveryEvents: 200, writeIntervalMs: 5000 });
  await fiber.await();
  for (let waited = 0; !ctx.get('sessionProjectionCache') && waited < 2000; waited += 25) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(ctx.get('sessionProjectionCache'), 'sessionProjectionCache provided');
  return 'mounted';
}

async function compare(ctx, ids, phase) {
  const started = performance.now();
  const batch = await batchTodos(ctx, signal());
  const batchMs = performance.now() - started;
  if (phase === 'cold') {
    for (const id of ids) {
      assert.equal(ctx.sessions.get(id), undefined, 'the batch read attaches no Session');
      assert.equal(ctx.agents.get(id), undefined, 'the batch read attaches no Agent');
    }
  }
  const perStarted = performance.now();
  const per = [];
  for (const id of ids) per.push((await ctx.sessionController.projections({ sessionId: id }, signal()))?.values?.todos);
  const perChatMs = performance.now() - perStarted;
  ids.forEach((id, i) => {
    assert.ok(batch.has(id), `chat ${i} listed`);
    assert.deepEqual(per[i], todosOf(i), `projections() gives chat ${i}'s to-dos`);
    assert.deepEqual(batch.get(id).todos, todosOf(i), `the batch pass gives chat ${i}'s to-dos (${phase})`);
  });
  const mine = ids.map(id => batch.get(id));
  const count = source => mine.filter(v => v.source === source).length;
  const cache = state => mine.filter(v => v.cache === state).length;
  return { batchMs: Math.round(batchMs), perChatMs: Math.round(perChatMs), listed: batch.size, fromLive: count('live'), fromProjections: count('projections'), cacheAgrees: cache('agrees'), cacheDiffers: cache('differs'), cacheNone: cache('none') };
}

/** Live: COUNT new chats, each with its own to-dos, read in one pass and one by one. Returns the ids for `cold`. */
export async function todoBatchLive(runtime, loader, cwd) {
  const { ctx, deterministic, version } = runtime;
  const cache = await mountCache(ctx, loader);
  const fiber = await mountTodo(ctx, loader);
  const calls = deterministic.calls;
  const ids = [];
  try {
    for (let i = 0; i < COUNT; i++) {
      const sessionId = `session-canary-batch-${i}-${randomUUID()}`;
      await ctx.sessionController.create({ cwd, sessionId });
      const session = ctx.sessions.get(sessionId);
      assert.ok(session, 'a created chat is attached');
      session.append('todo/write', { todos: todosOf(i) });
      ids.push(sessionId);
    }
    const result = await compare(ctx, ids, 'live');
    assert.equal(deterministic.calls, calls, 'to-do reads call no model');
    return { ids, phase: { checks: ['todos-batch-live-matches-projections'], result: { version, chats: COUNT, cache, ...result } } };
  } finally { await fiber.dispose(); }
}

/** Cold, after a remount: the same chats, none attached, read in one pass and one by one. */
export async function todoBatchCold(runtime, loader, ids) {
  const { ctx, deterministic, version } = runtime;
  const cache = await mountCache(ctx, loader);
  const fiber = await mountTodo(ctx, loader);
  const calls = deterministic.calls;
  try {
    const result = await compare(ctx, ids, 'cold');
    assert.equal(deterministic.calls, calls, 'to-do reads call no model');
    return { checks: ['todos-batch-cold-matches-projections', 'todos-batch-cold-attaches-nothing'], result: { version, chats: ids.length, cache, ...result } };
  } finally { await fiber.dispose(); }
}
