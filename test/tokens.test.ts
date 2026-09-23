// env.ts first: points BRAIN_DB/BRAIN_LOG_DIR/BRAIN_TOKENS_FILE at temp paths before any src import.
import './env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintToken, verifyToken, revokeToken, listTokens, hashToken } from '../src/tokens.ts';
import { whoIs, AuthError, callVerb } from '../src/verbs.ts';

// Runs fn with BRAIN_TOKENS_FILE pointed at a fresh temp dir's tokens.json.
function withTokensFile(fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'brain-tokens-'));
  const prev = process.env.BRAIN_TOKENS_FILE;
  process.env.BRAIN_TOKENS_FILE = join(dir, 'tokens.json');
  try { fn(process.env.BRAIN_TOKENS_FILE); } finally {
    process.env.BRAIN_TOKENS_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
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

test('tokens: stored rows carry no scope; file is 0600 after every write, even if it was looser', () => {
  withTokensFile((path) => {
    writeFileSync(path, '{}\n');
    chmodSync(path, 0o644);
    const { hash } = mintToken('perm-bot');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, 'utf8'))[hash]).sort(), ['agent', 'created_at']);
    assert.deepEqual(readdirSync(join(path, '..')), ['tokens.json'], 'no temp file left behind');
  });
});

test('tokens: a malformed/truncated/non-object file -> verify null, list [], mint/revoke throw and leave it byte-identical', () => {
  for (const bad of ['{"abc": {"agent": "x"', '[]', 'null', '"str"', '']) {
    withTokensFile((path) => {
      writeFileSync(path, bad);
      assert.equal(verifyToken('anything'), null, bad);
      assert.deepEqual(listTokens(), []);
      assert.throws(() => mintToken('x'), /not a JSON object/, bad);
      assert.throws(() => revokeToken('abc'), /not a JSON object/, bad);
      assert.equal(readFileSync(path, 'utf8'), bad);
    });
  }
  withTokensFile(() => {
    assert.equal(verifyToken('anything'), null, 'missing file = no tokens');
    assert.deepEqual(listTokens(), []);
  });
});

test('tokens: listTokens tolerates null/non-object rows; verify ignores them', () => {
  withTokensFile((path) => {
    writeFileSync(path, JSON.stringify({ [hashToken('t1')]: null, [hashToken('t2')]: 5, [hashToken('t3')]: { agent: 'ok', created_at: 'x' } }));
    assert.deepEqual(listTokens().map((t) => t.agent), ['?', '?', 'ok']);
    assert.equal(verifyToken('t1'), null);
    assert.deepEqual(verifyToken('t3'), { agent: 'ok', scope: 'full' });
  });
});

test('whoIs: default (loopback) ignores Authorization entirely, uses ?agent=', () => {
  const { token } = mintToken('cloud');
  assert.deepEqual(whoIs({ url: '/mcp?agent=codex-x', headers: { authorization: `Bearer ${token}` } }), { agent: 'codex-x', scope: 'full' });
  assert.deepEqual(whoIs({ url: '/mcp?agent=codex-x', headers: { authorization: 'Bearer garbage' } }), { agent: 'codex-x', scope: 'full' });
});

test('whoIs { bearer: true } resolves the token agent (policy applied), else AuthError', async () => {
  const { token } = mintToken('cloud-scoped');
  await callVerb('set_agent_policy', { agent: 'cloud-scoped', read: true, write: false, projects: ['alpha'] }, { agent: 'ui', scope: 'admin' });
  const bearer = { bearer: true };
  assert.deepEqual(
    whoIs({ url: '/mcp?agent=admin', headers: { authorization: `bearer ${token}` } }, bearer),
    { agent: 'cloud-scoped', scope: 'full', read: true, write: false, projects: ['alpha'] },
  );
  assert.throws(() => whoIs({ url: '/mcp?agent=codex' }, bearer), AuthError);
  assert.throws(() => whoIs({ url: '/mcp', headers: { authorization: 'Bearer wrong' } }, bearer), AuthError);
  assert.throws(() => whoIs({ url: '/mcp', headers: { authorization: token } }, bearer), AuthError, 'scheme required');
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
    process.env.BRAIN_TOKENS_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
