import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { openDb } from '../src/db.ts';
import { setDb, getDb, callVerb } from '../src/verbs.ts';
import type { Who } from '../src/verbs.ts';
import { judge } from '../src/judge.ts';
import { apiPre, apiVersion, httpServer } from '../src/server.ts';

const who: Who = { agent: 'test', scope: 'full' };
const GUARD_LOG = join(homedir(), '.brain', 'logs', 'guard.log');

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'brain-test-'));
  setDb(openDb(join(tmpDir, 'brain.db')));
});
afterEach(() => {
  try { getDb().close(); } catch { /* already closed */ }
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.BRAIN_JEV;
  delete process.env.BRAIN_JEV_GUARDS;
  delete process.env.BRAIN_GUARDS;
});

function guardLogLinesFor(sessionId: string): any[] {
  const lines = readFileSync(GUARD_LOG, 'utf8').split('\n').filter(Boolean);
  return lines.map((l) => JSON.parse(l)).filter((e) => e.session_id === sessionId);
}

// ---- data model / schema-backed constraints ----

test('enum rejection (status=bogus)', async () => {
  await assert.rejects(
    () => callVerb('log', { kind: 'thought', title: 'bad status', status: 'bogus' }, who),
    /status/,
  );
});

test('action without why is rejected', async () => {
  await assert.rejects(
    () => callVerb('log', { kind: 'action', title: 'no why' }, who),
    /why/,
  );
});

test('illegal edge endpoints: evaluates from a thought', async () => {
  const t = (await callVerb('log', { kind: 'thought', title: 'T', why: '' }, who)) as any;
  const a = (await callVerb('log', { kind: 'action', title: 'A', why: 'x' }, who)) as any;
  await assert.rejects(
    () => callVerb('link', { src: t.id, type: 'evaluates', dst: a.id }, who),
    /illegal edge endpoints/,
  );
});

test('a rule cannot be born approved', async () => {
  await assert.rejects(
    () => callVerb('log', { kind: 'rule', title: 'R', why: 'x', status: 'approved' }, who),
    /proposed/,
  );
});

test('approve_rule rejects a blank approved_by', async () => {
  const r = (await callVerb('log', { kind: 'rule', title: 'R2', why: 'x' }, who)) as any;
  await assert.rejects(
    () => callVerb('approve_rule', { id: r.id, approved_by: ' ' }, who),
    /approved_by/,
  );
});

test('complies_with to a proposed rule is rejected and the action is rolled back too', async () => {
  const r = (await callVerb('log', { kind: 'rule', title: 'Proposed rule', why: 'x' }, who)) as any;
  await assert.rejects(
    () => callVerb('log', { kind: 'action', title: 'Unique complies action', why: 'x', links: [{ type: 'complies_with', to: r.id }] }, who),
    /approved rule/,
  );
  const found = (await callVerb('search', { query: 'Unique complies action' }, who)) as any;
  assert.equal(found.hits.length, 0);
});

test('stale rev conflict', async () => {
  const t = (await callVerb('log', { kind: 'thought', title: 'Stale rev thought', why: '' }, who)) as any;
  await assert.rejects(
    () => callVerb('update', { id: t.id, rev: 99, title: 'x' }, who),
    /conflict/,
  );
});

test('same content twice returns the same id, created:false', async () => {
  const first = (await callVerb('log', { kind: 'thought', title: 'Dup thought', why: 'same' }, who)) as any;
  const second = (await callVerb('log', { kind: 'thought', title: 'Dup thought', why: 'same' }, who)) as any;
  assert.equal(second.id, first.id);
  assert.equal(second.created, false);
});

test('supersedes closes the old rule (valid_to set, status retired)', async () => {
  const r1 = (await callVerb('log', { kind: 'rule', title: 'Old rule', why: 'x' }, who)) as any;
  await callVerb('approve_rule', { id: r1.id, approved_by: 'Yahav' }, who);
  await callVerb('log', { kind: 'rule', title: 'New rule', why: 'y', links: [{ type: 'supersedes', to: r1.id }] }, who);
  const g = (await callVerb('get', { ids: [r1.id] }, who)) as any;
  assert.equal(g.nodes[0].status, 'retired');
  assert.notEqual(g.nodes[0].valid_to, null);
});

