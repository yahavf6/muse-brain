// Imported first (see env.ts's own comment): sets BRAIN_DB/BRAIN_LOG_DIR to temp dirs before
// server.ts's module-level code (mkdirSync(LOG_DIR), openDb()) ever runs, so this file -- like
// brain.test.ts -- never touches real ~/.brain data. Every test below additionally uses its own
// mkdtempSync'd HOME, and the two HTTP end-to-end tests save/restore process.env.HOME around the
// request rather than leaving it pointed at a temp dir for the rest of the process.
import './env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { installStatus, install } from '../src/install.ts';
import type { InstallCtx } from '../src/install.ts';
import { httpServer } from '../src/server.ts';

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'brain-install-home-'));
}
function ctxFor(home: string): InstallCtx {
  return { baseUrl: 'http://127.0.0.1:4747', repoDir: '/test/repo', home };
}

function rawGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
function rawPost(port: number, path: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'content-type': 'application/json' } },
      (res) => {
        let respBody = '';
        res.on('data', (c) => { respBody += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: respBody }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('cursor: install creates mcp.json with the brain entry; a second run reports everything skipped, no backup', () => {
  const home = tempHome();
  const ctx = ctxFor(home);
  const first = install('cursor', ctx);
  assert.equal(first.changed.length, 1);
  assert.deepEqual(first.skipped, []);
  assert.deepEqual(first.backups, []);
  const configPath = join(home, '.cursor', 'mcp.json');
  const written = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(written.mcpServers.brain.url, 'http://127.0.0.1:4747/mcp?agent=cursor');

  const second = install('cursor', ctx);
  assert.deepEqual(second.changed, []);
  assert.deepEqual(second.backups, []);
  assert.equal(second.skipped.length, 1);
  rmSync(home, { recursive: true, force: true });
});

test('a 0600 config file keeps its mode after install; a new file is created 0600', () => {
  const home = tempHome();
  const ctx = ctxFor(home);
  const tomlPath = join(home, '.codex', 'config.toml');
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(tomlPath, 'model = "x"\n', { mode: 0o600 });
  install('codex', ctx);
  assert.equal(statSync(tomlPath).mode & 0o777, 0o600);
  install('cursor', ctx);
  assert.equal(statSync(join(home, '.cursor', 'mcp.json')).mode & 0o777, 0o600);
  rmSync(home, { recursive: true, force: true });
});

test('cursor: an existing mcp.json with another server keeps it and gets a backup', () => {
  const home = tempHome();
  const configPath = join(home, '.cursor', 'mcp.json');
  mkdirSync(join(home, '.cursor'), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ mcpServers: { otherServer: { url: 'http://example.com' } } }, null, 2));

  const result = install('cursor', ctxFor(home));
  assert.equal(result.changed.length, 1);
  assert.equal(result.backups.length, 1);
  assert.ok(result.backups[0].startsWith(`${configPath}.bak-brain-`));
  assert.ok(existsSync(result.backups[0]));
  const backedUp = JSON.parse(readFileSync(result.backups[0], 'utf8'));
  assert.deepEqual(backedUp, { mcpServers: { otherServer: { url: 'http://example.com' } } });

  const written = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(written.mcpServers.otherServer.url, 'http://example.com');
  assert.equal(written.mcpServers.brain.url, 'http://127.0.0.1:4747/mcp?agent=cursor');
  rmSync(home, { recursive: true, force: true });
});

test('cursor: an unparsable mcp.json -> errors, and the file is left byte-identical', () => {
  const home = tempHome();
  const configPath = join(home, '.cursor', 'mcp.json');
  mkdirSync(join(home, '.cursor'), { recursive: true });
  const badContent = '{ this is not json';
  writeFileSync(configPath, badContent);

  const result = install('cursor', ctxFor(home));
  assert.deepEqual(result.changed, []);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].path, configPath);
  assert.equal(readFileSync(configPath, 'utf8'), badContent);
  rmSync(home, { recursive: true, force: true });
});

