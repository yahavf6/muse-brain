// Imported first (see env.ts's own comment): sets BRAIN_DB/BRAIN_LOG_DIR to temp dirs before
// verbs.ts's module-level openDb() ever runs, so this file never touches real ~/.brain data.
import './env.ts';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSetup } from '../src/setup.ts';
import { callVerb, setDb, getDb } from '../src/verbs.ts';
import { openDb } from '../src/db.ts';
import type { InstallCtx } from '../src/install.ts';
import type { Who } from '../src/verbs.ts';

const admin: Who = { agent: 'ui', scope: 'admin' };

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'brain-setup-home-'));
}
function ctxFor(home: string): InstallCtx {
  return { baseUrl: 'http://127.0.0.1:4747', repoDir: '/test/repo', home };
}
const out = { write: () => {}, isTTY: false };

// Scripted prompt: consumes canned answers in order, throws if it runs out (catches a test
// under-scripting its questions rather than silently returning undefined).
function scriptedPrompt(answers: string[]): (q: string, def: string) => Promise<string> {
  let i = 0;
  return async (_q: string, def: string) => {
    if (i >= answers.length) throw new Error(`scriptedPrompt: no answer left for question ${i + 1}`);
    const a = answers[i++];
    return a === '' ? def : a;
  };
}
function allDefaults(): (q: string, def: string) => Promise<string> {
  return async (_q: string, def: string) => def;
}

let dbDir: string;
let home: string;
beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'brain-setup-db-'));
  setDb(openDb(join(dbDir, 'brain.db')));
  home = tempHome();
});
afterEach(() => {
  try { getDb().close(); } catch { /* already closed */ }
  rmSync(dbDir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test('default-path run: Enter through everything connects detected clients and writes no policy rows', async () => {
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.cursor'), { recursive: true });
  const ctx = ctxFor(home);

  await runSetup({ ctx, prompt: allDefaults(), out });

  assert.ok(existsSync(join(home, '.claude.json')));
  assert.ok(existsSync(join(home, '.cursor', 'mcp.json')));

  const r = (await callVerb('agent_policies', {}, admin)) as { agents: { agent: string }[] };
  assert.equal(r.agents.find((a) => a.agent === 'claude-code'), undefined);
  assert.equal(r.agents.find((a) => a.agent === 'cursor'), undefined);
});

test('custom-answer run: decline connect-all, set one client read-only with a project list', async () => {
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.cursor'), { recursive: true });
  const ctx = ctxFor(home);

  // Order: [connect-all? -> n], then per found client (claude-code, cursor):
  // access, projects. claude-code takes defaults (RW, all); cursor goes read-only with a,b.
  const prompt = scriptedPrompt(['n', '', '', 'r', 'a,b']);
  await runSetup({ ctx, prompt, out });

  const r = (await callVerb('agent_policies', {}, admin)) as { agents: { agent: string; read: boolean; write: boolean; projects: string[] | null; last_write: string | null }[] };
  assert.equal(r.agents.find((a) => a.agent === 'claude-code'), undefined);
  const cursor = r.agents.find((a) => a.agent === 'cursor');
  assert.deepEqual(cursor, { agent: 'cursor', read: true, write: false, projects: ['a', 'b'], last_write: null });
});

test('yes:true never calls the injected prompt, and no throw escapes runSetup', async () => {
  mkdirSync(join(home, '.claude'), { recursive: true });
  const ctx = ctxFor(home);
  const throwingPrompt = async (): Promise<string> => { throw new Error('prompt should never be called under yes:true'); };

  await runSetup({ ctx, prompt: throwingPrompt, out, yes: true });
  assert.ok(existsSync(join(home, '.claude.json')));
});

test('re-run choosing RW/all-projects defaults clears an existing read-only restriction', async () => {
  mkdirSync(join(home, '.claude'), { recursive: true });
  const ctx = ctxFor(home);
  type PolicyRow = { agent: string; read: boolean; write: boolean; projects: string[] | null; last_write: string | null };

  // First run: decline connect-all, set claude-code read-only (repro setup for the bug).
  await runSetup({ ctx, prompt: scriptedPrompt(['n', 'r', '']), out });
  const before = (await callVerb('agent_policies', {}, admin)) as { agents: PolicyRow[] };
  assert.deepEqual(before.agents.find((a) => a.agent === 'claude-code'), { agent: 'claude-code', read: true, write: false, projects: null, last_write: null });

  // Second run: already fully connected -> "change access?" y, then RW/all-projects defaults.
  await runSetup({ ctx, prompt: scriptedPrompt(['y', '', '']), out });

  const after = (await callVerb('agent_policies', {}, admin)) as { agents: PolicyRow[] };
  const claudeCode = after.agents.find((a) => a.agent === 'claude-code');
  const unrestricted = claudeCode === undefined || (claudeCode.read === true && claudeCode.write === true && claudeCode.projects === null);
  assert.ok(unrestricted, `expected claude-code to be unrestricted, got ${JSON.stringify(claudeCode)}`);
});

test('already-fully-connected re-run: declining "change access?" leaves policy untouched', async () => {
  mkdirSync(join(home, '.claude'), { recursive: true });
  const ctx = ctxFor(home);
  await runSetup({ ctx, prompt: allDefaults(), out }); // first run connects claude-code

  const prompt = scriptedPrompt(['n']); // "Change access for these 1 agent(s)? [y/N]" -> n
  await runSetup({ ctx, prompt, out });

  const r = (await callVerb('agent_policies', {}, admin)) as { agents: { agent: string }[] };
  assert.equal(r.agents.find((a) => a.agent === 'claude-code'), undefined);
});