test('refutes flips the thought to refuted', async () => {
  const t = (await callVerb('log', { kind: 'thought', title: 'Refute me', why: '' }, who)) as any;
  await callVerb('log', { kind: 'conclusion', title: 'Bad outcome', why: 'x', verdict: 'bad', links: [{ type: 'refutes', to: t.id }] }, who);
  const g = (await callVerb('get', { ids: [t.id] }, who)) as any;
  assert.equal(g.nodes[0].status, 'refuted');
});

test('FTS stemming: "refund" finds a node whose why says "refunded"', async () => {
  await callVerb('log', { kind: 'action', title: 'Some action', why: 'We refunded the customer today.' }, who);
  const res = (await callVerb('search', { query: 'refund' }, who)) as any;
  assert.ok(res.hits.length >= 1);
});

test('context() shape', async () => {
  const t = (await callVerb('log', { kind: 'thought', title: 'CtxT', why: '' }, who)) as any;
  const a = (await callVerb('log', { kind: 'action', title: 'CtxA', why: 'x', links: [{ type: 'motivated_by', to: t.id }] }, who)) as any;
  const c = (await callVerb('log', { kind: 'conclusion', title: 'CtxC', why: 'x', verdict: 'good', links: [{ type: 'evaluates', to: a.id }, { type: 'supports', to: t.id }] }, who)) as any;
  const ctx = (await callVerb('context', { id: a.id, hops: 2 }, who)) as any;
  const ids = ctx.nodes.map((n: any) => n.id).sort((x: number, y: number) => x - y);
  assert.deepEqual(ids, [t.id, a.id, c.id].sort((x, y) => x - y));
  assert.equal(ctx.edges.length, 3);
  assert.ok(Array.isArray(ctx.footer));
});

test('invalid guard regex is rejected at log()', async () => {
  await assert.rejects(
    () => callVerb('log', { kind: 'rule', title: 'Bad guard', why: 'x', guard: { tool: '(' } }, who),
    /regex/,
  );
});

test('guard_frozen rejects changing a live guard', async () => {
  const r = (await callVerb('log', { kind: 'rule', title: 'Guarded rule', why: 'x', guard: { tool: 'send', judge: 'bad?' } }, who)) as any;
  await callVerb('approve_rule', { id: r.id, approved_by: 'Yahav' }, who);
  assert.throws(
    () => getDb().prepare('UPDATE node SET props = ? WHERE id = ?').run(JSON.stringify({ guard: { tool: 'other' } }), r.id),
    /guard_frozen/,
  );
});

test('node_file rows are written from files[]', async () => {
  const a = (await callVerb('log', { kind: 'action', title: 'Touched files', why: 'x', files: ['src/a.ts', 'src/b.ts'] }, who)) as any;
  const rows = getDb().prepare('SELECT path, node_id FROM node_file WHERE node_id = ? ORDER BY path').all(a.id) as any[];
  assert.deepEqual(rows.map((r) => r.path), ['src/a.ts', 'src/b.ts']);
});

test('footer: outcome gate appears for a 15-day-old action', async () => {
  const a = (await callVerb('log', { kind: 'action', title: 'Old undone action', why: 'x' }, who)) as any;
  getDb().prepare("UPDATE node SET created_at = datetime('now', '-15 days') WHERE id = ?").run(a.id);
  const res = (await callVerb('search', { kind: 'action' }, who)) as any;
  assert.ok(res.footer.some((l: string) => l.includes(`#${a.id}`) && l.toLowerCase().includes('outcome')));
});

test('ask() with Jev off returns plain FTS order and jev:false', async () => {
  await callVerb('log', { kind: 'thought', title: 'Pricing toggle causes churn', why: '' }, who);
  await callVerb('log', { kind: 'action', title: 'Unrelated action about servers', why: 'x' }, who);
  const res = (await callVerb('ask', { question: 'pricing toggle' }, who)) as any;
  assert.equal(res.jev, false);
  assert.ok(res.hits.length >= 1);
  assert.equal(res.hits[0].title, 'Pricing toggle causes churn');
});

// ---- Jev (judge()) ----

test('judge returns null on timeout', async (t) => {
  process.env.TYPESAFE_API_KEY = 'k';
  t.mock.method(globalThis, 'fetch', async () => {
    throw new DOMException('The operation timed out.', 'TimeoutError');
  });
  const result = await judge({ q: 1 }, { a: { type: 'noul', instructions: 'x' } }, 10);
  assert.equal(result, null);
});

