// Interactive terminal wizard: connects agent clients to the brain (reusing install.ts) and
// sets each agent's read/write/project policy via callVerb. `prompt`/`out` are injected so
// test/setup.test.ts can drive the whole flow headlessly, no real TTY or stdin required.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { installStatus, install, CLIENT_IDS } from './install.ts';
import type { InstallCtx } from './install.ts';
import { callVerb } from './verbs.ts';
import type { Who } from './verbs.ts';

const ADMIN: Who = { agent: 'setup', scope: 'admin' };
const DEFAULT_POLICY = { read: true, write: true, projects: null as string[] | null };

type Out = { write: (s: string) => void; isTTY?: boolean };
type Prompt = (question: string, def: string) => Promise<string>;

function line(out: Out, s = ''): void {
  out.write(`${s}\n`);
}

// ---- ASCII intro (gated: real TTY, not CI, colors on, first run only) ----

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const COLORS = { thought: '\x1b[34m', action: '\x1b[32m', rule: '\x1b[35m', conclusion: '\x1b[33m', gray: '\x1b[90m' };

// Each frame is its own array of lines; frames grow the graph one node at a time, landing on
// the wordmark. Redrawn in place (cursor-up + overwrite) by playIntro below.
const FRAMES: string[][] = [
  [`  ${COLORS.thought}•${RESET}`],
  [`  ${COLORS.thought}•${RESET}${COLORS.gray}──${RESET}${COLORS.action}■${RESET}`],
  [`  ${COLORS.thought}•${RESET}${COLORS.gray}──${RESET}${COLORS.action}■${RESET}${COLORS.gray}──${RESET}${COLORS.rule}⬡${RESET}`],
  [`  ${COLORS.thought}•${RESET}${COLORS.gray}──${RESET}${COLORS.action}■${RESET}${COLORS.gray}──${RESET}${COLORS.rule}⬡${RESET}${COLORS.gray}──${RESET}${COLORS.conclusion}▲${RESET}`],
  [
    `  ${COLORS.thought}•${RESET} ${COLORS.action}■${RESET} ${COLORS.rule}⬡${RESET} ${COLORS.conclusion}▲${RESET}`,
    `  ${BOLD}MUSE BRAIN${RESET}`,
  ],
];
const WORDMARK_LINE = `  ${COLORS.thought}•${RESET} ${COLORS.action}■${RESET} ${COLORS.rule}⬡${RESET} ${COLORS.conclusion}▲${RESET}  ${BOLD}MUSE BRAIN${RESET}`;

function introEligible(opts: { yes?: boolean; out: Out }): boolean {
  if (opts.yes) return false;
  if (!opts.out.isTTY) return false;
  if (process.env.CI) return false;
  if (process.env.NO_COLOR) return false;
  if (process.env.TERM === 'dumb') return false;
  const cols = process.stdout.columns;
  if (cols !== undefined && cols < 40) return false;
  return true;
}

async function playIntro(out: Out): Promise<void> {
  const markerDir = join(homedir(), '.brain');
  const markerPath = join(markerDir, '.intro-shown');
  if (existsSync(markerPath)) {
    line(out, WORDMARK_LINE);
    return;
  }
  let cursorHidden = false;
  const restoreCursor = () => {
    if (cursorHidden) { out.write('\x1b[?25h'); cursorHidden = false; }
  };
  // Must actually terminate the process (not just return) -- a bare SIGINT listener replaces
  // Node's default "exit on Ctrl-C" for the rest of the process, not just during the animation.
  const onSigint = () => { restoreCursor(); process.exit(130); };
  process.on('SIGINT', onSigint);
  process.on('exit', restoreCursor);
  try {
    out.write('\x1b[?25l');
    cursorHidden = true;
    let prevLines = 0;
    for (const frame of FRAMES) {
      if (prevLines > 0) out.write(`\x1b[${prevLines}A`);
      for (const l of frame) out.write(`${l}\x1b[K\n`);
      prevLines = frame.length;
      await new Promise((r) => setTimeout(r, 300));
    }
  } finally {
    restoreCursor();
  }
  try {
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(markerPath, '');
  } catch { /* best effort -- worst case the intro replays next run */ }
}

// ---- policy prompts ----

function parseProjects(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
}

async function promptAccess(prompt: Prompt, name: string): Promise<{ read: boolean; write: boolean }> {
  const ans = (await prompt(`${name}: access -- [RW] read+write, r = read-only, s = skip (no access)`, 'RW')).trim().toLowerCase();
  if (ans === 's') return { read: false, write: false };
  if (ans === 'r') return { read: true, write: false };
  return { read: true, write: true };
}

