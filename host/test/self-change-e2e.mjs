#!/usr/bin/env node
// Live check that a phone can update, turn off and uninstall DSH Anywhere itself (Settings › Computer settings ›
// DSH Anywhere) without taking DSH's host down. For each starting version and action, in a new scratch home:
// DSH's own `dsh plugin add` installs the starting version from a local registry, `dsh --profile web` boots it, a phone
// paired as owner calls DSH's pluginManager through the companion's relay (https://127.0.0.1:<port>/dsh/api/…), and the
// check reads back that DSH's host still runs and answers, that DSH applied the change, and (from 0.8.7 on) that the
// companion kept which phone made it.
//   node host/test/self-change-e2e.mjs <dsh-anywhere.tgz> <DSH runtime folder | dsh command> [--from <version|current>]... [--action update|off|uninstall]... [--port <n>]
// The runtime folder holds node_modules/@deepseek-ai/dsh (npm install @deepseek-ai/dsh), as for tools/computer-e2e.mjs;
// the dsh command can be DSH Desktop's (DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh).
// <dsh-anywhere.tgz> is the package under test (tools/pack-bundle.mjs; --only for this computer is enough), `current`
// starts from it, any other --from from that version on npm (default: 0.8.7 and current). Updates go to the package
// under test; from `current`, to a copy of it numbered <next patch>-e2e.1. The local registry serves those files and
// passes every other request to npm; nothing is published. Companions up to 0.8.6 keep the change after DSH has stopped
// them and crash DSH's host on all three: `--from 0.8.6` reports CRASH.
// Prints statuses only, never keys or tokens. Exit code 0 only when every case passed.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, statSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const NAME = '@jt-wang/dsh-anywhere', UPSTREAM = 'https://registry.npmjs.org';
const [tarball, dshArgument, ...rest] = process.argv.slice(2);
const froms = [], actions = [];
let port = '19447', bad = !tarball || !dshArgument;
for (let i = 0; i < rest.length; i++) {
  const [flag, value] = [rest[i], rest[i + 1]];
  if (flag === '--from' && value) froms.push(value);
  else if (flag === '--action' && ['update', 'off', 'uninstall'].includes(value)) actions.push(value);
  else if (flag === '--port' && /^\d+$/.test(value ?? '')) port = value;
  else { bad = true; break; }
  i++;
}
if (bad) { console.error('Usage: node host/test/self-change-e2e.mjs <dsh-anywhere.tgz> <DSH runtime folder | dsh command> [--from <version|current>]... [--action update|off|uninstall]... [--port <n>]'); process.exit(2); }
if (!froms.length) froms.push('0.8.7', 'current');
if (!actions.length) actions.push('update', 'off', 'uninstall');
// node <bin>, not the .bin shim: Windows will not spawn a .cmd without a shell.
const dshPrefix = (() => {
  if (!statSync(dshArgument).isDirectory()) return [path.resolve(dshArgument)];
  const dir = path.join(path.resolve(dshArgument), 'node_modules', '@deepseek-ai', 'dsh'), { bin } = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  return [process.execPath, path.join(dir, typeof bin === 'string' ? bin : bin.dsh)];
})();
const dshCommand = dshPrefix[0], dshArgs = args => [...dshPrefix.slice(1), ...args];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { runAdminCli } = await import(pathToFileURL(path.join(root, 'host', 'dist', 'cli.js')).href);
const { defaultConfigPath } = await import(pathToFileURL(path.join(root, 'host', 'dist', 'zero-config.js')).href);
const atLeast = (version, floor) => { const [a, b] = [version, floor].map(v => v.split('-')[0].split('.').map(Number)); const i = a.findIndex((n, k) => n !== b[k]); return i < 0 || a[i] > b[i]; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = message => { throw new Error(message); };
async function until(what, ms, ready) {
  const end = Date.now() + ms;
  for (;;) { const value = await ready(); if (value) return value; if (Date.now() > end) fail(`timed out: ${what}`); await sleep(250); }
}

// --- npm-pack archives: read and renumber package/package.json (ustar, as tools/pack-bundle.mjs writes them).
function entries(gz) {
  const tar = gunzipSync(gz), list = [];
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512);
    if (header.every(byte => byte === 0)) break;
    const size = parseInt(header.subarray(124, 136).toString('latin1').replace(/\0.*$/s, '').trim() || '0', 8);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    list.push({ header: Buffer.from(header), name, data: Buffer.from(tar.subarray(at + 512, at + 512 + size)) });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return list;
}
const manifestOf = gz => JSON.parse(entries(gz).find(e => e.name === 'package/package.json').data.toString('utf8'));
function renumbered(gz, version) {
  const out = [];
  for (const entry of entries(gz)) {
    let { header, data } = entry;
    if (entry.name === 'package/package.json') {
      data = Buffer.from(JSON.stringify({ ...JSON.parse(data.toString('utf8')), version }, null, 2) + '\n');
      header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'latin1');
      header.fill(0x20, 148, 156);
      header.write((header.reduce((sum, byte) => sum + byte, 0)).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
    }
    out.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...out, Buffer.alloc(1024)]));
}

