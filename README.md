# Muse Brain

The company brain: a typed graph of decisions, rules and lessons (`thought` / `action` / `rule` / `conclusion`), on SQLite, served locally over MCP.
Every coding agent (Claude Code, Codex, Cursor, Gemini CLI, Claude Desktop) reads and writes the same graph, consults it before acting, and shows it live on a graph page.
V1 is local-only: one always-on server on `127.0.0.1:4747`, started by `launchd`.

## Requirements

- Node 24 (this repo assumes `/Users/yahavfuchs/.nvm/versions/node/v24.11.1/bin/node`)
- `/usr/bin/sqlite3`, `/usr/local/bin/jq`, `/usr/bin/curl` (all present on this Mac)
- macOS (launchd for the service; hooks use `/bin/bash`)

## Install

```bash
cd /Users/yahavfuchs/WebstormProjects/muse-brain
npm install
```

## Run in dev

```bash
npm start   # node src/server.ts, no build step
```

Serves the MCP endpoint at `http://127.0.0.1:4747/mcp` and the graph page at `http://127.0.0.1:4747/`.

## Seed demo data

```bash
npm run seed
```

Writes a small demo story (thoughts, actions, rules, conclusions) so the graph page and the verbs have something to show on an empty brain. Safety:

- Every seeded node -- rules included -- is scoped `project: 'demo'`, so it can never bind real work: a scoped query (`project IS NULL OR project = <repo>`) only matches `NULL` (company-wide) or the exact repo, never `'demo'`. A demo em-dash guard rule, for example, fires for `project: 'demo'` but not for `project: 'reddgrow'`.
- The script refuses to run against a DB that already has any node (prints the count, exits 1). Pass `--force` to seed anyway (it will not deduplicate against what's already there; content-hash dedup in `log()` still applies node by node).
- It always prints the DB path it wrote to (`process.env.BRAIN_DB`, else `~/.brain/brain.db`).

To reseed a scratch DB: `BRAIN_DB=/tmp/mb-verify.db npm run seed -- --force` (or delete the file first).

## Install as a background service (launchd)

```bash
cp /Users/yahavfuchs/WebstormProjects/muse-brain/launchd/ai.reddgrow.brain.plist ~/Library/LaunchAgents/ai.reddgrow.brain.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.reddgrow.brain.plist
launchctl kickstart -k gui/$(id -u)/ai.reddgrow.brain
```

Check it's up: `curl -s http://127.0.0.1:4747/api/version`

**Stop it:**

```bash
launchctl bootout gui/$(id -u)/ai.reddgrow.brain
```

## Register the Claude Code hooks

Back up `~/.claude/settings.json` first (or use the `update-config` skill, which does this for you). **Append** the blocks below to the existing arrays under `"hooks"`: do not replace what's already there (other hooks, e.g. `herdr-agent-state.sh`, must stay untouched).

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "bash /Users/yahavfuchs/WebstormProjects/muse-brain/hooks/brain-hook.sh start", "timeout": 5 }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "bash /Users/yahavfuchs/WebstormProjects/muse-brain/hooks/brain-hook.sh recall", "timeout": 5 }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__.*",
        "hooks": [
          { "type": "command", "command": "bash /Users/yahavfuchs/WebstormProjects/muse-brain/hooks/brain-hook.sh pre", "timeout": 5 }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash|mcp__.*",
        "hooks": [
          { "type": "command", "command": "bash /Users/yahavfuchs/WebstormProjects/muse-brain/hooks/brain-hook.sh mark", "timeout": 5 }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "bash /Users/yahavfuchs/WebstormProjects/muse-brain/hooks/brain-hook.sh stop", "timeout": 5 }
        ]
      }
    ]
  }
}
```

### How `pre` decides

`PreToolUse` calls the server first: one `curl -s -m 2.5 POST /api/pre`, which runs regex guards, then semantic guards, then file-touch advice, and answers in one round trip (measured on this Mac with the server up: the `curl` itself ~0.5-0.8ms, HTTP-loopback-local, well under the 100ms budget; the full hook invocation, dominated by bash/jq/curl process spawn rather than the network call, ~200ms). The hook's own `sqlite3 -readonly` + `jq` regex-only path only runs as a fallback, when that call is unreachable (curl fails or comes back empty) -- never just because the decision wasn't `allow`.

## Wire up each client (MCP server, one-time)

The same wiring below can be done from the graph page instead of by hand: `Connect agent` -> `Install`.
It writes the same files this section describes, backing up any existing file first as `<file>.bak-brain-<YYYYMMDD-HHMMSS>`.
An already-wired-up client is left untouched: no write, no backup.

Server name must be `brain` (the hook's `mark` regex, `^mcp__brain__...`, depends on it). Each client gets `http://127.0.0.1:4747/mcp?agent=<name>`.

