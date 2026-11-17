// The phone's chat list asks the adapter for the computer's chats every few seconds while it is open, for as long as DSH
// runs, so a call must leave nothing behind. Each call combined the caller's signal with the adapter's own lifetime signal
// through AbortSignal.any, and on Node 24.13.1 a signal combined with a long-lived one stays reachable after the call:
// about 0.18 KB a call, never freed (measured 2026-11-14, the same as the Progress plugin's list).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';

test('adapter calls leave no memory behind', { timeout: 120_000 }, async t => {
  // In a process of its own, outside the test runner, with the heap settled after every 10,000 calls.
  const script = fileURLToPath(new URL('./dsh-adapter-memory-calls.mts', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, ['--expose-gc', script, '6']);
  const { heaps } = JSON.parse(stdout.trim().split('\n').at(-1)!) as { heaps: number[] };
  // What the heap grows by from one round to the next, the middle value, so a one-off drop does not count. Measured
  // 2026-11-14 on Node 24.13.1: about 1.76 MB a round as written before; about 0.01 MB with the caller's signal alone, or
  // combined with a short-lived one.
  const steps = heaps.slice(1).map((h, i) => h - heaps[i]!).sort((a, b) => a - b);
  const median = (steps[2]! + steps[3]!) / 2;
  t.diagnostic(`heap after each 10,000 calls, MB: ${heaps.map(h => (h / 1e6).toFixed(2)).join(' ')}`);
  assert.ok(median < 700_000, `the heap grows ${(median / 1e6).toFixed(2)} MB every 10,000 calls`);
});