// --- The local registry: the package under test and its renumbered copy, every other request passed to npm.
const current = readFileSync(path.resolve(tarball)), currentVersion = manifestOf(current).version;
const nextVersion = currentVersion.replace(/^(\d+\.\d+\.)(\d+).*$/, (_, head, patch) => `${head}${Number(patch) + 1}-e2e.1`);
const local = new Map([[currentVersion, current], [nextVersion, renumbered(current, nextVersion)]]);
const registry = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://registry');
    const file = /^\/-\/local\/(.+)\.tgz$/.exec(url.pathname);
    if (file && local.has(file[1])) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(local.get(file[1])); return; }
    const upstream = await fetch(UPSTREAM + url.pathname, { headers: { accept: 'application/json' } });
    if (decodeURIComponent(url.pathname.slice(1)) !== NAME || !upstream.ok) {
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream' });
      res.end(Buffer.from(await upstream.arrayBuffer())); return;
    }
    const doc = await upstream.json(), base = `http://127.0.0.1:${registry.address().port}`;
    for (const [version, bytes] of local) {
      doc.versions[version] = { ...manifestOf(bytes), _id: `${NAME}@${version}`, dist: {
        tarball: `${base}/-/local/${version}.tgz`, shasum: createHash('sha1').update(bytes).digest('hex'),
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` } };
      doc.time[version] = new Date().toISOString();
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(doc));
  } catch { res.writeHead(502); res.end(); }
});
await new Promise(resolve => registry.listen(0, '127.0.0.1', resolve));
const registryUrl = `http://127.0.0.1:${registry.address().port}/`;
const dshVersion = spawnSync(dshCommand, dshArgs(['--version']), { encoding: 'utf8' }).stdout.trim();
const work = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'dsh-anywhere-self-')));
const store = path.join(work, 'pnpm-store');

// --- A phone's call through the companion, pinned to the companion's own certificate (the only one `ca` trusts; it
// names no host, as Tailcat's identity certificates do not).
function phoneCall(config, method, options) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
    const req = request({ host: '127.0.0.1', port: config.port, path: method, method: body ? 'POST' : 'GET', ca: config.certificate, checkServerIdentity: () => undefined, timeout: options.timeout ?? 30_000,
      headers: { ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}) } },
    res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, json }); }); });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject); req.end(body);
  });
}
function run(command, args, options, ms) {
  return new Promise(resolve => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', c => { output = (output + c).slice(-20_000); });
    child.stderr.setEncoding('utf8').on('data', c => { output = (output + c).slice(-20_000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), ms);
    child.on('exit', code => { clearTimeout(timer); resolve({ code, output }); });
  });
}
const envelope = (method, args) => ({ type: 'client-request', rpcId: `e2e-${randomBytes(4).toString('hex')}`, method, payload: { args } });

