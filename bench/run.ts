// Latency/throughput benchmark for the brain graph. Quiet on stdout except the final table;
// per-size progress goes to stderr. Jev is forced off (dynamic import after env is set, per
// test/env.ts's pattern) so numbers reflect the plain-FTS path, not a network round trip.
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const HOOK = join(REPO_ROOT, 'hooks', 'brain-hook.sh');

process.env.BRAIN_JEV = 'off';
delete process.env.TYPESAFE_API_KEY;
const scratch = mkdtempSync(join(tmpdir(), 'brain-bench-'));
process.env.BRAIN_DB = join(scratch, 'boot.db'); // never ~/.brain/brain.db

const { openDb } = await import('../src/db.ts');
const { setDb, getDb, callVerb } = await import('../src/verbs.ts');

const who = { agent: 'bench', scope: 'full' as const };
const SIZES = (process.env.BENCH_SIZES ?? '1000,10000,100000').split(',').map(Number);
const SAMPLES = 200;

const SUBJECTS = ['the pricing page', 'the onboarding flow', 'the auth guard', 'the billing sync job', 'the search ranker', 'the email queue', 'the webhook retry', 'the rate limiter', 'the cache layer', 'the session store', 'the export pipeline', 'the notification worker', 'the schema migration', 'the feature flag rollout', 'the dashboard widget'];
const PURPOSES = ['fewer signup drop-offs', 'lower p95 latency', 'fewer false denies', 'simpler on-call', 'cheaper compute', 'faster page loads', 'clearer error messages', 'less duplicate work', 'better test coverage', 'fewer support tickets'];
const REASONS = ['the old path was silently failing', 'load testing showed a bottleneck', 'users reported confusion', 'the metric regressed after the last deploy', 'a security review flagged it', 'the on-call runbook was too manual', 'the vendor changed their API', 'a race condition surfaced under load', 'the feature flag was stuck on', 'stakeholders asked for it directly'];
const SEARCH_WORDS = ['pricing', 'onboarding', 'auth', 'billing', 'search', 'email', 'webhook', 'cache', 'session', 'export'];
const ASK_QUERIES = ['why did we change the pricing page', 'what rules apply to billing sync', 'lessons from the search ranker', 'what failed with the email queue', 'history of the auth guard'];

// Varied templates (not one fixed opening word/closing phrase) so no single term sits on every
// row -- a fixed "Chose ... confirmed by evidence" on 100% of nodes would make jevLinkSuggestions'
// FTS candidate query (bm25 ORDER BY over OR'd terms) degenerate into a virtual-table scan
// regardless of corpus size, which would measure this benchmark's word list, not the product.
const TITLE_TPL = [
  (s: string, v: number, p: string, i: number) => `Chose ${s} approach v${v} for ${p} #${i}`,
  (s: string, v: number, p: string, i: number) => `Reworked ${s} to chase ${p}, variant ${v} #${i}`,
  (s: string, v: number, p: string, i: number) => `Shipped a fix to ${s} targeting ${p} (v${v}) #${i}`,
  (s: string, v: number, p: string, i: number) => `Replaced the old ${s} logic for ${p}, take ${v} #${i}`,
  (s: string, v: number, p: string, i: number) => `Rolled out ${s} changes aimed at ${p}, rev ${v} #${i}`,
];
const WHY_TPL = [
  (r: string, i: number) => `${r}, evidence in run #${i}.`,
  (r: string, i: number) => `${r}; see incident #${i} for details.`,
  (r: string, i: number) => `Root cause: ${r} (case #${i}).`,
  (r: string, i: number) => `${r}. Tracked under ticket #${i}.`,
  (r: string, i: number) => `Because ${r}, logged as #${i}.`,
];
function synth(i: number) {
  const s = SUBJECTS[i % SUBJECTS.length];
  const v = (i % 7) + 1;
  const p = PURPOSES[(i * 7) % PURPOSES.length];
  const r = REASONS[(i * 13) % REASONS.length];
  const title = TITLE_TPL[i % TITLE_TPL.length](s, v, p, i);
  const why = WHY_TPL[(i * 3) % WHY_TPL.length](r, i);
  return { title, why };
}

function pct(times: number[], p: number): number {
  const s = [...times].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}
const pick = (arr: number[]) => arr[Math.floor(Math.random() * arr.length)];
const fmt = (n: number) => n.toFixed(n < 10 ? 3 : 2);

