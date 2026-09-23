# Security

Muse Brain has two modes. The default is local-only; `BRAIN_PUBLIC=1` (the Docker image, see "Deploy" in the README) opens `/mcp` and `/api/v1/*` to the internet behind bearer tokens.

## Default mode: local-only

The server binds to `127.0.0.1` only; it is never meant to be reachable from another machine or the internet.

Every request is checked against the Host and Origin headers, which is the mitigation for DNS rebinding: a malicious page in a browser cannot use your browser as a proxy to reach the server, because the Host header it sends will not match.

There is no authentication in this mode. It is a loopback trust model: any local process that can reach `127.0.0.1:4747` and send the right Host header can call `POST /api/call` with admin scope (the same power the graph page UI has, including edit and delete), and `POST /api/install`, which edits agent config files on disk (always with backups first). Treat anything running on your machine as able to reach the brain. Agent identity is the self-declared `?agent=` query param.

## Public mode: `BRAIN_PUBLIC=1`

Set exactly `1`; `0`, `false` or any other value leaves the server in default mode. The server then binds `0.0.0.0` and the following changes apply (`src/server.ts`, `src/tokens.ts`, `src/verbs.ts`).

**What is remote.** Only `/mcp` and `/api/v1/*` skip the Host/Origin check. Both require `Authorization: Bearer <token>`; a missing or unknown token gets `401` with `WWW-Authenticate: Bearer`. `?agent=` is ignored, so local agents need a token too. `GET /api/v1/openapi.json` (the OpenAPI document, the same one as `/openapi.json`) is part of `/api/v1/*` and is served without a token; it describes the request schemas and contains no data from the graph.

**What stays local.** Every other route (`/`, the graph page, `/api/graph`, `/api/needs`, `/api/version`, `/api/call`, `/api/install`, `/api/token`, `/api/recall`, `/api/pre`, `/openapi.json`) still needs the Host/Origin check, and in public mode also a loopback socket address and none of these proxy headers on the request: `X-Forwarded-For`, `Forwarded`, `X-Real-IP`, `CF-Connecting-IP`, `Fly-Client-IP`. A request that fails the socket or header check gets `403 {"error":"local only"}`; one that fails Host/Origin gets the MCP SDK's own 403. Host alone is not enough in public mode because a remote client can forge it.

**Tokens.** A token is 32 random bytes as hex, shown once at mint. Only its sha256 is stored, in `BRAIN_TOKENS_FILE` (default `~/.brain/tokens.json`, `/data/tokens.json` in the shipped Fly and Droplet configs), created with file mode 0600. The file is re-read on every request, so revoking takes effect immediately. Mint, list and revoke with `npm run token` inside the deployment (or `POST /api/token`, loopback only). A token's scope is always `full`, hardcoded at verification; it can never be `admin`, so it cannot reach `delete_node`, `delete_edge`, `agent_policies` or `set_agent_policy`, and it cannot edit an approved rule, set a verdict or edit a guard. The per-agent `agent_policy` still applies to it, and `npm run token -- mint <agent> --read-only` sets a read-only policy.

**Known limits.**

- A `full` token can call `approve_rule`, which can activate a guard that denies tool calls in Claude Code. Restrict a cloud agent with `--read-only` unless it needs to write. An approval records only the `approved_by` string the caller sends, not the token's agent.
- This class of agent (cloud assistants that browse and act for a user) has documented prompt-injection incidents. A prompt-injected agent can do whatever its token allows: with read access, everything the brain holds; with write access, add nodes and, at `full` scope, approve rules.
- Grok Bot: a token supplied through chat is visible to the model and the transcript, and it is unsettled whether Grok Bot accepts a header secret at all (a Cursor staff reply of 2026-09-17 says its connectors currently authenticate only via OAuth, which Muse Brain does not implement). Mint a dedicated token per Bot, prefer `--read-only`, revoke on any doubt.
- The local-only check can be defeated by a reverse proxy on the same machine that connects from loopback, sends none of the headers above and rewrites Host to a local value: the admin routes would then look local. Agents on the token path are unaffected. A proxy that adds any of those headers is treated as remote, which is the intended behavior.
- The server speaks plain HTTP. Fly terminates TLS (`force_https = true` in `fly.toml`); the Droplet cloud-init does not, so put TLS in front before issuing tokens or they cross the internet in cleartext.
- No token expiry, no per-token scopes and no rate limiting yet. Tokens are unsalted sha256 lookup keys, which is adequate for 256-bit random values and would not be for passwords.
- Agent policy, in either mode, narrows what a well-behaved agent does; it is not a substitute for keeping the token secret.

Please report vulnerabilities through GitHub's private vulnerability reporting on this repository, not as a public issue.
