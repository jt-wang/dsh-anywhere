import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROMPTS } from './deterministic.mts';
import { activationSpec } from './activation-spec.mjs';
async function waitActive(deterministic, kind, run) {
  // The preceding controller checks have already used these prompt kinds;
  // started[] is historical, whereas controls identifies a currently held turn.
  if (deterministic.controls.has(kind)) return;
  let started;
  try {
    await Promise.race([
      new Promise(resolve => { started = value => { if (value === kind) resolve(); }; deterministic.events.on('started', started); }),
      run.result.then(result => { throw new Error(`Synthetic ${kind} child settled before model start: ${result.stopReason}`); }),
    ]);
  } finally { deterministic.events.off('started', started); }
}

// Diagnostics printed only when a check fails: what the adapter saw for the parent chat. Kinds, event and frame
// types, sequence numbers, running flags and counts, and the synthetic session ids; never event data or text.
const KIND = /^[a-z][a-z0-9/_-]{0,63}$/;
const kind = value => typeof value === 'string' && KIND.test(value) ? value : undefined;
function followItem(item) {
  const event = item?.event ?? (item?.type === 'event' ? item?.data : undefined);
  return { t: kind(item?.type), ...(kind(event?.type) ? { e: event.type } : {}), ...(Number.isSafeInteger(event?.seq) ? { seq: event.seq } : {}),
    ...(kind(item?.frame?.type) ? { f: item.frame.type } : {}), ...(typeof item?.running === 'boolean' ? { running: item.running } : {}),
    ...(item?.type === 'snapshot' ? { shape: shape(item) } : {}) };
}
/** A snapshot's structure: for each field, a boolean's value, an array's length and its last element types, or an
 * object's own type; never strings, text or ids. */
function shape(frame) {
  const out = {};
  for (const [key, value] of Object.entries(frame)) {
    if (!KIND.test(key) || key === 'type') continue;
    if (typeof value === 'boolean') out[key] = value;
    else if (Array.isArray(value)) out[key] = { n: value.length, last: value.slice(-6).map(v => kind(v?.event?.type) ?? kind(v?.frame?.type) ?? kind(v?.type) ?? typeof v) };
    else if (key === 'projections' && value?.values && typeof value.values === 'object') out[key] = Object.keys(value.values).filter(k => KIND.test(k)).join(',');
    else if (value && typeof value === 'object') out[key] = kind(value.type) ?? Object.keys(value).filter(k => KIND.test(k)).slice(0, 12).join(',');
  }
  return out;
}
function recordingController(controller, diag, parentId) {
  return new Proxy(controller, { get(target, property) {
    const value = Reflect.get(target, property);
    if (property !== 'follow') return typeof value === 'function' ? value.bind(target) : value;
    return (request, signal) => {
      const iterable = target.follow(request, signal);
      if (request?.address?.sessionId !== parentId()) return iterable;
      const opened = diag.follow.length;
      return (async function* () { for await (const item of iterable) { if (diag.follow.length - opened < 200) diag.follow.push({ ms: Date.now() - diag.started, ...followItem(item) }); yield item; } })();
    };
  } });
}

