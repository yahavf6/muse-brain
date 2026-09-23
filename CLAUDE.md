# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Muse Brain: a typed knowledge graph (thought/action/rule/conclusion nodes, typed edges) on SQLite, served over MCP + a small JSON API to every coding agent on the machine (Claude Code, Codex, Cursor, Gemini CLI, Claude Desktop). Full thesis and comparison to memory-store approaches: `README.md`.

## Commands

```bash
npm start                                          # runs src/server.ts directly on :4747, no build step
npm test                                            # node:test, all of test/*.test.ts
node --no-warnings=ExperimentalWarning --test test/brain.test.ts        # one file
node --no-warnings=ExperimentalWarning --test --test-name-pattern="guard" test/*.test.ts   # by name
bash hooks/brain-hook.sh --selftest                # hook fixtures (start/pre/mark/stop) -- separate from npm test, also run in CI
npm run seed                                        # demo graph, project: 'demo'; refuses a non-empty DB without --force
npm run bench                                       # synthetic-graph numbers via the real log() verb; BENCH_SIZES=1000000 for the 1M run
```

No build step, no lint/format config in the repo. Node's native TypeScript type-stripping runs `.ts` files directly (requires Node >= 24). `scripts/service.sh {install,uninstall,restart,status,render}` manages the macOS launchd background service.

## Architecture

**One process, three surfaces, one `callVerb()` path.** `src/server.ts` is the only entry point: a raw `node:http` server that serves the MCP endpoint (`/mcp`), a JSON API (`/api/*`) used by the 3D graph page in `public/`, and static files. Every mutation and query -- whether it arrived as an MCP tool call or a `POST /api/call` -- funnels through `callVerb()` in `src/verbs.ts`, which zod-validates args and dispatches to one of the 8 verbs in the `VERBS` table (`ask`, `search`, `context`, `get`, `log`, `link`, `update`, `approve_rule`; `delete_node`/`delete_edge` are UI-only, flagged `ui_only: true` in that table and skipped when `server.ts` registers MCP tools). Read `src/verbs.ts` top to bottom to see the whole write/read surface; there is no other business-logic layer.

**Two scopes gate what a caller can do.** `Who = { agent, scope: 'full' | 'admin' }`. MCP callers (any agent) always get `scope: 'full'`, set in `whoIs()` from the `?agent=` query param. `POST /api/call` (the local UI only) always gets `scope: 'admin'`. `update()` in `verbs.ts` is where this matters most: `full` cannot touch an approved rule's fields, cannot set a conclusion's verdict, cannot edit a guard, cannot revive a retired node -- `admin` can. This is the only privilege boundary in the system; there is no auth beyond loopback + `Host`/Origin validation (see "Status and limits" in README.md).

**The graph's integrity lives in `src/schema.sql`, not in application code.** Which node kinds require `why`, which kind needs `status` vs `verdict`, which 9 (type, src_kind, dst_kind) edge combinations are legal (`edge_rule` table + `edge_endpoints` trigger), rule lifecycle (`proposed` -> `approved` -> `retired`, enforced by `rule_starts_proposed`/`rule_approve_guard`/`supersede_on_approve` triggers), and FTS5 sync (`node_fts_ai/ad/au` triggers) are all DB constraints/triggers, re-applied on every `openDb()`. `src/verbs.ts` mirrors the same rules in zod (`checkStatusVerdictForKind`, `assertUpdateStatusForKind`) purely to fail with a readable message before a write reaches the DB -- `cleanSqliteError()` translates the SQLite-level failure back to English for the cases zod doesn't pre-empt. When changing a rule, decide whether it belongs in the schema (real invariant, enforced for every caller including raw SQL) or in verbs.ts (a scope-dependent or message-quality concern) -- don't only add it in one layer if the other needs it too.

**Jev (`src/judge.ts`) is a decoration, never a dependency.** It's an optional external LLM judge (TypeSafe System One) used for `ask` ranking/intent, recall reranking, semantic guards, and link suggestions. `judge()` returns `null` on a missing `TYPESAFE_API_KEY`, a timeout, a non-2xx, or bad JSON -- callers always have a non-Jev fallback (FTS5 `bm25` ranking, or skipping the feature outright) and a write is never blocked waiting on it except `log()`'s bounded wait for link suggestions. When touching anything that calls `judge()`, preserve the "degrades to null, never throws" contract.

**Guards run in a fixed order in `apiPre()` (server.ts) and are mirrored in `hooks/brain-hook.sh`'s `cmd_pre`.** Regex guards (cheap, DB-only, `guard.deny_if` matched against `JSON.stringify(tool_input)`) run first and short-circuit; semantic (Jev) guards run only if no regex denied and `BRAIN_JEV_GUARDS` isn't `off`; file-touch advice runs last. `BRAIN_JEV_GUARDS=shadow` (default) logs what a semantic guard *would* have done without blocking. The hook's `cmd_pre` calls the server's `/api/pre` first and only falls back to a local sqlite3+jq regex-only reimplementation if the server is unreachable -- keep both paths in sync if the regex-guard logic changes.

**`hooks/brain-hook.sh` has a hard fail-open contract**: every mode must exit 0 and print nothing on any error (errors go to `~/.brain/logs/hook.log`), because Claude Code hooks run on every tool call. It's bash 3.2-compatible (macOS system bash) with no dependency beyond `sqlite3`/`jq`/`curl`/`node`. It carries its own fixture harness (`--selftest`, run in CI alongside `npm test`) rather than being covered by the Node test suite. `cmd_mark`/`cmd_stop` implement the "logged real-world work but never called `log`" nudge via a per-session marker file in `$TMPDIR`.

**`src/install.ts` is the manual "wire up each client" README steps, automated.** Each of the 5 clients (`CLIENT_IDS`) is a `Client` with a list of idempotent file writes (JSON merge, marker-gated text append, or symlink), each backed up to `<file>.bak-brain-<timestamp>` before any change. If you change what a client needs wired up, update both the installer function here and the matching manual snippet in README.md's "Connect an agent, by hand".

**Testing gotcha**: `test/env.ts` is imported first in `test/brain.test.ts` specifically to set `BRAIN_DB`/`BRAIN_LOG_DIR` before `src/verbs.ts` or `src/server.ts` are imported -- their top-level code opens the DB / creates the log dir on import, so import order here is load-bearing, not cosmetic.

**Ponytail-tagged comments** (`// ponytail: ...`) mark a deliberate simplification with a known ceiling and an upgrade condition (e.g. `action_open` index note in schema.sql, single-file log rotation in server.ts) -- they're intentional, not TODOs.
