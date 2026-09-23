# Security

Muse Brain is one process with two listeners. The loopback listener is the default and is local-only. The public listener exists only when `BRAIN_PUBLIC_PORT` is set (the Docker image, see "Deploy" in the README) and opens a narrow set of routes to the internet behind bearer tokens.

## Loopback listener: local-only

`BRAIN_PORT` (default 4747) binds `127.0.0.1` only; it is never meant to be reachable from another machine or the internet. It serves every route: the graph page, `/api/call`, `/api/install`, `/api/recall`, `/api/pre`, `/mcp` and `/api/v1/*`.

Every request is checked against the Host and Origin headers, which is the mitigation for DNS rebinding: a malicious page in a browser cannot use your browser as a proxy to reach the server, because the Host header it sends will not match.

There is no authentication on this listener. It is a loopback trust model: any local process that can reach `127.0.0.1:4747` and send the right Host header can call `POST /api/call` with admin scope (the same power the graph page UI has, including edit and delete), and `POST /api/install`, which edits agent config files on disk (always with backups first). Treat anything running on your machine as able to reach the brain. Agent identity is the self-declared `?agent=` query param.

Turning the public listener on does not change any of this: same port, same checks, same identity, so local agents and hooks need no token.

## Public listener: `BRAIN_PUBLIC_PORT`

Set `BRAIN_PUBLIC_PORT` to a port other than `BRAIN_PORT` (unset or empty leaves it off; an invalid value stops the server at startup). It binds `BRAIN_HOST` (default `0.0.0.0`; use `127.0.0.1` behind a same-machine tunnel or proxy). Code: `src/server.ts` (`makeHandler`, `publicPort()`), `src/tokens.ts`, `src/verbs.ts`.

**What it serves.** Only `/mcp`, `POST /api/v1/<verb>` for the 8 non-UI verbs, and `GET /api/v1/openapi.json` (the OpenAPI document, served without a token; it describes request schemas and holds no data from the graph). Everything else, including `/`, `/api/call`, `/api/install`, `/api/version`, `/api/graph`, `/api/recall`, `/api/pre` and any path trick, answers `404` before any processing, whatever the headers. Which listener a request arrived on is the whole boundary: no header, `Host` value or socket address is consulted to decide it, so a reverse proxy in front, a forged `Host` or a forwarded header cannot reach an admin route. The Host/Origin check does not run here; the token is the gate.

**Identity.** `Authorization: Bearer <token>` only; a missing or unknown token gets `401` with `WWW-Authenticate: Bearer`, and `?agent=` is ignored. The scope is always `full`, hardcoded at verification and never stored, so a token can never be `admin`. The per-agent `agent_policy` still applies to it, and `npm run token -- mint <agent> --read-only` sets a read-only policy for that agent name.

**Tokens.** A token is 32 random bytes as hex, shown once at mint. Only its sha256 is stored, in `BRAIN_TOKENS_FILE` (default `~/.brain/tokens.json`, `/data/tokens.json` in the shipped Docker, Fly and Droplet configs). The file is written atomically (a fresh mode-0600 temp file renamed over it), so it ends up `0600` even if a looser file was there before. A malformed file is never rewritten: `mint` and `revoke` throw, and verification fails closed (no token is valid until the file is fixed or moved aside). The file is re-read on every request, so revoking takes effect immediately. Tokens are minted, listed and revoked only with `npm run token` inside the deployment; there is no HTTP endpoint for it.

**Defenses behind the listener.**

- `callVerb()` refuses the `ui_only` verbs (`delete_node`, `delete_edge`, `agent_policies`, `set_agent_policy`) for any caller that is not `admin`, on top of the REST route and MCP registration not exposing them. A token cannot delete anything, change agent policy, edit an approved rule, set a verdict or edit a guard.
- A request body over 1 MB on `/mcp` or `/api/v1/*` gets `413` before it is parsed; malformed JSON gets `400`.
- Each `/mcp` request gets its own MCP server and transport, and its tools run as the identity resolved once for that request. An earlier shared server could cross responses between concurrent requests; that was found in review and fixed.

**Known limits.**

- A `full` token can call `approve_rule`, which can activate a guard that denies tool calls in Claude Code. Restrict a cloud agent with `--read-only` unless it needs to write. An approval records only the `approved_by` string the caller sends, not the token's agent.
- This class of agent (cloud assistants that browse and act for a user) has documented prompt-injection incidents. A prompt-injected agent can do whatever its token allows: with read access, everything the brain holds; with write access, add nodes and, at `full` scope, approve rules.
- A token you hand a cloud agent through chat (Grok Bot) is visible to the model and the transcript, and it is unsettled whether Grok Bot accepts a header secret at all (a Cursor staff reply of 2026-09-17 says its connectors currently authenticate only via OAuth, which Muse Brain does not implement). Mint a dedicated token per agent, prefer `--read-only`, revoke on any doubt.
- The public listener speaks plain HTTP. TLS is the operator's job: the platform's edge (Fly terminates it, `force_https = true` in `fly.toml`) or a reverse proxy in front (Caddy, nginx). The Droplet cloud-init publishes the port on the Droplet's loopback only, so nothing is reachable until you add that proxy; without TLS a token crosses the network in cleartext.
- Tokens have no expiry, no per-token scopes and no rate limiting yet. They are unsalted sha256 lookup keys, which is adequate for 256-bit random values and would not be for passwords.
- The token file has no cross-process lock: minting or revoking from two processes at the same moment can lose one write.
- `npm run token -- mint <agent> --read-only` overwrites an existing project scope for that agent with all projects.
- Agent policy, on either listener, narrows what a well-behaved agent does; it is not a substitute for keeping the token secret.

Please report vulnerabilities through GitHub's private vulnerability reporting on this repository, not as a public issue.
