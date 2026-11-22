// The phone's way to DSH: Tailcat reaches only the companion's own server, so the companion relays /dsh/* to DSH's
// web protocol, signed in as DSH's Desktop host signs in. Only a device paired with every workspace (the owner's
// phone) may use it. The stand-in DSH (helpers/fake-dsh.ts) mints a host-bound cookie at GET /?token=.
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { createDshRelay } from '../src/dsh-relay.ts';
import { startHostServer } from '../src/server.ts';
import type { HostAdapter, HostConfiguration } from '../src/types.ts';
import { fakeDsh, TOKEN } from './helpers/fake-dsh.ts';

const adapter = { upstreamVersion: 'synthetic', async listSessions() { return []; }, async listPresets() { return []; } } as unknown as HostAdapter;
const waitFor = async (probe: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!probe()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)); } };
const ENVELOPE = { type: 'client-request', rpcId: 'r', method: 'session/list', payload: { args: { _request: {} } } };

async function setup(t: TestContext) {
  const dsh = await fakeDsh(t);
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-route-')));
  const pkg = join(dir, 'p.nshpkg'); writeFileSync(pkg, 'signed-package-bytes');
  const ui = { packagePath: (id: string) => (id === 'call/1' ? pkg : undefined), rootKey: async () => 'root-public-key' };
  const config: HostConfiguration = { hostName: 'Synthetic', bind: '127.0.0.1', port: 0, statePath: join(dir, 'host.sqlite'), allowInsecureLoopback: true, workspaces: [{ id: 'alpha', name: 'alpha', path: dir }] };
  const relay = createDshRelay({ ui, upstream: () => ({ origin: dsh.origin, loginUrl: `${dsh.origin}/?token=${TOKEN}` }) });
  const host = await startHostServer({ config, adapter, dsh: () => relay });
  const base = (await host.start()).baseUrl;
  t.after(async () => { await relay.close(); await host.close(); rmSync(dir, { recursive: true, force: true }); });
  const pair = (grants: { readWorkspaceIds: string[]; executeWorkspaceIds: string[] }) => host.state.consumePairing(host.state.createPairing(grants).pairingToken, 'Synthetic phone').deviceToken;
  const post = (path: string, token?: string, headers: Record<string, string> = {}) => fetch(`${base}/dsh${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(ENVELOPE) });
  return { dsh, base, pair, post, host, owner: pair({ readWorkspaceIds: ['*'], executeWorkspaceIds: ['*'] }) };
}

test('the owner\'s phone reaches DSH: one sign-in, DSH\'s Host and session cookie, nothing of the phone\'s own', async t => {
  const { dsh, post, owner } = await setup(t);
  const first = await post('/api/session/list', owner, { cookie: 'phone=1' });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { echoed: ENVELOPE, path: '/api/session/list' });
  assert.equal((await post('/api/session/list', owner)).status, 200);
  assert.equal(dsh.logins(), 1, 'one sign-in serves later requests');
  const forwarded = dsh.seen.filter(s => s.path.startsWith('/api/'));
  assert.equal(forwarded.length, 2);
  assert.ok(forwarded.every(s => s.host === new URL(dsh.origin).host && !s.authorization && !s.cookie?.includes('phone=1') && !s.path.includes(owner)), 'the device token and the phone\'s cookies never reach DSH');
});

test('only the owner\'s phone, only with its token in the header, only the API', async t => {
  const { dsh, base, pair, post, owner } = await setup(t);
  assert.equal((await post('/api/session/list', pair({ readWorkspaceIds: ['*'], executeWorkspaceIds: [] }))).status, 403, 'a phone limited to reading must not get owner access to DSH');
  assert.equal((await post('/api/session/list', pair({ readWorkspaceIds: ['alpha'], executeWorkspaceIds: ['alpha'] }))).status, 403);
  assert.equal((await post('/api/session/list')).status, 401);
  assert.equal((await post(`/api/session/list?dshm_key=${owner}`)).status, 401, 'no query credentials outside the socket');
  assert.equal((await post('/api/session/list', owner, { origin: 'https://example.invalid' })).status, 403, 'no browser surface');
  assert.equal((await fetch(`${base}/dsh/`, { headers: { authorization: `Bearer ${owner}` } })).status, 404);
  assert.equal(dsh.seen.length, 0);
});

// The computer's Settings page lists which phone changed which DSH setting or plugin (client/index.js), named as DSH
// Desktop names them: a plugin's own title (its locale files, DSH's meta.title), a provider's display name.
test('a change DSH made is kept with the phone\'s name and DSH\'s own names for it, never its values', async t => {
  const { dsh, host, pair, base, owner } = await setup(t);
  const voice = '@deepseek-ai/dsh-experimental-voice-input-bundle';
  dsh.answers.set('pluginManager/listBundles', () => [{ name: voice, meta: { title: { en: 'Voice input', zh: '语音输入' } } }, { name: '@deepseek-ai/dsh-cua-bundle', meta: { title: { en: 'Computer use' } } }]);
  dsh.answers.set('llm/listConfigurableProviders', () => [{ provider: 'deepseek', displayName: 'DeepSeek', settingsNs: 'llm', settingsPath: ['providers', 'deepseek'] }]);
  dsh.answers.set('pluginManager/setBundleEnabled', () => ({ changed: true, application: 'applied' }));
  dsh.answers.set('credentials/set', () => null);
  dsh.answers.set('settings/mutate', (args: { ns: string }) => { if (args.ns === 'locked') throw new Error('settings/conflict'); return { revision: 4 }; });
  const call = (method: string, args: Record<string, unknown>, token = owner) => fetch(`${base}/dsh/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ type: 'client-request', rpcId: 'r', method, payload: { args } }) });
  assert.equal((await call('session/list', { _request: {} })).status, 200)
  assert.equal((await call('pluginManager/setBundleEnabled', { name: voice, enabled: true })).status, 200)
  assert.equal((await call('credentials/set', { ref: 'DEEPSEEK_API_KEY', value: 'sk-synthetic-secret' })).status, 200)
  assert.equal((await call('settings/mutate', { ns: 'llm', ops: [{ op: 'set', path: ['providers', 'deepseek', 'baseUrl'], value: 'https://secret.invalid' }], expectedRevision: 3 })).status, 200)
  assert.equal((await call('settings/mutate', { ns: 'agent-preset-registry', ops: [{ op: 'set', path: ['selectedDefault'], value: 'secret-preset' }], expectedRevision: 1 })).status, 200)
  // DSH refused this one: nothing changed, so nothing is kept.
  assert.equal((await call('settings/mutate', { ns: 'locked', ops: [{ op: 'set', path: ['x'], value: 1 }], expectedRevision: 1 })).status, 200)
  // A phone allowed only to read is refused before anything is relayed or kept.
  assert.equal((await call('pluginManager/setBundleEnabled', { name: 'x', enabled: false }, pair({ readWorkspaceIds: ['*'], executeWorkspaceIds: [] }))).status, 403)
  await waitFor(() => host.state.listPhoneChanges().length === 4)
  await new Promise(resolve => setTimeout(resolve, 100))
  const kept = host.state.listPhoneChanges()
  assert.deepEqual(kept.map(({ deviceName, method, target, label }) => ({ deviceName, method, target, label })).sort((a, b) => a.method.localeCompare(b.method) || a.target.localeCompare(b.target)), [
    { deviceName: 'Synthetic phone', method: 'credentials/set', target: 'DEEPSEEK_API_KEY', label: { provider: 'DeepSeek' } },
    { deviceName: 'Synthetic phone', method: 'pluginManager/setBundleEnabled', target: `${voice} on`, label: { title: { en: 'Voice input', zh: '语音输入' } } },
    { deviceName: 'Synthetic phone', method: 'settings/mutate', target: 'agent-preset-registry selectedDefault', label: { defaultAgent: true } },
    { deviceName: 'Synthetic phone', method: 'settings/mutate', target: 'llm providers.deepseek.baseUrl', label: { provider: 'DeepSeek', field: 'baseUrl' } },
  ])
  const all = JSON.stringify(kept)
  assert.ok(!['sk-synthetic-secret', 'secret.invalid', 'secret-preset'].some(v => all.includes(v)), 'no value or key is kept')
  assert.ok(kept.every(c => Number.isFinite(c.at) && c.deviceId.length > 0))
});