**Claude Code:**
```bash
claude mcp add --scope user --transport http brain "http://127.0.0.1:4747/mcp?agent=claude-code"
```

**Codex CLI + ChatGPT desktop**: add to `~/.codex/config.toml`:
```toml
[mcp_servers.brain]
url = "http://127.0.0.1:4747/mcp?agent=codex"
```

**Cursor**: add to `~/.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "brain": { "url": "http://127.0.0.1:4747/mcp?agent=cursor" }
  }
}
```

**Gemini CLI**: add to `~/.gemini/settings.json`:
```json
{
  "mcpServers": {
    "brain": { "url": "http://127.0.0.1:4747/mcp?agent=gemini-cli", "type": "http" }
  }
}
```
(Verify these two key names against current Cursor/Gemini CLI docs before relying on them: they move.)

**Claude Desktop** (no native HTTP MCP support, bridge via `mcp-remote`):
```json
{
  "mcpServers": {
    "brain": { "command": "npx", "args": ["mcp-remote", "http://127.0.0.1:4747/mcp?agent=claude-desktop"] }
  }
}
```

## Skill (all agents)

```bash
ln -s /Users/yahavfuchs/WebstormProjects/muse-brain/skills/brain ~/.claude/skills/brain
ln -s /Users/yahavfuchs/WebstormProjects/muse-brain/skills/brain ~/.agents/skills/brain
```

For agents without hooks (Codex, Gemini CLI, Cursor), add this 3-line pointer to `~/.codex/AGENTS.md` and `~/.gemini/GEMINI.md`:

```
Muse Brain (MCP server `brain`) is this machine's shared decision log. Before a task or any outbound/irreversible call, call `ask`; after real-world work, call `log` once with kind=action and a why.
Approved rules bind you: call `search(kind: rule, status: approved)` at the start of a session and obey what comes back.
See the `brain` skill for the 4 node kinds, the edge vocabulary, and worked `log` examples.
```

## Env file

`~/.brain/.env` (create with `chmod 600`), loaded automatically by the server:

```
TYPESAFE_API_KEY=sk-...
BRAIN_JEV_GUARDS=shadow
BRAIN_GUARDS=off
```

`TYPESAFE_API_KEY` absent = Jev (semantic ranking/guards) off, everything else still works off plain FTS. `BRAIN_JEV_GUARDS=shadow` (default) logs what a semantic guard would have done without blocking; flip to `on` once you trust it.

`~/.brain/.env` is the single place to flip `BRAIN_GUARDS=on|off`: the server loads it at startup (`process.loadEnvFile`), and the hook falls back to grepping this file (never sourcing it) whenever `BRAIN_GUARDS` isn't already set in its own process environment. Setting it here silences both the hook's local regex guards and the server's semantic guards -- no shell profile or `settings.json` edit needed.

## Troubleshooting

- Logs: `~/.brain/logs/server.log` (server), `~/.brain/logs/hook.log` (hook errors: always fail-open, check here first if a hook seems silent), `~/.brain/logs/guard.log` (every guard decision, JSONL), `~/.brain/logs/launchd.log` (service stdout/stderr).
- Hook doing nothing? Run `bash /Users/yahavfuchs/WebstormProjects/muse-brain/hooks/brain-hook.sh --selftest`: should print all `PASS`.
- Kill-switch for guards without touching rules: set `BRAIN_GUARDS=off` in `~/.brain/.env` (see Env file, above) to pass every tool call through unchecked -- both the hook and the server read it from there, no shell profile or `settings.json` edit needed.
- `BRAIN_DB` overrides the DB path (used by the selftest; can also point at a scratch DB for manual testing).
- Service not starting: `launchctl print gui/$(id -u)/ai.reddgrow.brain` and check `~/.brain/logs/launchd.log`.
