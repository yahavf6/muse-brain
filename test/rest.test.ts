// env.ts first: points BRAIN_DB/BRAIN_LOG_DIR/BRAIN_TOKENS_FILE at temp paths before any src import.
import './env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mintToken } from '../src/tokens.ts';
import { VERBS, callVerb, agentWho } from '../src/verbs.ts';
import { httpServer } from '../src/server.ts';

process.env.BRAIN_JEV = 'off'; // ask() must be deterministic: FTS5 ranking only, no Jev call.
const admin = { agent: 'ui', scope: 'admin' } as const;
let port = 0;
before(async () => {
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  port = (httpServer.address() as any).port;
});
after(() => new Promise<void>((resolve) => httpServer.close(() => resolve())));

async function withPublic<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.BRAIN_PUBLIC;
  if (on) process.env.BRAIN_PUBLIC = '1'; else delete process.env.BRAIN_PUBLIC;
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.BRAIN_PUBLIC; else process.env.BRAIN_PUBLIC = prev;
  }
}

function req(method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined }));
    });
    r.on('error', reject);
    r.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('rest: POST /api/v1/ask returns what callVerb returns, and policy/ui_only/bad args are refused', async () => {
  await callVerb('log', { kind: 'thought', title: 'Pricing page should lead with the yearly plan' }, admin);
  const { token } = mintToken('rest-bot');
  const auth = { authorization: `Bearer ${token}`, host: 'brain.example.com' }; // remote Host: public mode must not care
  await withPublic(true, async () => {
    const args = { question: 'yearly pricing plan' };
    const res = await req('POST', '/api/v1/ask', auth, args);
    assert.equal(res.status, 200);
    assert.ok(res.json.hits.length > 0, 'seeded node is found');
    assert.deepEqual(res.json, JSON.parse(JSON.stringify(await callVerb('ask', args, agentWho('rest-bot')))));

    const bad = await req('POST', '/api/v1/ask', auth, { question: '' });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /question/);

    // ui_only verbs have no REST route, even with a valid token.
    assert.equal((await req('POST', '/api/v1/delete_node', auth, { id: 1 })).status, 404);
    assert.equal((await req('POST', '/api/v1/agent_policies', auth, {})).status, 404);

    // agent_policy carries over: a read-only agent can ask but not log.
    await callVerb('set_agent_policy', { agent: 'rest-bot', read: true, write: false, projects: null }, admin);
    assert.equal((await req('POST', '/api/v1/ask', auth, args)).status, 200);
    const denied = await req('POST', '/api/v1/log', auth, { kind: 'thought', title: 'nope' });
    assert.equal(denied.status, 400);
    assert.match(denied.json.error, /no write access/);
  });
});

test('rest: no or invalid bearer -> 401 in public mode; without BRAIN_PUBLIC it is ?agent= like /mcp', async () => {
  await withPublic(true, async () => {
    const none = await req('POST', '/api/v1/ask', { host: 'brain.example.com' }, { question: 'x' });
    assert.equal(none.status, 401);
    assert.match(none.json.error, /bearer/);
    assert.equal((await req('POST', '/api/v1/ask', { host: 'brain.example.com', authorization: 'Bearer nope' }, { question: 'x' })).status, 401);
    assert.equal((await req('POST', '/api/v1/ask?agent=codex', { host: 'brain.example.com' }, { question: 'x' })).status, 401, '?agent= is ignored');
  });
  await withPublic(false, async () => {
    assert.equal((await req('POST', '/api/v1/ask?agent=codex', { host: `127.0.0.1:${port}` }, { question: 'x' })).status, 200);
    assert.equal((await req('POST', '/api/v1/ask', { host: 'brain.example.com' }, { question: 'x' })).status, 403, 'loopback Host check still applies');
  });
});

test('rest: /openapi.json has a path per non-ui_only verb and none for ui_only ones', async () => {
  const doc = (await req('GET', '/openapi.json', { host: `127.0.0.1:${port}` })).json;
  assert.match(doc.openapi, /^3\./);
  const expected = VERBS.filter((v) => !v.ui_only).map((v) => `/api/v1/${v.name}`);
  assert.deepEqual(Object.keys(doc.paths).sort(), expected.sort());
  assert.ok(doc.paths['/api/v1/ask'] && !doc.paths['/api/v1/delete_node']);
  const schema = doc.paths['/api/v1/ask'].post.requestBody.content['application/json'].schema;
  assert.deepEqual(schema.required, ['question'], 'defaulted limit stays optional');
  assert.equal(schema.$schema, undefined);

  // Public mode: /openapi.json is local-only (not a remote route); /api/v1/openapi.json is reachable remotely.
  await withPublic(true, async () => {
    assert.equal((await req('GET', '/openapi.json', { host: `127.0.0.1:${port}`, 'x-forwarded-for': '1.2.3.4' })).status, 403);
    const remote = await req('GET', '/api/v1/openapi.json', { host: 'brain.example.com' });
    assert.equal(remote.status, 200);
    assert.deepEqual(remote.json, doc);
  });
});
