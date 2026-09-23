// Bearer tokens for the public listener (BRAIN_PUBLIC_PORT). Only sha256(token) is stored, never the
// token itself: it is shown once at mint time (like a GitHub PAT). Opaque random 32-byte tokens, so a
// plain unsalted hash is enough -- this is a lookup key, not a password.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

type TokenRow = { agent: string; created_at: string };
type TokenFile = Record<string, TokenRow>;

function tokensPath(): string {
  return process.env.BRAIN_TOKENS_FILE || join(homedir(), '.brain', 'tokens.json');
}

// A missing file is "no tokens yet". A file that exists but is not a JSON object throws: mint/revoke
// must never rewrite it as {} (that would destroy every other token); verify/list fail closed instead.
// ponytail: re-reads the file on every verify (one small JSON read per request); cache on mtime if
// request volume ever makes it show up.
function load(): TokenFile {
  const path = tokensPath();
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object; fix or move it aside, it was left untouched`);
  return parsed as TokenFile;
}

// Atomic: write a fresh 0600 temp file next to it, then rename over it (which also replaces any
// looser mode a pre-existing file had). Sync fs calls, so read-modify-write is already serialized
// within this process.
// ponytail: no cross-process lock -- two processes minting at once (server + CLI) can lose one
// write; add a lockfile if tokens are ever minted concurrently.
function save(tokens: TokenFile): void {
  const path = tokensPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* never created */ }
    throw e;
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function mintToken(agent: string): { token: string; hash: string } {
  const tokens = load();
  const token = randomBytes(32).toString('hex');
  const hash = hashToken(token);
  tokens[hash] = { agent, created_at: new Date().toISOString() };
  save(tokens);
  return { token, hash };
}

export function verifyToken(token: string): { agent: string; scope: 'full' } | null {
  try {
    const tokens = load();
    const hash = hashToken(token);
    if (!Object.hasOwn(tokens, hash)) return null;
    const agent = tokens[hash]?.agent;
    // scope is hardcoded, never stored: a token can never become 'admin'.
    return typeof agent === 'string' && agent ? { agent, scope: 'full' } : null;
  } catch {
    return null; // unreadable/malformed file = no valid tokens
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
  let tokens: TokenFile;
  try { tokens = load(); } catch { return []; }
  return Object.entries(tokens).map(([hash, t]) => ({
    hash,
    agent: typeof t?.agent === 'string' ? t.agent : '?',
    created_at: typeof t?.created_at === 'string' ? t.created_at : '?',
  }));
}
