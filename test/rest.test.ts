// env.ts first: points BRAIN_DB/BRAIN_LOG_DIR/BRAIN_TOKENS_FILE at temp paths before any src import.
import './env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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

// Loopback listener, identity from ?agent= (the public listener's bearer path is test/public.test.ts).
test('rest: POST /api/v1/ask returns what callVerb returns, and policy/ui_only/bad args are refused', async () => {
  await callVerb('log', { kind: 'thought', title: 'Pricing page should lead with the yearly plan' }, admin);
  const args = { question: 'yearly pricing plan' };
  const res = await req('POST', '/api/v1/ask?agent=rest-bot', {}, args);
  assert.equal(res.status, 200);
  assert.ok(res.json.hits.length > 0, 'seeded node is found');
  assert.deepEqual(res.json, JSON.parse(JSON.stringify(await callVerb('ask', args, agentWho('rest-bot')))));

  const bad = await req('POST', '/api/v1/ask?agent=rest-bot', {}, { question: '' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /question/);

  // ui_only verbs have no REST route.
  assert.equal((await req('POST', '/api/v1/delete_node?agent=rest-bot', {}, { id: 1 })).status, 404);
  assert.equal((await req('POST', '/api/v1/agent_policies?agent=rest-bot', {}, {})).status, 404);

  // agent_policy carries over: a read-only agent can ask but not log.
  await callVerb('set_agent_policy', { agent: 'rest-bot', read: true, write: false, projects: null }, admin);
  assert.equal((await req('POST', '/api/v1/ask?agent=rest-bot', {}, args)).status, 200);
  const denied = await req('POST', '/api/v1/log?agent=rest-bot', {}, { kind: 'thought', title: 'nope' });
  assert.equal(denied.status, 400);
  assert.match(denied.json.error, /no write access/);
});

test('rest: loopback keeps the Host check', async () => {
  assert.equal((await req('POST', '/api/v1/ask?agent=codex', { host: `127.0.0.1:${port}` }, { question: 'x' })).status, 200);
  assert.equal((await req('POST', '/api/v1/ask', { host: 'brain.example.com' }, { question: 'x' })).status, 403);
});

test('rest: /api/v1/openapi.json has a path per non-ui_only verb and none for ui_only ones; /openapi.json is gone', async () => {
  const doc = (await req('GET', '/api/v1/openapi.json', { host: `127.0.0.1:${port}` })).json;
  assert.match(doc.openapi, /^3\./);
  const expected = VERBS.filter((v) => !v.ui_only).map((v) => `/api/v1/${v.name}`);
  assert.deepEqual(Object.keys(doc.paths).sort(), expected.sort());
  assert.ok(doc.paths['/api/v1/ask'] && !doc.paths['/api/v1/delete_node']);
  const schema = doc.paths['/api/v1/ask'].post.requestBody.content['application/json'].schema;
  assert.deepEqual(schema.required, ['question'], 'defaulted limit stays optional');
  assert.equal(schema.$schema, undefined);
  assert.equal((await req('GET', '/openapi.json', { host: `127.0.0.1:${port}` })).status, 404);
});

test('callVerb refuses ui_only verbs for scope full, allows them for admin', async () => {
  const { id } = (await callVerb('log', { kind: 'thought', title: 'ui_only refusal canary' }, admin)) as { id: number };
  const full = agentWho('some-agent');
  await assert.rejects(callVerb('delete_node', { id }, full), /UI-only/);
  await assert.rejects(callVerb('set_agent_policy', { agent: 'x', read: true, write: true, projects: null }, full), /UI-only/);
  await assert.rejects(callVerb('agent_policies', {}, full), /UI-only/);
  await assert.rejects(callVerb('delete_edge', { src: id, dst: id, type: 'supports' }, full), /UI-only/);
  assert.equal(((await callVerb('get', { ids: [id] }, admin)) as any).nodes.length, 1, 'not deleted');
  assert.ok(Array.isArray(((await callVerb('agent_policies', {}, admin)) as any).agents));
  assert.equal(((await callVerb('delete_node', { id }, admin)) as any).deleted, true);
});
