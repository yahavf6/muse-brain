// One-click installer: wires the brain MCP server (+ hooks, for Claude Code) into each agent
// client's own config files. Every write here mirrors the manual steps in README.md's "Wire up
// each client" section -- this is just those steps, automated and made idempotent.
import { existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, mkdirSync, lstatSync, statSync, unlinkSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type InstallCtx = { baseUrl: string; repoDir: string; home: string };

type WriteOutcome =
  | { status: 'changed'; backupPath?: string }
  | { status: 'skipped' }
  | { status: 'error'; error: string; backupPath?: string };

type ClientFile = { path: string; checkInstalled: () => boolean; doWrite: () => WriteOutcome };
type Client = { id: string; name: string; files: ClientFile[]; snippet: string; gets: string; restart: string };

// ---- low-level write helpers (backup + atomic write, shared by every file kind below) ----

function backupPath(path: string): string {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  return `${path}.bak-brain-${stamp}`;
}
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-brain-${process.pid}-${Date.now()}`;
  // Keep the file's mode: ~/.claude.json, ~/.codex/config.toml and the Claude Desktop config are
  // 0600 on this machine; a fresh temp file would silently come back 0644. New files start 0600.
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, path);
}

// ---- JSON files: mcpServers.brain merged into an object, 2-space indent + trailing newline ----

// A BOM-prefixed file (some editors write one) fails JSON.parse otherwise; strip it before
// parsing, so the rewritten file also comes out BOM-free.
function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, '');
}
function checkJson(path: string, isInstalled: (obj: any) => boolean): boolean {
  if (!existsSync(path)) return false;
  try {
    return isInstalled(JSON.parse(stripBom(readFileSync(path, 'utf8'))));
  } catch {
    return false;
  }
}
function writeJson(path: string, isInstalled: (obj: any) => boolean, apply: (obj: any) => void): WriteOutcome {
  mkdirSync(dirname(path), { recursive: true });
  const existed = existsSync(path);
  let obj: any = {};
  if (existed) {
    try {
      obj = JSON.parse(stripBom(readFileSync(path, 'utf8')));
    } catch (e) {
      return { status: 'error', error: e instanceof Error ? e.message : String(e) };
    }
  }
  if (isInstalled(obj)) return { status: 'skipped' };
  let backup: string | undefined;
  if (existed) {
    backup = backupPath(path);
    copyFileSync(path, backup);
  }
  apply(obj);
  atomicWrite(path, `${JSON.stringify(obj, null, 2)}\n`);
  return { status: 'changed', backupPath: backup };
}

// ---- text-append files: config.toml / AGENTS.md / GEMINI.md, marker-gated idempotent append ----

function checkTextContains(path: string, marker: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, 'utf8').includes(marker);
  } catch {
    return false;
  }
}
function writeTextAppend(path: string, marker: string, block: string): WriteOutcome {
  mkdirSync(dirname(path), { recursive: true });
  const existed = existsSync(path);
  const content = existed ? readFileSync(path, 'utf8') : '';
  if (content.includes(marker)) return { status: 'skipped' };
  let backup: string | undefined;
  if (existed) {
    backup = backupPath(path);
    copyFileSync(path, backup);
  }
  atomicWrite(path, content + block);
  return { status: 'changed', backupPath: backup };
}

// ---- symlinks: skills/brain -> the repo's skill dir ----

function checkSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
function writeSymlink(path: string, target: string): WriteOutcome {
  if (checkSymlink(path)) return { status: 'skipped' };
  mkdirSync(dirname(path), { recursive: true });
  let existed = false;
  try {
    lstatSync(path);
    existed = true;
  } catch { /* nothing at path */ }
  let backup: string | undefined;
  if (existed) {
    // ponytail: best-effort backup for a stray non-symlink file at the target path; a directory
    // there would throw out of copyFileSync/unlinkSync and surface as an install error -- fine,
    // that's a rare hand-edited-config case, not one this installer needs to repair.
    try {
      backup = backupPath(path);
      copyFileSync(path, backup);
      unlinkSync(path);
    } catch (e) {
      return { status: 'error', error: e instanceof Error ? e.message : String(e) };
    }
  }
  try {
    symlinkSync(target, path);
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : String(e), backupPath: backup };
  }
  return { status: 'changed', backupPath: backup };
}

// ---- Claude Code hooks: merge missing SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop
// groups into settings.json without ever touching an existing group ----

const HOOK_MODES: { event: string; mode: string; matcher?: string }[] = [
  { event: 'SessionStart', mode: 'start' },
  { event: 'UserPromptSubmit', mode: 'recall' },
  { event: 'PreToolUse', mode: 'pre', matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__.*' },
  { event: 'PostToolUse', mode: 'mark', matcher: 'Bash|mcp__.*' },
  { event: 'Stop', mode: 'stop' },
];

function installedHookModes(obj: any): Set<string> {
  const found = new Set<string>();
  const h = obj?.hooks;
  const ok = h === undefined || h === null || (typeof h === 'object' && !Array.isArray(h));
  if (!ok) return found;
  for (const { event, mode } of HOOK_MODES) {
    const groups = h?.[event];
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!Array.isArray(g?.hooks)) continue;
      for (const hk of g.hooks) {
        if (typeof hk?.command === 'string' && hk.command.includes(`brain-hook.sh ${mode}`)) found.add(mode);
      }
    }
  }
  return found;
}
function checkClaudeHooks(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return installedHookModes(JSON.parse(readFileSync(path, 'utf8'))).size === HOOK_MODES.length;
  } catch {
    return false;
  }
}
function writeClaudeHooks(path: string, repoDir: string): WriteOutcome {
  mkdirSync(dirname(path), { recursive: true });
  const existed = existsSync(path);
  let obj: any = {};
  if (existed) {
    try {
      obj = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      return { status: 'error', error: e instanceof Error ? e.message : String(e) };
    }
  }
  const h = obj?.hooks;
  const hooksOk = h === undefined || h === null || (typeof h === 'object' && !Array.isArray(h));
  if (!hooksOk) return { status: 'error', error: `hooks is not an object in ${path}` };
  const found = installedHookModes(obj);
  const missing = HOOK_MODES.filter((m) => !found.has(m.mode));
  if (missing.length === 0) return { status: 'skipped' };
  let backup: string | undefined;
  if (existed) {
    backup = backupPath(path);
    copyFileSync(path, backup);
  }
  obj.hooks = obj.hooks ?? {};
  for (const { event, mode, matcher } of missing) {
    obj.hooks[event] = obj.hooks[event] ?? [];
    const hookCmd = { type: 'command', command: `bash ${repoDir}/hooks/brain-hook.sh ${mode}`, timeout: 5 };
    obj.hooks[event].push(matcher ? { matcher, hooks: [hookCmd] } : { hooks: [hookCmd] });
  }
  atomicWrite(path, `${JSON.stringify(obj, null, 2)}\n`);
  return { status: 'changed', backupPath: backup };
}

// ---- the "Company brain" pointer block, worded exactly as ~/.codex/AGENTS.md carries it ----

const COMPANY_BRAIN_BLOCK =
  '\n## Company brain\n\n' +
  "Muse Brain (MCP server `brain`) is this machine's shared decision log. Before a task or any outbound/irreversible call, call `ask`; after real-world work, call `log` once with kind=action and a why.\n" +
  'Approved rules bind you: call `search(kind: rule, status: approved)` at the start of a session and obey what comes back.\n' +
  'See the `brain` skill for the 4 node kinds, the edge vocabulary, and worked `log` examples.\n';

function codexTomlBlock(baseUrl: string): string {
  return `\n# --- muse-brain: start ---\n[mcp_servers.brain]\nurl = "${baseUrl}/mcp?agent=codex"\n# --- muse-brain: end ---\n`;
}