// A phone paired to read every workspace but run none sees the computer's settings and plugins (Computer settings on
// the phone shows them without controls); it changes nothing, opens no socket, and a phone limited to some workspaces
// sees none of it.
test('a phone that may only read reads the computer\'s settings and plugins, and changes nothing', async t => {
  const { dsh, base, pair, owner } = await setup(t);
  dsh.answers.set('settings/describe', () => ({ writable: true, hasDocument: true, namespaces: [] }));
  dsh.answers.set('pluginManager/listBundles', () => []);
  const call = (method: string, token: string) => fetch(`${base}/dsh/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ type: 'client-request', rpcId: 'r', method, payload: { args: {} } }) });
  const reader = pair({ readWorkspaceIds: ['*'], executeWorkspaceIds: [] }), some = pair({ readWorkspaceIds: ['alpha'], executeWorkspaceIds: ['alpha'] });
  assert.equal((await call('settings/describe', reader)).status, 200);
  assert.equal((await call('pluginManager/listBundles', reader)).status, 200);
  for (const method of ['settings/mutate', 'pluginManager/setBundleEnabled', 'pluginManager/removeBundle', 'credentials/set', 'session/list']) assert.equal((await call(method, reader)).status, 403, method);
  assert.equal((await call('settings/describe', some)).status, 403);
  const forwarded = dsh.seen.filter(x => x.path.startsWith('/api/')).map(x => x.path);
  assert.deepEqual(forwarded, ['/api/settings/describe', '/api/pluginManager/listBundles']);
  const socket = new WebSocket(`${base.replace('http', 'ws')}/dsh/api/remote.mux?dshm_key=${reader}`);
  const refused = await new Promise<number>(resolve => { socket.once('unexpected-response', (_r, res) => resolve(res.statusCode ?? 0)); socket.once('open', () => resolve(101)); socket.once('error', () => resolve(0)); });
  assert.equal(refused, 403, 'no socket for a phone that may only read');
  const control = async (token: string) => ((await (await fetch(`${base}/v1/capabilities`, { headers: { authorization: `Bearer ${token}` } })).json()) as { capabilities: { control: boolean } }).capabilities.control;
  assert.equal(await control(reader), false);
  assert.equal(await control(owner), true);
});

// Turning DSH Anywhere off (or removing or updating it) stops the companion while DSH acts, so the change is kept before
// DSH answers: DSH Desktop's page names the phone once DSH Anywhere runs again.
test('a phone turning DSH Anywhere itself off is kept before DSH answers, even when no answer comes back', async t => {
  const { dsh, host, base, owner } = await setup(t);
  dsh.answers.set('pluginManager/setBundleEnabled', () => { throw new Error('operation-error'); });
  const res = await fetch(`${base}/dsh/api/pluginManager/setBundleEnabled`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${owner}` }, body: JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'pluginManager/setBundleEnabled', payload: { args: { name: '@jt-wang/dsh-anywhere', enabled: false } } }) });
  assert.equal(res.status, 200);
  const kept = host.state.listPhoneChanges();
  assert.deepEqual(kept.map(({ deviceName, method, target, label }) => ({ deviceName, method, target, label })), [
    { deviceName: 'Synthetic phone', method: 'pluginManager/setBundleEnabled', target: '@jt-wang/dsh-anywhere off', label: { title: 'DSH Anywhere' } },
  ]);
});

