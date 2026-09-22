# Muse Brain: interface contracts (v1, local)

Everything below is fixed so the server, the hooks and the UI can be built in parallel. `docs/design.md` is the full design; this file is the wire format.

## Runtime

- Node 24 (`/Users/yahavfuchs/.nvm/versions/node/v24.11.1/bin/node`), TypeScript run directly (`node src/server.ts`, type stripping, no build). ESM (`"type": "module"`), imports carry `.ts` extensions.
- DB `~/.brain/brain.db` (override `BRAIN_DB`), WAL, `node:sqlite`. Port `4747` on `127.0.0.1` (override `BRAIN_PORT`). Env file `~/.brain/.env` loaded with `process.loadEnvFile` when present.
- Env: `TYPESAFE_API_KEY` (absent = Jev off), `BRAIN_JEV=on|off` (default on when key present), `BRAIN_JEV_GUARDS=shadow|on|off` (default `shadow`), `BRAIN_GUARDS=on|off` (default on; hooks honor it, falling back to grepping `~/.brain/.env` when unset in their own environment -- that file is the single place to flip it), `BRAIN_LOG_DIR` (default `~/.brain/logs`), `JEV_MODEL=jev-1.13.0`.
- Logs: `~/.brain/logs/server.log`, `~/.brain/logs/hook.log`, `~/.brain/logs/guard.log` (JSONL, see below) -- all under `BRAIN_LOG_DIR` when set.
- Timestamps: every `created_at`, `valid_to` and `approved_on` is ISO-8601 UTC with a literal `Z` suffix and millisecond precision (`strftime('%Y-%m-%dT%H:%M:%fZ','now')` in SQL, `new Date().toISOString()` on the TS side). `julianday()` and its date-math comparisons (outcome gate, `/api/needs` staleness) accept this form directly (SQLite >= 3.42).
- Dependencies: `@modelcontextprotocol/server@2.0.0`, `@modelcontextprotocol/node@2.0.0`, `zod@4.6.5`. Nothing else at runtime.

## Identity

Every handler receives `{agent, scope}` from one function `whoIs(req)`. v1: `agent` = `?agent=` query param on the request URL (`/mcp?agent=codex`), default `unknown`; scope is always `full`. v2 will read a bearer token here; handlers never look at the request themselves.

## Verbs (the one table in `src/verbs.ts`)

Each entry: `{ name, description, input: zodObject, handler(args, who) -> result }`. MCP tools and `POST /api/call` are both generated from this table. Tool names are the verb names (clients register the server as `brain`, so Claude Code sees `mcp__brain__search`).

| verb | input | result |
|---|---|---|
| `ask` | `{question: string, project?: string, limit?: number=10}` | `{intent: 'rules'\|'lessons'\|'dead_ends'\|'history'\|'general', hits: Hit[] (with `score` 0..1), expanded: {nodes: Node[], edges: Edge[]}, jev: boolean, footer: string[]}` |
| `search` | `{query?: string, kind?, status?, verdict?, project?, limit?: number=20}` | `{hits: Hit[], footer}` |
| `context` | `{id: number, hops?: number=2}` (cap 25 nodes) | `{nodes: Node[], edges: Edge[], footer}` |
| `get` | `{ids: number[]}` | `{nodes: (Node & {edges_out: Edge[], edges_in: Edge[]})[], footer}` |
| `log` | `{kind, title, why?, status?, verdict?, confidence?, project?, alternatives?: string[], evidence?: string[], files?: string[], guard?: Guard, links?: {type, to: number}[]}` | `{id, created: boolean, links: number, footer}` (`created:false` = hash hit) |
| `link` | `{src: number, type: string, dst: number}` | `{ok: true, footer}` |
| `update` | `{id, rev, title?, why?, status?, confidence?, alternatives?, evidence?, files?, project?}` | `{id, rev, footer}`; stale rev -> error `conflict: #id is at rev N`; rule status/approval/guard changes -> error |
| `approve_rule` | `{id: number, approved_by: string}` | `{id, status: 'approved', footer}` |

Types: `Hit = {id, kind, title, status, verdict, project, created_at}`; `Node = {id, kind, title, why, project, status, verdict, confidence, props (parsed object), approved_by, approved_on, agent, rev, created_at, valid_to}`; `Edge = {src, dst, type, created_at}`; `Guard = {tool: string (regex on tool_name), deny_if?: string (regex over JSON.stringify(tool_input)), judge?: string (yes/no question for Jev)}`.

Errors from handlers are thrown `Error(message)`; MCP returns them as `isError: true` text; `/api/call` returns HTTP 400 `{error: message}`.

