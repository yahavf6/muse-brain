// env.ts first: points BRAIN_DB/BRAIN_LOG_DIR/BRAIN_TOKENS_FILE at temp paths before any src import.
import './env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintToken, verifyToken, revokeToken, listTokens, hashToken } from '../src/tokens.ts';
import { whoIs, AuthError, callVerb } from '../src/verbs.ts';
import { httpServer } from '../src/server.ts';

function withPublic<T>(on: boolean, fn: () => T): T {
  const prev = process.env.BRAIN_PUBLIC;
  if (on) process.env.BRAIN_PUBLIC = '1'; else delete process.env.BRAIN_PUBLIC;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.BRAIN_PUBLIC; else process.env.BRAIN_PUBLIC = prev;
  }
}

test('tokens: mint -> verify -> list (no raw token) -> revoke', () => {
  const { token, hash } = mintToken('grok-bot');
  assert.equal(hash, hashToken(token));
  assert.deepEqual(verifyToken(token), { agent: 'grok-bot', scope: 'full' });
  assert.equal(verifyToken('nope'), null);
  assert.equal(verifyToken(hash), null, 'the stored hash is not itself a valid token');
  const listed = listTokens().find((t) => t.hash === hash);
  assert.equal(listed?.agent, 'grok-bot');
  assert.ok(!JSON.stringify(listTokens()).includes(token));
  assert.equal(revokeToken(hash), true);
  assert.equal(revokeToken(hash), false);
  assert.equal(verifyToken(token), null);
});

test('whoIs: BRAIN_PUBLIC unset ignores Authorization entirely, uses ?agent=', () => {
  const { token } = mintToken('cloud');
  withPublic(false, () => {
    assert.deepEqual(whoIs({ url: '/mcp?agent=codex-x', headers: { authorization: `Bearer ${token}` } }), { agent: 'codex-x', scope: 'full' });
    assert.deepEqual(whoIs({ url: '/mcp?agent=codex-x', headers: { authorization: 'Bearer garbage' } }), { agent: 'codex-x', scope: 'full' });
  });
});

test('whoIs: BRAIN_PUBLIC set resolves the token agent (policy applied), else AuthError', async () => {
  const { token } = mintToken('cloud-scoped');
  await callVerb('set_agent_policy', { agent: 'cloud-scoped', read: true, write: false, projects: ['alpha'] }, { agent: 'ui', scope: 'admin' });
  withPublic(true, () => {
    assert.deepEqual(
      whoIs({ url: '/mcp?agent=admin', headers: { authorization: `bearer ${token}` } }),
      { agent: 'cloud-scoped', scope: 'full', read: true, write: false, projects: ['alpha'] },
    );
    assert.throws(() => whoIs({ url: '/mcp?agent=codex' }), AuthError);
    assert.throws(() => whoIs({ url: '/mcp', headers: { authorization: 'Bearer wrong' } }), AuthError);
    assert.throws(() => whoIs({ url: '/mcp', headers: { authorization: token } }), AuthError, 'scheme required');
  });
});

function post(port: number, path: string, body: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('http: public mode -- /mcp needs a bearer (401) and skips Host; /api/call keeps the Host check', async () => {
  const { token } = mintToken('cloud-http');
  const prev = process.env.BRAIN_PUBLIC;
  process.env.BRAIN_PUBLIC = '1';
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  try {
    const port = (httpServer.address() as any).port;
    const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    assert.equal(await post(port, '/mcp', init, { Host: 'brain.example.com' }), 401);
    assert.equal(await post(port, '/mcp', init, { Host: 'brain.example.com', authorization: `Bearer ${token}` }), 200);
    assert.equal(await post(port, '/api/call', '{}', { Host: 'brain.example.com', authorization: `Bearer ${token}` }), 403);
    assert.equal(await post(port, '/api/token', '{"action":"list"}', { Host: `127.0.0.1:${port}`, 'x-forwarded-for': '1.2.3.4' }), 403);
    assert.equal(await post(port, '/api/token', '{"action":"list"}', { Host: `127.0.0.1:${port}` }), 200);
  } finally {
    if (prev === undefined) delete process.env.BRAIN_PUBLIC; else process.env.BRAIN_PUBLIC = prev;
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
});

test('token CLI: mint prints a token that verifies against BRAIN_TOKENS_FILE', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-token-cli-'));
  const tokensFile = join(dir, 'tokens.json');
  const script = new URL('../scripts/token.ts', import.meta.url).pathname;
  const prev = process.env.BRAIN_TOKENS_FILE;
  try {
    const out = execFileSync(process.execPath, ['--no-warnings=ExperimentalWarning', script, 'mint', 'cli-test'], {
      encoding: 'utf8',
      env: { ...process.env, BRAIN_TOKENS_FILE: tokensFile, BRAIN_DB: join(dir, 'brain.db') },
    });
    const token = /^token: ([0-9a-f]{64})$/m.exec(out)?.[1];
    assert.ok(token, 'mint prints the raw token');
    process.env.BRAIN_TOKENS_FILE = tokensFile;
    assert.deepEqual(verifyToken(token), { agent: 'cli-test', scope: 'full' });
    assert.ok(out.includes(hashToken(token)), 'mint prints the hash too');
  } finally {
    if (prev === undefined) delete process.env.BRAIN_TOKENS_FILE; else process.env.BRAIN_TOKENS_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
