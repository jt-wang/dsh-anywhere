import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, openSync, closeSync, chmodSync, existsSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HostError } from './errors.ts';
import type { ChangeLabel } from './dsh-relay.ts';
import type { CommandReceipt, DeviceGrants } from './types.ts';

export interface AuthorizedDevice { deviceId: string; deviceName: string; grants: DeviceGrants; createdAt: number }
export interface DeviceSummary extends AuthorizedDevice { revokedAt: number | null }
export interface PairingOffer { pairingToken: string; expiresAt: number }
export interface PairingResult { deviceId: string; deviceToken: string }
export interface StoredCommand { receipt: CommandReceipt; httpStatus: number; workspaceId: string | null }
export interface CommandAdmission extends StoredCommand { fresh: boolean }
export interface StateOptions { now?: () => number }
export interface TailcatSnapshot { state: string | null; allowedClients: string[]; address: string | null; running: boolean; updatedAt: number;
  /** The connector's TailcatPhase and, while not ready, when it tries again (unix ms). */
  phase: string | null; retryAt: number | null }
/** ask is the helper's question for an emoji window: the phone's name, its route and the four emoji it shows. */
export interface TailcatPairAsk { device: string; route: string; emoji: string[] }
export interface TailcatPairingRequest { id: string; pairingHash: string; offerExpiresAt: number; status: 'requested' | 'open' | 'failed'; createdAt: number; address?: string; clientKey?: string; proof?: string; expiresAt?: number; template?: string;
  emoji: boolean; invite?: string; ask?: TailcatPairAsk; answer?: boolean }
export const TAILCAT_CLIENT = /^nodekey:[0-9a-f]{64}$/;
/** An allowlisted key whose pairing was never consumed stays reachable this long past the offer. */
const TAILCAT_UNCONSUMED_GRACE_MS = 60_000;

