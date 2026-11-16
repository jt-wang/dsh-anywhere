// Run by progress-memory.test.ts in a process of its own (node --expose-gc), outside the test runner: lists `rounds`
// times 10,000 lists and prints the heap after each round, settled. Every chat and folder here is made up.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProgress } from '../src/progress.ts';

const rounds = Number(process.argv[2]);
const gc = (globalThis as { gc?: () => void }).gc!;
// Each list's and read's time limit is a timer that keeps its signal until it fires: short limits here, and every one
// of them has fired before the heap is read.
const heap = async () => {
  await new Promise(r => setTimeout(r, 300));
  for (let i = 0; i < 20; i++) { gc(); await new Promise(r => setTimeout(r, 20)); }
  return process.memoryUsage().heapUsed;
};
const dir = mkdtempSync(join(tmpdir(), 'dsh-progress-memory-'));
let updatedAt = 1;
const progress = await createProgress({ dir, listMs: 50, readTimeoutMs: 50, sources: {
  // updatedAt moves every list, so the chat's facts are read again each time.
  async sessions() { return [{ sessionId: 'c1', cwd: '/work/acme-api', title: 'Saved cards', running: false, updatedAt: ++updatedAt }]; },
  async opening() { return []; },
  async projections() { return {}; },
} });
const heaps: number[] = [];
for (let k = 0; k < rounds; k++) {
  for (let i = 0; i < 10_000; i++) await progress.list(new AbortController().signal);
  heaps.push(await heap());
}
await progress.close(); rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ heaps }));