test('codex: config.toml append is idempotent and preserves the existing text', () => {
  const home = tempHome();
  const configPath = join(home, '.codex', 'config.toml');
  mkdirSync(join(home, '.codex'), { recursive: true });
  const existing = '[some_other_section]\nkey = "value"\n';
  writeFileSync(configPath, existing);
  const ctx = ctxFor(home);

  install('codex', ctx);
  const afterFirst = readFileSync(configPath, 'utf8');
  assert.ok(afterFirst.startsWith(existing));
  assert.match(afterFirst, /\[mcp_servers\.brain]/);
  assert.match(afterFirst, /url = "http:\/\/127\.0\.0\.1:4747\/mcp\?agent=codex"/);

  const second = install('codex', ctx);
  assert.equal(readFileSync(configPath, 'utf8'), afterFirst);
  assert.ok(second.skipped.includes(configPath));
  assert.ok(!second.changed.includes(configPath));
  rmSync(home, { recursive: true, force: true });
});

test('claude-code: hooks merge keeps an existing foreign PreToolUse group first, adds exactly 5 brain groups, and is a no-op on rerun', () => {
  const home = tempHome();
  const settingsPath = join(home, '.claude', 'settings.json');
  mkdirSync(join(home, '.claude'), { recursive: true });
  const foreignGroup = { matcher: 'Foo', hooks: [{ type: 'command', command: 'bash some-other-hook.sh', timeout: 5 }] };
  writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: [foreignGroup] } }, null, 2));
  const ctx = ctxFor(home);

  install('claude-code', ctx);
  const afterFirst = readFileSync(settingsPath, 'utf8');
  const written = JSON.parse(afterFirst);
  assert.deepEqual(written.hooks.PreToolUse[0], foreignGroup);
  assert.equal(written.hooks.PreToolUse.length, 2);
  const brainGroupCount = (Object.values(written.hooks) as any[][])
    .flat()
    .filter((g: any) => g.hooks.some((h: any) => typeof h.command === 'string' && h.command.includes('brain-hook.sh')))
    .length;
  assert.equal(brainGroupCount, 5);

  const second = install('claude-code', ctx);
  assert.ok(second.skipped.includes(settingsPath));
  assert.ok(!second.changed.includes(settingsPath));
  assert.equal(readFileSync(settingsPath, 'utf8'), afterFirst);
  rmSync(home, { recursive: true, force: true });
});

test('claude-code: the skill symlink is created once', () => {
  const home = tempHome();
  const skillPath = join(home, '.claude', 'skills', 'brain');
  const ctx = ctxFor(home);

  const first = install('claude-code', ctx);
  assert.ok(first.changed.includes(skillPath));
  assert.ok(lstatSync(skillPath).isSymbolicLink());

  const second = install('claude-code', ctx);
  assert.ok(second.skipped.includes(skillPath));
  assert.ok(!second.changed.includes(skillPath));
  rmSync(home, { recursive: true, force: true });
});

test('installStatus: an empty home reports installed:false for every real client, true after install', () => {
  const home = tempHome();
  const ctx = ctxFor(home);
  const before = installStatus(ctx);
  const realBefore = before.clients.filter((c) => c.id !== 'other');
  assert.equal(realBefore.length, 5);
  for (const c of realBefore) assert.equal(c.installed, false);
  const other = before.clients.find((c) => c.id === 'other');
  assert.equal(other?.installed, null);
  assert.deepEqual(other?.files, []);

  for (const id of ['claude-code', 'codex', 'cursor', 'gemini', 'claude-desktop']) install(id, ctx);
  const after = installStatus(ctx);
  for (const c of after.clients.filter((c) => c.id !== 'other')) assert.equal(c.installed, true);
  rmSync(home, { recursive: true, force: true });
});

test('HTTP: GET /api/install and POST /api/install {client:cursor} work end to end with a temp HOME', async () => {
  const home = tempHome();
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  try {
    const port = (httpServer.address() as any).port;
    const status = await rawGet(port, '/api/install');
    assert.equal(status.status, 200);
    const statusBody = JSON.parse(status.body);
    assert.equal(statusBody.clients.find((c: any) => c.id === 'cursor').installed, false);

    const res = await rawPost(port, '/api/install', JSON.stringify({ client: 'cursor' }));
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.client, 'cursor');
    assert.equal(body.changed.length, 1);
    const written = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'));
    assert.ok(written.mcpServers.brain.url.includes('agent=cursor'));
  } finally {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('HTTP: POST /api/install with an unknown client -> 400', async () => {
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  try {
    const port = (httpServer.address() as any).port;
    const res = await rawPost(port, '/api/install', JSON.stringify({ client: 'not-a-real-client' }));
    assert.equal(res.status, 400);
    assert.ok('error' in JSON.parse(res.body));
  } finally {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
});
