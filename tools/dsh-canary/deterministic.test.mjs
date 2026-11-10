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