async function buildGraph(size: number): Promise<{ times: number[]; allIds: number[]; totalSec: number }> {
  const thoughtIds: number[] = [];
  const actionIds: number[] = [];
  const allIds: number[] = [];
  const times: number[] = [];
  const tickEvery = Math.max(1, Math.floor(size / 20));
  const t0total = performance.now();
  for (let i = 0; i < size; i++) {
    const r = Math.random();
    const kind = r < 0.15 ? 'thought' : r < 0.75 ? 'action' : r < 0.8 ? 'rule' : 'conclusion';
    const { title, why } = synth(i);
    const args: Record<string, unknown> = { kind, title, why };
    if (kind === 'action') {
      const links: { type: string; to: number }[] = [];
      if (thoughtIds.length) links.push({ type: 'motivated_by', to: pick(thoughtIds) });
      if (actionIds.length && Math.random() < 0.5) links.push({ type: 'follows', to: pick(actionIds) });
      if (links.length) args.links = links;
    } else if (kind === 'conclusion') {
      args.verdict = ['good', 'bad', 'mixed'][i % 3];
      if (actionIds.length) args.links = [{ type: 'evaluates', to: pick(actionIds) }];
    }
    const t0 = performance.now();
    const res = (await callVerb('log', args, who)) as { id: number };
    times.push(performance.now() - t0);
    allIds.push(res.id);
    if (kind === 'thought') thoughtIds.push(res.id);
    if (kind === 'action') actionIds.push(res.id);
    if (i % tickEvery === 0) process.stderr.write(`\r  size=${size} log ${i}/${size}`);
  }
  process.stderr.write(`\r  size=${size} log ${size}/${size} done\n`);
  return { times, allIds, totalSec: (performance.now() - t0total) / 1000 };
}

async function timeCalls(n: number, fn: (i: number) => Promise<unknown>): Promise<number[]> {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn(i);
    times.push(performance.now() - t0);
  }
  return times;
}

// ---- hook overhead first (fast, DB-independent): 20 runs of the real hook against the live
// server (or its fallback). Printed immediately so it survives a kill during a slow size below.
let serverUp = false;
try {
  const res = await fetch('http://127.0.0.1:4747/api/version', { signal: AbortSignal.timeout(1000) });
  serverUp = res.ok;
} catch { /* down */ }

const fixture = JSON.stringify({ tool_name: 'mcp__gmail__send_message', tool_input: { body: 'Hello world' }, cwd: '/tmp', session_id: 'bench-hook' });
const hookTimes: number[] = [];
for (let i = 0; i < 20; i++) {
  const t0 = performance.now();
  execFileSync('bash', [HOOK, 'pre'], { input: fixture, env: { ...process.env, BRAIN_DB: join(scratch, 'no-such.db') }, stdio: ['pipe', 'pipe', 'pipe'] });
  hookTimes.push(performance.now() - t0);
}
process.stderr.write(`  hook overhead done (server ${serverUp ? 'up, contacted' : 'down, local fallback'})\n`);
console.log(`Hook overhead (\`bash hooks/brain-hook.sh pre\`, 20 runs, ${serverUp ? 'live server contacted' : 'server down, local regex fallback'}): p50 ${fmt(pct(hookTimes, 50))} ms, p95 ${fmt(pct(hookTimes, 95))} ms`);

// ---- table: header printed now, then one row per size, flushed as each size finishes -- so a
// kill partway through a slow size (e.g. 1,000,000) still leaves every completed row on disk.
const header = '**Machine:** Apple M4 Pro, 48 GB, macOS 26.6.2, Node 24.11.1, 2026-09-22';
const cols = ['Size', 'log p50', 'log p95', 'writes/s', 'ask p50', 'ask p95', 'search p50', 'context p50', 'get p50', 'DB MB', 'cold open ms'];
console.log(`\n${header}\n\n| ${cols.join(' | ')} |\n|${cols.map(() => '---').join('|')}|`);

for (const size of SIZES) {
  process.stderr.write(`--- size ${size} ---\n`);
  const dbPath = join(scratch, `bench-${size}.db`);
  setDb(openDb(dbPath));

  const { times: logTimes, allIds, totalSec } = await buildGraph(size);

  const askTimes = await timeCalls(SAMPLES, (i) => callVerb('ask', { question: ASK_QUERIES[i % ASK_QUERIES.length] }, who));
  const searchTimes = await timeCalls(SAMPLES, (i) => callVerb('search', { kind: 'action', query: SEARCH_WORDS[i % SEARCH_WORDS.length] }, who));
  const ctxTimes = await timeCalls(SAMPLES, () => callVerb('context', { id: pick(allIds), hops: 2 }, who));
  const getTimes = await timeCalls(SAMPLES, () => callVerb('get', { ids: [pick(allIds)] }, who));
  process.stderr.write(`  size=${size} ask/search/context/get done\n`);

  getDb().exec('PRAGMA wal_checkpoint(TRUNCATE);');
  const dbMb = statSync(dbPath).size / (1024 * 1024);
  getDb().close();

  const tCold0 = performance.now();
  const coldDb = new DatabaseSync(dbPath);
  coldDb.prepare('SELECT id FROM node WHERE id = ?').get(1);
  const coldMs = performance.now() - tCold0;
  coldDb.close();

  const wps = size / totalSec;
  console.log(
    `| ${size.toLocaleString()} | ${fmt(pct(logTimes, 50))} | ${fmt(pct(logTimes, 95))} | ${Math.round(wps)} | ${fmt(pct(askTimes, 50))} | ${fmt(pct(askTimes, 95))} | ${fmt(pct(searchTimes, 50))} | ${fmt(pct(ctxTimes, 50))} | ${fmt(pct(getTimes, 50))} | ${dbMb.toFixed(2)} | ${fmt(coldMs)} |`,
  );

  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (existsSync(f)) rmSync(f, { force: true });
}

rmSync(scratch, { recursive: true, force: true });
