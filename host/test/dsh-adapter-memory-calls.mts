// Run by dsh-adapter-memory.test.ts in a process of its own (node --expose-gc), outside the test runner: calls
// listSessions() `rounds` times 10,000 times and prints the heap after each round, settled. The folder is a fresh temporary
// one; nothing here is real.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDshAdapter } from '../src/dsh-adapter.ts';

const rounds = Number(process.argv[2]);
const gc = (globalThis as { gc?: () => void }).gc!;
const heap = async () => {
  await new Promise(r => setTimeout(r, 300));
  for (let i = 0; i < 20; i++) { gc(); await new Promise(r => setTimeout(r, 20)); }
  return process.memoryUsage().heapUsed;
};
const work = mkdtempSync(join(tmpdir(), 'dsh-adapter-memory-'));
const adapter = await createDshAdapter({ dshVersion: '0.2.0-rc.2', workspaces: [{ id: 'alpha', name: 'Alpha', path: work }], sessionController: { async list() { return { items: [] }; } } as never });
const heaps: number[] = [];
for (let k = 0; k < rounds; k++) {
  for (let i = 0; i < 10_000; i++) await adapter.listSessions(new AbortController().signal);
  heaps.push(await heap());
}
adapter.dispose(); rmSync(work, { recursive: true, force: true });
console.log(JSON.stringify({ heaps }));
