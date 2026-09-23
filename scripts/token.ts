// Operator CLI for the public listener's bearer tokens (BRAIN_PUBLIC_PORT). Needs no running server
// and works inside a slim container. Loads ~/.brain/.env first, the same guarded way src/server.ts
// does, so a BRAIN_TOKENS_FILE/BRAIN_DB set only there is honored exactly as the server sees it; src/
// modules are imported dynamically after that, since static imports would run before it.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ENV_PATH = join(homedir(), '.brain', '.env');
try {
  if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);
} catch { /* unreadable env file: fall back to the process env */ }

const { mintToken, listTokens, revokeToken } = await import('../src/tokens.ts');

const [cmd, ...rest] = process.argv.slice(2);
const readOnly = rest.includes('--read-only');
const args = rest.filter((a) => a !== '--read-only');

function usage(): never {
  console.error('usage: token mint <agent> [--read-only]   mint a bearer token, shown once (--read-only: no writes)');
  console.error('       token list                          hash, agent, created_at (never the raw token)');
  console.error('       token revoke <hash>                 delete a token by the hash `list` prints');
  process.exit(1);
}

if (cmd === 'mint' && args.length === 1 && args[0].trim() && !args[0].startsWith('-')) {
  const agent = args[0].trim();
  if (readOnly) {
    // Policy first, token second: a failure here must never leave a full-access token behind.
    // Imported lazily so `list` and `revoke` never open the database.
    const { callVerb } = await import('../src/verbs.ts');
    await callVerb('set_agent_policy', { agent, read: true, write: false, projects: null }, { agent: 'cli', scope: 'admin' });
  }
  const { token, hash } = mintToken(agent);
  console.log(`token: ${token}`);
  console.log(`hash:  ${hash}`);
  console.log(`agent: ${agent}${readOnly ? ' (read-only, all projects)' : ''}`);
  console.log('This token is shown once and cannot be recovered; store it now. Revoke it with: token revoke <hash>');
} else if (cmd === 'list' && args.length === 0 && !readOnly) {
  for (const t of listTokens()) console.log(`${t.hash}  ${t.agent}  ${t.created_at}`);
} else if (cmd === 'revoke' && args.length === 1 && !readOnly) {
  if (!revokeToken(args[0])) {
    console.error(`no token with hash ${args[0]}`);
    process.exit(1);
  }
  console.log(`revoked ${args[0]}`);
} else {
  usage();
}
