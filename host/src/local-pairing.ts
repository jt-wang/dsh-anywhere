import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { NetworkInterfaceInfo } from 'node:os';
import { HostError } from './errors.ts';

/**
 * Same-Wi-Fi pairing (docs/TAILCAT.md): delivers the pairing bootstrap, never a transport. Wire version 2, TailPocket
 * v0.3.0-pre.9's (docs/PROTOCOL.md "Same-Wi-Fi delivery") with DSH's label: the phone commits to its key before it sees
 * the computer's, and a pairing window hands its key to at most LOCAL_PAIRING_MAX_ATTEMPTS commitments, to one address at
 * most once every LOCAL_PAIRING_SOURCE_GAP_MS. The CLI serves one window per pair session and ends the whole session
 * (offer and Tailcat window) when the attempts run out. Anything malformed, any other version (v1 included) and a reveal that does not
 * match its commitment close the connection without a reply.
 */
export const LOCAL_PAIRING_LABEL = 'dsh-mobile-local-pairing-v1';
export const LOCAL_PAIRING_WIRE = 2;
/** Each key handed out lets the peer compute the code the computer would show, so it is a guess: 3 per window. */
export const LOCAL_PAIRING_MAX_ATTEMPTS = 3;
export const LOCAL_PAIRING_SOURCE_GAP_MS = 2000;
export const LOCAL_PAIRING_SERVICE = '_dshmobile._tcp';
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex'), SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');
const MAX_LINE = 4096;
const HELLO_TIMEOUT_MS = 5000;
/** Tunnels, VPNs, AirDrop/peer-to-peer and VM bridges: never serve pairing on them. */
const VIRTUAL_INTERFACE = /^(utun|ipsec|ppp|gif|stf|awdl|llw|anpi|bridge|vmnet|vboxnet|tun|tap|wg|tailscale|zt|docker|veth)/i;

export interface LanAddress { address: string; netmask: string }
function ipv4(text: string): number | undefined {
  const parts = text.replace(/^::ffff:/i, '').split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return undefined;
  return parts.reduce((sum, part) => sum * 256 + Number(part), 0);
}
function privateIpv4(value: number): boolean {
  const a = Math.floor(value / 2 ** 24), b = Math.floor(value / 2 ** 16) % 256;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}
/** Private IPv4 addresses (RFC 1918, link-local) of physical interfaces: the Wi-Fi/Ethernet the phone shares. */
export function lanAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): LanAddress[] {
  const out: LanAddress[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (VIRTUAL_INTERFACE.test(name)) continue;
    for (const entry of entries ?? []) {
      const value = ipv4(entry.address);
      if (entry.family === 'IPv4' && !entry.internal && value !== undefined && privateIpv4(value) && ipv4(entry.netmask) !== undefined) out.push({ address: entry.address, netmask: entry.netmask });
    }
  }
  return out;
}
/** True when remote is on the same subnet as the local listener address. */
export function sameSubnet(remote: string | undefined, local: LanAddress): boolean {
  const r = remote === undefined ? undefined : ipv4(remote), l = ipv4(local.address), mask = ipv4(local.netmask);
  if (r === undefined || l === undefined || mask === undefined) return false;
  const network = (value: number) => Number((BigInt(value) & BigInt(mask)));
  return network(r) === network(l);
}

