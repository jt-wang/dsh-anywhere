// The Progress plugin on its own (src/progress-plugin.ts): a Cordis plugin that provides the `progress` service, which
// the companion's phone calls and any other plugin inject. Every chat, folder and text here is made up.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import progressPlugin from '../src/progress-plugin.ts';
import type { ProgressService } from '../src/progress-plugin.ts';
import type { ProgressView } from '../src/progress.ts';

const NOW = 1_800_000_000_000;
const events = (sessionId: string) => [
  { seq: 1, time: NOW, type: 'turn/start', data: { turn: 1 } },
  { seq: 2, time: NOW + 1, type: 'user/message', data: { id: `m-${sessionId}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Add a POST /cards endpoint' }] } },
  { seq: 3, time: NOW + 2, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'POST /cards is in.' }] } } },
  { seq: 4, time: NOW + 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
];
/** DSH's session controller as the plugin reads it: one made-up chat in acme-api. */
const sessionController = {
  async list() { return { items: [{ sessionId: 's1', cwd: '/work/acme-api', running: false, updatedAt: NOW + 3, projections: { values: { title: 'Saved cards endpoint' } } }] }; },
  follow() { return (async function* () { yield { records: events('s1') }; })(); },
  async projections() { return { values: {} }; },
};
const workspaceRegistry = { list: () => [{ id: 'ws-api', title: 'acme-api', path: '/work/acme-api', status: async () => 'ok' as const }], archivedSessionIds: [] };

function directory(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-progress-plugin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The context the plugin gets, as far as it uses one: services by name, events, and what it provides. */
function fakeContext(services: Record<string, unknown>) {
  const listeners = new Map<string, Set<(...args: any[]) => unknown>>(), provided = new Map<string, unknown>();
  return {
    provided, listeners,
    sessionController,
    get(name: string) { return services[name]; },
    on(name: string, listener: (...args: any[]) => unknown) { const set = listeners.get(name) ?? new Set(); set.add(listener); listeners.set(name, set); return () => set.delete(listener); },
    provide(name: string, value: unknown) { provided.set(name, value); return () => provided.delete(name); },
  };
}

test('the plugin provides `progress`: the jobs by project, the setting, and a change of it kept in its own folder', async t => {
  const dir = directory(t), ctx = fakeContext({ workspaceRegistry, profileContext: {} });
  const dispose = await progressPlugin.apply(ctx as any, { dir });
  t.after(() => dispose());
  const service = ctx.provided.get('progress') as ProgressService;
  assert.ok(service, 'provided under the name other plugins inject');
  assert.deepEqual(service.settings(), { judge: false, language: 'en' });
  const view = await service.list(AbortSignal.timeout(5000));
  assert.deepEqual(view.projects.map(p => [p.title, p.workspaceId, p.jobs.map(j => [j.title, j.status, j.result?.text])]), [['acme-api', 'ws-api', [['Saved cards endpoint', 'done', 'POST /cards is in.']]]]);
  assert.deepEqual(await service.configure({ judge: true, language: 'zh-Hans' }), { judge: true, language: 'zh-Hans' });
  assert.equal(Object.keys(service).sort().join(','), 'configure,list,settings', 'only what a reader needs; no event feed, no close');
});

test('the plugin hears every chat while it runs and stops hearing when it is unloaded', async t => {
  const dir = directory(t), ctx = fakeContext({});
  const dispose = await progressPlugin.apply(ctx as any, { dir });
  assert.equal(ctx.listeners.get('session/event')?.size, 1);
  await dispose();
  assert.equal(ctx.listeners.get('session/event')?.size, 0);
});

test('without a DSH home or a folder from its row the plugin provides nothing and does not fail', async () => {
  const ctx = fakeContext({ profileContext: {} });
  const dispose = await progressPlugin.apply(ctx as any, {});
  assert.equal(ctx.provided.has('progress'), false);
  await dispose();
});

test('the folder is <DSH home>/dsh-anywhere/progress when DSH says where its home is', async t => {
  const home = directory(t), ctx = fakeContext({ profileContext: { home } });
  const dispose = await progressPlugin.apply(ctx as any, { dir: join(home, 'ignored') });
  t.after(() => dispose());
  await (ctx.provided.get('progress') as ProgressService).configure({ judge: true });
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(join(home, 'dsh-anywhere', 'progress', 'jobs.json')), true);
  assert.equal(existsSync(join(home, 'ignored')), false);
});

test('a <DSH home>/dsh-mobile folder from an earlier release moves to dsh-anywhere with its saved settings', async t => {
  const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs');
  // A real saved setting (judging on), as an earlier release wrote it, placed under the old folder name.
  const earlier = directory(t), first = fakeContext({ profileContext: { home: earlier } });
  const stop = await progressPlugin.apply(first as any, {});
  await (first.provided.get('progress') as ProgressService).configure({ judge: true });
  await stop();
  const saved = readFileSync(join(earlier, 'dsh-anywhere', 'progress', 'jobs.json'), 'utf8');
  const home = directory(t), ctx = fakeContext({ profileContext: { home } });
  mkdirSync(join(home, 'dsh-mobile', 'progress'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'dsh-mobile', 'progress', 'jobs.json'), saved, { mode: 0o600 });
  const dispose = await progressPlugin.apply(ctx as any, {});
  t.after(() => dispose());
  assert.equal(existsSync(join(home, 'dsh-mobile')), false);
  assert.equal(readFileSync(join(home, 'dsh-anywhere', 'progress', 'jobs.json'), 'utf8'), saved, 'the saved setting was read, not replaced');
});

// Real Cordis, from a staged DSH runtime (DSH_ANYWHERE_CORDIS_MODULE names any file in it, as phone-adapter.test.ts uses).
test('in a real Cordis context another plugin injects `progress`, and loses it when the Progress plugin unloads', { skip: !process.env.DSH_ANYWHERE_CORDIS_MODULE }, async t => {
  const require = createRequire(process.env.DSH_ANYWHERE_CORDIS_MODULE!);
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  ctx.provide('sessionController', sessionController);
  ctx.provide('workspaceRegistry', workspaceRegistry);
  const dir = directory(t);
  const fiber = ctx.plugin(progressPlugin, { dir });
  await fiber;
  let seen: ProgressService | undefined, lost = 0;
  const consumer = ctx.inject(['progress'], (inner: { progress: ProgressService }) => { seen = inner.progress; return () => { lost++; }; });
  await consumer;
  for (let i = 0; i < 100 && !seen; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(seen, 'the consumer got the service');
  assert.deepEqual(seen!.settings(), { judge: false, language: 'en' });
  assert.equal((await seen!.list(AbortSignal.timeout(5000))).projects[0]?.title, 'acme-api');
  await fiber.dispose();
  for (let i = 0; i < 100 && !lost; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(lost, 1, 'the consumer is told the service went away');
  assert.equal(ctx.get('progress'), undefined);
});

// The whole companion in real Cordis: it mounts the Progress plugin itself (one profile row), the phone reads the jobs
// through it, and unloading the companion unloads both without one waiting on the other.
test('in a real Cordis context the companion mounts the Progress plugin, serves it to the phone, and unloads with it', { skip: !process.env.DSH_ANYWHERE_CORDIS_MODULE, timeout: 20000 }, async t => {
  const require = createRequire(process.env.DSH_ANYWHERE_CORDIS_MODULE!);
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
  const { writeFileSync, existsSync } = await import('node:fs');
  const { createServer } = await import('node:net');
  const { default: companion } = await import('../src/plugin.ts');
  const { HostState } = await import('../src/state.ts');
  const dir = directory(t);
  const reserve = createServer(); await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = (reserve.address() as { port: number }).port; await new Promise<void>(resolve => reserve.close(() => resolve()));
  const config = { hostName: 'Synthetic', bind: '127.0.0.1', port, statePath: join(dir, 'host.sqlite'), allowInsecureLoopback: true, workspaces: [{ id: 'alpha', name: 'alpha', path: dir }] };
  const configPath = join(dir, 'private.json'); writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  ctx.provide('sessionController', sessionController);
  ctx.provide('agentPresets', { async remoteExportList() { return { presets: [] }; } });
  ctx.provide('workspaceRegistry', workspaceRegistry);
  const fiber = ctx.plugin(companion, { dshVersion: '0.2.2-rc.1', configPath });
  await fiber;
  const admin = new HostState(config.statePath);
  t.after(() => admin.close());
  const offer = admin.createPairing({ readWorkspaceIds: ['*'], executeWorkspaceIds: ['*'] });
  const base = `http://127.0.0.1:${port}`;
  const paired = await fetch(`${base}/v1/pairings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pairingToken: offer.pairingToken, deviceName: 'Synthetic phone' }) });
  assert.equal(paired.status, 201);
  const token = (await paired.json() as { deviceToken: string }).deviceToken;
  const capabilities = async () => (await (await fetch(`${base}/v1/capabilities`, { headers: { authorization: `Bearer ${token}` } })).json() as { capabilities: Record<string, unknown> }).capabilities;
  let flag: unknown;
  for (let i = 0; i < 100 && flag !== true; i++) { flag = (await capabilities()).progress; if (flag !== true) await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal(flag, true);
  const listed = await fetch(`${base}/dsh/companion/progress/list`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'progress/list', payload: { args: {} } }) });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json() as { result: { value: ProgressView } }).result.value.projects[0]?.title, 'acme-api');
  assert.ok(ctx.get('progress'), 'other plugins can inject it too');
  const unloaded = await Promise.race([Promise.resolve(fiber.dispose()).then(() => 'unloaded'), new Promise(resolve => setTimeout(() => resolve('stuck'), 5000))]);
  assert.equal(unloaded, 'unloaded');
  assert.equal(ctx.get('progress'), undefined);
  await assert.rejects(fetch(`${base}/v1/capabilities`));
  assert.equal(existsSync(join(dir, 'progress')), true, 'jobs kept next to the companion configuration when DSH names no home');
});

// At the plugin's edge: the dispose the companion awaits when it stops (plugin.ts, progressFiber.dispose)
// returns although a phone gave up a list while reads were waiting for one of the 8 slots.
test('the plugin unloads after a phone gave up a list while reads waited for a slot', { timeout: 10_000 }, async t => {
  const ids = Array.from({ length: 30 }, (_, i) => `c${i}`);
  const slow = <T>(value: T) => new Promise<T>(resolve => setTimeout(() => resolve(value), 50));
  const controller = {
    async list() { return { items: ids.map(id => ({ sessionId: id, cwd: '/work/acme-api', running: false, updatedAt: NOW + 3, projections: { values: { title: `Chat ${id}` } } })) }; },
    follow(id: string) { return (async function* () { yield await slow({ records: events(id) }); })(); },
    projections() { return slow({ values: {} }); },
  };
  const ctx = { ...fakeContext({ workspaceRegistry }), sessionController: controller };
  const dispose = await progressPlugin.apply(ctx as any, { dir: directory(t) });
  const service = ctx.provided.get('progress') as ProgressService;
  const given = new AbortController();
  const listed = service.list(given.signal).catch(() => 'given up');
  await new Promise(resolve => setTimeout(resolve, 5));
  given.abort(new Error('the phone went away'));
  const unloaded = await Promise.race([dispose().then(() => 'unloaded'), new Promise(resolve => setTimeout(() => resolve('stuck'), 3000))]);
  assert.equal(unloaded, 'unloaded');
  assert.equal(await Promise.race([listed, new Promise(resolve => setTimeout(() => resolve('stuck'), 1000))]), 'given up');
});