`footer` is an array of short strings the server appends to every result: outcome gate (`"#18 has waited 16 days for an outcome. If you know it, log a conclusion that evaluates it."`, max 3 lines, actions older than 14 days with no `evaluates` edge, current, same project when known), unlinked warning after a `log` with zero links, Jev link suggestions after `log`.

## HTTP (all JSON, loopback only, host/origin validated)

- `POST /mcp` Streamable HTTP MCP, stateless (new transport per request).
- `GET /` -> `public/index.html`. `GET /api/version` -> `{version: number, nodes: number, agents: [{agent, last_write}], jev: 'on'\|'off', guards: 'shadow'\|'on'\|'off'}`. `version` is an in-memory counter bumped after every committed write.
- `GET /api/graph?range=24h|7d|30d|all&project=<name>|_all&limit=2000` -> `{nodes: Node[], edges: Edge[], version}`; nodes = most recent in range, edges = those with both ends in the set. `GET /api/graph?ids=1,2,3&hops=2` -> same shape, the union of `context()` for those ids.
- `GET /api/needs?project=` -> `{proposed_rules: Node[], stale_actions: (Node & {days: number})[], guard_events: GuardEvent[] (last 20)}`.
- `POST /api/call` `{verb, args, agent?}` -> the verb result. `agent` defaults to `ui`.
- `POST /api/recall` `{prompt, project?}` -> `{hits: Hit[]}` max 3 (FTS top 10 -> Jev noul >= 0.6; Jev off -> top 3 by bm25 if the best rank is under a threshold; empty array when nothing relevant).
- `POST /api/pre` `{tool_name, tool_input, project?, repo_root?, session_id}` -> `{decision: 'allow'\|'deny'\|'ask', reason?: string, context?: string}`. `repo_root` is the absolute git toplevel of `cwd` (empty/absent when not a repo); the hook sends it on every call. Runs semantic guards (Jev, only when some live rule's `guard.tool` matches `tool_name` and it has `guard.judge`) with bands: noul >= 0.85 deny, 0.5..0.85 ask, else allow; in `shadow` mode never denies, logs what it would do. Then advice: for `tool_name` in `Edit|Write|MultiEdit|NotebookEdit`, up to 2 nodes from `node_file` matching `tool_input.file_path` made repo-relative -- strip `repo_root + '/'` when the path starts with it, else (absolute path, `project` known) keep only what follows the last `/<project>/`, else use the path as given -- then an **exact** match (`nf.path = rel`, no suffix `LIKE`) scoped to `nf.project = project OR nf.project IS NULL`; each id shown once per `session_id` (in-memory set), formatted `"Brain: decisions that touched this file: #12 <title>, #40 <title>. context(12) for more."`.
- HTTP hygiene: a malformed JSON body on any `POST` -> `400 {error}`; a body over 1 MB -> `413 {error}` before it is parsed.

`GuardEvent` (one JSON per line in `~/.brain/logs/guard.log`): `{ts, session_id, tool, rule_id, title, mode: 'regex'\|'semantic', decision: 'deny'\|'ask'\|'would_deny'\|'would_ask'\|'allow', p?: number}`. The hook appends regex events; the server appends semantic ones.

## Hooks -> server

`hooks/brain-hook.sh <mode>` reads the Claude Code hook JSON on stdin. Modes: `start` (SessionStart), `recall` (UserPromptSubmit), `pre` (PreToolUse), `mark` (PostToolUse), `stop` (Stop), `--selftest`. Everything fails open (exit 0, nothing on stdout) on any error, logging to `~/.brain/logs/hook.log`. `start` and the regex part of `pre` read the DB with `/usr/bin/sqlite3 -readonly` so they work with the server down; `recall` and the second half of `pre` call the server with `curl -s -m 1.5` / `-m 2.5`. Project = basename of `git rev-parse --show-toplevel` from `cwd`, else null. Marker file: `${TMPDIR:-/tmp}/brain-nudge-<session_id>`.

## Jev

`src/judge.ts`: `judge(state: unknown, questions: Record<string, Question>, timeoutMs: number): Promise<Answers | null>`. `POST https://api.typesafe.ai/v1/systemone`, header `Authorization: Bearer $TYPESAFE_API_KEY`, body `{state, model, questions}`. Question: `{type: 'noul', instructions, criteria?: {true, false}}` | `{type: 'choice', instructions, criteria: {option: description|null}}` | `{type: 'score', instructions, criteria: string[]}`. Answers: `{[id]: {type:'noul', noul: number} | {type:'choice', choice, probabilities, confidence} | {type:'score', score, probabilities, confidence}}`. Returns `null` on missing key, `BRAIN_JEV=off`, timeout (`AbortSignal.timeout`), non-2xx, or invalid JSON. Never throws. Never called before a write commits.
