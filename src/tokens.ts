// Bearer tokens for BRAIN_PUBLIC mode. Only sha256(token) is stored, never the token itself:
// it is shown once at mint time (like a GitHub PAT). Opaque random 32-byte tokens, so a plain
// unsalted hash is enough -- this is a lookup key, not a password.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

type TokenRow = { agent: string; scope: 'full'; created_at: string };
type TokenFile = Record<string, TokenRow>;

// Read live (not captured at import) so tests can toggle it. Exact '1', not truthy-any-string --
// BRAIN_PUBLIC=0 or =false must stay off, not silently turn public mode on.
export function isPublic(): boolean {
  return process.env.BRAIN_PUBLIC === '1';
}

function tokensPath(): string {
  return process.env.BRAIN_TOKENS_FILE ?? join(homedir(), '.brain', 'tokens.json');
}

// ponytail: re-reads the file on every verify (one small JSON read per MCP request); cache on
// mtime if request volume ever makes it show up.
function load(): TokenFile {
  try {
    const parsed = JSON.parse(readFileSync(tokensPath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {}; // missing or malformed file = no tokens yet
  }
}

function save(tokens: TokenFile): void {
  const path = tokensPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function mintToken(agent: string): { token: string; hash: string } {
  const token = randomBytes(32).toString('hex');
  const hash = hashToken(token);
  const tokens = load();
  tokens[hash] = { agent, scope: 'full', created_at: new Date().toISOString() };
  save(tokens);
  return { token, hash };
}

export function verifyToken(token: string): { agent: string; scope: 'full' } | null {
  try {
    const tokens = load();
    const hash = hashToken(token);
    if (!Object.hasOwn(tokens, hash)) return null;
    const agent = tokens[hash]?.agent;
    // scope is hardcoded, never read from the file: a token can never become 'admin'.
    return typeof agent === 'string' && agent ? { agent, scope: 'full' } : null;
  } catch {
    return null;
  }
}

export function revokeToken(hash: string): boolean {
  const tokens = load();
  if (!Object.hasOwn(tokens, hash)) return false;
  delete tokens[hash];
  save(tokens);
  return true;
}

export function listTokens(): { hash: string; agent: string; created_at: string }[] {
  return Object.entries(load()).map(([hash, t]) => ({ hash, agent: t.agent, created_at: t.created_at }));
}
