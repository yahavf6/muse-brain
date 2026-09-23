// env.ts first: points BRAIN_DB/BRAIN_LOG_DIR/BRAIN_TOKENS_FILE at temp paths before any src import.
import { TEST_DB } from './env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Server } from 'node:http';
import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mintToken, revokeToken, hashToken } from '../src/tokens.ts';
import { VERBS, callVerb, getDb } from '../src/verbs.ts';
import { backupDaily } from '../src/db.ts';
import { httpServer, publicServer, publicPort } from '../src/server.ts';

process.env.BRAIN_JEV = 'off'; // ask() must be deterministic: FTS5 ranking only, no Jev call.
const admin = { agent: 'ui', scope: 'admin' } as const;
let loopPort = 0;
let pubPort = 0;
const listen = (s: Server) => new Promise<number>((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as any).port)));
const close = (s: Server) => new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); });
before(async () => { loopPort = await listen(httpServer); pubPort = await listen(publicServer); });
after(async () => { await close(httpServer); await close(publicServer); });

type Res = { status: number; text: string; headers: http.IncomingHttpHeaders; json: any };
// Raw http.request so paths go out byte-for-byte (no client-side normalization of ../ or //).
// `chunks` sends the body in pieces with a pause between them (a deliberately slow upload).
function request(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string, chunks?: { parts: string[]; delayMs: number }): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json: any;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode ?? 0, text, headers: res.headers, json });
      });
    });
    r.on('error', reject);
    r.setTimeout(5000, () => r.destroy(new Error(`${method} ${path} hung`))); // a hang fails loudly, never stalls the suite
    if (chunks) {
      (async () => {
        for (const [i, p] of chunks.parts.entries()) {
          if (i) await new Promise((w) => setTimeout(w, chunks.delayMs));
          r.write(p);
        }
        r.end();
      })();
    } else r.end(body);
  });
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

