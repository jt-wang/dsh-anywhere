// The bundle row (`dsh plugin add …tgz`) carries no configuration: the companion finds the running DSH's version,
// creates its private Tailcat configuration on first start and refuses to run beside an install-host companion.
// HOME points at a throwaway directory, so the default private path is a temp path.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import plugin from '../src/plugin.ts';
import { HOST_VERSION } from '../src/phone.ts';
import { currentConfigPath, dataFolder, defaultConfigPath, LEGACY_DATA_FOLDER, legacyCompanionActive, runningDshVersion } from '../src/zero-config.ts';
import { setupTailcat } from '../src/setup-tailcat.ts';
import { SHIPPED_COMPUTERS } from '../src/tailcat-connector.ts';
import { assertPrivate } from '../src/private-files.ts';

const FAKE_HELPER = fileURLToPath(new URL('./fixtures/fake-tailcat-helper.mjs', import.meta.url));

function sandbox(t: TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-anywhere-zero-')));
  // homedir() reads USERPROFILE on Windows, and the Windows path is under LOCALAPPDATA.
  const names = ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'XDG_DATA_HOME'] as const;
  const previous = names.map(name => process.env[name]);
  process.env.HOME = process.env.USERPROFILE = join(root, 'home');
  process.env.LOCALAPPDATA = join(root, 'home', 'AppData', 'Local');
  delete process.env.XDG_DATA_HOME;
  mkdirSync(process.env.HOME);
  t.after(() => {
    names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
/** A DSH installation as runProfile sees it: installAnchor is @deepseek-ai/dsh's package.json; app-boot sits beside it. */
function installation(root: string, version: string): string {
  const scope = join(root, 'runtime', 'node_modules', '@deepseek-ai');
  mkdirSync(join(scope, 'dsh'), { recursive: true }); mkdirSync(join(scope, 'dsh-app-boot'), { recursive: true });
  writeFileSync(join(scope, 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version, type: 'module' }));
  writeFileSync(join(scope, 'dsh-app-boot', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-app-boot', version, type: 'module', exports: { '.': './lib/index.js', './package.json': './package.json' } }));
  return join(scope, 'dsh', 'package.json');
}
function profile(root: string, patch?: string) {
  const dir = join(root, 'profiles', 'desktop');
  mkdirSync(dir, { recursive: true });
  if (patch !== undefined) writeFileSync(join(dir, 'cordis.patch.yml'), patch);
  return { dir, patchPath: join(dir, 'cordis.patch.yml') };
}
function context(services: Record<string, unknown>) {
  const registry = { list: () => [], archivedSessionIds: [] };
  const all: Record<string, unknown> = { workspaceRegistry: registry, ...services };
  return {
    sessionController: { async list() { return []; } },
    get: (name: string) => all[name],
    on: () => () => {},
    inject: () => undefined,
  } as any;
}
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

test('the default private configuration is the path the installers use, on each computer', t => {
  sandbox(t);
  // Macs (Apple silicon and Intel) share one rule; the folder is DSHAnywhere everywhere (old DSHMobile folders move, below).
  assert.equal(defaultConfigPath('darwin', {}, '/synthetic-home'), '/synthetic-home/Library/Application Support/DSHAnywhere/host/host.json');
  assert.equal(defaultConfigPath('win32', { LOCALAPPDATA: 'D:\\synthetic-home\\AppData\\Local' }, 'D:\\synthetic-home'), 'D:\\synthetic-home\\AppData\\Local\\DSHAnywhere\\host\\host.json');
  assert.equal(defaultConfigPath('win32', {}, 'D:\\synthetic-home'), 'D:\\synthetic-home\\AppData\\Local\\DSHAnywhere\\host\\host.json');
  assert.equal(defaultConfigPath('linux', { XDG_DATA_HOME: '/data' }, '/synthetic-home'), '/data/DSHAnywhere/host/host.json');
  assert.equal(defaultConfigPath('linux', { XDG_DATA_HOME: 'relative' }, '/synthetic-home'), '/synthetic-home/.local/share/DSHAnywhere/host/host.json');
  const expected = process.platform === 'darwin' ? join(process.env.HOME!, 'Library', 'Application Support', 'DSHAnywhere', 'host', 'host.json')
    : process.platform === 'win32' ? join(process.env.LOCALAPPDATA!, 'DSHAnywhere', 'host', 'host.json')
    : join(process.env.HOME!, '.local', 'share', 'DSHAnywhere', 'host', 'host.json');
  assert.equal(defaultConfigPath(), expected);
  // The source installers name the same folders: the new one, or an old one that an install-host block still uses.
  for (const file of ['install-host.mjs']) {
    const installer = readFileSync(new URL(`../../tools/${file}`, import.meta.url), 'utf8');
    assert.match(installer, /'DSHAnywhere'/, file); assert.match(installer, /'DSHMobile'/, file);
  }
});

test('the running DSH version is the version of the app-boot package beside the installation anchor', t => {
  const root = sandbox(t);
  assert.equal(runningDshVersion({ installAnchor: installation(root, '0.2.1-rc.3') }), '0.2.1-rc.3');
  assert.equal(runningDshVersion(undefined), undefined, 'no profile context: unknown');
  assert.equal(runningDshVersion({ installAnchor: join(root, 'nowhere', 'package.json') }), undefined);
  assert.equal(runningDshVersion({ installAnchor: 42 }), undefined);
});

test('an install-host block in the profile patch is detected by its marker; other patches are not', t => {
  const root = sandbox(t);
  assert.equal(legacyCompanionActive(undefined), false);
  assert.equal(legacyCompanionActive({ patchPath: join(root, 'missing.yml') }), false);
  const plain = profile(root, '# synthetic\n- insert:\n    - id: other\n      name: other\n');
  assert.equal(legacyCompanionActive(plain), false);
  const legacy = profile(root, '# synthetic\n# DSH-MOBILE-COMPANION-BEGIN v1 id=dsh-mobile-companion\n- insert:\n    - id: dsh-mobile-companion\n      name: "file:///synthetic/companion.js"\n# DSH-MOBILE-COMPANION-END v1 id=dsh-mobile-companion\n');
  assert.equal(legacyCompanionActive(legacy), true);
});

test('a bundle row with no configuration sets up Tailcat once, with the running DSH version, then starts from it', async t => {
  const root = sandbox(t);
  const ctx = context({ profileContext: { installAnchor: installation(root, '0.2.1-rc.3'), ...profile(root, '# synthetic\n') } });
  const configPath = defaultConfigPath();
  // Running from source there is no bundled helper next to the plugin: setup happens, then start fails closed before binding.
  // On a computer DSH Desktop is not built for (Linux CI), the same start says so instead of calling the package damaged.
  const missing = SHIPPED_COMPUTERS.includes(`${process.platform}-${process.arch}`) ? 'tailcat_helper_missing' : 'unsupported_computer';
  await assert.rejects(plugin.apply(ctx, {} as any), { code: missing });
  const created = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(created.dshVersion, '0.2.1-rc.3');
  assert.equal(created.tailcat.enabled, true);
  await ownerOnly(configPath);
  const hostId = created.tailcat.hostId;
  // Second start reuses the identity. Point it at the fake helper and a free port (the default 19445 may be in use here).
  writeFileSync(configPath, JSON.stringify({ ...created, port: await freePort(), tailcat: { ...created.tailcat, helperPath: FAKE_HELPER } }, null, 2), { mode: 0o600 });
  const stop = await plugin.apply(ctx, undefined as any);
  try { // stopped here, not in t.after: the sandbox's removal runs first there, and Windows cannot delete the open database
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).tailcat.hostId, hostId, 'never regenerated');
    assert.match(readFileSync(join(configPath, '..', 'companion.log'), 'utf8'), new RegExp(`running ${HOST_VERSION.replaceAll('.', '\\.')}\n`));
  } finally { await stop(); }
});

test('a DSH line the canary has not run yet still starts the companion, and its log says the line is unverified', async t => {
  const root = sandbox(t);
  const ctx = context({ profileContext: { installAnchor: installation(root, '0.2.4-alpha.1'), ...profile(root, '# synthetic\n') } });
  const configPath = defaultConfigPath();
  await assert.rejects(plugin.apply(ctx, {} as any), { code: SHIPPED_COMPUTERS.includes(`${process.platform}-${process.arch}`) ? 'tailcat_helper_missing' : 'unsupported_computer' });
  const created = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(created.dshVersion, '0.2.4-alpha.1');
  writeFileSync(configPath, JSON.stringify({ ...created, port: await freePort(), tailcat: { ...created.tailcat, helperPath: FAKE_HELPER } }, null, 2), { mode: 0o600 });
  const stop = await plugin.apply(ctx, undefined as any);
  try {
    assert.match(readFileSync(join(configPath, '..', 'companion.log'), 'utf8'), new RegExp(`running ${HOST_VERSION.replaceAll('.', '\\.')} unverified-dsh-0\\.2\\.4-alpha\\.1\n`));
  } finally { await stop(); }
});

/** Mode bits on a Mac and Linux; on Windows, which has none, the ACL: only this user, nothing inherited. */
async function ownerOnly(path: string) {
  if (process.platform === 'win32') await assertPrivate(path); else assert.equal(statSync(path).mode & 0o077, 0, 'owner-only');
}

/** A private folder as 0.8.3 and earlier left it, under the old name: setup-tailcat's files plus a paired-phone database. */
async function legacyFolder(): Promise<{ legacy: string; current: string; hostId: string }> {
  const legacy = dataFolder(process.platform, process.env, process.env.HOME!, LEGACY_DATA_FOLDER), current = dataFolder();
  await setupTailcat({ configPath: join(legacy, 'host', 'host.json'), dshVersion: '0.2.1-rc.3' });
  writeFileSync(join(legacy, 'host', 'state', 'host.sqlite'), 'paired phones');
  return { legacy, current, hostId: JSON.parse(readFileSync(join(legacy, 'host', 'host.json'), 'utf8')).tailcat.hostId };
}
/** The moved folder is the old one under the new name, and host.json names only files in it. */
async function assertMoved(legacy: string, current: string, hostId: string) {
  assert.equal(existsSync(legacy), false, 'the old folder is gone');
  const configPath = join(current, 'host', 'host.json'), text = readFileSync(configPath, 'utf8');
  assert.equal(text.includes(LEGACY_DATA_FOLDER), false, 'host.json names no file in the old folder');
  assert.equal(JSON.parse(text).tailcat.hostId, hostId, 'same identity: paired phones keep working');
  assert.equal(readFileSync(join(current, 'host', 'state', 'host.sqlite'), 'utf8'), 'paired phones');
  await ownerOnly(configPath);
  // The companion's own check of an existing configuration accepts it as it is (no new identity).
  assert.equal((await setupTailcat({ configPath, dshVersion: '0.2.1-rc.3' })).existing, true);
}

test('an old DSHMobile folder moves to DSHAnywhere once, with its identity and paired phones', async t => {
  sandbox(t);
  const { legacy, current, hostId } = await legacyFolder();
  assert.equal(currentConfigPath(), join(current, 'host', 'host.json'));
  await assertMoved(legacy, current, hostId);
  assert.equal(currentConfigPath(), join(current, 'host', 'host.json'), 'a second start changes nothing');
  await assertMoved(legacy, current, hostId);
});

test('a new install uses DSHAnywhere and creates nothing until setup', t => {
  sandbox(t);
  assert.equal(currentConfigPath(), join(dataFolder(), 'host', 'host.json'));
  assert.equal(existsSync(dataFolder()), false);
  assert.equal(existsSync(dataFolder(process.platform, process.env, process.env.HOME!, LEGACY_DATA_FOLDER)), false);
});

test('a move interrupted before or during the host.json rewrite is finished by the next start', async t => {
  sandbox(t);
  const { legacy, current, hostId } = await legacyFolder();
  // Stopped right after the rename: the host folder is in DSHAnywhere, host.json still names the old place, and the
  // emptied DSHMobile is still there.
  mkdirSync(current); renameSync(join(legacy, 'host'), join(current, 'host'));
  // Stopped during the rewrite: a half-written staged file next to the untouched host.json.
  writeFileSync(join(current, 'host', 'host.json.moving'), '{"half');
  assert.equal(currentConfigPath(), join(current, 'host', 'host.json'));
  await assertMoved(legacy, current, hostId);
  assert.equal(existsSync(join(current, 'host', 'host.json.moving')), false);
});

test('an existing DSHAnywhere folder is never overwritten by an old DSHMobile one', async t => {
  sandbox(t);
  const { legacy, current } = await legacyFolder();
  mkdirSync(join(current, 'host'), { recursive: true });
  writeFileSync(join(current, 'host', 'host.json'), '{"newer":true}');
  assert.equal(currentConfigPath(), join(current, 'host', 'host.json'));
  assert.equal(readFileSync(join(current, 'host', 'host.json'), 'utf8'), '{"newer":true}');
  assert.ok(existsSync(join(legacy, 'host', 'state', 'host.sqlite')), 'the old folder is left as it was');
});

test('a DSHAnywhere folder that holds other files (a release key) still receives the companion, and keeps those files', async t => {
  sandbox(t);
  const { legacy, current, hostId } = await legacyFolder();
  mkdirSync(join(current, 'signing'), { recursive: true });
  writeFileSync(join(current, 'signing', 'release.p12'), 'key');
  assert.equal(currentConfigPath(), join(current, 'host', 'host.json'));
  await assertMoved(legacy, current, hostId);
  assert.equal(readFileSync(join(current, 'signing', 'release.p12'), 'utf8'), 'key');
});

test('an install-host companion\'s own files stay in DSHMobile; only its host folder moves', async t => {
  sandbox(t);
  const { legacy, current } = await legacyFolder();
  mkdirSync(join(legacy, 'plugin', '0.7.14'), { recursive: true });
  writeFileSync(join(legacy, 'install-receipt.json'), '{}');
  assert.equal(currentConfigPath(), join(current, 'host', 'host.json'));
  assert.equal(readFileSync(join(current, 'host', 'state', 'host.sqlite'), 'utf8'), 'paired phones');
  assert.equal(existsSync(join(legacy, 'host')), false);
  assert.ok(existsSync(join(legacy, 'plugin', '0.7.14')) && existsSync(join(legacy, 'install-receipt.json')));
});

test('the folder does not move while an install-host companion, which names the old folder, is in the profile', async t => {
  const root = sandbox(t);
  const { legacy, current } = await legacyFolder();
  const block = profile(root, '# DSH-MOBILE-COMPANION-BEGIN v1 id=dsh-mobile-companion\n- insert: []\n# DSH-MOBILE-COMPANION-END v1 id=dsh-mobile-companion\n');
  await assert.rejects(plugin.apply(context({ profileContext: { installAnchor: installation(root, '0.2.1-rc.3'), ...block } }), {} as any), { code: 'companion_conflict' });
  assert.ok(existsSync(join(legacy, 'host', 'host.json')));
  assert.equal(existsSync(current), false);
  assert.match(readFileSync(join(legacy, 'host', 'companion.log'), 'utf8'), /failed \S+ companion_conflict/);
});

test('a bundle row fails closed without a supported DSH version and creates nothing', async t => {
  const root = sandbox(t);
  await assert.rejects(plugin.apply(context({}), {} as any), { code: 'unsupported_dsh_version' });
  await assert.rejects(plugin.apply(context({ profileContext: { installAnchor: installation(root, '1.0.0'), ...profile(root) } }), {} as any), { code: 'unsupported_dsh_version' });
  assert.equal(existsSync(defaultConfigPath()), false);
});

test('a bundle row stands down while an install-host companion is set up in the same profile', async t => {
  const root = sandbox(t);
  const legacy = profile(root, '# DSH-MOBILE-COMPANION-BEGIN v1 id=dsh-mobile-companion\n- insert: []\n# DSH-MOBILE-COMPANION-END v1 id=dsh-mobile-companion\n');
  await assert.rejects(plugin.apply(context({ profileContext: { installAnchor: installation(root, '0.2.1-rc.3'), ...legacy } }), {} as any), { code: 'companion_conflict' });
  assert.equal(existsSync(defaultConfigPath()), false);
});

test('rows that name a configPath keep their validation: relative paths and unknown keys are refused', async t => {
  const root = sandbox(t);
  const ctx = context({ profileContext: { installAnchor: installation(root, '0.2.1-rc.3'), ...profile(root) } });
  await assert.rejects(plugin.apply(ctx, { dshVersion: '0.2.1-rc.3', configPath: 'relative/host.json' }), { code: 'invalid_config' });
  await assert.rejects(plugin.apply(ctx, { dshVersion: '0.2.1-rc.3', configPath: join(root, 'host.json'), extra: 1 } as any), { code: 'invalid_config' });
  assert.equal(existsSync(defaultConfigPath()), false, 'an explicit row never falls back to the default path');
});