function sameProjects(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

async function maybeSetPolicy(prompt: Prompt, name: string, agent: string): Promise<void> {
  const { read, write } = await promptAccess(prompt, name);
  let projects: string[] | null = null;
  if (read || write) {
    const raw = await prompt(`${name}: projects -- Enter for all, or a comma-separated list`, '');
    projects = parseProjects(raw);
  }
  // Compare against the agent's ACTUAL current state (its policy row if one exists, else the
  // unrestricted default) -- not the hardcoded default alone. Otherwise choosing full access for
  // an agent that already has a restrictive row silently leaves that row in place.
  const { agents } = (await callVerb('agent_policies', {}, ADMIN)) as {
    agents: { agent: string; read: boolean; write: boolean; projects: string[] | null }[];
  };
  const current = agents.find((a) => a.agent === agent) ?? DEFAULT_POLICY;
  const unchanged = read === current.read && write === current.write && sameProjects(projects, current.projects);
  if (unchanged) return; // matches actual current state -- nothing to write
  await callVerb('set_agent_policy', { agent, read, write, projects }, ADMIN);
}

// ---- main flow ----

export async function runSetup(opts: { ctx: InstallCtx; prompt: Prompt; out: Out; yes?: boolean }): Promise<void> {
  const { ctx, out } = opts;
  // Gate on opts.yes alone: the CLI already folds "stdin isn't a TTY" into opts.yes before
  // calling runSetup (see main() below), so this is the one flag that decides whether the
  // injected prompt() is ever invoked -- tests rely on it never being called when yes is set.
  const skipPrompt = !!opts.yes;
  const ask: Prompt = skipPrompt ? async (_q, def) => def : opts.prompt;

  if (introEligible(opts)) await playIntro(out);

  // Step 1: is the server reachable?
  try {
    const res = await fetch(`${ctx.baseUrl}/api/version`, { signal: AbortSignal.timeout(1500) });
    let detail = '';
    try {
      const v = await res.json() as { nodes?: number; agents?: unknown[] };
      detail = ` (${v.nodes ?? '?'} nodes, ${v.agents?.length ?? '?'} agents seen)`;
    } catch { /* reachable but not JSON -- still report it reachable, just without counts */ }
    line(out, `Server: reachable at ${ctx.baseUrl}${detail}.`);
  } catch {
    line(out, `Server: not reachable at ${ctx.baseUrl} yet (start it with \`npm start\`). Continuing -- this wizard writes config files and can change access policy.`);
  }

  // Step 2: client status
  const status = installStatus(ctx);
  const real = status.clients.filter((c) => (CLIENT_IDS as readonly string[]).includes(c.id));
  line(out);
  for (const c of real) {
    const detected = c.detected ? 'found' : 'not found';
    const wired = c.installed === true ? 'already connected' : c.installed === 'partial' ? 'partially connected' : 'not connected';
    line(out, `${c.name}: ${detected}${c.detected ? `, ${wired}` : ''}`);
  }

  const found = real.filter((c) => c.detected === true);
  if (found.length === 0) {
    line(out);
    line(out, "No agents detected on this machine. See README.md's \"Connect an agent, by hand\" section to wire one up manually.");
    return;
  }

  const changedFiles: string[] = [];
  const backupFiles: string[] = [];

  const allWired = found.every((c) => c.installed === true);
  if (allWired) {
    const ans = (await ask(`Change access for these ${found.length} agent(s)? [y/N]`, 'N')).trim().toLowerCase();
    if (ans !== 'y') {
      line(out);
      line(out, `All ${found.length} detected agent(s) already connected. Nothing to do.`);
      return;
    }
    for (const c of found) install(c.id, ctx); // no-op re-install, idempotent by contract
    for (const c of found) await maybeSetPolicy(ask, c.name, c.agent);
  } else {
    const ans = (await ask(`Connect the ${found.length} found agent(s) with read + write on all projects? [Y/n]`, 'Y')).trim().toLowerCase();
    if (ans !== 'n') {
      for (const c of found) {
        const r = install(c.id, ctx);
        changedFiles.push(...r.changed);
        backupFiles.push(...r.backups);
        line(out, `${c.name}: ${r.changed.length} file(s) written${r.backups.length ? `, ${r.backups.length} backup(s)` : ''}.`);
      }
      printSummary(out, ctx, changedFiles, backupFiles);
      return;
    }
    for (const c of found) {
      if (c.installed !== true) {
        const r = install(c.id, ctx);
        changedFiles.push(...r.changed);
        backupFiles.push(...r.backups);
        line(out, `${c.name}: ${r.changed.length} file(s) written${r.backups.length ? `, ${r.backups.length} backup(s)` : ''}.`);
      }
      await maybeSetPolicy(ask, c.name, c.agent);
    }
  }

  printSummary(out, ctx, changedFiles, backupFiles);
}

function printSummary(out: Out, ctx: InstallCtx, changed: string[], backups: string[]): void {
  line(out);
  if (changed.length) {
    line(out, `Files changed: ${changed.join(', ')}`);
    if (backups.length) line(out, `Backups: ${backups.join(', ')}`);
    line(out, 'Start a new session in each connected agent for changes to take effect.');
  } else {
    line(out, 'No files changed.');
  }
  line(out, `See ${ctx.baseUrl}/ -- Connect agent panel -- to change access later.`);
}

// ---- CLI entry point ----

function buildCtx(): InstallCtx {
  const port = Number(process.env.BRAIN_PORT ?? 4747);
  const repoDir = join(new URL('.', import.meta.url).pathname, '..');
  return { baseUrl: `http://127.0.0.1:${port}`, repoDir, home: homedir() };
}

async function main(): Promise<void> {
  const yesFlag = process.argv.includes('--yes');
  // --yes or a piped/non-interactive stdin: never create a readline interface, so a bootstrap
  // script piping into this can't hang waiting for input that will never come.
  const interactive = !yesFlag && !!process.stdin.isTTY;
  const ctx = buildCtx();
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const prompt: Prompt = rl
    ? async (question, def) => {
        const ans = await rl.question(`${question} `);
        return ans.trim() === '' ? def : ans;
      }
    : async (_q, def) => def;
  try {
    await runSetup({ ctx, prompt, out: process.stdout, yes: yesFlag || !process.stdin.isTTY });
  } finally {
    rl?.close(); // release stdin so the process can exit naturally
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
