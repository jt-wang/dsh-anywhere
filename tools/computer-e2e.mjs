#!/usr/bin/env node
// Live check on one computer (macOS, Windows, Linux): DSH's own `dsh plugin add` installs the packed companion
// (tools/pack-bundle.mjs) into a scratch profile, DSH boots that profile (`dsh --profile web`), which starts the
// companion from its configuration-free bundle row, and the reference phone (tailcat/e2e/phone) pairs with it over
// real Tailcat relays, confirms the same four emoji the computer shows, and reads GET /v1/workspaces through the tunnel.
//   node tools/computer-e2e.mjs <dsh-anywhere.tgz> <phone binary> <DSH runtime folder> [--port <companion port>]
// The runtime folder holds node_modules/@deepseek-ai/dsh (npm install @deepseek-ai/dsh). Everything DSH, pnpm and the
// companion write goes to one new temp folder: HOME, USERPROFILE, LOCALAPPDATA, APPDATA, XDG_* and DSH_HOME point there.
// Without --port the companion creates its configuration itself on first start (port 19445), as for a user.
// Prints statuses only, never keys or tokens. Exit code 0 only when the phone paired and read.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [tarball, phone, runtimeRoot, flag, portText] = process.argv.slice(2);
if (!tarball || !phone || !runtimeRoot || (flag !== undefined && (flag !== '--port' || !/^\d+$/.test(portText ?? '')))) {
  console.error('Usage: node tools/computer-e2e.mjs <dsh-anywhere.tgz> <phone binary> <DSH runtime folder> [--port <companion port>]'); process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = message => { throw new Error(message); };
const step = message => console.log(`[e2e] ${message}`);
const dshPackage = path.join(path.resolve(runtimeRoot), 'node_modules', '@deepseek-ai', 'dsh');
const dshManifest = JSON.parse(readFileSync(path.join(dshPackage, 'package.json'), 'utf8'));
// node <bin>, not the .bin shim: Windows will not spawn a .cmd without a shell.
const dshBin = path.join(dshPackage, typeof dshManifest.bin === 'string' ? dshManifest.bin : dshManifest.bin.dsh);

// The companion refuses a private folder with a redirected ancestor (macOS's /var and /tmp are symlinks): real path.
const scratch = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'dsh-anywhere-e2e-')));
const home = path.join(scratch, 'home');
const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: path.join(home, '.dsh'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'), APPDATA: path.join(home, 'AppData', 'Roaming'),
  XDG_CACHE_HOME: path.join(home, '.cache'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_STATE_HOME: path.join(home, '.local', 'state'),
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' };
for (const dir of [home, env.LOCALAPPDATA, env.APPDATA]) mkdirSync(dir, { recursive: true });
// The companion's own path rule (host/src/zero-config.ts), evaluated for the scratch environment.
const { defaultConfigPath } = await import(pathToFileURL(path.join(root, 'host', 'dist', 'zero-config.js')).href);
const configPath = defaultConfigPath(process.platform, env, home), logPath = path.join(path.dirname(configPath), 'companion.log');
const companionLog = () => existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
step(`${process.platform}-${process.arch}, Node ${process.version}, DSH ${dshManifest.version}, private folder <home>/${path.relative(home, path.dirname(configPath)).split(path.sep).join('/')}`);

let dsh, exitCode = 1;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(what, ms, ready) {
  const end = Date.now() + ms;
  for (;;) { const value = await ready(); if (value) return value; if (Date.now() > end) fail(`timed out: ${what}`); await sleep(250); }
}
try {
  // 1. DSH's own plugin command, as AGENT-INSTALL.md runs it (there with the npm name; here the file just packed).
  const added = spawnSync(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'add', path.resolve(tarball)], { env, cwd: scratch, encoding: 'utf8', timeout: 300_000 });
  if (added.status !== 0) { process.stdout.write(added.stdout ?? ''); process.stderr.write(added.stderr ?? ''); fail(`dsh plugin add exited ${added.status}`); }
  const profile = JSON.parse(readFileSync(path.join(env.DSH_HOME, 'profiles', 'web', 'package.json'), 'utf8'));
  if (!profile.dsh?.profile?.bundles?.includes('@jt-wang/dsh-anywhere')) fail('the profile does not list @jt-wang/dsh-anywhere');
  step('dsh plugin add: exit 0, @jt-wang/dsh-anywhere in dsh.profile.bundles');
  if (portText !== undefined) {
    // A computer that already runs a companion on 19445: create the same configuration on another port first.
    const { runAdminCli } = await import(pathToFileURL(path.join(root, 'host', 'dist', 'cli.js')).href);
    if (await runAdminCli(['setup-tailcat', '--config', configPath, '--dsh-version', dshManifest.version, '--port', portText], { out: () => {}, error: text => process.stderr.write(text) }) !== 0) fail('setup-tailcat failed');
  }

  // 2. DSH boots the profile; the companion starts from the bundle row and writes `running <version>`.
  dsh = spawn(process.execPath, [dshBin, '--profile', 'web', '--no-open', '--port', '0'], { env, cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let dshOut = '';
  const keep = chunk => { dshOut = (dshOut + chunk).slice(-20_000); };
  dsh.stdout.setEncoding('utf8').on('data', keep); dsh.stderr.setEncoding('utf8').on('data', keep);
  const exited = new Promise(resolve => dsh.once('exit', code => resolve(code)));
  await until('the companion starts', 180_000, async () => {
    if (dsh.exitCode !== null) fail(`dsh exited ${dsh.exitCode}:\n${dshOut.replace(/token=[^\s&]+/g, 'token=…')}`);
    const failed = /^.*\bfailed\b.*$/m.exec(companionLog());
    if (failed) fail(`companion: ${failed[0]}\n${dshOut.replace(/token=[^\s&]+/g, 'token=…')}`);
    return /\brunning \d/.test(companionLog());
  });
  const host = JSON.parse(readFileSync(configPath, 'utf8'));
  step(`DSH booted the profile; companion.log: ${companionLog().trim().split('\n').at(-1).replace(/^\S+\s+/, '')}; transport ${host.tailcat ? 'tailcat' : 'direct'}, port ${host.port}`);
  if (!host.tailcat) fail('the companion did not set up Tailcat');

  // 3. The computer's owner pairs a phone (what Settings → Mobile → Pair a phone does), answering the emoji question
  // with yes only when the phone shows the same four.
  const { runAdminCli } = await import(pathToFileURL(path.join(root, 'host', 'dist', 'cli.js')).href);
  const invitation = path.join(path.dirname(configPath), 'invitations', 'e2e-phone.json');
  let phoneEmoji = '', phoneOut = '';
  const confirmed = [];
  const quiet = { out: () => {}, error: text => process.stderr.write(`[pair] ${text}`) };
  const paired = runAdminCli(['pair', '--config', configPath, '--tailcat', '--read', 'all', '--execute', 'all', '--output', invitation], quiet, {
    emojiConfirm: async (emoji, device, route) => {
      const end = Date.now() + 60_000;
      while (!phoneEmoji && Date.now() < end) await sleep(100);
      const same = phoneEmoji === emoji.join(' ');
      step(`the computer asks about "${device}" over ${route}: ${same ? 'same emoji as the phone, yes' : 'DIFFERENT emoji, no'}`);
      confirmed.push(same); return same;
    } });
  await until('the pairing invitation', 120_000, () => existsSync(invitation));
  // 4. The reference phone: pair over Tailcat, then POST /v1/pairings and GET /v1/workspaces through the tunnel.
  const phoneCode = await new Promise(resolve => {
    const child = spawn(path.resolve(phone), ['--invitation', invitation, '--timeout', '150s'], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    child.stdout.setEncoding('utf8').on('data', chunk => {
      phoneOut += chunk;
      for (const line of chunk.split('\n')) if (line.trim()) console.log(`[phone] ${line.trim()}`);
      phoneEmoji ||= /^emoji: (.+)$/m.exec(phoneOut)?.[1]?.trim() ?? '';
    });
    child.on('error', () => resolve(1)); child.on('exit', code => resolve(code ?? 1));
  });
  const pairExit = await paired;
  step(`pair exit ${pairExit}, confirmed ${JSON.stringify(confirmed)}, phone exit ${phoneCode}`);
  if (phoneCode !== 0 || pairExit !== 0 || confirmed.join() !== 'true') fail('the phone did not pair');
  if (!/^workspaces: 200$/m.test(phoneOut)) fail('the phone did not read /v1/workspaces');
  step('PASS: the companion DSH started paired a phone over Tailcat and answered its request');
  exitCode = 0;
  dsh.kill(); await Promise.race([exited, sleep(15_000)]);
} catch (error) {
  console.error(`[e2e] FAIL: ${error instanceof Error ? error.message : error}`);
  const log = companionLog(); if (log) console.error(`[e2e] companion.log:\n${log}`);
} finally {
  if (dsh && dsh.exitCode === null) { dsh.kill('SIGKILL'); await sleep(1000); }
  // Windows keeps a file open a moment after its process exits.
  for (let attempt = 0; attempt < 10 && existsSync(scratch); attempt++) {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { await sleep(1000); }
  }
}
process.exit(exitCode);