export function x25519Private(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new HostError('invalid_request');
  return createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: 'der', type: 'pkcs8' });
}
export function x25519PublicRaw(key: KeyObject): Buffer { return createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32); }
function x25519Public(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new HostError('invalid_request');
  return createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: 'der', type: 'spki' });
}
export interface LocalPairingSession { code: string; seal(plaintext: string, nonce?: Buffer): Buffer; open(sealed: Buffer): string }
/** The phone's commitment: SHA256(label ‖ "commit" ‖ phonePub ‖ nonce). */
export function localPairingCommit(phonePublic: Buffer, nonce: Buffer): Buffer {
  return createHash('sha256').update(LOCAL_PAIRING_LABEL).update('commit').update(phonePublic).update(nonce).digest();
}
/** Either role, once both keys and the phone's nonce are known; phonePub ‖ hostPub ordering is fixed by role. */
export function localPairingSession(own: KeyObject, peerPublic: Buffer, isPhone: boolean, nonce: Buffer): LocalPairingSession {
  if (nonce.length !== 32) throw new HostError('invalid_request');
  const ownPublic = x25519PublicRaw(own), shared = diffieHellman({ privateKey: own, publicKey: x25519Public(peerPublic) });
  // Node does not refuse a low-order peer key; X25519 then yields all zeroes, as Go's curve25519 refuses.
  if (shared.every(byte => byte === 0)) throw new HostError('invalid_request');
  const phone = isPhone ? ownPublic : peerPublic, host = isPhone ? peerPublic : ownPublic;
  const commit = localPairingCommit(phone, nonce);
  const digest = createHash('sha256').update(LOCAL_PAIRING_LABEL).update('code').update(commit).update(phone).update(host).update(nonce).update(shared).digest();
  const code = (digest.readBigUInt64BE(0) % 1_000_000n).toString().padStart(6, '0');
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([commit, phone, host, nonce]), Buffer.from(LOCAL_PAIRING_LABEL + ' invitation'), 32));
  return {
    code,
    seal(plaintext, aeadNonce = randomBytes(12)) {
      const cipher = createCipheriv('chacha20-poly1305', key, aeadNonce, { authTagLength: 16 });
      return Buffer.concat([aeadNonce, cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    },
    open(sealed) {
      if (sealed.length < 28) throw new HostError('invalid_request');
      const decipher = createDecipheriv('chacha20-poly1305', key, sealed.subarray(0, 12), { authTagLength: 16 });
      decipher.setAuthTag(sealed.subarray(sealed.length - 16));
      return Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]).toString('utf8');
    },
  };
}
/** Canonical standard base64 of exactly 32 bytes, or undefined. */
function bytes32(value: unknown): Buffer | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = Buffer.from(value, 'base64');
  return raw.length === 32 && raw.toString('base64') === value ? raw : undefined;
}
/** One JSON object whose keys are all in `allowed`, with v = 2; anything else is undefined. */
function message(line: string, allowed: string[]): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    return record.v === LOCAL_PAIRING_WIRE && Object.keys(record).every(key => allowed.includes(key)) ? record : undefined;
  } catch { return undefined; }
}
/** Sorted-key single-line JSON, matching the phone's encoder. */
export function wireLine(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))) + '\n';
}
function lines(socket: Socket) {
  let buffer = '';
  const waiters: { resolve: (line: string) => void; reject: (error: Error) => void }[] = [], ready: string[] = [];
  let failure: Error | undefined;
  const fail = (error: Error) => { failure ??= error; for (const waiter of waiters.splice(0)) waiter.reject(failure); };
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      const waiter = waiters.shift(); if (waiter) waiter.resolve(line); else ready.push(line);
    }
    if (buffer.length > MAX_LINE) { fail(new HostError('invalid_request')); socket.destroy(); }
  });
  socket.on('close', () => fail(new HostError('invalid_request')));
  socket.on('error', () => fail(new HostError('invalid_request')));
  return () => new Promise<string>((resolve, reject) => { const line = ready.shift(); if (line !== undefined) resolve(line); else if (failure) reject(failure); else waiters.push({ resolve, reject }); });
}

export interface LocalPairingOptions {
  /** Plaintext sent sealed after approval: the pairing bootstrap JSON. */
  invitation: string; expiresAt: number; serviceName: string;
  /** Operator decision for one phone; false denies it and keeps the window open. */
  confirm(code: string, device: string): Promise<boolean>;
  /** Bonjour registration for the window; returns its stop function. Defaults to macOS dns-sd. */
  advertise?(serviceName: string, port: number): () => void;
  /** Tests bind loopback; by default only this Mac's Wi-Fi/LAN addresses (never 0.0.0.0, VPNs or tunnels). */
  host?: string;
  /** Silent peers are dropped after this; tests shorten it. */
  helloTimeoutMs?: number;
  /** LOCAL_PAIRING_SOURCE_GAP_MS; tests that pair several times from loopback set 0. */
  sourceGapMs?: number;
  onListening?(port: number): void;
}
export function dnsSdAdvertiser(serviceName: string, port: number): () => void {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/dns-sd')) throw new HostError('local_pairing_unavailable');
  const child = spawn('/usr/bin/dns-sd', ['-R', serviceName, LOCAL_PAIRING_SERVICE, 'local', String(port), 'v=1'], { stdio: 'ignore' });
  child.on('error', () => {});
  return () => { child.kill(); };
}
/** One phone at a time until one is approved (resolves), the window closes (pairing_not_approved) or LOCAL_PAIRING_MAX_ATTEMPTS
 * phones got its key without an approval (local_pairing_too_many_attempts). */
