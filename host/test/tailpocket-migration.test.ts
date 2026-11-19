// The move to TailPocket (state version 5): back up first, then drop relay v2's tables (docs/TAILCAT.md, "Rollback").
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { HostState } from '../src/state.ts';

const all = { readWorkspaceIds: ['*'], executeWorkspaceIds: ['*'] };
const DSH_STATE = JSON.stringify({ version: 1, privateKey: 'privkey:' + '1'.repeat(64), presharedKey: 'pre-shared-synthetic', region: { RegionID: 1 } });

/** A database as a build with relay v2 left it: its two tables, a relay device and DSH's own Tailcat state. */
function legacyDatabase(path: string) {
  const fresh = new HostState(path); fresh.close();
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE relay_grants (access_id TEXT PRIMARY KEY, route_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      device_id TEXT REFERENCES devices(id), pairing_hash TEXT REFERENCES pairings(token_hash), expires_at INTEGER NOT NULL,
      max_streams INTEGER NOT NULL CHECK(max_streams IN (2,8)), published INTEGER NOT NULL DEFAULT 0, generation TEXT, revoked_at INTEGER, pending_since INTEGER) STRICT;
    CREATE TABLE relay_status (route_id TEXT PRIMARY KEY, connected INTEGER NOT NULL, ready INTEGER NOT NULL, generation TEXT, updated_at INTEGER NOT NULL) STRICT;`);
  const now = Date.now();
  for (const id of ['relay-phone', 'tailcat-phone'])
    db.prepare('INSERT INTO devices (id,name,token_hash,grants,created_at) VALUES (?,?,?,?,?)').run(id, id, 'h-' + id, JSON.stringify(all), now);
  db.prepare("INSERT INTO pairings (token_hash,grants,expires_at) VALUES ('relay-offer',?,?)").run(JSON.stringify(all), now + 60_000);
  db.prepare("INSERT INTO relay_grants (access_id,route_id,token_hash,device_id,pairing_hash,expires_at,max_streams) VALUES ('a','r','t','relay-phone','relay-offer',?,2)").run(now + 60_000);
  db.prepare("INSERT INTO relay_status VALUES ('r',1,1,NULL,?)").run(now);
  db.prepare("INSERT INTO tailcat_state (id,state,allowed,updated_at) VALUES (1,?,'[]',?) ON CONFLICT(id) DO UPDATE SET state=excluded.state").run(DSH_STATE, now);
  db.exec('PRAGMA user_version = 4');
  db.close();
}
const tables = (path: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'relay_%'").all().map(row => String(row.name)).sort(); } finally { db.close(); } };

test('opening a relay-v2 database backs it up whole, then drops relay_grants and relay_status and revokes relay devices', t => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-tailpocket-migration-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'host.sqlite');
  legacyDatabase(path);
  const state = new HostState(path);
  const backup = state.preTailPocketBackup;
  assert.ok(existsSync(backup), 'the backup exists before anything was dropped');
  if (process.platform !== 'win32') assert.equal(statSync(backup).mode & 0o077, 0, 'the backup is owner-only');
  assert.deepEqual(tables(backup), ['relay_grants', 'relay_status'], 'the backup keeps relay v2 as it was');
  const old = new DatabaseSync(backup, { readOnly: true });
  assert.equal(old.prepare('SELECT state FROM tailcat_state WHERE id=1').get()?.state, DSH_STATE, 'the backup keeps the Tailcat state from before TailPocket');
  old.close();
  assert.deepEqual(tables(path), [], 'relay v2 tables are gone');
  assert.equal(state.tailcatSnapshot().state, DSH_STATE, 'the helper, not this migration, rewrites tailcat_state');
  assert.deepEqual(state.listDevices().filter(d => d.revokedAt === null).map(d => d.deviceId), ['tailcat-phone'], 'only the relay device is revoked');
  state.close();
  const db = new DatabaseSync(path, { readOnly: true });
  assert.equal(Number(db.prepare('PRAGMA user_version').get()?.user_version), 5);
  assert.equal(db.prepare("SELECT 1 FROM pairings WHERE token_hash='relay-offer'").get(), undefined, 'the relay pairing offer is dropped');
  db.close();
  // Reopening migrates nothing again and never overwrites the backup.
  const before = readFileSync(backup);
  new HostState(path).close();
  assert.deepEqual(readFileSync(backup), before);
});

test('a database with nothing to migrate gets no backup', t => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-tailpocket-fresh-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = new HostState(join(dir, 'host.sqlite'));
  assert.ok(!existsSync(state.preTailPocketBackup));
  state.close();
});
