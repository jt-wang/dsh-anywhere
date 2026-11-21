// A stand-in for DSH's web server: GET /?token= mints a host-bound session cookie, /api needs it, and
// /api/remote.mux echoes WebSocket messages. Synthetic values only.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';
import { WebSocketServer } from 'ws';

export const TOKEN = 'synthetic-launch-token', KEY = 'synthetic-device-key-0123456789abcdef';

export async function fakeDsh(t: TestContext) {
  const seen: { path: string; host?: string; cookie?: string; origin?: string; authorization?: string }[] = [];
  let logins = 0, session = 'session-1';
  /** Methods answered as DSH answers them ({ result: { ok, value } }); anything else is echoed. */
  const answers = new Map<string, (args: any) => unknown>();
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    seen.push({ path: url.pathname + url.search, host: req.headers.host, cookie: req.headers.cookie, origin: req.headers.origin, authorization: req.headers.authorization });
    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.get('token') === TOKEN) {
      logins++;
      res.writeHead(302, { location: './', 'set-cookie': `dshs_${req.headers.host}=${session}; Path=/; HttpOnly; SameSite=Strict` });
      return res.end();
    }
    if (!url.pathname.startsWith('/api/')) { res.writeHead(404); return res.end(); }
    if (req.headers.cookie !== `dshs_${req.headers.host}=${session}`) { res.writeHead(401); return res.end('unauthorized'); }
    let body = ''; req.setEncoding('utf8'); req.on('data', c => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body || 'null'), answer = answers.get(url.pathname.slice('/api/'.length));
      res.writeHead(200, { 'content-type': 'application/json' });
      if (!answer) return res.end(JSON.stringify({ echoed: parsed, path: url.pathname }));
      try { res.end(JSON.stringify({ type: 'server-response', rpcId: parsed?.rpcId, result: { ok: true, value: answer(parsed?.payload?.args) } })); }
      catch (error) { res.end(JSON.stringify({ type: 'server-response', rpcId: parsed?.rpcId, result: { ok: false, error: { code: String((error as Error).message), message: '' } } })); }
    });
  });
  server.on('upgrade', (req, socket, head) => {
    seen.push({ path: req.url ?? '', host: req.headers.host, cookie: req.headers.cookie });
    if (req.url !== '/api/remote.mux' || req.headers.cookie !== `dshs_${req.headers.host}=${session}`) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => ws.on('message', data => ws.send(`echo:${data}`)));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { for (const client of wss.clients) client.terminate(); wss.close(); server.closeAllConnections(); server.close(() => resolve()); }));
  const port = (server.address() as AddressInfo).port;
  return { origin: `http://127.0.0.1:${port}`, seen, answers, logins: () => logins, rotate: () => { session = 'session-2'; } };
}