// ---- per-client snippets (the copy-paste text shown in the UI before an install) ----

function claudeCodeSnippet(ctx: InstallCtx): string {
  const hooksJson = JSON.stringify(
    {
      hooks: Object.fromEntries(
        HOOK_MODES.map(({ event, mode, matcher }) => [
          event,
          [
            {
              ...(matcher ? { matcher } : {}),
              hooks: [{ type: 'command', command: `bash ${ctx.repoDir}/hooks/brain-hook.sh ${mode}`, timeout: 5 }],
            },
          ],
        ]),
      ),
    },
    null,
    2,
  );
  return [
    `claude mcp add --scope user --transport http brain "${ctx.baseUrl}/mcp?agent=claude-code"`,
    hooksJson,
    `ln -s ${ctx.repoDir}/skills/brain ~/.claude/skills/brain`,
    `ln -s ${ctx.repoDir}/skills/brain ~/.agents/skills/brain`,
  ].join('\n\n');
}
function pathAndBlockSnippet(entries: { path: string; block: string }[]): string {
  return entries.map((e) => `${e.path}:\n${e.block}`).join('\n\n');
}

// ---- the 5 real clients ----

export const CLIENT_IDS = ['claude-code', 'codex', 'cursor', 'gemini', 'claude-desktop'] as const;

