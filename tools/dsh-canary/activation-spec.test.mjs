import test from 'node:test';
import assert from 'node:assert/strict';
import { activationSpec } from './activation-spec.mjs';

// How each DSH line reads the spec, copied from @deepseek-ai/dsh-subagent lib/index.js `startActivation`
// (read 2026-11-12 from the npm tarballs): 0.2.2-rc.1 reads `spec.request.parent` and `spec.request.maxDepth`;
// 0.2.2-rc.2 reads `spec.parent` and `spec.maxDepth` and passes the spec on as the start request.
// The 2026-11-12 public canary on 0.2.2-rc.2 failed with "Cannot read properties of undefined (reading 'id')" there.
const readers = {
  '0.2.2-rc.1': spec => ({ parent: spec.request.parent.id, maxDepth: spec.request.maxDepth, prompt: spec.request.prompt }),
  '0.2.2-rc.2': spec => ({ parent: spec.parent.id, maxDepth: spec.maxDepth, prompt: spec.prompt }),
};

for (const [version, read] of Object.entries(readers)) {
  test(`DSH ${version} reads the parent, depth and prompt from the canary's activation spec`, () => {
    const prompt = [{ type: 'text', text: 'synthetic' }];
    const spec = activationSpec({ provider: 'fork', label: 'canary-fork', parent: { id: 'session-parent' }, maxDepth: 4, prompt, signal: new AbortController().signal });
    assert.deepEqual(read(spec), { parent: 'session-parent', maxDepth: 4, prompt });
    assert.equal(spec.provider, 'fork');
    assert.equal(spec.label, 'canary-fork');
    assert.ok(spec.signal instanceof AbortSignal);
  });
}