/** Real in-process fork/spawn providers and deterministic turns, no external model. */
export async function subagentChecks(runtime, loader, projectRoot, cwd, observe = async () => {}) {
  const { ctx, deterministic } = runtime;
  const fibers = [], runs = [];
  let parent, adapter;
  const active = new AbortController();
  const diag = { started: Date.now(), follow: [], status: [] };
  try {
    if (!ctx.get('subagents')) for (const [id, config] of [['dsh-subagent', { maxDepth: 4, maxActiveSubagents: 8 }], ['dsh-subagent-fork-in-process', {}], ['dsh-subagent-spawn-in-process', {}]]) {
      const module = await loader.load(id), fiber = ctx.plugin(module.default ?? module, config);
      fibers.push(fiber); await fiber.await(); assert.equal(fiber.state, 2);
    }
    const { runningSubagentCounts } = await import(pathToFileURL(path.join(projectRoot, 'host', 'dist', 'running-subagents.js')).href);
    const module = await import(pathToFileURL(path.join(projectRoot, 'host', 'dist', 'dsh-adapter.js')).href);
    adapter = await module.createDshAdapter({ dshVersion: runtime.version, sessionController: recordingController(ctx.sessionController, diag, () => parent?.agent.id), workspaces: [{ id: 'subagent-canary', name: 'Synthetic child canary', path: cwd }], pollIntervalMs: 10, throttleMs: 1,
      sessionStatus: id => {
        const running = ctx.agents.get(id)?.status === 'running';
        if (id === parent?.agent.id && diag.status.at(-1)?.running !== running && diag.status.length < 100) diag.status.push({ ms: Date.now() - diag.started, running });
        return { running, updatedAt: ctx.sessions.get(id)?.header.createdAt ?? 0 };
      },
      runningSubagentCounts: () => runningSubagentCounts(ctx.agents.list(), ctx.sessions.list()),
    });
    parent = await ctx.agents.create({ sessionId: `session-subagent-parent-${randomUUID()}`, meta: { cwd }, agentOptions: ctx.agentDefaultModel.currentSelection() });
    const startChild = async (provider, parentAgent, prompt, signal) => {
      if (typeof ctx.subagents.start === 'function') return ctx.subagents.start(provider, { parent: parentAgent, signal, prompt });
      const receipt = await ctx.subagents.startActivation(activationSpec({ provider, label: 'canary-' + provider, parent: parentAgent, maxDepth: 4, prompt, signal }));
      const childAgent = ctx.agents.get(receipt.childId);
      assert.ok(childAgent, 'started child agent must be live');
      // receipt.result settles once the child has closed and DSH has sent its parent the finished notice.
      return { id: receipt.childId, localAgent: childAgent, result: receipt.result ?? childAgent.whenIdle(), dispose: async () => { try { await ctx.subagents.drainChildren?.(parentAgent, [receipt.childId]); } catch {} } };
    };
    // DSH sends a parent a notice when its child finishes, and the parent runs one turn to read it. Wait until the
    // parent has read the given number of notices and is idle again.
    const limitations = [];
    const noticesRead = async (agent, count) => {
      const read = () => deterministic.notices.filter(id => id === agent.id).length;
      const deadline = Date.now() + 5000;
      while (read() < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(read(), count, 'the parent reads one child-finished notice per finished child');
      await agent.whenIdle();
    };
    // No prompt on the main Agent: it stays idle while its children work.
    const first = await startChild('fork', parent.agent, [{ type: 'text', text: PROMPTS.cancel }], active.signal); runs.push(first);
    await waitActive(deterministic, 'cancel', first);
    assert.equal(first.localAgent.session.header.origin, 'subagent');
    assert.equal(first.localAgent.session.header.parentSession, parent.agent.id);
    const watch = adapter.watch(parent.agent.id, active.signal)[Symbol.asyncIterator]();
    try {
      const initial = (await watch.next()).value;
      assert.equal(initial.session.running, false); assert.equal(initial.activity, 'idle'); assert.equal(initial.runningSubagents, 1);
      await assert.rejects(adapter.snapshot(first.id, new AbortController().signal), { code: 'not_found' }, 'real child address remains hidden');
      await observe(parent.agent.id, 1, first.id);
      const next = watch.next(); deterministic.release('cancel'); await first.result;
      const settled = (await next).value;
      assert.equal(settled.runningSubagents, 0);
      await noticesRead(parent.agent, 1);
      // The phone may see the parent running while it reads the notice; the watch must come back to idle.
      let frame = settled;
      while (frame.session.running) frame = (await Promise.race([watch.next(), new Promise((_, reject) => setTimeout(() => reject(new Error('watch stayed running after the parent went idle')), 5000))])).value;
      assert.equal(frame.runningSubagents, 0); assert.equal(frame.activity, 'idle');
      const after = await adapter.snapshot(parent.agent.id, new AbortController().signal);
      assert.equal(after.session.running, false); assert.equal(after.runningSubagents, 0);
      await observe(parent.agent.id, 0);
    } finally { active.abort(); await watch.return(); }
    const signal = new AbortController().signal;
    const child = await startChild('spawn', parent.agent, [{ type: 'text', text: PROMPTS.live }], signal); runs.push(child);
    await waitActive(deterministic, 'live', child);
    const nested = await startChild('fork', child.localAgent, [{ type: 'text', text: PROMPTS.reconnect }], signal); runs.push(nested);
    await waitActive(deterministic, 'reconnect', nested);
    const summary = (await adapter.listSessions(signal)).find(item => item.id === parent.agent.id);
    assert.equal(summary.runningSubagents, 2); assert.equal(summary.running, false);
    await observe(parent.agent.id, 2, nested.id);
    assert.equal((await adapter.listSessions(signal)).some(item => item.id === child.id || item.id === nested.id), false, 'delegated children stay hidden');
    deterministic.release('reconnect'); await nested.result;
    assert.equal((await adapter.snapshot(parent.agent.id, signal)).runningSubagents, 1);
    await observe(parent.agent.id, 1);
    deterministic.release('live'); await child.result;
    await noticesRead(parent.agent, 2);
    // DSH 0.2.1-rc.2 can block a fresh follow after subagent activity inside Cordis ctx.on.
    // Read the final count from the authoritative list instead and record the gap.
    let finalSnapshot;
    try {
      finalSnapshot = await Promise.race([
        adapter.snapshot(parent.agent.id, signal),
        new Promise((_, reject) => setTimeout(() => reject(new Error('final-subagent-snapshot-timeout')), 5000)),
      ]);
    } catch (error) {
      if (error?.message !== 'final-subagent-snapshot-timeout' || runtime.version !== '0.2.1-rc.2') throw error;
      const row = (await adapter.listSessions(signal)).find(item => item.id === parent.agent.id);
      limitations.push('DSH 0.2.1-rc.2: a fresh follow after subagent activity did not return within 5s; final runningSubagents read from listSessions');
      finalSnapshot = { runningSubagents: row?.runningSubagents, fallback: true };
    }
    assert.equal(finalSnapshot.runningSubagents, 0);
    if (!finalSnapshot.fallback) await observe(parent.agent.id, 0);
    await ctx.sessionPersistence.flush();
    return { checks: ['real-fork-origin/parent-link', 'idle-main-with-child-one', 'settled-child-zero-via-watch', 'nested-fork-count-two', 'subagents-hidden-in-list', 'main-status/stop-semantics-unchanged', 'parent-reads-child-notice-then-idle'], ...(limitations.length ? { limitations } : {}), deterministicCalls: 3, parentNoticeTurns: deterministic.notices.filter(id => id === parent.agent.id).length };
  } catch (error) {
    const agents = ctx.agents.list().map(agent => ({ id: agent.id, origin: kind(agent.session?.header?.origin) ?? 'main', parent: agent.session?.header?.parentSession, status: kind(agent.status) }));
    console.log('CANARY_SUBAGENT_DIAG ' + JSON.stringify({ version: runtime.version, ms: Date.now() - diag.started, parent: parent?.agent.id, parentStatus: kind(parent?.agent.status), agents, status: diag.status, follow: diag.follow }));
    throw error;
  } finally {
    active.abort(); adapter?.dispose();
    for (const run of runs.toReversed()) await run.dispose();
    await parent?.dispose();
    for (const fiber of fibers.toReversed()) await fiber.dispose();
  }
}