async function runCase(from, action) {
  const scratch = mkdtempSync(path.join(work, 'case-')), home = path.join(scratch, 'home');
  const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: path.join(home, '.dsh'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_STATE_HOME: path.join(home, '.local', 'state'),
    npm_config_registry: registryUrl, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' };
  mkdirSync(path.join(env.XDG_CONFIG_HOME, 'pnpm'), { recursive: true });
  writeFileSync(path.join(home, '.npmrc'), `registry=${registryUrl}\n`);
  writeFileSync(path.join(env.XDG_CONFIG_HOME, 'pnpm', 'config.yaml'), `storeDir: ${JSON.stringify(store)}\nminimumReleaseAge: 0\n`);
  const startVersion = from === 'current' ? currentVersion : from, target = from === 'current' ? nextVersion : currentVersion;
  const configPath = defaultConfigPath(process.platform, env, home), logPath = path.join(path.dirname(configPath), 'companion.log');
  const log = () => existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  const quiet = { out: () => {}, error: text => process.stderr.write(`[admin] ${text}`) };
  let dsh, dshOut = '', answer = 'not sent', last;
  try {
    // The companion on its own port (the computer's real one keeps 19445), then DSH installs and boots it.
    if (await runAdminCli(['setup-tailcat', '--config', configPath, '--port', port, '--dsh-version', dshVersion], quiet) !== 0) fail('setup-tailcat failed');
    // Not spawnSync: the local registry answers pnpm from this process's event loop.
    const added = await run(dshCommand, dshArgs(['plugin', '--profile', 'web', 'add', `${NAME}@${startVersion}`]), { env, cwd: scratch }, 300_000);
    if (added.code !== 0) fail(`dsh plugin add exited ${added.code}: ${added.output.trim().split('\n').slice(-3).join(' / ')}`);
    dsh = spawn(dshCommand, dshArgs(['--profile', 'web', '--no-open', '--port', '0']), { env, cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = chunk => { dshOut = (dshOut + chunk).slice(-40_000); };
    dsh.stdout.setEncoding('utf8').on('data', keep); dsh.stderr.setEncoding('utf8').on('data', keep);
    const signIn = await until('DSH prints its address', 120_000, () => /http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/.exec(dshOut)?.[0]);
    const origin = new URL(signIn).origin;
    await until(`companion ${startVersion} runs`, 120_000, () => { if (dsh.exitCode !== null) fail(`dsh exited ${dsh.exitCode}`); return log().includes(`running ${startVersion.replace(/-e2e\.1$/, '')}`); });
    const cookie = (await fetch(signIn, { redirect: 'manual' })).headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    const dshApi = async (method, args) => {
      const res = await fetch(`${origin}/api/${method}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(envelope(method, args)), signal: AbortSignal.timeout(30_000) });
      return res.ok ? (await res.json()).result?.value : fail(`DSH answered ${method} with ${res.status}`);
    };
    const bundle = async () => { const v = await dshApi('pluginManager/listBundles', {}); return (Array.isArray(v) ? v : v.items ?? []).find(b => b.name === NAME); };

    // An owner phone: a one-time offer in the running companion's own database (no newer code opens it), then pairing.
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.certificate = readFileSync(path.resolve(path.dirname(configPath), config.tls.certPath));
    const offer = randomBytes(32).toString('base64url');
    const db = new DatabaseSync(path.join(path.dirname(configPath), 'state', 'host.sqlite'));
    db.prepare('INSERT INTO pairings (token_hash, grants, expires_at) VALUES (?, ?, ?)').run(createHash('sha256').update(offer).digest('hex'),
      JSON.stringify({ readWorkspaceIds: ['*'], executeWorkspaceIds: ['*'] }), Date.now() + 300_000);
    db.close();
    const paired = await phoneCall(config, '/v1/pairings', { body: { pairingToken: offer, deviceName: 'Self-change phone' } });
    if (paired.status !== 201 || !paired.json?.deviceToken) fail(`pairing answered ${paired.status}`);
    const token = paired.json.deviceToken;
    const before = await bundle();
    if (before?.version !== startVersion || before.enabled === false) fail(`DSH lists ${NAME} ${before?.version} enabled ${before?.enabled} before the change`);

    // The phone's change, as computer-settings.tsx sends it.
    const [method, args] = action === 'update' ? ['pluginManager/updateBundle', { name: NAME, version: target, options: { registry: registryUrl } }]
      : action === 'off' ? ['pluginManager/setBundleEnabled', { name: NAME, enabled: false }] : ['pluginManager/removeBundle', { name: NAME }];
    const lines = log().split('\n').length;
    answer = await phoneCall(config, `/dsh/api/${method}`, { token, body: envelope(method, args), timeout: 240_000 }).then(r => {
      const value = r.json?.result?.value, outcome = value?.result ?? value;
      return `${r.status}${r.json?.result ? ` ok ${r.json.result.ok}` : ''}${outcome?.application ? `, ${value.step ? `step ${value.step}, ` : ''}${outcome.application}${outcome.error?.code ? ` ${outcome.error.code}: ${String(outcome.error.diagnostic ?? '').slice(0, 160)}` : ''}` : ''}${r.json?.result?.error ? ` ${JSON.stringify(r.json.result.error).slice(0, 200)}` : ''}`;
    }, e => `none (${e.message})`);

    if (/, (step \w+, )?(failed|cancelled)/.test(answer)) fail('DSH refused the change');
    // DSH applied it and its host still runs and answers.
    const applied = await until(`DSH applies ${action}`, 120_000, async () => {
      if (dsh.exitCode !== null) return 'exited';
      const now = last = await bundle().catch(() => 'unreachable');
      if (now === 'unreachable') return undefined;
      if (action === 'update') return now?.version === target && /\brunning \d/.test(log().split('\n').slice(lines).join('\n')) && 'ok';
      return (action === 'off' ? now?.enabled === false : now === undefined) && 'ok';
    });
    await sleep(3000);
    const fatal = /^.*(fatal|ERR_INVALID_STATE|database is not open).*$/im.exec(dshOut)?.[0]?.trim().slice(0, 160);
    if (applied === 'exited' || dsh.exitCode !== null || fatal) return { result: 'CRASH', detail: `dsh ${dsh.exitCode === null ? 'still running' : `exited ${dsh.exitCode}`}${fatal ? `: ${fatal}` : ''}; phone's answer ${answer}` };
    await dshApi('pluginManager/listBundles', {});

    // The companion kept which phone did it (0.8.7 and later keep a change to itself before forwarding it).
    let kept = [];
    await runAdminCli(['phone-changes', '--config', configPath], { out: text => { try { kept = JSON.parse(text).items ?? []; } catch {} }, error: () => {} });
    const mine = kept.some(c => c.deviceName === 'Self-change phone' && c.method === method);
    if (atLeast(startVersion, '0.8.7') && !mine) return { result: 'FAIL', detail: `DSH applied it, but the companion kept no change by the phone; phone's answer ${answer}` };
    return { result: 'PASS', detail: `DSH host up, ${action === 'update' ? `${startVersion} → ${target} running` : action === 'off' ? 'turned off' : 'removed'}, change ${mine ? 'kept' : 'not kept'}; phone's answer ${answer}` };
  } catch (error) {
    return { result: 'FAIL', detail: `${error instanceof Error ? error.message : error}; phone's answer ${answer}; DSH lists ${JSON.stringify(last === undefined ? null : last === 'unreachable' ? last : { version: last.version, enabled: last.enabled })}${log() ? ` | companion.log: ${log().trim().split('\n').slice(-2).join(' / ')}` : ''}` };
  } finally {
    if (dsh && dsh.exitCode === null) { dsh.kill(); await Promise.race([new Promise(r => dsh.once('exit', r)), sleep(15_000)]); if (dsh.exitCode === null) dsh.kill('SIGKILL'); }
    rmSync(scratch, { recursive: true, force: true });
  }
}

let passed = true;
try {
  console.log(`[self-change] package under test ${currentVersion}, DSH ${dshVersion}, companion port ${port}`);
  for (const from of froms) for (const action of actions) {
    const { result, detail } = await runCase(from, action);
    console.log(`[self-change] from ${from === 'current' ? `${currentVersion} (current)` : from}, ${action}: ${result} — ${detail}`);
    if (result !== 'PASS') passed = false;
  }
} finally {
  registry.close();
  rmSync(work, { recursive: true, force: true });
}
process.exit(passed ? 0 : 1);