function buildClaudeCode(ctx: InstallCtx): Client {
  const configPath = join(ctx.home, '.claude.json');
  const settingsPath = join(ctx.home, '.claude', 'settings.json');
  const skillPath = join(ctx.home, '.claude', 'skills', 'brain');
  const isInstalled = (o: any) => o?.mcpServers?.brain !== undefined;
  return {
    id: 'claude-code',
    name: 'Claude Code',
    files: [
      {
        path: configPath,
        checkInstalled: () => checkJson(configPath, isInstalled),
        doWrite: () =>
          writeJson(configPath, isInstalled, (o) => {
            o.mcpServers = o.mcpServers ?? {};
            o.mcpServers.brain = { type: 'http', url: `${ctx.baseUrl}/mcp?agent=claude-code` };
          }),
      },
      { path: settingsPath, checkInstalled: () => checkClaudeHooks(settingsPath), doWrite: () => writeClaudeHooks(settingsPath, ctx.repoDir) },
      { path: skillPath, checkInstalled: () => checkSymlink(skillPath), doWrite: () => writeSymlink(skillPath, join(ctx.repoDir, 'skills', 'brain')) },
    ],
    snippet: claudeCodeSnippet(ctx),
    gets: 'tools, hooks, approved rules at session start',
    restart: 'Takes effect in the next session.',
  };
}

function buildCodex(ctx: InstallCtx): Client {
  const configPath = join(ctx.home, '.codex', 'config.toml');
  const agentsPath = join(ctx.home, '.codex', 'AGENTS.md');
  const skillPath = join(ctx.home, '.agents', 'skills', 'brain');
  return {
    id: 'codex',
    name: 'Codex CLI + ChatGPT desktop',
    files: [
      {
        path: configPath,
        checkInstalled: () => checkTextContains(configPath, '[mcp_servers.brain]'),
        doWrite: () => writeTextAppend(configPath, '[mcp_servers.brain]', codexTomlBlock(ctx.baseUrl)),
      },
      {
        path: agentsPath,
        checkInstalled: () => checkTextContains(agentsPath, '## Company brain'),
        doWrite: () => writeTextAppend(agentsPath, '## Company brain', COMPANY_BRAIN_BLOCK),
      },
      { path: skillPath, checkInstalled: () => checkSymlink(skillPath), doWrite: () => writeSymlink(skillPath, join(ctx.repoDir, 'skills', 'brain')) },
    ],
    snippet: pathAndBlockSnippet([
      { path: configPath, block: codexTomlBlock(ctx.baseUrl).trim() },
      { path: agentsPath, block: COMPANY_BRAIN_BLOCK.trim() },
      { path: skillPath, block: `ln -s ${ctx.repoDir}/skills/brain ${skillPath}` },
    ]),
    gets: 'MCP tools only, no hooks',
    restart: 'Takes effect in the next session.',
  };
}

function buildCursor(ctx: InstallCtx): Client {
  const configPath = join(ctx.home, '.cursor', 'mcp.json');
  const isInstalled = (o: any) => o?.mcpServers?.brain !== undefined;
  const desired = { mcpServers: { brain: { url: `${ctx.baseUrl}/mcp?agent=cursor` } } };
  return {
    id: 'cursor',
    name: 'Cursor',
    files: [
      {
        path: configPath,
        checkInstalled: () => checkJson(configPath, isInstalled),
        doWrite: () =>
          writeJson(configPath, isInstalled, (o) => {
            o.mcpServers = o.mcpServers ?? {};
            o.mcpServers.brain = { url: `${ctx.baseUrl}/mcp?agent=cursor` };
          }),
      },
    ],
    snippet: pathAndBlockSnippet([{ path: configPath, block: JSON.stringify(desired, null, 2) }]),
    gets: 'MCP tools only, no hooks',
    restart: 'Takes effect in the next session.',
  };
}

