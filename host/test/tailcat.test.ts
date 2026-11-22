import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { connect, createServer as createNetServer } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import type { TestContext } from 'node:test';
import { createMobileAdminRoutes } from '../src/admin.ts';
import { runAdminCli, tailcatStatusMessage } from '../src/cli.ts';
import { loadConfiguration, prepareConfiguration } from '../src/config.ts';
import { LOCAL_PAIRING_MAX_ATTEMPTS, LOCAL_PAIRING_SOURCE_GAP_MS, lanAddresses, localPairingCommit, localPairingSession, sameSubnet, serveLocalPairing, wireLine, x25519Private, x25519PublicRaw } from '../src/local-pairing.ts';
import { startHostServer } from '../src/server.ts';
import { setupTailcat } from '../src/setup-tailcat.ts';
import { HostState, hashSecret } from '../src/state.ts';
import { createTailcatConnector, readTailcatRelays, TAILCAT_RESTART_MAX_MS, TAILCAT_WAITING_MAX_MS, tailcatHelperCommand, tailcatRestartDelay } from '../src/tailcat-connector.ts';
import type { HostAdapter, HostConfiguration } from '../src/types.ts';
import { generateServerIdentity } from '../src/x509.ts';
import { createWorkspaceSource } from '../src/workspace-source.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-tailcat-helper.mjs', import.meta.url));
const helper = { command: process.execPath, args: [FAKE] };
const PHONE = 'nodekey:' + 'ab'.repeat(32), OTHER = 'nodekey:' + 'cd'.repeat(32);
const DSH = '0.2.1-alpha.1';
const all = { readWorkspaceIds: ['*'], executeWorkspaceIds: ['*'] };
const adapter: HostAdapter = {
  upstreamVersion: 'synthetic-tailcat', async listPresets() { return []; }, async listSessions() { return []; },
  async snapshot() { throw new Error('No synthetic sessions'); }, async *watch() {},
  async createSession() { return { sessionId: 'synthetic' }; }, async prompt() {}, async cancel() {},
};

