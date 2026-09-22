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

## Wire up each client (MCP server, one-time)

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
    "brain": { "httpUrl": "http://127.0.0.1:4747/mcp?agent=gemini-cli" }
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
```

`TYPESAFE_API_KEY` absent = Jev (semantic ranking/guards) off, everything else still works off plain FTS. `BRAIN_JEV_GUARDS=shadow` (default) logs what a semantic guard would have done without blocking; flip to `on` once you trust it.

## Troubleshooting

- Logs: `~/.brain/logs/server.log` (server), `~/.brain/logs/hook.log` (hook errors: always fail-open, check here first if a hook seems silent), `~/.brain/logs/guard.log` (every guard decision, JSONL), `~/.brain/logs/launchd.log` (service stdout/stderr).
- Hook doing nothing? Run `bash /Users/yahavfuchs/WebstormProjects/muse-brain/hooks/brain-hook.sh --selftest`: should print all `PASS`.
- Kill-switch for guards without touching rules: set `BRAIN_GUARDS=off` in the environment the hook runs in (e.g. export it in your shell profile, or add to the hook's env in `settings.json`) to pass every tool call through unchecked.
- `BRAIN_DB` overrides the DB path (used by the selftest; can also point at a scratch DB for manual testing).
- Service not starting: `launchctl print gui/$(id -u)/ai.reddgrow.brain` and check `~/.brain/logs/launchd.log`.
