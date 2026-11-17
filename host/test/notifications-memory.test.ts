// While any phone has notifications on, the feed checks every relevant DSH event, the phone's notification stream reads
// a page every second for as long as it is connected, and the host checks every chat every 60 s, so none of them may
// leave memory behind. Each combined its signal with the feed's long-lived lifetime (and the event and the check also
// with its activation) through AbortSignal.any, and on Node 24.13.1 such a signal stays reachable after use: measured
// 2026-11-14, about 3.9 KB an event, 2.2 KB a page and 3.9 KB a check, never freed, while the same calls with
// short-lived signals in their place stayed flat.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';

for (const [path, what] of [['event', 'DSH events'], ['page', 'notification pages'], ['reconcile', 'notification checks']] as const) {
  test(`${what} leave no memory behind`, { timeout: 120_000 }, async t => {
    // In a process of its own, outside the test runner, with the heap settled after every 10,000 calls.
    const script = fileURLToPath(new URL('./notifications-memory-calls.mts', import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, ['--expose-gc', script, path, '6']);
    const { coverage, heaps } = JSON.parse(stdout.trim().split('\n').at(-1)!) as { coverage: string; heaps: number[] };
    assert.equal(coverage, 'ready'); // every call did its normal work, nothing failed early
    // What the heap grows by from one round to the next, the middle value, so a one-off drop does not count.
    const steps = heaps.slice(1).map((h, i) => h - heaps[i]!).sort((a, b) => a - b);
    const median = (steps[2]! + steps[3]!) / 2;
    t.diagnostic(`heap after each 10,000 ${what}, MB: ${heaps.map(h => (h / 1e6).toFixed(2)).join(' ')}`);
    assert.ok(median < 700_000, `the heap grows ${(median / 1e6).toFixed(2)} MB every 10,000 ${what}`);
  });
}
