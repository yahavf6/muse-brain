// Imported FIRST in brain.test.ts (before src/verbs.ts or src/server.ts) so BRAIN_DB and
// BRAIN_LOG_DIR are set before those modules' top-level code runs -- ES module evaluation
// visits import declarations in written order, so this side effect lands before theirs.
// Without this, importing verbs.ts alone opens (and creates) ~/.brain/brain.db, and
// importing server.ts creates ~/.brain/logs -- npm test must never touch real brain data.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testHome = mkdtempSync(join(tmpdir(), 'brain-test-home-'));
export const TEST_LOG_DIR = join(testHome, 'logs');
export const TEST_DB = join(testHome, 'brain.db');
process.env.BRAIN_DB = TEST_DB;
process.env.BRAIN_LOG_DIR = TEST_LOG_DIR;
process.env.BRAIN_TOKENS_FILE = join(testHome, 'tokens.json');
// server.ts loads ~/.brain/.env, which never overrides a key that is already set: pin these so a
// developer's real .env cannot start a public listener or rebind anything under test.
process.env.BRAIN_PUBLIC_PORT = '';
process.env.BRAIN_HOST = '';