type Row = Record<string, unknown>;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Device credential lifetime for both direct and relay pairings; revocation still applies at any time. */
const DEVICE_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
export function isRequestId(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }
export function hashSecret(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
/** '*' is a grant marker, never a mobile workspace id. */
export function allowsWorkspace(ids: readonly string[], workspaceId: string): boolean { return ids.includes('*') || ids.includes(workspaceId); }
export function validateGrants(grants: DeviceGrants): DeviceGrants {
  if (!grants || !Array.isArray(grants.readWorkspaceIds) || !Array.isArray(grants.executeWorkspaceIds)) throw new HostError('invalid_request');
  for (const ids of [grants.readWorkspaceIds, grants.executeWorkspaceIds]) {
    if (ids.length > 100 || ids.some(id => typeof id !== 'string' || (id !== '*' && !/^[A-Za-z0-9_-]{1,64}$/.test(id))) || new Set(ids).size !== ids.length || (ids.includes('*') && ids.length !== 1)) throw new HostError('invalid_request');
  }
  if (grants.executeWorkspaceIds.some(id => !allowsWorkspace(grants.readWorkspaceIds, id))) throw new HostError('invalid_request');
  return { readWorkspaceIds: [...grants.readWorkspaceIds].sort(), executeWorkspaceIds: [...grants.executeWorkspaceIds].sort() };
}

/** Local admin/storage boundary. No transcripts or plaintext credentials are retained. */
export class HostState {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private closed = false;
  private readonly revokeListeners = new Set<(deviceId: string) => void>();
  private runtimeId: string | undefined;
  private runtimeLockDb: DatabaseSync | undefined;

  constructor(path: string, options: StateOptions = {}) {
    if (!isAbsolute(path)) throw new HostError('invalid_config');
    this.path = path;
    this.now = options.now ?? Date.now;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { closeSync(openSync(path, 'wx', 0o600)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    if (process.platform !== 'win32') chmodSync(path, 0o600);
    this.db = new DatabaseSync(path, { timeout: 5_000, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        grants TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS pairings (
        token_hash TEXT PRIMARY KEY, grants TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS commands (
        device_id TEXT NOT NULL REFERENCES devices(id), request_id TEXT NOT NULL,
        operation TEXT NOT NULL, payload_hash TEXT NOT NULL, workspace_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','dispatching','accepted','rejected','uncertain')),
        result TEXT, error TEXT, http_status INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(device_id, request_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS mobile_created_sessions (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS notification_state (id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS runtime_lock (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, pid INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS phone_changes (id INTEGER PRIMARY KEY, device_id TEXT NOT NULL, device_name TEXT NOT NULL, method TEXT NOT NULL, target TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL) STRICT;
    `);
    // Early development databases have no scope column; unknown prior scope fails closed.
    if (!this.db.prepare('PRAGMA table_info(commands)').all().some(column => column.name === 'workspace_id')) this.db.exec('ALTER TABLE commands ADD COLUMN workspace_id TEXT');
    // NULL = paired before direct-device lifetimes existed; such devices stay valid until revoked.
    if (!this.db.prepare('PRAGMA table_info(devices)').all().some(column => column.name === 'expires_at')) this.db.exec('ALTER TABLE devices ADD COLUMN expires_at INTEGER');
    if (!this.db.prepare('PRAGMA table_info(devices)').all().some(column => column.name === 'publication_pending')) this.db.exec('ALTER TABLE devices ADD COLUMN publication_pending INTEGER NOT NULL DEFAULT 0');
    this.db.exec(`
    CREATE TABLE IF NOT EXISTS tailcat_state (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT, allowed TEXT NOT NULL DEFAULT '[]', address TEXT, running INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS tailcat_clients (public_key TEXT PRIMARY KEY, pairing_hash TEXT, device_id TEXT REFERENCES devices(id), expires_at INTEGER, created_at INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS tailcat_pairing_requests (
      id TEXT PRIMARY KEY, pairing_hash TEXT NOT NULL, offer_expires_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('requested','open','failed')),
      address TEXT, client_key TEXT, proof TEXT, expires_at INTEGER, template TEXT, created_at INTEGER NOT NULL
    ) STRICT;
    `);
    const statusColumns = this.db.prepare('PRAGMA table_info(tailcat_state)').all() as { name?: unknown }[];
    for (const [column, type] of [['phase', 'TEXT'], ['retry_at', 'INTEGER']] as const)
      if (!statusColumns.some(entry => entry.name === column)) this.db.exec(`ALTER TABLE tailcat_state ADD COLUMN ${column} ${type}`);
    const pairingColumns = this.db.prepare('PRAGMA table_info(tailcat_pairing_requests)').all() as { name?: unknown }[];
    if (!pairingColumns.some(column => column.name === 'template')) this.db.exec('ALTER TABLE tailcat_pairing_requests ADD COLUMN template TEXT');
    // Emoji windows (TailPocket v2 invites): the invite, the helper's question for the computer's user and the answer.
    for (const [column, type] of [['emoji', 'INTEGER NOT NULL DEFAULT 0'], ['invite', 'TEXT'], ['ask', 'TEXT'], ['answer', 'INTEGER']] as const)
      if (!pairingColumns.some(entry => entry.name === column)) this.db.exec(`ALTER TABLE tailcat_pairing_requests ADD COLUMN ${column} ${type}`);
    this.transaction(() => {
      const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
      if (version < 4) {
        const ttl = 7 * 24 * 60 * 60_000, now = this.now();
        // Retain the original acceptance age; reopening cannot renew or resurrect exceptions.
        this.db.prepare(`INSERT INTO mobile_created_sessions(id,expires_at)
          SELECT json_extract(result,'$.sessionId'), MAX(updated_at)+?
          FROM commands WHERE operation='create' AND status='accepted' AND updated_at>?
            AND json_valid(result) AND json_type(result,'$.sessionId')='text'
            AND length(json_extract(result,'$.sessionId')) BETWEEN 1 AND 256
          GROUP BY json_extract(result,'$.sessionId') ORDER BY MAX(updated_at) DESC LIMIT 256
          ON CONFLICT(id) DO UPDATE SET expires_at=MAX(expires_at,excluded.expires_at)`).run(ttl, now - ttl);
        this.db.prepare('DELETE FROM mobile_created_sessions WHERE expires_at<=?').run(now);
        this.db.exec('DELETE FROM mobile_created_sessions WHERE id NOT IN (SELECT id FROM mobile_created_sessions ORDER BY expires_at DESC, rowid DESC LIMIT 256)');
        this.db.exec('PRAGMA user_version = 4');
      }
    });
    this.retireRelayV2();
  }

  /** Where retireRelayV2 keeps the database as it was before TailPocket (docs/TAILCAT.md, "Rollback"). */
  get preTailPocketBackup(): string { return `${this.path}.before-tailpocket.sqlite`; }
  /**
   * Version 5: the move to TailPocket. Before anything is rewritten, a copy of the whole database goes beside it
   * (owner-only, never overwritten): the helper's old tailcat_state, which the helper rewrites in TailPocket's form at
   * its next start, and relay v2's tables, dropped here. Devices paired through relay v2 are revoked, since nothing
   * reaches the computer that way any more.
   */
  private retireRelayV2(): void {
    if (Number(this.db.prepare('PRAGMA user_version').get()?.user_version) >= 5) return;
    const tables = (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('relay_grants','relay_status')").all()).map(row => String(row.name));
    const state = this.db.prepare('SELECT state FROM tailcat_state WHERE id=1').get()?.state;
    const legacyTailcat = typeof state === 'string' && (() => { try { return (JSON.parse(state) as { version?: unknown }).version === 1; } catch { return false; } })();
    if ((tables.length || legacyTailcat) && !existsSync(this.preTailPocketBackup)) {
      const pending = `${this.preTailPocketBackup}.${process.pid}.partial`;
      try { rmSync(pending, { force: true }); this.db.prepare('VACUUM INTO ?').run(pending); if (process.platform !== 'win32') chmodSync(pending, 0o600); renameSync(pending, this.preTailPocketBackup); }
      catch (error) { rmSync(pending, { force: true }); throw error; }
    }
    this.transaction(() => {
      if (tables.includes('relay_grants')) {
        this.db.prepare('UPDATE devices SET revoked_at=?,publication_pending=0 WHERE revoked_at IS NULL AND id IN (SELECT device_id FROM relay_grants WHERE device_id IS NOT NULL)').run(this.now());
        const offers = this.db.prepare('SELECT pairing_hash FROM relay_grants WHERE pairing_hash IS NOT NULL').all().map(row => String(row.pairing_hash));
        this.db.exec('DROP TABLE relay_grants');
        const drop = this.db.prepare('DELETE FROM pairings WHERE token_hash=?');
        for (const offer of offers) drop.run(offer);
      }
      if (tables.includes('relay_status')) this.db.exec('DROP TABLE relay_status');
      this.db.exec('PRAGMA user_version = 5');
    });
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  /** Notification metadata only; bounded by the feed before committing. Uses this same SQLite DB. */
  readNotificationState<T>(id: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM notification_state WHERE id=?').get(id);
    return row ? JSON.parse(String(row.value)) as T : undefined;
  }
  writeNotificationState(id: string, value: unknown): void { this.writeNotificationStates([[id, value]]); }
  writeNotificationStates(values: [string, unknown][]): void {
    this.transaction(() => {
      const insert = this.db.prepare('INSERT INTO notification_state(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value');
      for (const [id, value] of values) insert.run(id, JSON.stringify(value));
    });
  }

  /** Index-only exception, never an authorization grant. 256 IDs, seven days. */
  rememberMobileSession(id: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM mobile_created_sessions WHERE expires_at<=?').run(this.now());
      this.db.prepare('INSERT INTO mobile_created_sessions(id,expires_at) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at').run(id, this.now() + 7 * 24 * 60 * 60_000);
      this.db.exec('DELETE FROM mobile_created_sessions WHERE id NOT IN (SELECT id FROM mobile_created_sessions ORDER BY expires_at DESC, rowid DESC LIMIT 256)');
    });
  }
  mobileSessionVisible(id: string, blank: boolean | undefined): boolean {
    const entry = this.db.prepare('SELECT expires_at FROM mobile_created_sessions WHERE id=?').get(id);
    const retained = !!entry && Number(entry.expires_at) > this.now();
    if (entry && (blank === false || !retained)) this.db.prepare('DELETE FROM mobile_created_sessions WHERE id=?').run(id);
    return blank !== true || retained;
  }

  createPairing(grants: DeviceGrants, ttlMs = 300_000): PairingOffer {
    const safeGrants = validateGrants(grants);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 900_000) throw new HostError('invalid_request');
    const pairingToken = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + ttlMs;
    this.transaction(() => {
      this.db.prepare('DELETE FROM pairings WHERE (expires_at <= ? OR consumed_at IS NOT NULL)').run(this.now());
      this.db.prepare('INSERT INTO pairings (token_hash, grants, expires_at) VALUES (?, ?, ?)').run(hashSecret(pairingToken), JSON.stringify(safeGrants), expiresAt);
    });
    return { pairingToken, expiresAt };
  }

  consumePairing(pairingToken: string, deviceName: string): PairingResult {
    if (typeof pairingToken !== 'string' || !TOKEN.test(pairingToken)) throw new HostError('unauthorized');
    if (typeof deviceName !== 'string' || !deviceName.trim() || Buffer.byteLength(deviceName, 'utf8') > 128 || /[\x00-\x1f\x7f]/.test(deviceName)) throw new HostError('invalid_request');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT grants FROM pairings WHERE token_hash=? AND consumed_at IS NULL AND expires_at > ?').get(hashSecret(pairingToken), this.now());
      if (!row) throw new HostError('unauthorized');
      const deviceId = randomUUID();
      const deviceToken = randomBytes(32).toString('base64url');
      this.db.prepare('UPDATE pairings SET consumed_at=? WHERE token_hash=?').run(this.now(), hashSecret(pairingToken));
      // Same bounded lifetime as relay device access; the phone treats the resulting 401 as re-pair.
      this.db.prepare('INSERT INTO devices (id, name, token_hash, grants, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(deviceId, deviceName.trim(), hashSecret(deviceToken), String(row.grants), this.now(), this.now() + DEVICE_LIFETIME_MS);
      // Transport v3: the phone key allowlisted for this offer now lives exactly as long as the device.
      this.db.prepare('UPDATE tailcat_clients SET device_id=?,expires_at=NULL WHERE pairing_hash=? AND device_id IS NULL').run(deviceId, hashSecret(pairingToken));
      return { deviceId, deviceToken };
    });
  }

  /** Invalidate an unused direct offer (CLI failure after creating it). */
  cancelPairing(pairingToken: string): void {
    if (TOKEN.test(pairingToken)) this.db.prepare('UPDATE pairings SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL').run(this.now(), hashSecret(pairingToken));
  }

  tailcatSnapshot(): TailcatSnapshot {
    const row = this.db.prepare('SELECT * FROM tailcat_state WHERE id=1').get();
    return { state: row?.state === undefined || row.state === null ? null : String(row.state), allowedClients: row ? JSON.parse(String(row.allowed)) as string[] : [],
      address: row?.address ? String(row.address) : null, running: row?.running === 1, updatedAt: row ? Number(row.updated_at) : 0,
      phase: typeof row?.phase === 'string' ? row.phase : null, retryAt: row?.retry_at === undefined || row.retry_at === null ? null : Number(row.retry_at) };
  }
  /** Helper persist event. Keys new to the allowlist belong to the open pairing window, else expire now. */
  /** state is null until the helper's node has chosen a DERP region (fresh identity, no phone yet). */
  persistTailcat(state: string | null, allowedClients: string[], pairing?: { pairingHash: string; offerExpiresAt: number }): void {
    if ((state !== null && (typeof state !== 'string' || !state || state.length > 16384)) || !Array.isArray(allowedClients) || allowedClients.length > 64 || allowedClients.some(key => typeof key !== 'string' || !TAILCAT_CLIENT.test(key)) || new Set(allowedClients).size !== allowedClients.length) throw new HostError('invalid_request');
    this.transaction(() => {
      this.db.prepare("INSERT INTO tailcat_state (id,state,allowed,updated_at) VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,allowed=excluded.allowed,updated_at=excluded.updated_at").run(state, JSON.stringify([...allowedClients].sort()), this.now());
      const insert = this.db.prepare('INSERT OR IGNORE INTO tailcat_clients (public_key,pairing_hash,device_id,expires_at,created_at) VALUES (?,?,NULL,?,?)');
      for (const key of allowedClients) insert.run(key, pairing?.pairingHash ?? null, pairing ? pairing.offerExpiresAt + TAILCAT_UNCONSUMED_GRACE_MS : this.now(), this.now());
    });
  }
  updateTailcatStatus(address: string | null, running: boolean, phase: string | null = null, retryAt: number | null = null): void {
    this.db.prepare("INSERT INTO tailcat_state (id,address,running,phase,retry_at,updated_at) VALUES (1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET address=COALESCE(excluded.address,address),running=excluded.running,phase=excluded.phase,retry_at=excluded.retry_at,updated_at=excluded.updated_at").run(address, running ? 1 : 0, phase, retryAt, this.now());
  }
  /** Helper paired event; idempotent with the provisional row persistTailcat created. */
  recordTailcatPaired(client: string, pairing: { pairingHash: string; offerExpiresAt: number } | undefined): void {
    if (!TAILCAT_CLIENT.test(client)) throw new HostError('invalid_request');
    this.db.prepare('INSERT INTO tailcat_clients (public_key,pairing_hash,device_id,expires_at,created_at) VALUES (?,?,NULL,?,?) ON CONFLICT(public_key) DO UPDATE SET pairing_hash=COALESCE(pairing_hash,excluded.pairing_hash) WHERE device_id IS NULL')
      .run(client, pairing?.pairingHash ?? null, pairing ? pairing.offerExpiresAt + TAILCAT_UNCONSUMED_GRACE_MS : this.now(), this.now());
  }
  /** Sweep, then the keys that may reach the companion: unexpired unconsumed offers and valid linked devices. */
  tailcatAllowedClients(): string[] {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM tailcat_clients WHERE device_id IS NULL AND expires_at<=?').run(this.now());
      this.db.prepare('DELETE FROM tailcat_clients WHERE device_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM devices WHERE devices.id=tailcat_clients.device_id AND devices.revoked_at IS NULL AND (devices.expires_at IS NULL OR devices.expires_at>?))').run(this.now());
      return this.db.prepare('SELECT public_key FROM tailcat_clients ORDER BY public_key LIMIT 64').all().map(row => String(row.public_key));
    });
  }
  tailcatClientCounts(): { linked: number; pending: number } {
    const row = this.db.prepare('SELECT count(device_id) AS linked, count(*)-count(device_id) AS pending FROM tailcat_clients').get();
    return { linked: Number(row?.linked ?? 0), pending: Number(row?.pending ?? 0) };
  }
  requestTailcatPairing(pairingHash: string, offerExpiresAt: number, template?: string, emoji = false): string {
    if (!/^[a-f0-9]{64}$/.test(pairingHash) || !Number.isSafeInteger(offerExpiresAt)) throw new HostError('invalid_request');
    const id = randomUUID();
    this.transaction(() => {
      if (Number(this.db.prepare("SELECT count(*) AS n FROM tailcat_pairing_requests WHERE status='requested'").get()?.n) >= 8) throw new HostError('rate_limited');
      this.db.prepare("INSERT INTO tailcat_pairing_requests (id,pairing_hash,offer_expires_at,status,template,emoji,created_at) VALUES (?,?,?,'requested',?,?,?)").run(id, pairingHash, offerExpiresAt, template ?? null, emoji ? 1 : 0, this.now());
    });
    return id;
  }
  /** Plugin side: retire stale rows (secrets included) and return the newest live request. */
  nextTailcatPairingRequest(maxAgeMs = 30_000): TailcatPairingRequest | undefined {
    return this.transaction(() => {
      this.db.prepare("DELETE FROM tailcat_pairing_requests WHERE (status='open' AND expires_at<=?) OR created_at<=?").run(this.now(), this.now() - 5 * 60_000);
      this.db.prepare("UPDATE tailcat_pairing_requests SET status='failed' WHERE status='requested' AND created_at<=?").run(this.now() - maxAgeMs);
      const row = this.db.prepare("SELECT * FROM tailcat_pairing_requests WHERE status='requested' ORDER BY created_at DESC, rowid DESC LIMIT 1").get();
      return row ? this.pairingRequest(row) : undefined;
    });
  }
  openTailcatPairing(id: string, address: string, clientKey: string, proof: string, expiresAt: number): boolean {
    return this.db.prepare("UPDATE tailcat_pairing_requests SET status='open',address=?,client_key=?,proof=?,expires_at=? WHERE id=? AND status='requested'").run(address, clientKey, proof, expiresAt, id).changes === 1;
  }
  /** An emoji window: the v2 invite (its code included) stays here only until the CLI has shown it. */
  openTailcatPairing2(id: string, invite: string, expiresAt: number): boolean {
    return this.db.prepare("UPDATE tailcat_pairing_requests SET status='open',invite=?,expires_at=? WHERE id=? AND status='requested' AND emoji=1").run(invite, expiresAt, id).changes === 1;
  }
  /** CLI side: the v1 window's key and proof leave the database once the bootstrap was built. */
  forgetTailcatSecrets(id: string): void { this.db.prepare('UPDATE tailcat_pairing_requests SET client_key=NULL,proof=NULL WHERE id=?').run(id); }
  /** CLI side: the v2 invite (its pairing code included) leaves the database once it was shown. */
  forgetTailcatInvite(id: string): void { this.db.prepare('UPDATE tailcat_pairing_requests SET invite=NULL WHERE id=?').run(id); }
  /** Plugin side: the helper asks whether this phone may pair (null: the question was withdrawn). */
  askTailcatPairing(id: string, ask: TailcatPairAsk | null): void {
    this.db.prepare("UPDATE tailcat_pairing_requests SET ask=?,answer=NULL WHERE id=? AND status='open' AND emoji=1").run(ask ? JSON.stringify(ask) : null, id);
  }
  /** CLI side: the computer's user answered the question that is open now. */
  answerTailcatPairing(id: string, approve: boolean): boolean {
    return this.db.prepare("UPDATE tailcat_pairing_requests SET answer=? WHERE id=? AND status='open' AND ask IS NOT NULL AND answer IS NULL").run(approve ? 1 : 0, id).changes === 1;
  }
  /** Whether a phone was allowed through this pairing offer (the helper persisted it with the offer's hash). */
  tailcatPairedThrough(pairingHash: string): boolean {
    return this.db.prepare('SELECT 1 FROM tailcat_clients WHERE pairing_hash=?').get(pairingHash) !== undefined;
  }
  failTailcatPairing(id: string): void {
    this.db.prepare("UPDATE tailcat_pairing_requests SET status='failed',client_key=NULL,proof=NULL,invite=NULL,ask=NULL WHERE id=? AND status!='failed'").run(id);
  }
  tailcatPairingRequest(id: string): TailcatPairingRequest | undefined {
    const row = this.db.prepare('SELECT * FROM tailcat_pairing_requests WHERE id=?').get(id);
    return row ? this.pairingRequest(row) : undefined;
  }
  /** CLI side: secrets leave the database once the invitation was rendered (or failed). */
  forgetTailcatPairing(id: string): void { this.db.prepare('DELETE FROM tailcat_pairing_requests WHERE id=?').run(id); }
  private pairingRequest(row: Row): TailcatPairingRequest {
    return { id: String(row.id), pairingHash: String(row.pairing_hash), offerExpiresAt: Number(row.offer_expires_at), status: row.status as TailcatPairingRequest['status'], createdAt: Number(row.created_at),
      ...(row.address !== null ? { address: String(row.address) } : {}), ...(row.client_key !== null ? { clientKey: String(row.client_key) } : {}),
      ...(row.proof !== null ? { proof: String(row.proof) } : {}), ...(row.expires_at !== null ? { expiresAt: Number(row.expires_at) } : {}),
      ...(row.template !== null ? { template: String(row.template) } : {}), emoji: row.emoji === 1,
      ...(row.invite !== null && row.invite !== undefined ? { invite: String(row.invite) } : {}), ...(row.ask !== null && row.ask !== undefined ? { ask: JSON.parse(String(row.ask)) as TailcatPairAsk } : {}),
      ...(row.answer !== null && row.answer !== undefined ? { answer: row.answer === 1 } : {}) };
  }

  authenticate(deviceToken: string): AuthorizedDevice | undefined {
    if (typeof deviceToken !== 'string' || !TOKEN.test(deviceToken)) return undefined;
    const row = this.db.prepare('SELECT * FROM devices WHERE token_hash=? AND devices.revoked_at IS NULL AND (devices.expires_at IS NULL OR devices.expires_at>?) AND publication_pending=0').get(hashSecret(deviceToken), this.now());
    return row ? this.device(row) : undefined;
  }
  getDevice(deviceId: string): AuthorizedDevice | undefined {
    const row = this.db.prepare('SELECT * FROM devices WHERE id=? AND devices.revoked_at IS NULL AND (devices.expires_at IS NULL OR devices.expires_at>?) AND publication_pending=0').get(deviceId, this.now());
    return row ? this.device(row) : undefined;
  }
  private device(row: Row): AuthorizedDevice {
    return { deviceId: String(row.id), deviceName: String(row.name), grants: validateGrants(JSON.parse(String(row.grants)) as DeviceGrants), createdAt: Number(row.created_at) };
  }
  /** Keeps a change of the computer's settings or plugins a phone asked for (dsh-relay.ts phoneChange), the last 200. */
  recordPhoneChange(device: AuthorizedDevice, method: string, target: string, label?: ChangeLabel): void {
    const named = label ? JSON.stringify(label).slice(0, 4000) : '';
    this.db.prepare('INSERT INTO phone_changes (device_id, device_name, method, target, label, at) VALUES (?, ?, ?, ?, ?, ?)').run(device.deviceId, device.deviceName, method, target, named, this.now());
    this.db.exec('DELETE FROM phone_changes WHERE id NOT IN (SELECT id FROM phone_changes ORDER BY id DESC LIMIT 200)');
  }
  /** The changes phones asked for, newest first. */
  listPhoneChanges(): { deviceId: string; deviceName: string; method: string; target: string; label?: ChangeLabel; at: number }[] {
    const labelOf = (raw: unknown): ChangeLabel | undefined => { try { return raw ? JSON.parse(String(raw)) as ChangeLabel : undefined; } catch { return undefined; } };
    return this.db.prepare('SELECT * FROM phone_changes ORDER BY id DESC').all().map(row => {
      const label = labelOf(row.label);
      return { deviceId: String(row.device_id), deviceName: String(row.device_name), method: String(row.method), target: String(row.target), ...label ? { label } : {}, at: Number(row.at) };
    });
  }
  listDevices(): DeviceSummary[] {
    return this.db.prepare('SELECT * FROM devices ORDER BY created_at, id').all().map(row => ({ ...this.device(row), revokedAt: row.revoked_at === null ? null : Number(row.revoked_at) }));
  }
  /** Replace ONLY active device grants; credentials, relay capabilities and receipts are unchanged. */
  replaceDeviceGrants(deviceId: string, grants: DeviceGrants): AuthorizedDevice {
    const safeGrants = validateGrants(grants);
    if (!isRequestId(deviceId)) throw new HostError('invalid_request');
    return this.transaction(() => {
      const device = this.getDevice(deviceId);
      if (!device) throw new HostError('not_found');
      const changed = this.db.prepare('UPDATE devices SET grants=? WHERE id=? AND revoked_at IS NULL').run(JSON.stringify(safeGrants), deviceId);
      if (!changed.changes) throw new HostError('not_found');
      return { ...device, grants: safeGrants };
    });
  }
  revokeDevice(deviceId: string): boolean {
    const changed = this.transaction(() => {
      const result = this.db.prepare('UPDATE devices SET revoked_at=?,publication_pending=0 WHERE id=? AND revoked_at IS NULL').run(this.now(), deviceId);
      return result.changes !== 0;
    });
    if (changed) for (const listener of this.revokeListeners) listener(deviceId);
    return changed;
  }
  onRevoke(listener: (deviceId: string) => void): () => void { this.revokeListeners.add(listener); return () => this.revokeListeners.delete(listener); }

  admitCommand(deviceId: string, requestId: string, operation: string, payloadHash: string, workspaceId: string | null = null): CommandAdmission {
    if (!isRequestId(requestId) || !/^[a-f0-9]{64}$/.test(payloadHash)) throw new HostError('invalid_request');
    requestId = requestId.toLowerCase();
    return this.transaction(() => {
      if (!this.getDevice(deviceId)) throw new HostError('unauthorized');
      const prior = this.db.prepare('SELECT * FROM commands WHERE device_id=? AND request_id=?').get(deviceId, requestId);
      if (prior) {
        if (prior.operation !== operation || prior.payload_hash !== payloadHash) throw new HostError('conflict');
        return { ...this.command(prior), fresh: false };
      }
      const updatedAt = this.now();
      // Dispatch intent is committed before any adapter call, including across a process crash.
      this.db.prepare('INSERT INTO commands (device_id,request_id,operation,payload_hash,workspace_id,status,http_status,updated_at) VALUES (?,?,?,?,?,\'dispatching\',202,?)').run(deviceId, requestId, operation, payloadHash, workspaceId, updatedAt);
      return { fresh: true, receipt: { requestId, status: 'pending', updatedAt }, httpStatus: 202, workspaceId };
    });
  }
  /** Bounded recent prompt identities; no text or foreign-device IDs are read. */
  promptCommandIds(deviceId: string): string[] {
    return this.db.prepare("SELECT request_id FROM commands WHERE device_id=? AND operation='prompt' ORDER BY rowid DESC LIMIT 1024").all(deviceId).map(row => String(row.request_id));
  }
  getCommand(deviceId: string, requestId: string): StoredCommand | undefined {
    const row = this.db.prepare('SELECT * FROM commands WHERE device_id=? AND request_id=?').get(deviceId, requestId.toLowerCase());
    return row ? this.command(row) : undefined;
  }
  private command(row: Row): StoredCommand {
    const receipt: CommandReceipt = { requestId: String(row.request_id), status: row.status === 'dispatching' ? 'pending' : row.status as CommandReceipt['status'], updatedAt: Number(row.updated_at) };
    if (row.result !== null) receipt.result = JSON.parse(String(row.result)) as NonNullable<CommandReceipt['result']>;
    if (row.error !== null) receipt.error = JSON.parse(String(row.error)) as NonNullable<CommandReceipt['error']>;
    return { receipt, httpStatus: Number(row.http_status), workspaceId: row.workspace_id === null ? null : String(row.workspace_id) };
  }
  finishCommand(deviceId: string, requestId: string, status: Exclude<CommandReceipt['status'], 'pending'>, options: { result?: CommandReceipt['result']; error?: CommandReceipt['error']; httpStatus?: number } = {}): StoredCommand {
    const httpStatus = options.httpStatus ?? (status === 'uncertain' ? 202 : status === 'accepted' ? 200 : 400);
    this.db.prepare("UPDATE commands SET status=?,result=?,error=?,http_status=?,updated_at=? WHERE device_id=? AND request_id=? AND status IN ('pending','dispatching')").run(status, options.result ? JSON.stringify(options.result) : null, options.error ? JSON.stringify(options.error) : null, httpStatus, this.now(), deviceId, requestId.toLowerCase());
    const result = this.getCommand(deviceId, requestId);
    if (!result) throw new HostError('not_found');
    return result;
  }
  recoverUnfinished(): void {
    this.db.prepare("UPDATE commands SET status='uncertain',http_status=202,updated_at=? WHERE status IN ('pending','dispatching')").run(this.now());
  }

  /** A local admin connection never claims this lock or recovers active dispatches. */
  claimRuntime(): void {
    if (this.runtimeId) throw new HostError('conflict');
    const owner = randomUUID();
    // A distinct rollback-journal database holds an OS-enforced lock for this runtime.
    // Main-state transactions remain available to the local admin CLI. A crash releases
    // the exclusive file lock; PID reuse and wall-clock/heartbeat races are irrelevant.
    const lockPath = this.path + '.lock.sqlite';
    try { closeSync(openSync(lockPath, 'wx', 0o600)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new HostError('unavailable'); }
    let lock: DatabaseSync | undefined;
    try {
      lock = new DatabaseSync(lockPath, { timeout: 0 });
      lock.exec('PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS lock_anchor (id INTEGER PRIMARY KEY); INSERT OR IGNORE INTO lock_anchor (id) VALUES (1);');
      if (lock.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') throw new HostError('conflict');
      lock.exec('BEGIN EXCLUSIVE;');
      this.transaction(() => {
        this.db.prepare('INSERT OR REPLACE INTO runtime_lock (id,owner,pid) VALUES (1,?,?)').run(owner, process.pid);
        this.recoverUnfinished();
      });
      this.runtimeLockDb = lock;
      this.runtimeId = owner;
    } catch {
      lock?.close();
      throw new HostError('conflict');
    }
  }
  releaseRuntime(): void {
    if (this.runtimeId) {
      this.db.prepare('DELETE FROM runtime_lock WHERE owner=?').run(this.runtimeId);
      this.runtimeId = undefined;
      this.runtimeLockDb?.exec('ROLLBACK');
      this.runtimeLockDb?.close();
      this.runtimeLockDb = undefined;
    }
  }
  close(): void {
    if (this.closed) return;
    this.releaseRuntime();
    this.closed = true;
    this.revokeListeners.clear();
    this.db.close();
  }
}
