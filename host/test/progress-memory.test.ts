// The Progress page lists every 5 s while it is open (nsh-app/src/progress.tsx), for as long as DSH runs, so a list must
// leave nothing behind. A signal combined with the plugin's own long-lived close signal through AbortSignal.any stayed
// reachable after its list ended: about 0.18 KB a list on Node 24.13.1, never freed.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';

test('lists leave no memory behind', { timeout: 120_000 }, async t => {
  // In a process of its own, outside the test runner, with the heap settled after every 10,000 lists.
  const script = fileURLToPath(new URL('./progress-memory-lists.mts', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, ['--expose-gc', script, '6']);
  const { heaps } = JSON.parse(stdout.trim().split('\n').at(-1)!) as { heaps: number[] };
  // What the heap grows by per round, first round to last. Measured 2026-11-14 on Node 24.13.1: with nothing leaking
  // about 0 MB a round (and once a drop of about 4 MB); with 0.18 KB kept a list about 1.75 MB a round. A step-to-step
  // median took GitHub's Macs' swing of about 1 MB between rounds for growth (2026-11-21).
  const growth = (heaps.at(-1)! - heaps[0]!) / (heaps.length - 1);
  t.diagnostic(`heap after each 10,000 lists, MB: ${heaps.map(h => (h / 1e6).toFixed(2)).join(' ')}`);
  assert.ok(growth < 700_000, `the heap grows ${(growth / 1e6).toFixed(2)} MB every 10,000 lists`);
});