// DSH stops the companion while it acts on some changes (an update or reinstall of DSH Anywhere, a reload of its
// settings), closing the companion's state before the answer comes back. Keeping the change then fails; that must stay
// inside the companion, because an unhandled rejection makes DSH exit its whole host (DSH Desktop 0.2.2-rc.5 crash
// report "database is not open at HostState.recordPhoneChange", companion 0.8.6).
test('a change answered after DSH stopped the companion reaches the phone and never escapes as an error', async t => {
  const { dsh, host, base, owner } = await setup(t);
  const escaped: unknown[] = [];
  const onError = (error: unknown) => { escaped.push(error); };
  process.on('unhandledRejection', onError); process.on('uncaughtException', onError);
  t.after(() => { process.off('unhandledRejection', onError); process.off('uncaughtException', onError); });
  dsh.answers.set('pluginManager/installBundle', () => { host.state.close(); return { changed: true, application: 'applied' }; });
  const res = await fetch(`${base}/dsh/api/pluginManager/installBundle`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${owner}` }, body: JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'pluginManager/installBundle', payload: { args: { options: { expected: { name: '@jt-wang/dsh-anywhere' } } } } }) });
  assert.equal(res.status, 200);
  assert.equal((await res.json() as { result: { ok: boolean } }).result.ok, true, 'the phone still gets DSH\'s answer');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(escaped, [], 'nothing escapes the companion to DSH');
});

test('an expired DSH session is renewed once and the request still succeeds', async t => {
  const { dsh, post, owner } = await setup(t);
  assert.equal((await post('/api/session/list', owner)).status, 200);
  dsh.rotate();
  assert.equal((await post('/api/session/list', owner)).status, 200);
  assert.equal(dsh.logins(), 2);
});

test('the socket is relayed both ways with DSH\'s cookie; the token may ride its query', async t => {
  const { base, pair, owner } = await setup(t);
  const ws = new WebSocket(`${base.replace('http', 'ws')}/dsh/api/remote.mux?dshm_key=${owner}`);
  t.after(() => ws.terminate());
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const echoed = new Promise<string>(resolve => ws.once('message', data => resolve(String(data))));
  ws.send('ping');
  assert.equal(await echoed, 'echo:ping');
  for (const [token, status] of [[pair({ readWorkspaceIds: ['*'], executeWorkspaceIds: [] }), 403], ['wrong', 401]] as const) {
    const refused = new WebSocket(`${base.replace('http', 'ws')}/dsh/api/remote.mux?dshm_key=${token}`);
    refused.on('error', () => {}); t.after(() => refused.terminate());
    assert.equal(await new Promise<number>(resolve => refused.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))), status);
  }
});

test('generated modules: the owner\'s phone gets the root key and a call\'s package', async t => {
  const { base, dsh, owner } = await setup(t);
  const get = (path: string, token?: string) => fetch(`${base}/dsh${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const root = await get('/ui/root.pub', owner);
  assert.equal(root.status, 200); assert.equal(await root.text(), 'root-public-key');
  const pkg = await get(`/ui/package?call=${encodeURIComponent('call/1')}`, owner);
  assert.equal(pkg.status, 200); assert.equal(pkg.headers.get('content-type'), 'application/octet-stream'); assert.equal(await pkg.text(), 'signed-package-bytes');
  assert.equal((await get('/ui/package?call=missing', owner)).status, 404);
  assert.equal((await get('/ui/root.pub')).status, 401);
  assert.equal(dsh.seen.length, 0);
});