export function serveLocalPairing(options: LocalPairingOptions): Promise<void> {
  const advertise = options.advertise ?? dnsSdAdvertiser;
  const name = [...options.serviceName.replace(/[\x00-\x1f\x7f.]/g, ' ').trim()].slice(0, 63).join('') || 'DSH Anywhere';
  return new Promise<void>((resolve, reject) => {
    let busy = false, finished = false, approved = false, attempts = 0, stopAdvertising: (() => void) | undefined;
    const lastAnswer = new Map<string, number>(), gap = options.sourceGapMs ?? LOCAL_PAIRING_SOURCE_GAP_MS;
    const bindings: LanAddress[] = options.host ? [{ address: options.host, netmask: '255.255.255.255' }] : lanAddresses();
    if (bindings.length === 0) { reject(new HostError('local_pairing_unavailable')); return; }
    const servers: Server[] = [];
    const denial = () => wireLine({ v: LOCAL_PAIRING_WIRE, status: 'denied', ...(Date.now() >= options.expiresAt ? { reason: 'expired' } : {}) });
    const helloTimeout = () => Math.max(1, Math.min(options.helloTimeoutMs ?? HELLO_TIMEOUT_MS, options.expiresAt - Date.now()));
    const handle = (binding: LanAddress) => (socket: Socket) => {
      // Only phones on the same Wi-Fi/LAN subnet; routed or tunneled peers are dropped without a reply.
      if (!sameSubnet(socket.remoteAddress, binding)) { socket.destroy(); return; }
      if (finished || busy || Date.now() >= options.expiresAt) { socket.end(denial()); return; }
      // A silent LAN peer must not hold the single slot for the whole window: the commitment and the reveal each within 5 s.
      busy = true; socket.setTimeout(helloTimeout(), () => socket.destroy());
      // This handler's own attempt number (0: none counted), as connectlocal v0.3.0-pre.9: the slot may be free again
      // before this handler ends, and the next phone's attempt must not end the window under that phone.
      let nth = 0;
      void (async () => {
        const read = lines(socket);
        try {
          const hello = message(await read(), ['commit', 'device', 'v']), commit = bytes32(hello?.commit);
          if (!hello || !commit || (hello.device !== undefined && typeof hello.device !== 'string')) throw new HostError('invalid_request');
          // Each key handed out is a guess at the code even if the peer never reveals: a window hands out
          // LOCAL_PAIRING_MAX_ATTEMPTS, at most one per address every LOCAL_PAIRING_SOURCE_GAP_MS, and then ends.
          const source = String(socket.remoteAddress).replace(/^::ffff:/i, '');
          if (attempts >= LOCAL_PAIRING_MAX_ATTEMPTS || Date.now() - (lastAnswer.get(source) ?? -Infinity) < gap) throw new HostError('rate_limited');
          nth = ++attempts; lastAnswer.set(source, Date.now());
          const device = typeof hello.device === 'string' ? [...hello.device.replace(/[\x00-\x1f\x7f]/g, ' ').trim()].slice(0, 64).join('') || 'Phone' : 'Phone';
          const own = generateKeyPairSync('x25519').privateKey;
          socket.write(wireLine({ v: LOCAL_PAIRING_WIRE, publicKey: x25519PublicRaw(own).toString('base64') }));
          socket.setTimeout(helloTimeout());
          const reveal = message(await read(), ['nonce', 'publicKey', 'v']), phoneKey = bytes32(reveal?.publicKey), nonce = bytes32(reveal?.nonce);
          // The phone, or someone in the middle, changed its key after seeing the computer's.
          if (!phoneKey || !nonce || !timingSafeEqual(localPairingCommit(phoneKey, nonce), commit)) throw new HostError('invalid_request');
          const session = localPairingSession(own, phoneKey, false, nonce);
          socket.setTimeout(Math.max(1, options.expiresAt - Date.now()));
          const allowed = await options.confirm(session.code, device);
          if (allowed && !finished && !socket.destroyed && Date.now() < options.expiresAt) {
            await new Promise<void>(done => socket.end(wireLine({ v: LOCAL_PAIRING_WIRE, status: 'approved', sealed: session.seal(options.invitation).toString('base64') }), done));
            approved = true; finish();
          } else { busy = false; socket.end(denial()); } // free the slot first: a denied phone may redial at once
        } catch { socket.destroy(); } // malformed, v1, mismatch, over a limit or gone: no reply
        finally {
          busy = false;
          if (nth >= LOCAL_PAIRING_MAX_ATTEMPTS && !approved) finish(new HostError('local_pairing_too_many_attempts'));
        }
      })();
    };
    const expiry = setTimeout(() => finish(new HostError('pairing_not_approved')), Math.max(1, options.expiresAt - Date.now()));
    function finish(error?: Error) {
      if (finished) return; finished = true;
      clearTimeout(expiry); stopAdvertising?.(); for (const server of servers) server.close();
      if (error) reject(error); else resolve();
    }
    // The first address picks the port; the rest (e.g. Ethernet beside Wi-Fi) share it or are skipped.
    const listen = (binding: LanAddress, port: number) => new Promise<number | undefined>(done => {
      const server = createServer(handle(binding));
      server.once('error', () => { server.close(); done(undefined); });
      server.listen(port, binding.address, () => {
        const address = server.address();
        if (finished || !address || typeof address === 'string') { server.close(); done(undefined); return; }
        servers.push(server); done(address.port);
      });
    });
    void (async () => {
      const port = await listen(bindings[0]!, 0);
      if (port === undefined) { finish(new HostError('local_pairing_unavailable')); return; }
      for (const binding of bindings.slice(1)) await listen(binding, port);
      if (finished) return;
      try { stopAdvertising = advertise(name, port); } catch (error) { finish(error instanceof Error ? error : new HostError('local_pairing_unavailable')); return; }
      options.onListening?.(port);
    })();
  });
}
