import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runAdminCli } from './cli.ts';
import { HOST_VERSION } from './phone.ts';
import { invitationQrSvg } from './qr.ts';

/** One authenticated browser Fetch route registered on the DSH shared /api channel. */
export interface MobileAdminRoute {
  readonly path: string;
  readonly methods: readonly ('GET' | 'HEAD' | 'POST')[];
  readonly requestBody: 'buffered' | 'streaming';
  readonly fetch: (request: Request) => Promise<Response>;
}

interface AdminOptions {
  readonly configPath: string;
  readonly dshVersion: string;
  readonly transport: 'tailcat' | 'direct';
  readonly publicUrl?: string;
  readonly tailcatWaitMs?: number;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

function failure(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

function codeOf(error: string): string {
  return /^([a-z_]+):/.exec(error.trim())?.[1] ?? 'unavailable';
}

/** One pairing started from Settings. The CLI's pair keeps running after the QR is written (the emoji window waits for
 * the phone), so the page polls this record instead of holding its request open. */
interface PairingSession {
  phase: 'waiting' | 'confirm' | 'approved' | 'refused' | 'expired' | 'failed' | 'cancelled';
  expiresAt: number;
  ask?: { emoji: string[]; device: string };
  answer?: (approve: boolean) => void;
}

const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Local admin surface for the Settings page. Every route runs behind DSH browser auth. */
export function createMobileAdminRoutes(options: AdminOptions): MobileAdminRoute[] {
  const invitations = join(dirname(options.configPath), 'invitations');
  const run = async (argv: string[]): Promise<{ code: number; out: string; error: string }> => {
    let out = '', error = '';
    const code = await runAdminCli(argv, { out: text => { out += text; }, error: text => { error += text; } }, options.tailcatWaitMs === undefined ? {} : { tailcatWaitMs: options.tailcatWaitMs });
    return { code, out, error };
  };

  const sessions = new Map<string, PairingSession>();
  const end = (session: PairingSession, phase: PairingSession['phase']) => {
    if (session.phase === 'waiting' || session.phase === 'confirm') session.phase = phase;
    session.answer?.(false); delete session.answer; delete session.ask;
  };

  const status = async (): Promise<Response> => {
    if (options.transport === 'direct') {
      const result = await run(['devices', '--config', options.configPath]);
      if (result.code !== 0) return failure(503, 'unavailable', 'The companion is not running.');
      try {
        const value = JSON.parse(result.out) as { items?: { revokedAt?: unknown }[] };
        const active = Array.isArray(value.items) ? value.items.filter(item => item.revokedAt === null).length : 0;
        return json(200, { transport: 'direct', running: true, address: options.publicUrl ?? null, allowedClients: 0, pairedPhones: active, pendingPhones: 0, updatedAt: Date.now(), stale: false, dshVersion: options.dshVersion, hostVersion: HOST_VERSION });
      } catch {
        return failure(503, 'unavailable', 'The companion status is unavailable.');
      }
    }
    const result = await run(['tailcat-status', '--config', options.configPath]);
    if (result.code !== 0) return failure(503, 'unavailable', 'The companion is not running.');
    try {
      const value = JSON.parse(result.out) as Record<string, unknown>;
      return json(200, { ...value, dshVersion: options.dshVersion, hostVersion: HOST_VERSION });
    } catch {
      return failure(503, 'unavailable', 'The companion status is unavailable.');
    }
  };

  const devices = async (): Promise<Response> => {
    const result = await run(['devices', '--config', options.configPath]);
    if (result.code !== 0) return failure(503, 'unavailable', 'The paired-device list is unavailable.');
    try {
      const value = JSON.parse(result.out) as { items?: unknown };
      return json(200, { items: Array.isArray(value.items) ? value.items : [] });
    } catch {
      return failure(503, 'unavailable', 'The paired-device list is unavailable.');
    }
  };

  const pair = async (request: Request): Promise<Response> => {
    let body: unknown;
    try { body = await request.json(); } catch { return failure(400, 'invalid_request', 'The pairing request is not valid JSON.'); }
    if (typeof body !== 'object' || body === null || (body as { execute?: unknown }).execute !== undefined && typeof (body as { execute?: unknown }).execute !== 'boolean') {
      return failure(400, 'invalid_request', 'The pairing request is invalid.');
    }
    const execute = (body as { execute?: boolean }).execute === true;
    // One pairing at a time: a new code ends the one before it, so an old QR can no longer ask this page.
    for (const old of sessions.values()) end(old, 'cancelled');
    sessions.clear();
    await mkdir(invitations, { recursive: true, mode: 0o700 });
    const id = randomUUID(), file = join(invitations, `ui-${id}.json`);
    const session: PairingSession = { phase: 'waiting', expiresAt: Date.now() + 300_000 };
    let error = '';
    const done = runAdminCli(options.transport === 'tailcat'
      ? ['pair', '--config', options.configPath, '--tailcat', '--read', 'all', ...(execute ? ['--execute', 'all'] : []), '--output', file]
      : ['pair', '--config', options.configPath, '--read', 'all', ...(execute ? ['--execute', 'all'] : []), '--url', options.publicUrl ?? '', '--output', file],
    { out() {}, error: text => { error += text; } }, {
      ...(options.tailcatWaitMs === undefined ? {} : { tailcatWaitMs: options.tailcatWaitMs }),
      emojiConfirm: (emoji, device) => new Promise<boolean>(resolve => {
        if (session.phase !== 'waiting') { resolve(false); return; }
        session.phase = 'confirm'; session.ask = { emoji, device };
        session.answer = approve => { delete session.answer; resolve(approve); };
      }),
    }).then(code => {
      // Direct pairing returns once the code is written; the device list shows when the phone uses it.
      if (code === 0) { if (options.transport === 'tailcat') end(session, 'approved'); return code; }
      end(session, /pairing_not_approved/.test(error) ? 'expired' : 'failed');
      return code;
    }, () => { end(session, 'failed'); return 1; });
    try {
      // The QR exists once the CLI wrote it; the CLI may still be waiting for the phone after that.
      let finished: number | undefined;
      void done.then(code => { finished = code; });
      while (!existsSync(file) && finished === undefined) await new Promise(resolve => setTimeout(resolve, 100));
      if (!existsSync(file)) return failure(503, codeOf(error) === 'tailcat_unavailable' ? 'tailcat_unavailable' : 'unavailable', 'Pairing could not start. Check that this computer is online and DSH Anywhere is running, then try again.');
      const invitation = JSON.parse(await readFile(file, 'utf8')) as { expiresAt?: unknown };
      const rendered = await invitationQrSvg(invitation);
      const expiresAt = typeof invitation.expiresAt === 'number' ? invitation.expiresAt : Date.now() + 120_000;
      session.expiresAt = expiresAt;
      sessions.set(id, session);
      return json(200, { id, svg: rendered.svg, version: rendered.version, expiresAt });
    } catch {
      end(session, 'failed');
      return failure(503, 'unavailable', 'Pairing could not start. Check that this computer is online and DSH Anywhere is running, then try again.');
    } finally {
      await rm(file, { force: true });
    }
  };

  const sessionOf = async (request: Request): Promise<PairingSession | { readonly response: Response }> => {
    let body: unknown;
    try { body = await request.json(); } catch { return { response: failure(400, 'invalid_request', 'The request is not valid JSON.') }; }
    const id = (body as { id?: unknown } | null)?.id;
    const session = typeof id === 'string' ? sessions.get(id) : undefined;
    return session ?? { response: failure(404, 'not_found', 'That pairing code is no longer open. Make a new one.') };
  };
  const view = (session: PairingSession) => json(200, { phase: session.phase, expiresAt: session.expiresAt, ...(session.ask ? { emoji: session.ask.emoji, device: session.ask.device } : {}) });

  const pairing = async (request: Request): Promise<Response> => {
    const session = await sessionOf(request);
    return 'response' in session ? session.response : view(session);
  };

  // The computer's half of the emoji check: the user compares the four emoji on both screens.
  const answer = async (request: Request): Promise<Response> => {
    const raw = await request.clone().json().catch(() => undefined) as { approve?: unknown } | undefined;
    const session = await sessionOf(request);
    if ('response' in session) return session.response;
    if (typeof raw?.approve !== 'boolean') return failure(400, 'invalid_request', 'approve must be true or false.');
    if (session.phase !== 'confirm' || !session.answer) return failure(409, 'conflict', 'No phone is waiting for an answer.');
    const approve = raw.approve;
    session.answer(approve);
    if (!approve) session.phase = 'refused';
    delete session.ask;
    return view(session);
  };

  const cancel = async (request: Request): Promise<Response> => {
    const session = await sessionOf(request);
    if ('response' in session) return session.response;
    end(session, 'cancelled');
    return view(session);
  };

  const revoke = async (request: Request): Promise<Response> => {
    let body: unknown;
    try { body = await request.json(); } catch { return failure(400, 'invalid_request', 'The revoke request is not valid JSON.'); }
    const deviceId = (body as { deviceId?: unknown })?.deviceId;
    if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) return failure(400, 'invalid_request', 'A device id is required.');
    const result = await run(['revoke', '--config', options.configPath, '--device', deviceId]);
    if (result.code !== 0) {
      return codeOf(result.error) === 'not_found' ? failure(404, 'not_found', 'That phone is not active.') : failure(503, 'unavailable', 'The phone could not be revoked.');
    }
    return json(200, { revoked: true });
  };

  return [
    { path: '/api/dsh-anywhere/status', methods: ['GET'], requestBody: 'buffered', fetch: status },
    { path: '/api/dsh-anywhere/devices', methods: ['GET'], requestBody: 'buffered', fetch: devices },
    { path: '/api/dsh-anywhere/pair', methods: ['POST'], requestBody: 'buffered', fetch: pair },
    { path: '/api/dsh-anywhere/revoke', methods: ['POST'], requestBody: 'buffered', fetch: revoke },
    { path: '/api/dsh-anywhere/pairing', methods: ['POST'], requestBody: 'buffered', fetch: pairing },
    { path: '/api/dsh-anywhere/pairing/answer', methods: ['POST'], requestBody: 'buffered', fetch: answer },
    { path: '/api/dsh-anywhere/pairing/cancel', methods: ['POST'], requestBody: 'buffered', fetch: cancel },
  ];
}
