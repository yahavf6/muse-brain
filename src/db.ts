import { DatabaseSync, backup } from 'node:sqlite';
import { readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, 'schema.sql');
export const DEFAULT_DB = join(homedir(), '.brain', 'brain.db');
export const BACKUP_DIR = join(homedir(), '.brain', 'backups');
const KEEP_BACKUPS = 14;

export function openDb(path: string = process.env.BRAIN_DB ?? DEFAULT_DB): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

export async function backupDaily(db: DatabaseSync): Promise<void> {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const dest = join(BACKUP_DIR, `brain-${today}.db`);
  if (!existsSync(dest)) await backup(db, dest);
  const files = readdirSync(BACKUP_DIR).filter((f) => /^brain-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP_BACKUPS))) unlinkSync(join(BACKUP_DIR, f));
}
