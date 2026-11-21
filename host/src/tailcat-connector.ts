import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostError } from './errors.ts';
import { privateRead } from './private-files.ts';
import { TAILCAT_CLIENT } from './state.ts';
import type { HostState, TailcatPairingRequest } from './state.ts';
import type { TailcatConfiguration } from './types.ts';

/** Helper IPC v3, docs/TAILCAT.md. stdout is private typed IPC; nothing from it is logged. */
export const TAILCAT_IPC_VERSION = 3;
export const TAILCAT_PAIRING_PORT = 48932;
export const TAILCAT_NORMAL_PORT = 48931;
const MAX_LINE = 64 * 1024;
const ADDRESS = /^tc[\x21-\x7e]{1,2046}$/, PRIVATE_KEY = /^privkey:[0-9a-f]{64}$/, PROOF = /^[A-Za-z0-9_-]{43}$/;
const EVENT_FIELDS: Record<string, string[]> = {
  ready: ['address'], persist: ['id', 'state', 'allowedClients'], pairing: ['address', 'port', 'key', 'proof', 'expiresAt'],
  paired: ['address', 'client'], pairingClosed: [], error: ['code'],
  // Emoji windows (TailPocket v2 invites): the invite to show, then one question per phone for the computer's user.
  pairing2: ['invite', 'expiresAt'], pairRequest: ['device', 'route', 'emoji'], pairRequestCancelled: [],
};

export interface TailcatHelperCommand { command: string; args: string[] }
export interface TailcatConnectorOptions {
  tailcat: TailcatConfiguration; state: HostState; targetPort: number; hostName: string;
  /** Programmatic tests only: run a fake helper instead of the bundled binary. */
  helper?: TailcatHelperCommand;
  /** tailcat.relay with its token already read (readTailcatRelays); sent on the config line, never logged. */
  relays?: { url: string; token: string }[];
  pollMs?: number; sweepMs?: number;
}
/**
 * What the helper is doing: starting, ready, waiting for the network (it exited start-failed with no identity yet: this
 * computer has no phone and cannot reach Tailcat's DERP relays to pick a region, so it tries again later, not a crash), or
 * restarting after it stopped.
 */
export type TailcatPhase = 'starting' | 'ready' | 'waiting-for-network' | 'restarting';
export interface TailcatConnectorStatus { running: boolean; ready: boolean; address: string; allowedClients: number; restarts: number; phase: TailcatPhase; retryAt?: number }
/** Restart backoff: 1 s doubling, at most 30 s after a crash and at most 5 minutes while waiting for the network. */
export const TAILCAT_RESTART_MAX_MS = 30_000, TAILCAT_WAITING_MAX_MS = 300_000;
export function tailcatRestartDelay(attempt: number, waiting: boolean): number {
  return Math.min(1000 * 2 ** Math.min(Math.max(0, attempt), 20), waiting ? TAILCAT_WAITING_MAX_MS : TAILCAT_RESTART_MAX_MS);
}
export interface TailcatConnector { start(): void; close(): Promise<void>; sweep(): void; status(): TailcatConnectorStatus }

/** process.platform-process.arch of the computers DSH Desktop is built for (tools/pack-bundle.mjs packs their helpers). */
export const SHIPPED_COMPUTERS = ['darwin-arm64', 'darwin-x64', 'win32-x64'];
/** Bundled helper next to the built plugin: dist/tailcat/dsh-tailcat-host-<goos>-<goarch>[.exe]. */
export function bundledTailcatHelper(base = dirname(fileURLToPath(import.meta.url))): string {
  const goos = process.platform === 'win32' ? 'windows' : process.platform;
  const goarch = process.arch === 'x64' ? 'amd64' : process.arch;
  return join(base, 'tailcat', `dsh-tailcat-host-${goos}-${goarch}${process.platform === 'win32' ? '.exe' : ''}`);
}
export function tailcatHelperCommand(tailcat: TailcatConfiguration): TailcatHelperCommand {
  const command = tailcat.helperPath ?? bundledTailcatHelper();
  // The npm package carries the helpers of the computers DSH Desktop ships for; elsewhere (Linux, Windows on Arm with a
  // native Node) the missing helper is no damage, the computer is simply not supported.
  if (!existsSync(command)) throw new HostError(tailcat.helperPath === undefined && !SHIPPED_COMPUTERS.includes(`${process.platform}-${process.arch}`) ? 'unsupported_computer' : 'tailcat_helper_missing');
  return { command, args: [] };
}

