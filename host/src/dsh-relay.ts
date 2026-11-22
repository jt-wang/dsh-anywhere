// DSH's own web-client protocol (POST /api/<method>, WebSocket /api/remote.mux) relayed for the owner's phone.
// The relay signs in exactly as DSH's Desktop host does (connection.authenticatedUrl → GET /?token= → host-bound
// session cookie) and forwards only /api, plus the generated modules (/ui) the phone downloads. Its front door is
// the companion's own server under /dsh (what Tailcat reaches; device-token auth, owner devices only: server.ts).
import { createReadStream } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { UiModules } from './ui-modules.ts';

export interface DshUpstream { origin: string; loginUrl: string }
export interface DshRelay {
  /** Answers a request whose URL is already stripped of any prefix and credential; false when it is not relayed.
   * `changed` hears each change of the computer's settings or plugins the request asks for (`phoneChange`). */
  serve(req: IncomingMessage, res: ServerResponse, url: URL, changed?: (change: PhoneChange) => void): boolean;
  /** Takes over a WebSocket upgrade for /api/remote.mux; false when it is not one. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): boolean;
  close(): Promise<void>;
}
export interface DshRelayOptions {
  /** Read at sign-in time: DSH's port and launch token change on every launch. */
  upstream: () => DshUpstream;
  /** Generated modules the phone downloads: the companion's root key and each tool call's signed package. */
  ui?: Pick<UiModules, 'packagePath' | 'rootKey'>;
}

export const KEY_PARAM = 'dshm_key';

/** A change of the computer's DSH settings or plugins a phone asked for: the call and what it is about, never a value,
 * a key or a credential. */
export interface PhoneChange { method: string; target: string; label?: ChangeLabel }
/** How the computer names what a change was about, as DSH Desktop shows it: a plugin's own title (its locale files,
 * DSH's `meta.title`, one text per language), a model provider's display name, the default agent, or the setting's
 * field. Names only, never a value. */
export interface ChangeLabel { title?: string | Record<string, string>; provider?: string; field?: string; defaultAgent?: true }
const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 200) : '');
const onOff = (v: unknown) => (v === true ? 'on' : v === false ? 'off' : '');
const join = (...parts: string[]) => parts.filter(Boolean).join(' ');
/** The DSH calls that change the computer (DSH 0.2.2-rc.5: dsh-plugin-manager, dsh-api-settings-controller,
 * dsh-experimental-api-speech-to-text, credentials, account), each with what it names. */
const CHANGES: Record<string, (args: Record<string, any>) => string> = {
  'pluginManager/setBundleEnabled': a => join(str(a.name), onOff(a.enabled)),
  'pluginManager/setPluginEnabled': a => join(str(a.id), onOff(a.enabled)),
  'pluginManager/installBundle': a => str(a.options?.expected?.name) || 'bundle',
  'pluginManager/updateBundle': a => str(a.name),
  'pluginManager/removeBundle': a => str(a.name),
  'settings/mutate': a => join(str(a.ns), Array.isArray(a.ops) ? a.ops.map((o: any) => Array.isArray(o?.path) ? o.path.map(str).join('.') : '').filter(Boolean).slice(0, 8).join(', ') : ''),
  'speech/configure': a => Object.keys(a.patch ?? {}).slice(0, 8).join(', '),
  'speech/prepare': a => str(a.providerId),
  'speech/cancelPreparation': a => str(a.providerId),
  'credentials/set': a => str(a.ref),
  'credentials/unset': a => str(a.ref),
  'account/signOut': () => '',
};
const argsOf = (body: Buffer): Record<string, any> => {
  try { const a = JSON.parse(body.toString('utf8'))?.payload?.args; if (a && typeof a === 'object' && !Array.isArray(a)) return a; } catch { /* still a change */ }
  return {};
};
/** The change a relayed POST /api/<method> asks for, or undefined for a call that changes nothing on the computer. */
export function phoneChange(path: string, body: Buffer): PhoneChange | undefined {
  const method = path.slice('/api/'.length), summary = CHANGES[method];
  return summary ? { method, target: summary(argsOf(body)) } : undefined;
}

/** The companion's own bundle, as DSH's plugin manager names it. */
export const SELF_BUNDLE = '@jt-wang/dsh-anywhere';
/** A call that turns the companion off, removes it or replaces it: every phone loses its link while it runs. */
export const touchesSelf = (method: string, args: Record<string, any>) => args.name === SELF_BUNDLE
  && ((method === 'pluginManager/setBundleEnabled' && args.enabled === false) || method === 'pluginManager/removeBundle' || method === 'pluginManager/updateBundle');

