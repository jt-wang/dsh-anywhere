import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ANSWERS, MODEL, PROMPTS, PROVIDER, createDeterministicAdapter } from './deterministic.mts';

const user = (text, kind = 'user') => ({ role: 'user', content: [{ type: 'text', text }], source: { kind } });
const turn = (model, messages, sessionId = 'session-synthetic-parent') => {
  const chunks = [];
  const done = (async () => { for await (const chunk of model.stream({ provider: PROVIDER, model: MODEL, messages, sessionId })) chunks.push(chunk); })();
  return { chunks, done };
};
const settledWithin = (promise, ms) => Promise.race([promise.then(() => true), delay(ms).then(() => false)]);

test('a turn on a child-finished notice ends at once, even after the session\'s own held prompt', async () => {
  const model = createDeterministicAdapter(class {});
  // A parent that started a child with its own prompt earlier, then got DSH's notice and a runtime-context message.
  const run = turn(model, [user(PROMPTS.live), user('Subagent finished.', 'subagent-settled'), user('Runtime context.', 'runtime-context')]);
  assert.equal(await settledWithin(run.done, 1000), true, 'the notice turn must not wait for a release');
  assert.deepEqual(run.chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } });
  assert.deepEqual(model.notices, ['session-synthetic-parent']);
  assert.equal(model.calls, 0, 'notice turns are not prompt calls');
});

test('a prompt sent after an earlier notice is a held prompt turn', async () => {
  const model = createDeterministicAdapter(class {});
  const run = turn(model, [user('Subagent finished.', 'subagent-settled'), user(PROMPTS.live)]);
  assert.equal(await settledWithin(run.done, 200), false, 'the prompt turn waits for its release');
  model.release('live');
  await run.done;
  assert.ok(run.chunks.some(chunk => chunk.type === 'block-end' && chunk.block.text === ANSWERS.live));
  assert.deepEqual(model.notices, []);
  assert.equal(model.calls, 1);
});

test('a child task with DSH\'s result-delivery guidance block after the prompt is the held prompt turn', async () => {
  // DSH 0.2.2-rc.2 appends one text block to a parent-delivered child's first message (dsh-subagent
  // `withResultDeliveryGuidance`, read 2026-11-12); the 2026-11-12 canary child ended in error before model start.
  const model = createDeterministicAdapter(class {});
  const message = { role: 'user', content: [{ type: 'text', text: PROMPTS.cancel }, { type: 'text', text: 'Your final answer is delivered automatically if your parent is still online.' }], source: { kind: 'user' } };
  const run = turn(model, [message], 'session-synthetic-child');
  assert.equal(await settledWithin(run.done, 200), false, 'the child turn waits for its release');
  model.release('cancel');
  await run.done;
  assert.ok(run.chunks.some(chunk => chunk.type === 'block-end' && chunk.block.text === ANSWERS.cancel));
  assert.equal(model.calls, 1);
});

test('a message whose text only contains a synthetic prompt among other words is still refused', async () => {
  const model = createDeterministicAdapter(class {});
  const run = turn(model, [user('Please ' + PROMPTS.cancel)]);
  await assert.rejects(run.done, /Only exact explicitly synthetic prompts are admitted/);
  assert.equal(model.calls, 0);
});