/** Reads tailcat.relay's token from its owner-only file (in an owner-only directory). No relay is configured by default. */
export async function readTailcatRelays(tailcat: TailcatConfiguration): Promise<{ url: string; token: string }[]> {
  if (!tailcat.relay) return [];
  let token: string;
  try { token = (await privateRead(tailcat.relay.tokenFile)).trim(); }
  catch (error) { throw error instanceof HostError ? error : new HostError('invalid_config'); }
  // The helper's own limits (connector.go): non-empty, at most 4096 bytes, no whitespace.
  if (!token || Buffer.byteLength(token) > 4096 || /\s/.test(token)) throw new HostError('invalid_config');
  return [{ url: tailcat.relay.url, token }];
}

/** Owns one helper process; the helper's only TCP destination is 127.0.0.1:targetPort. */
export function createTailcatConnector(options: TailcatConnectorOptions): TailcatConnector {
  const { state, targetPort } = options;
  if (!Number.isInteger(targetPort) || targetPort < 1024 || targetPort > 65534) throw new HostError('invalid_config');
  const helper = options.helper ?? tailcatHelperCommand(options.tailcat);
  const name = [...options.hostName.trim()].slice(0, 64).join('') || 'DSH Anywhere';
  const relays = options.relays ?? [];
  // Network choices (tailcat.lan, tailcat.tailcatOnly): TailPocket's local network route is on unless turned off.
  const routes = { ...(options.tailcat.lan === false ? { noLan: true } : {}), ...(options.tailcat.tailcatOnly ? { tailcatOnly: true } : {}) };
  let answered = false; // the open emoji question got the computer's answer
  let child: ChildProcess | undefined, buffer = '', closed = false, started = false, ready = false, address = '', restarts = 0, failures = 0;
  let phase: TailcatPhase = 'starting', retryAt: number | undefined, startFailed = false;
  let poll: ReturnType<typeof setInterval> | undefined, sweeper: ReturnType<typeof setInterval> | undefined, restartTimer: ReturnType<typeof setTimeout> | undefined;
  // Helper-side allowlist as last persisted; the database is authoritative for what it should be.
  let helperAllowed: string[] = [], allowedInFlight: string | undefined;
  let active: (TailcatPairingRequest & { windowExpiresAt?: number }) | undefined;

  function write(value: unknown) {
    if (!child?.stdin?.writable) return;
    child.stdin.write(JSON.stringify(value) + '\n');
  }
  function activePairing() {
    return active && (active.windowExpiresAt === undefined || active.windowExpiresAt > Date.now()) ? { pairingHash: active.pairingHash, offerExpiresAt: active.offerExpiresAt } : undefined;
  }
  function handle(event: Record<string, unknown>) {
    const kind = event.event;
    if (typeof kind !== 'string' || !EVENT_FIELDS[kind]) return;
    const fields = EVENT_FIELDS[kind]!;
    if (Object.keys(event).length !== fields.length + 1 || fields.some(field => !(field in event))) return;
    if (kind === 'ready' && typeof event.address === 'string' && (event.address === '' || ADDRESS.test(event.address))) {
      ready = true; address = event.address; phase = 'ready'; retryAt = undefined; failures = 0; state.updateTailcatStatus(address, true, 'ready'); sweep();
    } else if (kind === 'persist' && typeof event.id === 'string' && event.id.length <= 32) {
      let ok = false;
      try {
        const allowed = event.allowedClients as string[];
        // Commit before acknowledging: the helper treats ack as durable.
        state.persistTailcat(event.state as string | null, allowed, activePairing());
        helperAllowed = [...allowed].sort(); allowedInFlight = undefined; ok = true;
      } catch { ok = false; }
      write({ command: 'ack', id: event.id, ok });
    } else if (kind === 'pairing' && active && typeof event.address === 'string' && ADDRESS.test(event.address) && event.port === TAILCAT_PAIRING_PORT &&
        typeof event.key === 'string' && PRIVATE_KEY.test(event.key) && typeof event.proof === 'string' && PROOF.test(event.proof) &&
        Number.isSafeInteger(event.expiresAt) && (event.expiresAt as number) * 1000 > Date.now()) {
      const expiresAt = (event.expiresAt as number) * 1000;
      if (state.openTailcatPairing(active.id, event.address, event.key, event.proof, expiresAt)) active.windowExpiresAt = expiresAt;
      else active = undefined;
    } else if (kind === 'paired' && typeof event.client === 'string' && TAILCAT_CLIENT.test(event.client) && typeof event.address === 'string' && ADDRESS.test(event.address)) {
      try { state.recordTailcatPaired(event.client, activePairing()); } catch { /* invalid key: sweep removes it */ }
      address = event.address; state.updateTailcatStatus(address, true, 'ready');
    } else if (kind === 'pairing2' && active?.emoji && typeof event.invite === 'string' && event.invite.length <= 16_384 &&
        Number.isSafeInteger(event.expiresAt) && (event.expiresAt as number) * 1000 > Date.now()) {
      const expiresAt = (event.expiresAt as number) * 1000;
      if (state.openTailcatPairing2(active.id, event.invite, expiresAt)) active.windowExpiresAt = expiresAt;
      else active = undefined;
    } else if (kind === 'pairRequest' && active?.emoji && typeof event.device === 'string' && typeof event.route === 'string' && Array.isArray(event.emoji) &&
        event.emoji.length <= 4 && event.emoji.every(item => typeof item === 'string' && item.length <= 16)) {
      answered = false;
      state.askTailcatPairing(active.id, { device: [...event.device].slice(0, 64).join(''), route: event.route.slice(0, 16), emoji: event.emoji as string[] });
    } else if (kind === 'pairRequestCancelled') {
      if (active?.emoji) state.askTailcatPairing(active.id, null);
    } else if (kind === 'pairingClosed') {
      // An emoji window that closes without a phone was refused, left or expired: the CLI waiting on it says so.
      if (active && (active.windowExpiresAt === undefined || active.emoji)) state.failTailcatPairing(active.id);
      active = undefined;
    } else if (kind === 'error') {
      if (event.code === 'start-failed') startFailed = true;
      // Fixed vocabulary only; a failed pair request releases the CLI waiter now.
      if (active && active.windowExpiresAt === undefined) { state.failTailcatPairing(active.id); active = undefined; }
      allowedInFlight = undefined;
    }
  }
  function launch() {
    if (closed) return;
    // No identity yet: the helper must reach Tailcat's DERP map to pick a region before it can run at all.
    const neverPaired = state.tailcatSnapshot().state === null;
    let proc: ChildProcess;
    const env = process.platform === 'darwin' ? { ...process.env, SSL_CERT_FILE: process.env.SSL_CERT_FILE || '/etc/ssl/cert.pem' } : process.env;
    try { proc = spawn(helper.command, helper.args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env }); }
    catch { scheduleRestart(); return; }
    child = proc; buffer = ''; ready = false; allowedInFlight = undefined; active = undefined; startFailed = false;
    if (phase !== 'waiting-for-network') phase = 'starting';
    proc.on('error', () => {});
    proc.stdin?.on('error', () => {});
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      if (child !== proc) return;
      buffer += chunk;
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try { const value = JSON.parse(line) as unknown; if (value && typeof value === 'object' && !Array.isArray(value)) handle(value as Record<string, unknown>); }
        catch { /* malformed IPC is dropped, never echoed */ }
      }
      if (buffer.length > MAX_LINE) proc.kill();
    });
    proc.on('exit', () => {
      if (child !== proc) return;
      child = undefined; ready = false;
      if (active) { state.failTailcatPairing(active.id); active = undefined; }
      if (!closed) scheduleRestart(startFailed && neverPaired);
    });
    const snapshot = state.tailcatSnapshot(), allowed = state.tailcatAllowedClients();
    helperAllowed = [...allowed];
    write({ version: TAILCAT_IPC_VERSION, localPort: targetPort, state: snapshot.state, allowedClients: allowed, name, ...(relays.length ? { relays } : {}), ...routes });
  }
  function scheduleRestart(waiting = false) {
    if (closed || restartTimer) return;
    restarts++;
    const delay = tailcatRestartDelay(failures++, waiting);
    phase = waiting ? 'waiting-for-network' : 'restarting'; retryAt = Date.now() + delay;
    try { state.updateTailcatStatus(null, false, phase, retryAt); } catch { /* closed state */ }
    restartTimer = setTimeout(() => { restartTimer = undefined; launch(); }, delay); restartTimer.unref();
  }
  function servicePairing() {
    if (!ready || closed) return;
    if (active?.windowExpiresAt !== undefined && active.windowExpiresAt <= Date.now()) active = undefined;
    if (active?.windowExpiresAt !== undefined && state.tailcatPairingRequest(active.id)?.status === 'failed') {
      // The CLI gave up on this pairing (refused, too many attempts, interrupted): close the window now.
      active = undefined; write({ command: 'cancelPairing' }); return;
    }
    if (active?.emoji && active.windowExpiresAt !== undefined && !answered) {
      // The CLI answers the helper's question through the database.
      const current = state.tailcatPairingRequest(active.id);
      if (current?.ask && current.answer !== undefined) { answered = true; write({ command: 'confirm', approve: current.answer }); }
    }
    const next = state.nextTailcatPairingRequest();
    if (!next || next.id === active?.id) return;
    // One window at a time; a newer request replaces an older open window, as `pair` does in the helper.
    if (active && active.windowExpiresAt === undefined) return;
    active = next; answered = false; write({ command: 'pair', invitation: next.template ?? '', ...(next.emoji ? { emoji: true } : {}) });
  }
  function sweep() {
    if (closed) return;
    let desired: string[];
    try { desired = state.tailcatAllowedClients(); } catch { return; }
    if (ready) state.updateTailcatStatus(address, true, 'ready');
    const serialized = JSON.stringify(desired);
    if (!ready || allowedInFlight === serialized || serialized === JSON.stringify(helperAllowed)) return;
    allowedInFlight = serialized; write({ command: 'setAllowed', allowedClients: desired });
  }
  return {
    start() {
      if (started || closed) return; started = true;
      launch();
      poll = setInterval(servicePairing, options.pollMs ?? 250); poll.unref();
      sweeper = setInterval(sweep, options.sweepMs ?? 2000); sweeper.unref();
    },
    sweep,
    status: () => ({ running: child !== undefined, ready, address, allowedClients: helperAllowed.length, restarts, phase, ...(retryAt !== undefined && !ready ? { retryAt } : {}) }),
    async close() {
      if (closed) return; closed = true;
      if (poll) clearInterval(poll); if (sweeper) clearInterval(sweeper); if (restartTimer) clearTimeout(restartTimer);
      const proc = child; child = undefined;
      if (active) { try { state.failTailcatPairing(active.id); } catch { /* closed state */ } active = undefined; }
      try { state.updateTailcatStatus(null, false); } catch { /* closed state */ }
      if (!proc || proc.exitCode !== null) return;
      // Closing stdin is the helper's stop signal; kill only a helper that ignores it.
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { proc.kill(); resolve(); }, 3000); timer.unref();
        proc.once('exit', () => { clearTimeout(timer); resolve(); });
        proc.stdin?.end();
      });
    },
  };
}