type Call = (method: string, args: Record<string, unknown>) => Promise<unknown>;
interface ConfigurableProvider { provider?: unknown; displayName?: unknown; settingsNs?: unknown; settingsPath?: unknown }
/** DSH's own key name for a provider (the phone's provider-settings.ts deriveProviderKey). */
const keyOf = (provider: string) => `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
/** Names what a change was about with what DSH itself calls it (pluginManager/listBundles: dsh-plugin-manager,
 * llm/listConfigurableProviders: the phone's provider settings). Undefined when DSH has no name for it. */
export async function labelOf(method: string, args: Record<string, any>, call: Call): Promise<ChangeLabel | undefined> {
  if (method.startsWith('pluginManager/') && method !== 'pluginManager/setPluginEnabled') {
    const name = method === 'pluginManager/installBundle' ? args.options?.expected?.name : args.name;
    const bundles = await call('pluginManager/listBundles', {});
    const title = Array.isArray(bundles) ? bundles.find(b => b?.name === name)?.meta?.title : undefined;
    return typeof title === 'string' || (title && typeof title === 'object') ? { title } : undefined;
  }
  if (method === 'settings/mutate' && args.ns === 'agent-preset-registry') return { defaultAgent: true };
  if (method !== 'settings/mutate' && method !== 'credentials/set' && method !== 'credentials/unset') return undefined;
  const listed = await call('llm/listConfigurableProviders', {});
  const providers = (Array.isArray(listed) ? listed : []) as ConfigurableProvider[];
  const named = (p: ConfigurableProvider | undefined) => (typeof p?.displayName === 'string' && p.displayName ? p.displayName.slice(0, 80) : undefined);
  if (method !== 'settings/mutate') {
    const provider = named(providers.find(p => typeof p.provider === 'string' && keyOf(p.provider) === args.ref));
    return provider ? { provider } : undefined;
  }
  const path: string[] = Array.isArray(args.ops?.[0]?.path) ? args.ops[0].path.filter((k: unknown): k is string => typeof k === 'string') : [];
  const owner = providers.find(p => p.settingsNs === args.ns && Array.isArray(p.settingsPath) && p.settingsPath.length > 0
    && p.settingsPath.every((k, i) => path[i] === k));
  const field = (owner ? path[(owner.settingsPath as string[]).length] : path.at(-1))?.slice(0, 80);
  const provider = named(owner);
  return provider || field ? { ...provider ? { provider } : {}, ...field ? { field } : {} } : undefined;
}
const MUX_PATH = '/api/remote.mux';

export function createDshRelay(options: DshRelayOptions): DshRelay {
  let cookie: string | undefined;
  let signingIn: Promise<string> | undefined;

  /** GET the launch URL without following its redirect and keep the session cookie it sets. */
  function signIn(): Promise<string> {
    signingIn ??= new Promise<string>((resolve, reject) => {
      const req = httpRequest(options.upstream().loginUrl, { method: 'GET' }, res => {
        res.resume();
        const set = res.headers['set-cookie']?.[0];
        if (!set) { reject(new Error(`dsh sign-in returned ${res.statusCode} without a session cookie`)); return; }
        resolve(set.split(';', 1)[0]!);
      });
      req.on('error', reject); req.end();
    }).then(value => { cookie = value; return value; }).finally(() => { signingIn = undefined; });
    return signingIn;
  }
  const session = (): Promise<string> => (cookie ? Promise.resolve(cookie) : signIn());

  /** One call of DSH's protocol made by the companion itself, signed in as the relay is. */
  function call(method: string, args: Record<string, unknown>): Promise<unknown> {
    const send = (value: string, retry: boolean): Promise<unknown> => new Promise((resolve, reject) => {
      const target = new URL(options.upstream().origin);
      const body = Buffer.from(JSON.stringify({ type: 'client-request', rpcId: `companion-${Date.now()}`, method, payload: { args } }));
      const req = httpRequest({ host: target.hostname, port: target.port, path: `/api/${method}`, method: 'POST', timeout: 5000,
        headers: { host: target.host, cookie: value, 'content-type': 'application/json', 'content-length': String(body.length) } }, up => {
        if (up.statusCode === 401 && retry) { up.resume(); cookie = undefined; signIn().then(next => send(next, false)).then(resolve, reject); return; }
        const chunks: Buffer[] = [];
        up.on('data', chunk => chunks.push(chunk));
        up.on('end', () => {
          try { const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.result; if (result?.ok === true) resolve(result.value); else reject(new Error(String(result?.error?.code ?? up.statusCode))); }
          catch (error) { reject(error); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject); req.end(body);
    });
    return session().then(value => send(value, true));
  }

  function forward(req: IncomingMessage, res: ServerResponse, body: Buffer, path: string, retry: boolean, value: string, done?: (ok: boolean) => void) {
    const target = new URL(options.upstream().origin);
    const headers: Record<string, string> = { host: target.host, cookie: value };
    for (const name of ['content-type', 'accept', 'accept-encoding', 'x-file-name']) {
      const header = req.headers[name]; if (typeof header === 'string') headers[name] = header;
    }
    if (body.length) headers['content-length'] = String(body.length);
    const upstream = httpRequest({ host: target.hostname, port: target.port, path, method: req.method, headers }, up => {
      if (up.statusCode === 401 && retry) {
        up.resume(); cookie = undefined;
        signIn().then(next => forward(req, res, body, path, false, next, done), () => { res.writeHead(502); res.end(); done?.(false); });
        return;
      }
      const out: Record<string, string | string[]> = {};
      for (const [name, header] of Object.entries(up.headers)) if (header !== undefined && name !== 'set-cookie') out[name] = header;
      res.writeHead(up.statusCode ?? 502, out);
      // A change is kept only once DSH says it was made (its result.ok); the answer still streams to the phone.
      if (done) {
        const chunks: Buffer[] = [];
        up.on('data', chunk => chunks.push(chunk));
        up.on('end', () => {
          let ok = false;
          try { ok = (up.statusCode ?? 500) < 300 && JSON.parse(Buffer.concat(chunks).toString('utf8'))?.result?.ok === true; } catch { /* not DSH's answer */ }
          done(ok);
        });
      }
      up.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); done?.(false); });
    upstream.end(body);
  }

  function serveUi(url: URL, res: ServerResponse) {
    if (url.pathname === '/ui/root.pub') {
      options.ui!.rootKey().then(key => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(key); }, () => { res.writeHead(503); res.end(); });
      return;
    }
    const path = options.ui!.packagePath(url.searchParams.get('call') ?? '');
    if (!path) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    createReadStream(path).on('error', () => res.destroy()).pipe(res);
  }

  const wss = new WebSocketServer({ noServer: true });
  const upstreams = new Set<WebSocket>();
  return {
    serve(req, res, url, changed) {
      if (req.method === 'GET' && options.ui && (url.pathname === '/ui/root.pub' || url.pathname === '/ui/package')) { serveUi(url, res); return true; }
      if (!url.pathname.startsWith('/api/') || url.pathname === MUX_PATH) return false;
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const path = url.pathname + (url.search === '?' ? '' : url.search);
        const body = Buffer.concat(chunks);
        const change = req.method === 'POST' && changed ? phoneChange(url.pathname, body) : undefined;
        // Turning off, removing or updating the companion itself stops this process before DSH answers: keep the
        // change first, so DSH Desktop's page can say which phone did it once DSH Anywhere runs again.
        if (change && touchesSelf(change.method, argsOf(body))) {
          changed!({ ...change, label: { title: 'DSH Anywhere' } });
          session().then(value => forward(req, res, body, path, true, value), () => { res.writeHead(502); res.end(); });
          return;
        }
        const done = change && ((ok: boolean) => {
          if (!ok) return;
          labelOf(change.method, argsOf(body), call).catch(() => undefined)
            .then(label => changed!(label ? { ...change, label } : change));
        });
        session().then(value => forward(req, res, body, path, true, value, done), () => { res.writeHead(502); res.end(); });
      });
      return true;
    },
    upgrade(req, socket, head, url) {
      if (url.pathname !== MUX_PATH) return false;
      const refuse = (status: number) => { socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Bad Gateway'}\r\nConnection: close\r\n\r\n`); };
      const connect = (value: string, retry: boolean) => {
        const target = new URL(options.upstream().origin);
        const upstream = new WebSocket(`ws://${target.host}${MUX_PATH}`, { headers: { cookie: value } });
        upstreams.add(upstream); upstream.once('close', () => upstreams.delete(upstream));
        upstream.once('unexpected-response', (_request, response) => {
          response.resume();
          if (response.statusCode === 401 && retry) { cookie = undefined; signIn().then(next => connect(next, false), () => refuse(502)); }
          else refuse(response.statusCode === 401 ? 401 : 502);
        });
        upstream.once('error', () => { if (!socket.destroyed) refuse(502); });
        upstream.once('open', () => {
          wss.handleUpgrade(req, socket, head, client => {
            client.on('message', (data, binary) => { if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary }); });
            upstream.on('message', (data, binary) => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary }); });
            const closeCode = (code: number) => (code >= 1000 && code < 1005) || (code >= 3000 && code < 5000) ? code : 1011;
            client.on('close', (code, reason) => upstream.close(closeCode(code), reason));
            upstream.on('close', (code, reason) => client.close(closeCode(code), reason));
            client.on('error', () => upstream.terminate());
            upstream.on('error', () => client.terminate());
          });
        });
      };
      session().then(value => connect(value, true), () => refuse(502));
      return true;
    },
    async close() {
      for (const client of wss.clients) client.terminate();
      for (const upstream of upstreams) upstream.terminate();
      wss.close();
    },
  };
}

/** The credential a request carries, removed from the URL so it never reaches DSH. */
export function takeCredential(req: IncomingMessage, url: URL, allowQuery: boolean): string | undefined {
  const query = url.searchParams.get(KEY_PARAM); url.searchParams.delete(KEY_PARAM);
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  return allowQuery ? query ?? undefined : undefined;
}