test('judge returns null on 401', async (t) => {
  process.env.TYPESAFE_API_KEY = 'k';
  t.mock.method(globalThis, 'fetch', async () => new Response('unauthorized', { status: 401 }));
  const result = await judge({}, {}, 1000);
  assert.equal(result, null);
});

test('judge returns null on 529', async (t) => {
  process.env.TYPESAFE_API_KEY = 'k';
  t.mock.method(globalThis, 'fetch', async () => new Response('overloaded', { status: 529 }));
  const result = await judge({}, {}, 1000);
  assert.equal(result, null);
});

test('judge returns null when TYPESAFE_API_KEY is missing, and never calls fetch', async (t) => {
  delete process.env.TYPESAFE_API_KEY;
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 }));
  const result = await judge({}, {}, 1000);
  assert.equal(result, null);
  assert.equal((globalThis.fetch as any).mock.callCount(), 0);
});

// ---- /api/pre guard bands ----

async function makeApprovedGuardRule(judgeQuestion: string): Promise<number> {
  const r = (await callVerb('log', { kind: 'rule', title: `Guard rule ${Math.random()}`, why: 'x', guard: { tool: 'send', judge: judgeQuestion } }, who)) as any;
  await callVerb('approve_rule', { id: r.id, approved_by: 'Yahav' }, who);
  return r.id;
}

test('/api/pre band: noul 0.9 -> deny', async (t) => {
  process.env.TYPESAFE_API_KEY = 'k';
  process.env.BRAIN_JEV_GUARDS = 'on';
  await makeApprovedGuardRule('does this violate the rule?');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ r1: { type: 'noul', noul: 0.9 } }), { status: 200 }));
  const result = await apiPre({ tool_name: 'send-message', tool_input: { text: 'x' }, session_id: `s-${Math.random()}` });
  assert.equal(result.decision, 'deny');
});

test('/api/pre band: noul 0.7 -> ask', async (t) => {
  process.env.TYPESAFE_API_KEY = 'k';
  process.env.BRAIN_JEV_GUARDS = 'on';
  await makeApprovedGuardRule('does this violate the rule?');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ r1: { type: 'noul', noul: 0.7 } }), { status: 200 }));
  const result = await apiPre({ tool_name: 'send-message', tool_input: { text: 'x' }, session_id: `s-${Math.random()}` });
  assert.equal(result.decision, 'ask');
});

test('/api/pre band: noul 0.2 -> allow', async (t) => {
  process.env.TYPESAFE_API_KEY = 'k';
  process.env.BRAIN_JEV_GUARDS = 'on';
  await makeApprovedGuardRule('does this violate the rule?');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ r1: { type: 'noul', noul: 0.2 } }), { status: 200 }));
  const result = await apiPre({ tool_name: 'send-message', tool_input: { text: 'x' }, session_id: `s-${Math.random()}` });
  assert.equal(result.decision, 'allow');
});

test('/api/pre shadow mode: high noul still allows, and logs a would_deny line', async (t) => {
  process.env.TYPESAFE_API_KEY = 'k';
  // BRAIN_JEV_GUARDS left unset -> defaults to shadow
  await makeApprovedGuardRule('does this violate the rule?');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ r1: { type: 'noul', noul: 0.95 } }), { status: 200 }));
  const sessionId = `shadow-${Date.now()}-${Math.random()}`;
  const result = await apiPre({ tool_name: 'send-message', tool_input: { text: 'x' }, session_id: sessionId });
  assert.equal(result.decision, 'allow');
  const mine = guardLogLinesFor(sessionId);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].decision, 'would_deny');
  assert.equal(mine[0].mode, 'semantic');
});

// ---- HTTP: host/origin guard ----

function rawGet(port: number, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/version', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('HTTP: bad Host header -> 403, loopback -> 200', async () => {
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  try {
    const port = (httpServer.address() as any).port;
    const bad = await rawGet(port, { Host: 'evil.com' });
    assert.equal(bad.status, 403);
    const good = await rawGet(port, { Host: `127.0.0.1:${port}` });
    assert.equal(good.status, 200);
    const parsed = JSON.parse(good.body);
    assert.ok('version' in parsed);
    assert.deepEqual(parsed, apiVersion());
  } finally {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
});
