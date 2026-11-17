// Run by notifications-memory.test.ts in a process of its own (node --expose-gc), outside the test runner. argv: path
// rounds. path `event`: one tool/result event from DSH, which the feed checks with a lookup and an evidence read. path
// `page`: the phone's notification stream, which reads a page every second with one signal that lasts as long as the
// stream (server.ts streamNotifications). path `reconcile`: the 60 s check, run through the timer start() sets. Prints
// the heap after each round of 10,000 calls, settled. The folder, device and chat are made up.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostState } from '../src/state.ts';
import { NotificationFeed } from '../src/notifications.ts';

const [path, rounds] = [process.argv[2], Number(process.argv[3])];
const gc = (globalThis as { gc?: () => void }).gc!;
// Every read's time limit is a timer that keeps its signal until it fires: 50 ms here, and all have fired before the
// heap is read.
const heap = async () => {
  await new Promise(r => setTimeout(r, 300));
  for (let i = 0; i < 20; i++) { gc(); await new Promise(r => setTimeout(r, 20)); }
  return process.memoryUsage().heapUsed;
};
let check: (() => void) | undefined;
const setIntervalAsWritten = globalThis.setInterval;
(globalThis as { setInterval: unknown }).setInterval = (fn: () => void, ms: number) => {
  if (ms !== 60_000) return setIntervalAsWritten(fn, ms);
  check = fn; return setIntervalAsWritten(() => {}, 2 ** 30);
};
const dir = mkdtempSync(join(tmpdir(), 'dsh-notifications-memory-'));
const state = new HostState(join(dir, 'state.sqlite'));
const device = state.consumePairing(state.createPairing({ readWorkspaceIds: ['alpha'], executeWorkspaceIds: [] }).pairingToken, 'Synthetic phone');
let emit: (id: string, event: { seq: number; type: string; time: number }) => void = () => {}, seq = 0;
const feed = new NotificationFeed(state, {
  subscribe(fn: typeof emit) { emit = fn; return () => {}; },
  async evidence() { return { sessionId: 'chat', workspaceId: 'alpha', cursor: seq, pending: false, completed: [] }; },
  async list() { return [{ id: 'chat', workspaceId: 'alpha', running: true }]; },
}, 50, 50);
await feed.start();
feed.putSettings(device.deviceId, { expectedRevision: 0, enabled: true, projects: [], chats: [] });
await feed.idle();
const stream = new AbortController().signal;
let cursor = (await feed.page(device.deviceId)).nextCursor;
const heaps: number[] = [];
for (let k = 0; k < rounds; k++) {
  for (let i = 0; i < 10_000; i++) {
    if (path === 'event') { emit('chat', { seq: ++seq, type: 'tool/result', time: Date.now() }); await feed.idle(); }
    else if (path === 'page') cursor = (await feed.page(device.deviceId, cursor, 100, stream)).nextCursor;
    else { check!(); await feed.idle(); }
  }
  heaps.push(await heap());
}
const coverage = feed.coverage;
await feed.close(); state.close(); rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ coverage, heaps }));
