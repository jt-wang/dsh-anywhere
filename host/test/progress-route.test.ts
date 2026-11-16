// The Progress page's two calls under /dsh/companion, in DSH's call envelope, and the capability flag that tells a new
// app the companion has them. An older app never asks, and a companion without them answers as before.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createProgress } from '../src/progress.ts';
import { startHostServer } from '../src/server.ts';
import type { HostAdapter, HostConfiguration } from '../src/types.ts';

const adapter = { upstreamVersion: 'synthetic', async listSessions() { return []; }, async listPresets() { return []; } } as unknown as HostAdapter;

type Sources = Parameters<typeof createProgress>[0]['sources'];
async function setup(t: TestContext, withProgress: boolean, sources?: Sources) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-progress-route-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const progress = withProgress ? await createProgress({ dir: join(base, 'progress'), sources: sources ?? {
    async sessions() { return [{ sessionId: 's1', cwd: '/work/acme-api', title: 'Saved cards endpoint', running: true, updatedAt: 1_800_000_000_000 }]; },
    async opening() { return [{ seq: 1, time: 1, type: 'turn/start', data: { turn: 1 } }]; },
    async projections() { return {}; },
  } }) : undefined;
  if (progress) t.after(() => progress.close());
  const config: HostConfiguration = { hostName: 'Synthetic', bind: '127.0.0.1', port: 0, statePath: join(base, 'host.sqlite'), allowInsecureLoopback: true, workspaces: [{ id: 'alpha', name: 'alpha', path: base }] };
  // The service comes and goes with the Progress plugin (src/progress-plugin.ts); the server asks for it on every call.
  const live = { progress };
  const host = await startHostServer({ config, adapter, folderHome: base, progress: () => live.progress });
  const url = (await host.start()).baseUrl;
  t.after(() => host.close());
  const pair = (grants: { readWorkspaceIds: string[]; executeWorkspaceIds: string[] }) => host.state.consumePairing(host.state.createPairing(grants).pairingToken, 'Synthetic phone').deviceToken;
  const owner = pair({ readWorkspaceIds: ['*'], executeWorkspaceIds: ['*'] });
  const reader = pair({ readWorkspaceIds: ['*'], executeWorkspaceIds: [] });
  const partial = pair({ readWorkspaceIds: ['alpha'], executeWorkspaceIds: ['alpha'] });
  const raw = (method: string, args: Record<string, unknown>, token: string, signal?: AbortSignal) => fetch(`${url}/dsh/companion/${method}`, {
    ...(signal ? { signal } : {}), method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method, payload: { args } }),
  });
  const call = async (method: string, args: Record<string, unknown>, token = owner) => {
    const res = await raw(method, args, token); assert.equal(res.status, 200);
    return (await res.json() as { result: { ok: boolean; value?: any } }).result;
  };
  const capabilities = async () => (await fetch(`${url}/v1/capabilities`, { headers: { authorization: `Bearer ${owner}` } })).json() as Promise<Record<string, any>>;
  return { raw, call, owner, reader, partial, capabilities, progress, live };
}

test('the owner’s phone reads the jobs; a phone limited to some workspaces does not', async t => {
  const { raw, call, partial } = await setup(t, true);
  const result = await call('progress/list', {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.projects.map((p: { title: string; jobs: { title: string; status: string }[] }) => [p.title, p.jobs.map(j => [j.title, j.status])]), [['acme-api', [['Saved cards endpoint', 'running']]]]);
  assert.equal(result.value.judge, false);
  assert.equal((await raw('progress/list', {}, partial)).status, 403);
  assert.equal((await raw('progress/list', { path: '/' }, partial)).status, 403);
});

test('judging is turned on from the phone only with execute for every workspace, and only with a known language', async t => {
  const { raw, call, owner, reader, progress } = await setup(t, true);
  assert.deepEqual((await call('progress/settings', {})).value, { judge: false, language: 'en' }, 'reading the setting needs read only');
  assert.equal((await raw('progress/settings', { judge: true }, reader)).status, 403);
  assert.equal((await raw('progress/settings', { judge: 'yes' }, owner)).status, 400);
  assert.equal((await raw('progress/settings', { language: 'xx' }, owner)).status, 400);
  assert.equal((await raw('progress/settings', { other: 1 }, owner)).status, 400);
  assert.deepEqual((await call('progress/settings', { judge: true, language: 'ko' })).value, { judge: true, language: 'ko' });
  assert.deepEqual(progress!.settings(), { judge: true, language: 'ko' });
});

test('a companion with Progress says so in its capabilities; one without answers every call as before', async t => {
  const withIt = await setup(t, true), without = await setup(t, false);
  const a = await withIt.capabilities(), b = await without.capabilities();
  assert.equal(a.capabilities.progress, true);
  assert.equal('progress' in b.capabilities, false);
  const { progress: _, ...rest } = a.capabilities;
  assert.deepEqual(rest, b.capabilities, 'every other flag an older app reads is unchanged');
  assert.equal((await without.raw('progress/list', {}, without.owner)).status, 404);
  assert.equal((await without.raw('folders/list', {}, without.owner)).status, 200);
  assert.equal((await withIt.raw('folders/list', {}, withIt.owner)).status, 200);
});

test('when the Progress plugin unloads the calls and the flag go with it, and come back when it loads again', async t => {
  const { raw, owner, capabilities, live, progress } = await setup(t, true);
  live.progress = undefined;
  assert.equal('progress' in (await capabilities()).capabilities, false);
  assert.equal((await raw('progress/list', {}, owner)).status, 404);
  live.progress = progress;
  assert.equal((await capabilities()).capabilities.progress, true);
  assert.equal((await raw('progress/list', {}, owner)).status, 200);
});

// The phone cancels a list it gave up on (nsh-app/src/dsh.ts); the request closing aborts the list's
// reads on the computer.
test('a list request the phone cancels aborts the reads the list was waiting on', { timeout: 10_000 }, async t => {
  const reads: AbortSignal[] = [];
  let hanging = false;
  const first = [{ seq: 1, time: 1, type: 'turn/start', data: { turn: 1 } }];
  const hang = <T>(value: T, signal?: AbortSignal) => { if (!hanging) return Promise.resolve(value); if (signal) reads.push(signal); return new Promise<never>(() => {}); };
  const { owner, raw, call, progress } = await setup(t, true, {
    async sessions() { return [{ sessionId: 's1', cwd: '/work/acme-api', title: 'Saved cards endpoint', running: true, updatedAt: 1_800_000_000_000 }]; },
    opening: (_id: string, signal?: AbortSignal) => hang(first, signal),
    projections: (_id: string, signal?: AbortSignal) => hang({}, signal),
  });
  assert.equal((await call('progress/list', {})).ok, true); // the chat has its record
  progress!.event('s1', { seq: 2, time: 2, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'On it.' }] } } });
  await progress!.idle(); hanging = true; // the next list reads its facts again, and DSH does not answer

  const cancel = new AbortController();
  const asked = raw('progress/list', {}, owner, cancel.signal).catch(() => 'cancelled');
  for (let i = 0; i < 100 && reads.length < 2; i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(reads.length >= 2, 'the list was reading');
  cancel.abort();
  assert.equal(await asked, 'cancelled');
  for (let i = 0; i < 100 && reads.some(s => !s.aborted); i++) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(reads.map(s => s.aborted), reads.map(() => true), 'every read of the cancelled list is aborted');
});