const emptyRegistry = { list: () => [], archivedSessionIds: [] };
const registry = () => createWorkspaceSource({ workspaceSource: 'dsh-registry' }, () => emptyRegistry);
// Remove temp directories after every test's own hooks have closed databases and helpers: Windows
// refuses to delete open files, and a throwing hook would skip the remaining cleanup.
const tempDirs: string[] = [];
after(() => { for (const dir of tempDirs) try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp only */ } });
function temp(_t: TestContext, prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}
/** Fake helper behavior is selected by environment; restore it after each test. */
function fakeEnv(t: TestContext, values: Record<string, string>) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
function readLog(path: string): Record<string, any>[] {
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
async function waitFor<T>(probe: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 5000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
async function tailcatSetup(t: TestContext) {
  const dir = temp(t, 'dsh-anywhere-tailcat-'), configPath = join(dir, 'companion', 'host.json');
  const result = await setupTailcat({ configPath, port: await freePort(), dshVersion: DSH, hostName: 'Synthetic Mac' });
  return { dir, configPath, result, config: await loadConfiguration(configPath) };
}

test('native identity is a pinned P-256 serverAuth leaf for exactly one DNS name and completes TLS', async t => {
  const name = 'h-0123456789abcdef0123456789abcdef.dsh.invalid', identity = generateServerIdentity(name);
  const x509 = new X509Certificate(identity.certPem);
  assert.equal(x509.ca, false); assert.ok(x509.verify(x509.publicKey));
  assert.equal(x509.publicKey.asymmetricKeyDetails?.namedCurve, 'prime256v1');
  assert.deepEqual(x509.keyUsage, ['1.3.6.1.5.5.7.3.1']);
  assert.equal(x509.subjectAltName, `DNS:${name}`);
  assert.equal(x509.checkHost(name, { subject: 'never' }), name);
  assert.equal(x509.checkHost('h-other.dsh.invalid'), undefined);
  assert.ok(Date.parse(x509.validTo) - Date.now() <= 825 * 86_400_000);
  assert.equal(identity.pinSha256, 'sha256/' + createHash('sha256').update(x509.publicKey.export({ type: 'spki', format: 'der' })).digest('base64'));
  for (const bad of ['', 'UPPER.invalid', 'nodot', '-x.invalid']) assert.throws(() => generateServerIdentity(bad), { code: 'invalid_request' });
  const server = createHttpsServer({ cert: identity.certPem, key: identity.keyPem, minVersion: 'TLSv1.2' }, (_req, res) => res.end('ok'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const peer = await new Promise<X509Certificate>((resolve, reject) => {
    const socket = tlsConnect({ host: '127.0.0.1', port: (server.address() as { port: number }).port, servername: name, ca: identity.certPem }, () => { resolve(socket.getPeerX509Certificate()!); socket.end(); });
    socket.on('error', reject);
  });
  assert.equal(peer.fingerprint256, x509.fingerprint256);
});

test('tailcat configuration requires loopback TLS with the exact inner name and excludes relay', async t => {
  const { config, configPath, result } = await tailcatSetup(t);
  assert.equal(result.existing, false);
  assert.match(config.publicUrl!, /^https:\/\/h-[a-f0-9]{32}\.dsh\.invalid$/);
  assert.equal(config.publicUrl, `https://h-${config.tailcat!.hostId}.dsh.invalid`);
  assert.equal(config.includeCertificatePem, true); assert.equal(config.workspaceSource, 'dsh-registry');
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as HostConfiguration;
  for (const bad of [{ bind: '0.0.0.0' }, { port: 80 }, { tls: undefined }, { tailcat: { enabled: true, hostId: 'XYZ' } }, { tailcat: { enabled: true, hostId: '0'.repeat(32) } },
    { tailcat: { ...raw.tailcat, helperPath: 'relative/helper' } }, { tailcat: { ...raw.tailcat, extra: 1 } }, { relay: { url: 'wss://relay.example.test', routeId: 'a'.repeat(32), connectorToken: 'A'.repeat(43) } }])
    await assert.rejects(prepareConfiguration({ ...raw, ...bad } as HostConfiguration), { code: 'invalid_config' }, JSON.stringify(Object.keys(bad)));
  assert.deepEqual((await setupTailcat({ configPath, port: raw.port, dshVersion: DSH })).existing, true, 'rerun keeps the identity');
  await assert.rejects(setupTailcat({ configPath, port: raw.port + 1, dshVersion: DSH }), { code: 'invalid_config' });
  assert.throws(() => tailcatHelperCommand({ enabled: true, hostId: raw.tailcat!.hostId, helperPath: join(tmpdir(), 'missing-tailcat-helper') }), { code: 'tailcat_helper_missing' });
  await assert.rejects(startHostServer({ config: { ...raw, tailcat: { ...raw.tailcat!, helperPath: join(tmpdir(), 'missing-tailcat-helper') } }, adapter, workspaceSource: await registry() }), { code: 'tailcat_helper_missing' }, 'fails closed before binding');
});

test('a helper persist without a DERP region yet (null state) is accepted and keeps a fresh identity', async t => {
  const state = new HostState(join(temp(t, 'dsh-tailcat-null-'), 'host.sqlite'));
  t.after(() => state.close());
  state.persistTailcat(null, []);
  assert.equal(state.tailcatSnapshot().state, null);
  assert.deepEqual(state.tailcatSnapshot().allowedClients, []);
  assert.throws(() => state.persistTailcat('', []));
});

test('helper persist is acknowledged only after the state commit, and status never shows secrets', async t => {
  const { dir, config, configPath } = await tailcatSetup(t), log = join(dir, 'helper.log');
  fakeEnv(t, { FAKE_TAILCAT_LOG: log, FAKE_TAILCAT_DB: config.statePath });
  const state = new HostState(config.statePath); t.after(() => state.close());
  const connector = createTailcatConnector({ tailcat: config.tailcat!, state, targetPort: config.port, hostName: config.hostName, helper, pollMs: 20, sweepMs: 50 });
  t.after(() => connector.close());
  connector.start();
  const ack = await waitFor(() => readLog(log).find(row => row.ack));
  assert.deepEqual(ack, { ack: '1', ok: true, committedState: 'fake-node-state-1' });
  const configLine = readLog(log)[0]!.received;
  assert.deepEqual(configLine, { version: 3, localPort: config.port, state: null, allowedClients: [], name: 'Synthetic Mac' });
  await waitFor(() => connector.status().ready);
  let output = '';
  assert.equal(await runAdminCli(['tailcat-status', '--config', configPath], { out: text => { output += text; }, error() {} }), 0);
  const status = JSON.parse(output);
  assert.equal(status.running, true); assert.equal(status.allowedClients, 0);
  assert.ok(!output.includes('fake-node-state'), 'node state stays private');
});

test('tailcat-relay configures an opaque relay whose token reaches the helper only from its owner-only file', async t => {
  const { dir, configPath } = await tailcatSetup(t), log = join(dir, 'helper.log');
  const tokenFile = join(dir, 'companion', 'relay-token');
  writeFileSync(tokenFile, 'relay-token-123\n', { mode: 0o600 });
  let output = '';
  const cli = (args: string[]) => runAdminCli(['tailcat-relay', '--config', configPath, ...args], { out: text => { output += text; }, error() {} });
  assert.deepEqual(readLog(log), []);
  assert.equal((await loadConfiguration(configPath)).tailcat!.relay, undefined, 'no relay by default');
  for (const bad of [[], ['--url', 'wss://relay.example.test'], ['--off', '--url', 'wss://relay.example.test'], ['--url', 'https://relay.example.test', '--token-file', tokenFile],
    ['--url', 'ws://relay.example.test', '--token-file', tokenFile], ['--url', 'wss://relay.example.test/path', '--token-file', tokenFile], ['--url', 'wss://relay.example.test', '--token-file', 'relative']])
    assert.notEqual(await cli(bad), 0, JSON.stringify(bad));
  const before = readFileSync(configPath, 'utf8');
  if (process.platform !== 'win32') {
    chmodSync(tokenFile, 0o644);
    assert.notEqual(await cli(['--url', 'wss://relay.example.test', '--token-file', tokenFile]), 0, 'a readable-by-others token file is refused');
    chmodSync(tokenFile, 0o600);
  }
  assert.equal(readFileSync(configPath, 'utf8'), before, 'refusals leave host.json as it was');
  assert.equal(await cli(['--url', 'wss://relay.example.test/', '--token-file', tokenFile]), 0);
  assert.ok(!output.includes('relay-token-123') && !readFileSync(configPath, 'utf8').includes('relay-token-123'), 'the token stays in its file');
  if (process.platform !== 'win32') assert.equal(statSync(configPath).mode & 0o077, 0, 'host.json stays owner-only');
  const config = await loadConfiguration(configPath);
  assert.deepEqual(config.tailcat!.relay, { url: 'wss://relay.example.test', tokenFile });

  fakeEnv(t, { FAKE_TAILCAT_LOG: log });
  const state = new HostState(config.statePath); t.after(() => state.close());
  const connector = createTailcatConnector({ tailcat: config.tailcat!, state, targetPort: config.port, hostName: config.hostName, helper, relays: await readTailcatRelays(config.tailcat!), pollMs: 20, sweepMs: 50 });
  t.after(() => connector.close());
  connector.start();
  const configLine = (await waitFor(() => readLog(log)[0]))!.received;
  assert.deepEqual(configLine.relays, [{ url: 'wss://relay.example.test', token: 'relay-token-123' }]);

  assert.equal(await cli(['--off']), 0);
  assert.equal((await loadConfiguration(configPath)).tailcat!.relay, undefined);
});

test('tailcat-routes turns the same-network route off and Tailcat only on; the helper gets noLan and tailcatOnly, never with a relay', async t => {
  const { dir, configPath } = await tailcatSetup(t), log = join(dir, 'helper.log');
  let errors = '';
  const cli = (args: string[]) => runAdminCli(['tailcat-routes', '--config', configPath, ...args], { out() {}, error: text => { errors += text; } });
  assert.notEqual(await cli([]), 0); assert.notEqual(await cli(['--lan', 'maybe']), 0);
  assert.equal(await cli(['--lan', 'off']), 0);
  let config = await loadConfiguration(configPath);
  assert.equal(config.tailcat!.lan, false); assert.equal(config.tailcat!.tailcatOnly, undefined);
  fakeEnv(t, { FAKE_TAILCAT_LOG: log });
  const state = new HostState(config.statePath); t.after(() => state.close());
  let connector = createTailcatConnector({ tailcat: config.tailcat!, state, targetPort: config.port, hostName: config.hostName, helper, pollMs: 20, sweepMs: 50 });
  connector.start();
  assert.equal((await waitFor(() => readLog(log)[0]))!.received.noLan, true);
  await connector.close(); rmSync(log, { force: true });
  assert.equal(await cli(['--lan', 'on', '--tailcat-only', 'on']), 0);
  config = await loadConfiguration(configPath);
  assert.equal(config.tailcat!.lan, undefined); assert.equal(config.tailcat!.tailcatOnly, true);
  connector = createTailcatConnector({ tailcat: config.tailcat!, state, targetPort: config.port, hostName: config.hostName, helper, pollMs: 20, sweepMs: 50 });
  t.after(() => connector.close());
  connector.start();
  const line = (await waitFor(() => readLog(log)[0]))!.received;
  assert.equal(line.tailcatOnly, true); assert.equal(line.noLan, undefined);
  const tokenFile = join(dir, 'companion', 'relay-token');
  writeFileSync(tokenFile, 'tok\n', { mode: 0o600 });
  errors = '';
  assert.notEqual(await runAdminCli(['tailcat-relay', '--config', configPath, '--url', 'wss://relay.example.test', '--token-file', tokenFile], { out() {}, error: text => { errors += text; } }), 0);
  assert.match(errors, /tailcat_only_with_relay/);
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  await assert.rejects(prepareConfiguration({ ...raw, tailcat: { ...raw.tailcat, relay: { url: 'wss://relay.example.test', tokenFile } } }), { code: 'invalid_config' });
});

/** The normal invitation never enters the QR: the CLI hands the helper a template, and the helper serves it to the phone over /pair. */
function helperInvitation(log: string): Record<string, any> {
  const template = readLog(log).find(row => row.received?.command === 'pair')?.received.invitation;
  assert.ok(typeof template === 'string' && template.length > 0, 'the CLI handed the helper the invitation template');
  assert.match(template, /\$TAILCAT_ADDRESS/);
  return JSON.parse(template.replaceAll('$TAILCAT_ADDRESS', 'tcfake-normal-address').replaceAll('$PHONE_KEY', PHONE));
}

test('CLI pairing round trip: an emoji window, bootstrap v2 renders, the computer confirms, the helper gets the v4 template, consume links the phone key', async t => {
  const { dir, config, configPath } = await tailcatSetup(t), log = join(dir, 'helper.log');
  fakeEnv(t, { FAKE_TAILCAT_LOG: log, FAKE_TAILCAT_AUTOPAIR: PHONE });
  const state = new HostState(config.statePath); t.after(() => state.close());
  const connector = createTailcatConnector({ tailcat: config.tailcat!, state, targetPort: config.port, hostName: config.hostName, helper, pollMs: 20, sweepMs: 50 });
  t.after(() => connector.close());
  connector.start(); await waitFor(() => connector.status().ready);
  const output = join(dir, 'companion', 'invitations', 'phone.json');
  let errors = '';
  const asked: string[] = [];
  assert.equal(await runAdminCli(['pair', '--config', configPath, '--tailcat', '--read', 'all', '--execute', 'all', '--output', output], { out() {}, error: text => { errors += text; } },
    { emojiConfirm: async (emoji, device, route) => { asked.push(`${device}/${route}/${emoji.join('')}`); return true; } }), 0, errors);
  assert.deepEqual(asked, ['Synthetic phone/tailcat/🐶🌙🍕🔑'], 'the computer asked once, with the phone\'s emoji');
  assert.ok(readLog(log).some(row => row.received?.command === 'confirm' && row.received.approve === true));
  const bootstrap = JSON.parse(readFileSync(output, 'utf8'));
  assert.deepEqual(Object.keys(bootstrap).sort(), ['expiresAt', 'invite', 'version'], 'the QR carries only the TailPocket v2 invite');
  assert.equal(bootstrap.version, 2); assert.equal(bootstrap.invite.v, 2);
  assert.ok(!JSON.stringify(bootstrap).includes('pairingToken'), 'the normal invitation never enters the QR');
  assert.ok(bootstrap.expiresAt > Date.now() && bootstrap.expiresAt <= Date.now() + 121_000);
  assert.ok(readLog(log).some(row => row.received?.command === 'pair' && row.received.emoji === true));
  const invitation = helperInvitation(log);
  assert.equal(invitation.version, 4); assert.equal(invitation.baseUrl, config.publicUrl);
  assert.deepEqual(invitation.tailcat, { address: 'tcfake-normal-address', port: 48931 }, 'the normal invitation names the normal node and carries no key or proof');
  assert.match(invitation.certificatePem, /BEGIN CERTIFICATE/); assert.match(invitation.pinSha256, /^sha256\//);
  // The fake phone is allowlisted through the window; the key is provisional until /v1/pairings succeeds.
  await waitFor(() => state.tailcatClientCounts().pending === 1);
  assert.deepEqual(state.tailcatAllowedClients(), [PHONE]);
  const paired = state.consumePairing(invitation.pairingToken, 'Synthetic phone');
  assert.deepEqual(state.tailcatClientCounts(), { linked: 1, pending: 0 });
  assert.equal(state.nextTailcatPairingRequest(), undefined, 'the CLI deleted the request row and its invite');
  // Revocation removes reachability on the next sweep.
  state.revokeDevice(paired.deviceId); connector.sweep();
  await waitFor(() => readLog(log).some(row => row.received?.command === 'setAllowed' && row.received.allowedClients.length === 0));
  assert.deepEqual(state.tailcatAllowedClients(), []);
});

test('revoking the old device record leaves a fresh pairing of the same phone reachable', async t => {
  const { config } = await tailcatSetup(t);
  const state = new HostState(config.statePath); t.after(() => state.close());
  const grants = { readWorkspaceIds: ['*'], executeWorkspaceIds: ['*'] };
  const pair = (key: string) => {
    const offer = state.createPairing(grants);
    state.recordTailcatPaired(key, { pairingHash: hashSecret(offer.pairingToken), offerExpiresAt: offer.expiresAt });
    return state.consumePairing(offer.pairingToken, 'Synthetic phone');
  };
  const old = pair(PHONE);
  const fresh = pair(OTHER);
  assert.deepEqual(state.tailcatAllowedClients(), [PHONE, OTHER]);
  assert.equal(state.revokeDevice(old.deviceId), true);
  assert.deepEqual(state.tailcatAllowedClients(), [OTHER]);
  assert.equal(state.authenticate(old.deviceToken), undefined);
  assert.equal(state.authenticate(fresh.deviceToken)?.deviceId, fresh.deviceId);
});

test('Settings pairing: the QR returns while the emoji window waits, the page shows the phone\'s emoji, and its answer decides', async t => {
  const { dir, config, configPath } = await tailcatSetup(t), log = join(dir, 'helper.log');
  fakeEnv(t, { FAKE_TAILCAT_LOG: log, FAKE_TAILCAT_AUTOPAIR: PHONE });
  const state = new HostState(config.statePath); t.after(() => state.close());
  const connector = createTailcatConnector({ tailcat: config.tailcat!, state, targetPort: config.port, hostName: config.hostName, helper, pollMs: 20, sweepMs: 50 });
  t.after(() => connector.close());
  connector.start(); await waitFor(() => connector.status().ready);
  const routes = new Map(createMobileAdminRoutes({ configPath, dshVersion: '0.2.2', transport: 'tailcat' }).map(route => [route.path, route]));
  const call = async (path: string, body: unknown) => {
    const response = await routes.get(`/api/dsh-anywhere/${path}`)!.fetch(new Request('http://dsh.test/', { method: 'POST', body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const status = await routes.get('/api/dsh-anywhere/status')!.fetch(new Request('http://dsh.test/'));
  assert.match((await status.json() as { hostVersion: string }).hostVersion, /^\d+\.\d+\.\d+/);
  // Refused first: the page's no ends the window, and that code pairs nobody.
  const first = await call('pair', { execute: true });
  assert.equal(first.status, 200, JSON.stringify(first.body)); assert.match(first.body.svg, /^<svg/);
  const asking = await waitFor(async () => { const view = (await call('pairing', { id: first.body.id })).body; return view.phase === 'confirm' ? view : undefined; });
  assert.deepEqual([asking!.device, asking!.emoji.join('')], ['Synthetic phone', '🐶🌙🍕🔑']);
  assert.equal((await call('pairing/answer', { id: first.body.id, approve: false })).body.phase, 'refused');
  await waitFor(() => readLog(log).some(row => row.received?.command === 'confirm' && row.received.approve === false));
  assert.deepEqual(state.tailcatAllowedClients(), []);
  // A new code, approved: the CLI finishes and the page reads approved.
  const second = await call('pair', { execute: true });
  assert.equal(second.status, 200);
  assert.equal((await call('pairing', { id: first.body.id })).status, 404, 'a new code closes the old one');
  await waitFor(async () => (await call('pairing', { id: second.body.id })).body.phase === 'confirm');
  assert.equal((await call('pairing/answer', { id: second.body.id, approve: 'yes' })).status, 400);
  await call('pairing/answer', { id: second.body.id, approve: true });
  await waitFor(async () => (await call('pairing', { id: second.body.id })).body.phase === 'approved');
  assert.equal((await call('pairing/answer', { id: second.body.id, approve: true })).status, 409);
  await waitFor(() => state.tailcatClientCounts().pending === 1);
});

test('Settings lists the changes phones made to DSH here, newest first', async t => {
  const { config, configPath } = await tailcatSetup(t);
  const state = new HostState(config.statePath); t.after(() => state.close());
  const routes = new Map(createMobileAdminRoutes({ configPath, dshVersion: '0.2.2', transport: 'tailcat' }).map(route => [route.path, route]));
  const read = async () => (await (await routes.get('/api/dsh-anywhere/phone-changes')!.fetch(new Request('http://dsh.test/'))).json()) as { items: Record<string, unknown>[] };
  assert.deepEqual(await read(), { items: [] });
  const { deviceId } = state.consumePairing(state.createPairing({ readWorkspaceIds: ['*'], executeWorkspaceIds: ['*'] }).pairingToken, 'Synthetic phone');
  const device = state.getDevice(deviceId)!;
  state.recordPhoneChange(device, 'pluginManager/setBundleEnabled', '@deepseek-ai/dsh-experimental-voice-input-bundle on');
  state.recordPhoneChange(device, 'speech/prepare', 'local');
  const items = (await read()).items;
  assert.deepEqual(items.map(({ deviceName, method, target }) => ({ deviceName, method, target })), [
    { deviceName: 'Synthetic phone', method: 'speech/prepare', target: 'local' },
    { deviceName: 'Synthetic phone', method: 'pluginManager/setBundleEnabled', target: '@deepseek-ai/dsh-experimental-voice-input-bundle on' },
  ]);
});

test('a no on the computer ends the emoji window: nothing is paired and the offer is gone', async t => {
  const { dir, config, configPath } = await tailcatSetup(t), log = join(dir, 'helper.log');
  fakeEnv(t, { FAKE_TAILCAT_LOG: log, FAKE_TAILCAT_AUTOPAIR: PHONE });
  const state = new HostState(config.statePath); t.after(() => state.close());
  const connector = createTailcatConnector({ tailcat: config.tailcat!, state, targetPort: config.port, hostName: config.hostName, helper, pollMs: 20, sweepMs: 50 });
  t.after(() => connector.close());
  connector.start(); await waitFor(() => connector.status().ready);
  let errors = '';
  const output = join(dir, 'companion', 'invitations', 'refused.json');
  assert.equal(await runAdminCli(['pair', '--config', configPath, '--tailcat', '--read', 'all', '--output', output], { out() {}, error: text => { errors += text; } },
    { emojiConfirm: async () => false }), 1);
  assert.match(errors, /pairing_not_approved/);
  assert.ok(readLog(log).some(row => row.received?.command === 'confirm' && row.received.approve === false));
  assert.deepEqual(state.tailcatAllowedClients(), [], 'the refused phone is not allowed');
  assert.throws(() => state.consumePairing(helperInvitation(log).pairingToken, 'Refused phone'), { code: 'unauthorized' }, 'the offer behind the window is cancelled');
});

test('pair --tailcat refuses an existing output file before opening a window, and says so', async t => {
  const { dir, config, configPath } = await tailcatSetup(t), log = join(dir, 'helper.log');
  fakeEnv(t, { FAKE_TAILCAT_LOG: log, FAKE_TAILCAT_AUTOPAIR: PHONE });
  const state = new HostState(config.statePath); t.after(() => state.close());
  const connector = createTailcatConnector({ tailcat: config.tailcat!, state, targetPort: config.port, hostName: config.hostName, helper, pollMs: 20, sweepMs: 50 });
  t.after(() => connector.close());
  connector.start(); await waitFor(() => connector.status().ready);
  const output = join(dir, 'companion', 'invitations', 'stale.json');
  const io = { out() {}, error: (text: string) => { errors += text; } };
  let errors = '';
  assert.equal(await runAdminCli(['pair', '--config', configPath, '--tailcat', '--read', 'all', '--output', output], io, { emojiConfirm: async () => true }), 0, errors);
  const first = readFileSync(output, 'utf8');
  errors = '';
  assert.equal(await runAdminCli(['pair', '--config', configPath, '--tailcat', '--read', 'all', '--execute', 'all', '--output', output], io, { emojiConfirm: async () => true }), 1);
  assert.match(errors, /^invitation_output_exists/, 'an existing file is not reported as an unreachable companion');
  assert.equal(readFileSync(output, 'utf8'), first, 'the existing file is left untouched');
  assert.equal(readLog(log).filter(row => row.received?.command === 'pair').length, 1, 'no second pairing window was opened');
});

test('unconsumed phone keys expire from the allowlist, and pairing fails cleanly without a running companion', async t => {
  const { dir, config, configPath } = await tailcatSetup(t), log = join(dir, 'helper.log');
  let now = Date.now();
  const state = new HostState(config.statePath, { now: () => now }); t.after(() => state.close());
  const offer = state.createPairing(all), hash = hashSecret(offer.pairingToken);
  state.persistTailcat('fake-node-state-1', [PHONE], { pairingHash: hash, offerExpiresAt: offer.expiresAt });
  state.persistTailcat('fake-node-state-1', [PHONE, OTHER]); // A key outside any window expires immediately.
  now += 1;
  assert.deepEqual(state.tailcatAllowedClients(), [PHONE]);
  fakeEnv(t, { FAKE_TAILCAT_LOG: log });
  const connector = createTailcatConnector({ tailcat: config.tailcat!, state, targetPort: config.port, hostName: config.hostName, helper, pollMs: 20, sweepMs: 50 });
  t.after(() => connector.close());
  connector.start();
  await waitFor(() => readLog(log)[0]?.received?.allowedClients?.length === 1);
  now = offer.expiresAt + 60_001; connector.sweep();
  await waitFor(() => readLog(log).some(row => row.received?.command === 'setAllowed' && row.received.allowedClients.length === 0));
  await connector.close();
  let errors = '';
  assert.equal(await runAdminCli(['pair', '--config', configPath, '--tailcat', '--read', 'all', '--qr'], { out() {}, error: text => { errors += text; } }, { tailcatWaitMs: 300 }), 1);
  assert.match(errors, /^tailcat_unavailable/);
});

test('a crashing helper restarts with backoff and resumes from persisted state', async t => {
  const { dir, config } = await tailcatSetup(t), log = join(dir, 'helper.log');
  fakeEnv(t, { FAKE_TAILCAT_LOG: log, FAKE_TAILCAT_CRASH_ONCE: join(dir, 'crashed') });
  const state = new HostState(config.statePath); t.after(() => state.close());
  state.persistTailcat('persisted-node-state', []);
  const connector = createTailcatConnector({ tailcat: config.tailcat!, state, targetPort: config.port, hostName: config.hostName, helper, pollMs: 20, sweepMs: 50 });
  t.after(() => connector.close());
  connector.start();
  await waitFor(() => connector.status().ready, 8000);
  assert.ok(connector.status().restarts >= 1);
  const configs = readLog(log).filter(row => row.received?.version === 3);
  assert.equal(configs.length, 2);
  assert.ok(configs.every(row => row.received.state === 'persisted-node-state'));
});

test('restart backoff doubles from 1 s and stops at 30 s after crashes, at 5 minutes while waiting for the network', () => {
  const crashes = Array.from({ length: 12 }, (_, n) => tailcatRestartDelay(n, false));
  const waiting = Array.from({ length: 12 }, (_, n) => tailcatRestartDelay(n, true));
  assert.deepEqual(crashes.slice(0, 6), [1000, 2000, 4000, 8000, 16_000, 30_000]);
  assert.deepEqual(waiting.slice(0, 10), [1000, 2000, 4000, 8000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000]);
  assert.equal(Math.max(...crashes, tailcatRestartDelay(1000, false)), TAILCAT_RESTART_MAX_MS);
  assert.equal(Math.max(...waiting, tailcatRestartDelay(1000, true)), TAILCAT_WAITING_MAX_MS);
  assert.equal(TAILCAT_WAITING_MAX_MS, 5 * 60_000);
});

test('offline and never paired, the helper waits for the network: the companion and tailcat-status say so, not a crash', async t => {
  const { dir, config, configPath } = await tailcatSetup(t), log = join(dir, 'helper.log');
  fakeEnv(t, { FAKE_TAILCAT_LOG: log, FAKE_TAILCAT_OFFLINE: '1' });
  const state = new HostState(config.statePath); t.after(() => state.close());
  const connector = createTailcatConnector({ tailcat: config.tailcat!, state, targetPort: config.port, hostName: config.hostName, helper, pollMs: 20, sweepMs: 50 });
  t.after(() => connector.close());
  connector.start();
  await waitFor(() => connector.status().phase === 'waiting-for-network');
  const status = connector.status();
  assert.equal(status.ready, false);
  assert.ok(status.retryAt! > Date.now() && status.retryAt! <= Date.now() + TAILCAT_WAITING_MAX_MS);
  let output = '', errors = '';
  assert.equal(await runAdminCli(['tailcat-status', '--config', configPath], { out: text => { output += text; }, error: text => { errors += text; } }), 0);
  const printed = JSON.parse(output);
  assert.equal(printed.phase, 'waiting-for-network'); assert.equal(printed.running, false); assert.equal(typeof printed.retryAt, 'number');
  assert.match(errors, /^Waiting for the network: no phone is paired yet.*Not a crash; it keeps trying, at most every 5 minutes\. Next try in \d+ s\.\n$/);
  // A helper that stops with an identity is restarting, said as such.
  assert.match(tailcatStatusMessage('restarting', Date.now() + 4000), /^The Tailcat helper stopped; restarting\. Next try in [45] s\.$/);
  assert.equal(tailcatStatusMessage('ready', null), '');
});

test('companion server runs the helper, exempts loopback tunnels from throttling and links the paired phone', async t => {
  const { dir, configPath } = await tailcatSetup(t), log = join(dir, 'helper.log');
  fakeEnv(t, { FAKE_TAILCAT_LOG: log, FAKE_TAILCAT_AUTOPAIR: PHONE });
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as HostConfiguration;
  const host = await startHostServer({ config: raw, adapter, workspaceSource: await registry(), tailcatHelper: helper });
  t.after(() => host.close());
  await waitFor(() => host.tailcat?.status().ready);
  const output = join(dir, 'companion', 'invitations', 'server.json');
  assert.equal(await runAdminCli(['pair', '--config', configPath, '--tailcat', '--read', 'all', '--output', output], { out() {}, error() {} }, { emojiConfirm: async () => true }), 0);
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).version, 2);
  await waitFor(() => host.state.tailcatClientCounts().pending === 1);
  const invitation = helperInvitation(log);
  const name = new URL(invitation.baseUrl).hostname;
  // What the phone does through its Tailcat forward: pinned HTTPS to the loopback listener.
  const body = JSON.stringify({ pairingToken: invitation.pairingToken, deviceName: 'Synthetic phone' });
  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const socket = tlsConnect({ host: '127.0.0.1', port: raw.port, servername: name, ca: invitation.certificatePem }, () => {
      socket.write(`POST /v1/pairings HTTP/1.1\r\nHost: ${name}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    });
    let text = ''; socket.setEncoding('utf8'); socket.on('data', chunk => { text += chunk; }); socket.on('error', reject);
    socket.on('end', () => resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1]), body: text.slice(text.indexOf('\r\n\r\n') + 4) }));
  });
  assert.equal(response.status, 201);
  assert.deepEqual(host.state.tailcatClientCounts(), { linked: 1, pending: 0 });
  // Thirty-plus bad bearers from loopback never throttle the tunnel peer.
  for (let n = 0; n < 32; n++) {
    const status = await new Promise<number>((resolve, reject) => {
      const socket = tlsConnect({ host: '127.0.0.1', port: raw.port, servername: name, ca: invitation.certificatePem }, () => socket.write(`GET /v1/workspaces HTTP/1.1\r\nHost: ${name}\r\nAuthorization: Bearer ${'A'.repeat(43)}\r\nConnection: close\r\n\r\n`));
      let text = ''; socket.setEncoding('utf8'); socket.on('data', chunk => { text += chunk; }); socket.on('error', reject);
      socket.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1])));
    });
    assert.equal(status, 401);
  }
});

/** A wire-v2 phone (TailPocket docs/PROTOCOL.md, DSH's label): commit, read the computer's key, reveal, read the answer.
 * stopAfterKey abandons the attempt once the computer's key arrived (the grinding pattern pre.5 bounds). */
async function v2Phone(port: number, device: string, opts: { stopAfterKey?: boolean; tamper?: 'reveal' | 'v1' } = {}) {
  const own = generateKeyPairSync('x25519').privateKey, nonce = randomBytes(32), pub = x25519PublicRaw(own);
  const socket = connect(port, '127.0.0.1');
  const lines: string[] = []; let buffer = '', closed = false;
  socket.setEncoding('utf8'); socket.on('error', () => {}); socket.on('close', () => { closed = true; });
  socket.on('data', chunk => { buffer += chunk; for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) { lines.push(buffer.slice(0, i)); buffer = buffer.slice(i + 1); } });
  if (opts.tamper === 'v1') socket.write(wireLine({ v: 1, publicKey: pub.toString('base64'), device }));
  else socket.write(wireLine({ v: 2, commit: localPairingCommit(pub, nonce).toString('base64'), device }));
  await waitFor(() => lines.length >= 1 || closed, 8000);
  if (!lines.length) { socket.destroy(); return { key: false, closed: true as const }; }
  const hello = JSON.parse(lines[0]!);
  if (!hello.publicKey) { socket.destroy(); return { key: false, reply: hello }; }
  if (opts.stopAfterKey) { socket.destroy(); return { key: true }; }
  const session = localPairingSession(own, Buffer.from(hello.publicKey, 'base64'), true, nonce);
  const revealed = opts.tamper === 'reveal' ? x25519PublicRaw(generateKeyPairSync('x25519').privateKey) : pub;
  socket.write(wireLine({ v: 2, publicKey: revealed.toString('base64'), nonce: nonce.toString('base64') }));
  await waitFor(() => lines.length >= 2 || closed, 8000);
  socket.destroy();
  return { key: true, code: session.code, session, ...(lines[1] ? { reply: JSON.parse(lines[1]) } : { closed: true as const }) };
}
const localWindow = (extra: Partial<Parameters<typeof serveLocalPairing>[0]> & Pick<Parameters<typeof serveLocalPairing>[0], 'confirm'>) => {
  let port = 0;
  const served = serveLocalPairing({ invitation: '{"version":1}', expiresAt: Date.now() + 10_000, serviceName: 'Synthetic Mac', host: '127.0.0.1',
    advertise: () => () => {}, onListening: value => { port = value; }, ...extra });
  served.catch(() => {});
  return { served, port: () => waitFor(() => port) };
};

test('same-Wi-Fi pairing wire v2 reproduces the frozen vector (code 933437) and binds the nonce', () => {
  const phone = x25519Private(Buffer.alloc(32, 0x11)), hostKey = x25519Private(Buffer.alloc(32, 0x22)), nonce = Buffer.alloc(32, 0x44);
  assert.equal(x25519PublicRaw(phone).toString('base64'), 'e06Qm75//kTEZaIgA31gjuNYl9Me+XLwf3SJLLD3PxM=');
  assert.equal(x25519PublicRaw(hostKey).toString('base64'), 'D6poTtKIZ7l/Smot7l34zpdOdrcBjj8iocTPJnhXDyA=');
  assert.equal(localPairingCommit(x25519PublicRaw(phone), nonce).toString('base64'), 'HnYkDXyQsAK46/99Ac05tBezHWWwGBiGq+FIYIScHcM=');
  const phoneSide = localPairingSession(phone, x25519PublicRaw(hostKey), true, nonce), hostSide = localPairingSession(hostKey, x25519PublicRaw(phone), false, nonce);
  assert.equal(phoneSide.code, '933437'); assert.equal(hostSide.code, '933437');
  const sealed = hostSide.seal('{"version":3}', Buffer.alloc(12, 0x33));
  assert.equal(sealed.toString('base64'), 'MzMzMzMzMzMzMzMzZK3iZP3rpvoh+Bk9sxZNBMqdAxZYW+EfL0AKpog=');
  assert.equal(phoneSide.open(sealed), '{"version":3}');
  assert.throws(() => phoneSide.open(Buffer.concat([sealed.subarray(0, 20), Buffer.from([sealed[20]! ^ 1]), sealed.subarray(21)])));
  assert.notEqual(localPairingSession(phone, x25519PublicRaw(hostKey), true, Buffer.alloc(32, 0x55)).code, '933437', 'the nonce is part of the code');
  assert.throws(() => localPairingSession(phone, Buffer.alloc(32), true, nonce), 'a low-order key is refused');
  assert.equal(wireLine({ v: 2, commit: 'x', device: 'd' }), '{"commit":"x","device":"d","v":2}\n');
});

test('same-Wi-Fi pairing v2: one denied phone, then the approved one gets the sealed bootstrap; v1, a changed key and malformed lines get no reply', async () => {
  const decisions: string[] = [];
  const w = localWindow({ sourceGapMs: 0, confirm: async (code, device) => { decisions.push(`${device}:${code}`); return device === 'Approved phone'; } });
  const port = await w.port();
  const v1 = await v2Phone(port, 'Old phone', { tamper: 'v1' });
  assert.ok('closed' in v1 && !v1.key, 'a v1 hello is closed without a reply');
  for (const line of ['not json', '{"v":2}', '{"v":2,"commit":"AAAA","device":"x"}', '{"v":2,"commit":"' + Buffer.alloc(32).toString('base64') + '","device":"x","extra":1}']) {
    const socket = connect(port, '127.0.0.1'); let got = '';
    socket.setEncoding('utf8'); socket.on('data', chunk => { got += chunk; }); socket.on('error', () => {});
    socket.write(line + '\n');
    await new Promise<void>(done => socket.once('close', () => done()));
    assert.equal(got, '', `no reply to ${line}`);
  }
  const changed = await v2Phone(port, 'Middle', { tamper: 'reveal' });
  assert.ok(changed.key && 'closed' in changed, 'a reveal that does not match its commitment is closed without a reply');
  assert.deepEqual(decisions, [], 'the computer asked about nobody yet');
  const denied = await v2Phone(port, 'Other phone');
  assert.deepEqual(denied.reply, { status: 'denied', v: 2 });
  // Three keys are spent now (the changed reveal, the denied phone): the approved phone is the third and last.
  const approved = await v2Phone(port, 'Approved phone');
  assert.equal(approved.reply.status, 'approved');
  assert.equal(approved.session!.open(Buffer.from(approved.reply.sealed, 'base64')), '{"version":1}');
  assert.deepEqual(decisions, [`Other phone:${denied.code}`, `Approved phone:${approved.code}`]);
  await w.served;
});

// TailPocket TestWindowEndsAfterMaxAttempts: three keys per window, then the whole window ends, prompts or not.
test('same-Wi-Fi pairing: a window hands its key to at most 3 commitments, then ends as too many attempts', async () => {
  let prompts = 0;
  const honest = localWindow({ sourceGapMs: 0, confirm: async () => { prompts++; return true; } });
  let port = await honest.port();
  for (let i = 0; i < LOCAL_PAIRING_MAX_ATTEMPTS - 1; i++) { assert.ok((await v2Phone(port, 'x', { stopAfterKey: true })).key, `attempt ${i + 1}`); await new Promise(r => setTimeout(r, 50)); }
  const last = await v2Phone(port, 'honest');
  assert.equal(last.reply.status, 'approved', 'an honest phone after two abandoned attempts');
  await honest.served;

  prompts = 0;
  const ground = localWindow({ sourceGapMs: 0, confirm: async () => { prompts++; return true; } });
  port = await ground.port();
  let keys = 0;
  for (let i = 0; i < LOCAL_PAIRING_MAX_ATTEMPTS + 5; i++) {
    try { if ((await v2Phone(port, 'x', { stopAfterKey: true })).key) keys++; } catch { /* refused once the window ended */ }
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(keys, LOCAL_PAIRING_MAX_ATTEMPTS); assert.equal(prompts, 0);
  await assert.rejects(ground.served, { code: 'local_pairing_too_many_attempts' });
});

// TailPocket TestOneAnswerPerSourceGap: one key per address every 2 s.
test('same-Wi-Fi pairing: one address gets the key at most once every 2 s', async () => {
  const w = localWindow({ confirm: async () => true });
  const port = await w.port();
  assert.ok((await v2Phone(port, 'x', { stopAfterKey: true })).key);
  await new Promise(r => setTimeout(r, 50));
  for (let i = 0; i < 5; i++) assert.ok(!(await v2Phone(port, 'x', { stopAfterKey: true })).key, `attempt ${i + 2} within the gap`);
  await new Promise(r => setTimeout(r, LOCAL_PAIRING_SOURCE_GAP_MS));
  assert.equal((await v2Phone(port, 'after the gap')).reply.status, 'approved');
  await w.served;
});

// TailPocket TestAuditLocalPairingSilentRetries: abandoned commitments for 3 s, the same one over and over, never revealed.
test('same-Wi-Fi pairing: 3 s of abandoned commitments get at most 3 keys and no prompt', async () => {
  let prompts = 0;
  const w = localWindow({ expiresAt: Date.now() + 4_000, confirm: async () => { prompts++; return false; } });
  const port = await w.port();
  const own = generateKeyPairSync('x25519').privateKey, nonce = randomBytes(32);
  const line = wireLine({ v: 2, commit: localPairingCommit(x25519PublicRaw(own), nonce).toString('base64'), device: 'x' });
  let answered = 0;
  const start = Date.now();
  while (Date.now() - start < 3000) {
    const got = await new Promise<string>(resolve => {
      const socket = connect(port, '127.0.0.1'); let text = '';
      socket.setEncoding('utf8'); socket.on('error', () => resolve('')); socket.on('close', () => resolve(text));
      socket.on('data', chunk => { text += chunk; if (text.includes('\n')) socket.destroy(); });
      socket.on('connect', () => socket.write(line));
    });
    if (got.includes('publicKey')) answered++;
  }
  assert.ok(answered <= LOCAL_PAIRING_MAX_ATTEMPTS, `${answered} keys handed out`);
  assert.equal(prompts, 0);
  await w.served.catch(() => {});
});

test('same-Wi-Fi pairing binds only private LAN addresses of physical interfaces and same-subnet peers', () => {
  const entry = (address: string, netmask: string, family: 'IPv4' | 'IPv6' = 'IPv4', internal = false) =>
    ({ address, netmask, family, internal, mac: '00:00:00:00:00:00', cidr: null }) as never;
  const lan = lanAddresses({
    lo0: [entry('127.0.0.1', '255.0.0.0', 'IPv4', true)],
    en0: [entry('192.168.1.20', '255.255.255.0'), entry('fe80::1', 'ffff:ffff:ffff:ffff::', 'IPv6')],
    en1: [entry('203.0.113.7', '255.255.255.0'), entry('10.0.0.5', '255.0.0.0')],
    en2: [entry('100.100.1.1', '255.192.0.0')],
    utun3: [entry('10.8.0.2', '255.255.255.0')], awdl0: [entry('169.254.3.3', '255.255.0.0')], bridge100: [entry('192.168.64.1', '255.255.255.0')],
  });
  assert.deepEqual(lan.map(item => item.address), ['192.168.1.20', '10.0.0.5'], 'no loopback, public, CGNAT/Tailscale, VPN, AirDrop or VM bridge');
  const wifi = { address: '192.168.1.20', netmask: '255.255.255.0' };
  assert.ok(sameSubnet('192.168.1.77', wifi));
  assert.ok(sameSubnet('::ffff:192.168.1.77', wifi));
  assert.ok(!sameSubnet('192.168.2.77', wifi));
  assert.ok(!sameSubnet('10.8.0.9', wifi));
  assert.ok(!sameSubnet('fe80::2', wifi));
  assert.ok(!sameSubnet(undefined, wifi));
});

test('pair --tailcat --local runs the whole same-Wi-Fi flow through the CLI', async t => {
  const { dir, config, configPath } = await tailcatSetup(t);
  fakeEnv(t, { FAKE_TAILCAT_LOG: join(dir, 'helper.log') });
  const state = new HostState(config.statePath); t.after(() => state.close());
  const connector = createTailcatConnector({ tailcat: config.tailcat!, state, targetPort: config.port, hostName: config.hostName, helper, pollMs: 20, sweepMs: 50 });
  t.after(() => connector.close());
  connector.start(); await waitFor(() => connector.status().ready);
  let received: Promise<string> | undefined;
  const cli = runAdminCli(['pair', '--config', configPath, '--tailcat', '--local', '--read', 'all'], { out() {}, error() {} }, { localPairing: {
    host: '127.0.0.1', advertise: () => () => {}, confirm: async () => true,
    onListening: port => { received = v2Phone(port, 'Synthetic phone').then(r => r.session!.open(Buffer.from(r.reply.sealed, 'base64'))); } } });
  assert.equal(await cli, 0);
  const bootstrap = JSON.parse(await received!);
  assert.equal(bootstrap.version, 1); assert.equal(bootstrap.tailcat.port, 48932);
  assert.equal(bootstrap.pairingToken, undefined, 'same-Wi-Fi delivery carries the bootstrap, not the normal invitation');
  const invitation = helperInvitation(join(dir, 'helper.log'));
  assert.ok(state.consumePairing(invitation.pairingToken, 'Synthetic phone').deviceToken);
});