// One JSON-RPC message from an /mcp response, JSON or SSE framed.
function rpcMessage(res: Res): any {
  if (res.json) return res.json;
  const data = res.text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
  return data.at(-1);
}
function rpcBody(id: number, method: string, params: unknown = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

const LOCAL_ONLY: [string, string][] = [
  ['POST', '/api/call'], ['POST', '/api/token'], ['GET', '/'], ['GET', '/api/version'], ['GET', '/api/graph'],
  ['GET', '/api/needs'], ['GET', '/api/install'], ['POST', '/api/install'], ['POST', '/api/recall'], ['POST', '/api/pre'],
  ['GET', '/openapi.json'], ['GET', '/index.html'],
];

test('public: every local route 404s, even with a valid bearer, Host: localhost and/or X-Forwarded-For', async () => {
  const { id } = (await callVerb('log', { kind: 'thought', title: 'Canary node for the public route table' }, admin)) as { id: number };
  const { token } = mintToken('pub-routes');
  const variants: Record<string, string>[] = [
    {}, bearer(token), { host: 'localhost' }, { host: `127.0.0.1:${loopPort}`, ...bearer(token) },
    { 'x-forwarded-for': '1.2.3.4' }, { host: 'localhost', 'x-forwarded-for': '1.2.3.4', ...bearer(token) },
  ];
  const deleteBody = JSON.stringify({ verb: 'delete_node', args: { id } });
  for (const [method, path] of LOCAL_ONLY) {
    for (const h of variants) {
      const res = await request(pubPort, method, path, h, method === 'POST' ? deleteBody : undefined);
      assert.equal(res.status, 404, `${method} ${path} ${JSON.stringify(h)}`);
      assert.deepEqual(res.json, { error: 'not found' });
    }
  }
  // Path tricks: normalized, mis-cased or double-slashed paths never reach a local (or any) route.
  for (const path of ['/api/v1/../api/call', '/api/v1/%2e%2e/call', '/api/v1/%2E%2E/call', '//api/v1/ask', '/API/V1/ask', '/mcp/', '/mcp/../api/call', '/api/v1']) {
    const res = await request(pubPort, 'POST', path, { host: 'localhost', ...bearer(token) }, deleteBody);
    assert.equal(res.status, 404, path);
    assert.deepEqual(res.json, { error: 'not found' });
  }
  // GET on a verb path isn't a public route either.
  assert.equal((await request(pubPort, 'GET', '/api/v1/ask', bearer(token))).status, 404);
  // The canary survived all of the above: /api/call (admin) was never reached.
  assert.equal(((await callVerb('get', { ids: [id] }, admin)) as any).nodes.length, 1);
});

test('public: no/invalid/empty/Basic bearer -> 401 on /mcp and /api/v1/ask; ?agent= ignored; revoke is immediate', async () => {
  const bad: Record<string, string>[] = [{}, { authorization: 'Bearer nope' }, { authorization: 'Bearer ' }, { authorization: 'Bearer' }, { authorization: 'Basic dXNlcjpwYXNz' }];
  for (const h of bad) {
    for (const path of ['/mcp', '/mcp?agent=x', '/api/v1/ask', '/api/v1/ask?agent=x']) {
      const res = await request(pubPort, 'POST', path, h, path.startsWith('/mcp') ? rpcBody(1, 'tools/list') : JSON.stringify({ question: 'x' }));
      assert.equal(res.status, 401, `${path} ${JSON.stringify(h)}`);
      assert.equal(res.headers['www-authenticate'], 'Bearer');
    }
  }
  const { token, hash } = mintToken('pub-auth');
  assert.equal((await request(pubPort, 'POST', '/api/v1/ask?agent=someone-else', bearer(token), JSON.stringify({ question: 'x' }))).status, 200);
  const list = rpcMessage(await request(pubPort, 'POST', '/mcp', bearer(token), rpcBody(7, 'tools/list')));
  assert.equal(list.id, 7);
  assert.ok(list.result.tools.some((t: any) => t.name === 'log'));
  assert.ok(revokeToken(hash));
  assert.equal((await request(pubPort, 'POST', '/api/v1/ask', bearer(token), JSON.stringify({ question: 'x' }))).status, 401);
  assert.equal((await request(pubPort, 'POST', '/mcp', bearer(token), rpcBody(8, 'tools/list'))).status, 401);
});

test('public: GET /api/v1/openapi.json needs no auth and lists only non-ui_only verbs', async () => {
  const res = await request(pubPort, 'GET', '/api/v1/openapi.json');
  assert.equal(res.status, 200);
  const expected = VERBS.filter((v) => !v.ui_only).map((v) => `/api/v1/${v.name}`).sort();
  assert.deepEqual(Object.keys(res.json.paths).sort(), expected);
  for (const v of VERBS.filter((v) => v.ui_only)) assert.ok(!res.json.paths[`/api/v1/${v.name}`]);
  assert.deepEqual((await request(loopPort, 'GET', '/api/v1/openapi.json')).json, res.json, 'same doc on both listeners');
});

test('public: a malformed token file fails closed (401), never falls open', async () => {
  const { token } = mintToken('pub-malformed');
  const prev = process.env.BRAIN_TOKENS_FILE;
  const dir = mkdtempSync(join(tmpdir(), 'brain-bad-tokens-'));
  process.env.BRAIN_TOKENS_FILE = join(dir, 'tokens.json');
  try {
    writeFileSync(process.env.BRAIN_TOKENS_FILE, `{"${hashToken(token)}": {"agent": "pub-malformed"`);
    assert.equal((await request(pubPort, 'POST', '/api/v1/ask', bearer(token), JSON.stringify({ question: 'x' }))).status, 401);
  } finally {
    process.env.BRAIN_TOKENS_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal((await request(pubPort, 'POST', '/api/v1/ask', bearer(token), JSON.stringify({ question: 'x' }))).status, 200);
});

test('loopback is unchanged while the public listener runs: ?agent= identity, Host check, admin /api/call', async () => {
  const { token } = mintToken('loop-bearer');
  // ?agent= is the identity on loopback; a bearer header is ignored there.
  const ask = await request(loopPort, 'POST', '/api/v1/ask?agent=loop-agent', bearer(token), JSON.stringify({ question: 'x' }));
  assert.equal(ask.status, 200);
  const seen = (await request(loopPort, 'GET', '/api/version')).json.seen.map((s: any) => s.agent);
  assert.ok(seen.includes('loop-agent') && !seen.includes('loop-bearer'));
  assert.equal((await request(loopPort, 'POST', '/api/v1/ask', { host: 'brain.example.com' }, JSON.stringify({ question: 'x' }))).status, 403);
  assert.equal((await request(loopPort, 'GET', '/api/version', { host: 'evil.example.com' })).status, 403);
  assert.equal((await request(loopPort, 'GET', '/api/version', { origin: 'https://evil.example.com' })).status, 403);
  // /api/call is admin scope: a ui_only verb goes through.
  const pol = await request(loopPort, 'POST', '/api/call', {}, JSON.stringify({ verb: 'agent_policies', args: {} }));
  assert.equal(pol.status, 200);
  assert.ok(Array.isArray(pol.json.agents));
  // MCP over loopback: ?agent= works with no Authorization at all.
  const list = rpcMessage(await request(loopPort, 'POST', '/mcp?agent=loop-mcp', {}, rpcBody(3, 'tools/list')));
  assert.equal(list.id, 3);
  assert.ok(list.result.tools.length > 0);
  // /api/token and /openapi.json are gone.
  assert.equal((await request(loopPort, 'POST', '/api/token', {}, '{"action":"list"}')).status, 404);
  assert.equal((await request(loopPort, 'GET', '/openapi.json')).status, 404);
});

test('public: a read-only token gets no write tools over MCP and a policy error over REST', async () => {
  const { token } = mintToken('pub-ro');
  await callVerb('set_agent_policy', { agent: 'pub-ro', read: true, write: false, projects: null }, admin);
  const list = rpcMessage(await request(pubPort, 'POST', '/mcp', bearer(token), rpcBody(1, 'tools/list')));
  const names = list.result.tools.map((t: any) => t.name).sort();
  assert.deepEqual(names, VERBS.filter((v) => !v.ui_only && v.access === 'read').map((v) => v.name).sort());
  const call = rpcMessage(await request(pubPort, 'POST', '/mcp', bearer(token), rpcBody(2, 'tools/call', { name: 'log', arguments: { kind: 'thought', title: 'ro mcp write attempt' } })));
  assert.equal(call.id, 2);
  assert.ok(call.error || call.result?.isError, `refused: ${JSON.stringify(call)}`);
  const rest = await request(pubPort, 'POST', '/api/v1/log', bearer(token), JSON.stringify({ kind: 'thought', title: 'ro rest write attempt' }));
  assert.equal(rest.status, 400);
  assert.match(rest.json.error, /no write access/);
  const hits = (await callVerb('search', { query: 'write attempt' }, admin)) as any;
  assert.equal(hits.hits.length, 0, 'nothing was written');
});

test('public: concurrent /mcp calls from differently-scoped tokens each get their own answer (no cross-talk, no hang)', async () => {
  await callVerb('log', { kind: 'thought', title: 'Zebra crossing plan for alpha', project: 'alpha-cc' }, admin);
  await callVerb('log', { kind: 'thought', title: 'Zebra crossing plan for beta', project: 'beta-cc' }, admin);
  const a = mintToken('cc-alpha').token;
  const b = mintToken('cc-beta').token;
  await callVerb('set_agent_policy', { agent: 'cc-alpha', read: true, write: true, projects: ['alpha-cc'] }, admin);
  await callVerb('set_agent_policy', { agent: 'cc-beta', read: true, write: true, projects: ['beta-cc'] }, admin);
  const askBody = (id: number) => rpcBody(id, 'tools/call', { name: 'ask', arguments: { question: 'zebra crossing plan' } });

  const calls: { tok: string; project: string; id: number; slow: boolean }[] = [];
  for (let i = 0; i < 12; i++) calls.push({ tok: i % 2 ? b : a, project: i % 2 ? 'beta-cc' : 'alpha-cc', id: 100 + i, slow: i % 4 === 0 });
  const results = await Promise.all(calls.map((c) => {
    const body = askBody(c.id);
    // The slow ones trickle their body in: the old shared-McpServer code connected their transport,
    // then let the fast ones re-connect the same server before these finished.
    return request(pubPort, 'POST', '/mcp', bearer(c.tok), undefined, c.slow ? { parts: [body.slice(0, 20), body.slice(20)], delayMs: 150 } : { parts: [body], delayMs: 0 });
  }));
  results.forEach((res, i) => {
    const c = calls[i];
    assert.equal(res.status, 200, `call ${c.id}`);
    const msg = rpcMessage(res);
    assert.equal(msg.id, c.id, 'response carries its own request id');
    const payload = JSON.parse(msg.result.content[0].text);
    const projects = new Set(payload.hits.map((h: any) => h.project));
    assert.ok(projects.has(c.project), `call ${c.id} sees its own project`);
    assert.ok(![...projects].some((p) => p && p !== c.project), `call ${c.id} sees no other scoped project: ${[...projects]}`);
  });
});

test('/mcp: an oversized POST body is 413 on both listeners', async () => {
  const { token } = mintToken('pub-big');
  const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(1024 * 1024 + 10) } });
  assert.equal((await request(pubPort, 'POST', '/mcp', bearer(token), big)).status, 413);
  assert.equal((await request(loopPort, 'POST', '/mcp?agent=big', {}, big)).status, 413);
});

test('publicPort: unset/empty = off; junk or equal to BRAIN_PORT fails', () => {
  assert.equal(publicPort({}, 4747), null);
  assert.equal(publicPort({ BRAIN_PUBLIC_PORT: '' }, 4747), null);
  assert.equal(publicPort({ BRAIN_PUBLIC_PORT: '8080' }, 4747), 8080);
  for (const bad of ['abc', '0', '65536', '80a', ' 8080', '-1', '1e3']) assert.throws(() => publicPort({ BRAIN_PUBLIC_PORT: bad }, 4747), /BRAIN_PUBLIC_PORT/, bad);
  assert.throws(() => publicPort({ BRAIN_PUBLIC_PORT: '4747' }, 4747), /differ/);
});

test('backupDaily writes next to BRAIN_DB, not ~/.brain/backups', async () => {
  await backupDaily(getDb());
  assert.ok(existsSync(join(dirname(TEST_DB), 'backups', `brain-${new Date().toISOString().slice(0, 10)}.db`)));
});
