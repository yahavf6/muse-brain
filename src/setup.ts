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
//
// Three-tier fallback by terminal width, widest first: BIG (gradient wordmark + long graph
// build-up, needs WORDMARK_WIDTH+2 cols) -> SMALL (today's original one-liner, needs 40 cols) ->
// plain static line (any TTY at all). Every existing gate below is unchanged; this only adds a
// size branch to what was already a graceful-degradation ladder.

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const COLORS = { thought: '\x1b[34m', action: '\x1b[32m', rule: '\x1b[35m', conclusion: '\x1b[33m', gray: '\x1b[90m' };
// Same hex values as DESIGN.md's kind palette (thought/action/rule/conclusion), used both for
// the small intro's named ANSI-16 codes above and the big intro's truecolor gradient below.
const PALETTE_HEX: [number, number, number][] = [
  [0x39, 0x87, 0xe5], // thought
  [0x00, 0x83, 0x00], // action
  [0xd5, 0x51, 0x81], // rule
  [0xc9, 0x85, 0x00], // conclusion
];

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

// "MUSE BRAIN" in figlet's `big` font -- generated once at authoring time (figlet itself is
// never a runtime dependency, this is just the baked-in string result), trailing blank lines
// trimmed, every line padded to the same width so the gradient sweep below lines up column-for-column.
const WORDMARK_ART: string[] = [
  ' __  __ _    _  _____ ______   ____  _____            _____ _   _ ',
  '|  \\/  | |  | |/ ____|  ____| |  _ \\|  __ \\     /\\   |_   _| \\ | |',
  '| \\  / | |  | | (___ | |__    | |_) | |__) |   /  \\    | | |  \\| |',
  '| |\\/| | |  | |\\___ \\|  __|   |  _ <|  _  /   / /\\ \\   | | | . ` |',
  '| |  | | |__| |____) | |____  | |_) | | \\ \\  / ____ \\ _| |_| |\\  |',
  '|_|  |_|\\____/|_____/|______| |____/|_|  \\_\\/_/    \\_\\_____|_| \\_|',
];
const WORDMARK_WIDTH = 68; // widest line (66) + 2-col margin

// Nodes the big intro's graph build-up walks through, one per frame, before the wordmark.
const BIG_GRAPH_NODES: { kind: keyof typeof COLORS; glyph: string }[] = [
  { kind: 'thought', glyph: '•' },
  { kind: 'action', glyph: '■' },
  { kind: 'rule', glyph: '⬡' },
  { kind: 'conclusion', glyph: '▲' },
  { kind: 'thought', glyph: '•' },
  { kind: 'action', glyph: '■' },
  { kind: 'rule', glyph: '⬡' },
];
const EDGE_HOT = '\x1b[97m'; // DESIGN.md's edge-hot: brighter than resting COLORS.gray, only on the newest edge

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}
// Interpolates across all 4 palette stops for t in [0,1], wrapping the stop list as a cycle
// (0/4, 1/4, 2/4, 3/4, back to 0) so a wide wordmark gets a full sweep, not just the first two colors.
function gradientRgb(t: number): [number, number, number] {
  const n = PALETTE_HEX.length;
  const pos = ((t % 1) + 1) % 1 * n;
  const i = Math.floor(pos) % n;
  const j = (i + 1) % n;
  const f = pos - Math.floor(pos);
  const [r1, g1, b1] = PALETTE_HEX[i];
  const [r2, g2, b2] = PALETTE_HEX[j];
  return [lerp(r1, r2, f), lerp(g1, g2, f), lerp(b1, b2, f)];
}
function hasTrueColor(): boolean {
  return process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit';
}
// Renders one WORDMARK_ART line with a left-to-right color sweep: truecolor gets a smooth
// per-character RGB gradient (\x1b[38;2;R;G;Bm), anything else gets banded into 4 stripes using
// the same named ANSI-16 codes the small intro already uses -- still colorful, no capability
// crash on an old terminal.
function renderGradientLine(text: string, lineWidth: number, useTrueColor: boolean): string {
  if (!useTrueColor) {
    const bandColors = [COLORS.thought, COLORS.action, COLORS.rule, COLORS.conclusion];
    const bandWidth = Math.ceil(lineWidth / bandColors.length);
    let out = '';
    for (let i = 0; i < text.length; i++) {
      if (i % bandWidth === 0) out += bandColors[Math.min(Math.floor(i / bandWidth), bandColors.length - 1)];
      out += text[i];
    }
    return out + RESET;
  }
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const [r, g, b] = gradientRgb(i / lineWidth);
    out += `\x1b[38;2;${r};${g};${b}m${text[i]}`;
  }
  return out + RESET;
}

type IntroTier = 'big' | 'small' | 'none';
function introTier(opts: { yes?: boolean; out: Out }): IntroTier {
  if (opts.yes) return 'none';
  if (!opts.out.isTTY) return 'none';
  if (process.env.CI) return 'none';
  if (process.env.NO_COLOR) return 'none';
  if (process.env.TERM === 'dumb') return 'none';
  const cols = process.stdout.columns;
  if (cols === undefined) return 'big'; // unknown width: don't assume narrow, prefer the fuller intro
  if (cols >= WORDMARK_WIDTH) return 'big';
  if (cols >= 40) return 'small';
  return 'none';
}
async function playSmallIntro(out: Out): Promise<void> {
  let prevLines = 0;
  for (const frame of FRAMES) {
    if (prevLines > 0) out.write(`\x1b[${prevLines}A`);
    for (const l of frame) out.write(`${l}\x1b[K\n`);
    prevLines = frame.length;
    await new Promise((r) => setTimeout(r, 300));
  }
}

// Longer, denser build-up (7 nodes + edges, the newest edge briefly brighter before settling to
// resting gray -- DESIGN.md's edge/edge-hot distinction) landing on the gradient wordmark.
async function playBigIntro(out: Out): Promise<void> {
  const useTrueColor = hasTrueColor();
  let prevLines = 0;
  const redraw = (lines: string[]) => {
    if (prevLines > 0) out.write(`\x1b[${prevLines}A`);
    for (const l of lines) out.write(`${l}\x1b[K\n`);
    prevLines = lines.length;
  };
  for (let n = 1; n <= BIG_GRAPH_NODES.length; n++) {
    let row = '  ';
    for (let i = 0; i < n; i++) {
      const node = BIG_GRAPH_NODES[i];
      if (i > 0) row += i === n - 1 ? `${EDGE_HOT}──${RESET}` : `${COLORS.gray}──${RESET}`; // newest edge hot, settles to resting gray once a newer one supersedes it next frame
      row += `${COLORS[node.kind]}${node.glyph}${RESET}`;
    }
    redraw([row]);
    await new Promise((r) => setTimeout(r, 220));
  }
  await new Promise((r) => setTimeout(r, 150));
  const wordmarkLines = WORDMARK_ART.map((l) => `  ${renderGradientLine(l, WORDMARK_ART[0].length, useTrueColor)}`);
  redraw(wordmarkLines);
}

async function playIntro(out: Out, tier: IntroTier): Promise<void> {
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
    if (tier === 'big') await playBigIntro(out);
    else await playSmallIntro(out);
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

  const tier = introTier(opts);
  if (tier !== 'none') await playIntro(out, tier);

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
