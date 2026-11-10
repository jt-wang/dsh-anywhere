import assert from 'node:assert/strict';
import { line022 } from './composition.mjs';
import { opening } from './checks.mjs';

const TODOS = [{ content: 'Synthetic canary to-do', status: 'in_progress' }, { content: 'Second synthetic to-do', status: 'pending' }];
const signal = () => AbortSignal.timeout(10000);

/** The real dsh-tool-todo projection, mounted for this phase only and removed again so the canary's zero-tool model
 * routes stay as they were. DSH 0.2.2 marks `todos` `wire.summary: false` (dsh-session-projection README, "Session
 * summaries"): it leaves `session/list` rows, while an opened Session (follow opening, `projections`) still carries
 * it. Where the phone reads to-dos (nsh-app fold.ts from the follow opening, activity.tsx from session/projections),
 * both reads must give the list on every version; list rows carry it on 0.2.1 only. `live` appends the to-dos the
 * way the todo_write tool does; `cold` reads them back from the persisted log after a remount. */
export async function todoChecks(runtime, loader, sessionId, phase) {
  const { ctx, deterministic, version } = runtime;
  const module = await loader.load('dsh-tool-todo');
  const fiber = ctx.plugin(module.default ?? module, { allowParallelInProgress: false });
  await fiber.await();
  for (let waited = 0; fiber.state !== 2 && waited < 2000; waited += 25) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(fiber.state, 2, 'dsh-tool-todo active');
  const calls = deterministic.calls;
  try {
    if (phase === 'live') {
      const session = ctx.sessions.get(sessionId);
      assert.ok(session, 'live phase needs the attached Session');
      session.append('todo/write', { todos: TODOS });
    } else {
      assert.equal(ctx.sessions.get(sessionId), undefined, 'cold phase starts unattached');
    }
    const row = (await ctx.sessionController.list({}, signal())).items.find(item => item.sessionId === sessionId);
    assert.ok(row, 'session listed');
    const rowHasTodos = row.projections !== undefined && 'todos' in row.projections.values;
    if (phase === 'live') assert.equal(rowHasTodos, !line022(version), line022(version) ? '0.2.2 list rows leave todos out' : '0.2.1 list rows carry todos');
    if (phase === 'live' && rowHasTodos) assert.deepEqual(row.projections.values.todos, TODOS);
    const projected = await ctx.sessionController.projections({ sessionId }, signal());
    assert.deepEqual(projected?.values?.todos, TODOS, 'projections() serves todos by key');
    const snapshot = await opening(ctx.sessionController, sessionId);
    assert.deepEqual(snapshot.projections?.values?.todos, TODOS, 'the follow opening carries todos');
    if (phase === 'cold') {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(ctx.agents.get(sessionId), undefined, 'cold to-do reads attach no Agent');
      assert.equal(ctx.sessions.get(sessionId), undefined, 'cold to-do reads attach no Session');
    }
    assert.equal(deterministic.calls, calls, 'to-do reads call no model');
    return { checks: [`todos-${phase}-list-row-${rowHasTodos ? 'carries' : 'omits'}`, `todos-${phase}-projections-by-key`, `todos-${phase}-follow-opening`], result: { version, rowHasTodos, rowKeys: Object.keys(row.projections?.values ?? {}).sort() } };
  } finally {
    await fiber.dispose();
    assert.deepEqual(ctx.tools.schemas(), [], 'todo_write removed with its plugin');
  }
}