function buildGemini(ctx: InstallCtx): Client {
  const configPath = join(ctx.home, '.gemini', 'settings.json');
  const mdPath = join(ctx.home, '.gemini', 'GEMINI.md');
  const isInstalled = (o: any) => o?.mcpServers?.brain !== undefined;
  const desired = { mcpServers: { brain: { url: `${ctx.baseUrl}/mcp?agent=gemini-cli`, type: 'http' } } };
  return {
    id: 'gemini',
    name: 'Gemini CLI',
    files: [
      {
        path: configPath,
        checkInstalled: () => checkJson(configPath, isInstalled),
        doWrite: () =>
          writeJson(configPath, isInstalled, (o) => {
            o.mcpServers = o.mcpServers ?? {};
            o.mcpServers.brain = { url: `${ctx.baseUrl}/mcp?agent=gemini-cli`, type: 'http' };
          }),
      },
      {
        path: mdPath,
        checkInstalled: () => checkTextContains(mdPath, '## Company brain'),
        doWrite: () => writeTextAppend(mdPath, '## Company brain', COMPANY_BRAIN_BLOCK),
      },
    ],
    snippet: pathAndBlockSnippet([
      { path: configPath, block: JSON.stringify(desired, null, 2) },
      { path: mdPath, block: COMPANY_BRAIN_BLOCK.trim() },
    ]),
    gets: 'MCP tools only, no hooks',
    restart: 'Takes effect in the next session.',
  };
}

function buildClaudeDesktop(ctx: InstallCtx): Client {
  const configPath = join(ctx.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  const isInstalled = (o: any) => o?.mcpServers?.brain !== undefined;
  const url = `${ctx.baseUrl}/mcp?agent=claude-desktop`;
  const desired = { mcpServers: { brain: { command: 'npx', args: ['mcp-remote', url] } } };
  return {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    files: [
      {
        path: configPath,
        checkInstalled: () => checkJson(configPath, isInstalled),
        doWrite: () =>
          writeJson(configPath, isInstalled, (o) => {
            o.mcpServers = o.mcpServers ?? {};
            o.mcpServers.brain = { command: 'npx', args: ['mcp-remote', url] };
          }),
      },
    ],
    snippet: pathAndBlockSnippet([{ path: configPath, block: JSON.stringify(desired, null, 2) }]),
    gets: 'MCP tools only, no hooks',
    restart: 'Restart the app.',
  };
}

const CLIENT_BUILDERS: Record<(typeof CLIENT_IDS)[number], (ctx: InstallCtx) => Client> = {
  'claude-code': buildClaudeCode,
  codex: buildCodex,
  cursor: buildCursor,
  gemini: buildGemini,
  'claude-desktop': buildClaudeDesktop,
};

function buildClients(ctx: InstallCtx): Client[] {
  return CLIENT_IDS.map((id) => CLIENT_BUILDERS[id](ctx));
}

// ---- public API ----

export function installStatus(ctx: InstallCtx) {
  const clients = buildClients(ctx).map((c) => {
    const files = c.files.map((f) => ({ path: f.path, ok: f.checkInstalled() }));
    const okCount = files.filter((f) => f.ok).length;
    const installed: boolean | 'partial' = okCount === files.length ? true : okCount === 0 ? false : 'partial';
    return { id: c.id, name: c.name, installed, files, snippet: c.snippet, gets: c.gets, restart: c.restart };
  });
  clients.push({
    id: 'other',
    name: 'Other MCP client',
    installed: null as any,
    files: [],
    snippet: `Streamable HTTP MCP at ${ctx.baseUrl}/mcp?agent=<your-agent-name>`,
    gets: 'MCP tools only, no hooks',
    restart: 'Takes effect in the next session.',
  });
  return { url: `${ctx.baseUrl}/mcp`, repo_dir: ctx.repoDir, clients };
}

export function install(clientId: string, ctx: InstallCtx) {
  const client = buildClients(ctx).find((c) => c.id === clientId);
  if (!client) throw new Error(`unknown install client: ${clientId}`);
  const changed: string[] = [];
  const skipped: string[] = [];
  const backups: string[] = [];
  const errors: { path: string; error: string }[] = [];
  for (const f of client.files) {
    let result: WriteOutcome;
    try {
      result = f.doWrite();
    } catch (e) {
      result = { status: 'error', error: e instanceof Error ? e.message : String(e) };
    }
    if (result.status === 'changed') {
      changed.push(f.path);
      if (result.backupPath) backups.push(result.backupPath);
    } else if (result.status === 'skipped') {
      skipped.push(f.path);
    } else {
      errors.push({ path: f.path, error: result.error });
      if (result.backupPath) backups.push(result.backupPath);
    }
  }
  return { client: clientId, changed, skipped, backups, errors };
}
