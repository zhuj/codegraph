/** Rate-limited automatic sync for managed git hooks; manual sync bypasses it. */
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getCodeGraphDir } from '../directory';
import { loadBackgroundConfig } from '../project-config';
import { createDatabase, type SqliteDatabase } from '../db/sqlite-adapter';

interface HookLock { release(): Promise<void>; }

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function isDatabaseBusy(error: unknown): boolean {
  const value = error as { code?: string; errcode?: number; message?: string };
  return value?.errcode === 5 || value?.errcode === 6 || value?.code === 'SQLITE_BUSY' ||
    value?.code === 'SQLITE_LOCKED' || /database (?:table )?is (?:locked|busy)/i.test(value?.message ?? '');
}

function openCoordinator(file: string): SqliteDatabase {
  const { db } = createDatabase(file);
  try {
    db.exec('PRAGMA busy_timeout = 1000');
    db.exec(`CREATE TABLE IF NOT EXISTS background_owner (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      pid INTEGER NOT NULL CHECK (typeof(pid) = 'integer' AND pid > 0),
      token TEXT NOT NULL CHECK (length(token) > 0)
    )`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

async function releaseHookLock(file: string, token: string): Promise<void> {
  for (;;) {
    let db: SqliteDatabase | undefined;
    try {
      db = openCoordinator(file);
      // A delayed releaser can only delete its own lease, never a successor.
      db.prepare('DELETE FROM background_owner WHERE singleton = 1 AND token = ?').run(token);
      return;
    } catch (error) {
      if (!isDatabaseBusy(error)) throw error;
    } finally {
      db?.close();
    }
    // A contender paused inside its short ownership transaction must not
    // strand our row while this process remains alive. Keep no connection or
    // transaction open during the retry wait; process death remains recoverable.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Check/reclaim/publish ownership in one SQLite write transaction. Two stale
 * reclaimers cannot both act on the same old owner: the second reads the first
 * one's committed replacement. Interrupted transactions roll back, so no torn
 * owner record, filesystem unlink race, or recovery lock is possible.
 *
 * The connection and transaction are closed before returning the lease. Only
 * the small committed owner row remains during rate waits and actual syncing.
 */
function acquireHookLock(file: string): HookLock | 'pending' | null {
  let db: SqliteDatabase | undefined;
  let transaction = false;
  const token = randomUUID();
  try {
    db = openCoordinator(file);
    db.exec('BEGIN IMMEDIATE');
    transaction = true;
    const existing = db.prepare('SELECT pid FROM background_owner WHERE singleton = 1').get() as { pid: number } | undefined;
    if (existing && processAlive(existing.pid)) {
      db.exec('COMMIT');
      transaction = false;
      return null;
    }
    db.prepare(`INSERT INTO background_owner (singleton, pid, token) VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET pid = excluded.pid, token = excluded.token`)
      .run(process.pid, token);
    db.exec('COMMIT');
    transaction = false;
    return { release: () => releaseHookLock(file, token) };
  } catch (error) {
    if (isDatabaseBusy(error)) return 'pending';
    throw error;
  } finally {
    if (transaction) {
      try { db?.exec('ROLLBACK'); } catch { /* a crashed transaction is recovered by SQLite */ }
    }
    db?.close();
  }
}

export interface BackgroundSyncOptions {
  /** A recent foreground index/sync also satisfies the current rate window. */
  lastIndexedAt?: number | null;
}

function read(file: string): string {
  try { return fs.readFileSync(file, 'utf8').trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

/** Rename a private temporary file so readers never observe a partial value. */
function writeAtomic(file: string, value: string): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, value + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* renamed or not created */ }
  }
}

/**
 * Coalesce detached hook requests across processes and wait for the configured
 * rate window. Waiting holds only this helper's small coordination lock, never
 * a SQLite transaction or CodeGraph's writer lock. The callback still takes
 * the normal CodeGraph sync lock, so it cannot overlap a watcher/CLI write.
 *
 * Returns undefined when disabled or another hook already owns the pending
 * request. The owner picks up requests arriving during its wait or sync, so a
 * final edit is not silently lost just because it landed inside a rate window.
 */
export async function runBackgroundSync<T>(
  root: string,
  sync: () => Promise<T>,
  options: BackgroundSyncOptions = {},
): Promise<T | undefined> {
  const initial = loadBackgroundConfig(root);
  if (!initial.enabled || initial.intervalSeconds === 0) return undefined;
  const directory = getCodeGraphDir(root);
  if (!fs.existsSync(directory)) return undefined;
  const requestFile = path.join(directory, 'background-sync.request');
  const stampFile = path.join(directory, 'background-sync.timestamp');
  const lockFile = path.join(directory, 'background-sync.sqlite');
  writeAtomic(requestFile, randomUUID());
  let result: T | undefined;

  for (;;) {
    const config = loadBackgroundConfig(root);
    if (!config.enabled || config.intervalSeconds === 0) return result;
    const lock = acquireHookLock(lockFile);
    if (lock === null) return result;
    if (lock === 'pending') {
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    let consumed = '';
    try {
      for (;;) {
        const config = loadBackgroundConfig(root);
        if (!config.enabled || config.intervalSeconds === 0) return result;
        const rawStamp = Number(read(stampFile));
        const lastStarted = Number.isFinite(rawStamp) && rawStamp > 0 ? rawStamp : 0;
        const indexed = options.lastIndexedAt;
        const lastIndexed = typeof indexed === 'number' && Number.isFinite(indexed) && indexed > 0 ? indexed : 0;
        const remaining = Math.max(lastStarted, lastIndexed) + config.intervalSeconds * 1000 - Date.now();
        if (remaining <= 0) break;
        // Re-read config at least once a second: disabling background work
        // takes effect even when the old interval was several hours long.
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(remaining, 1000)));
      }
      consumed = read(requestFile);
      writeAtomic(stampFile, String(Date.now()));
      result = await sync();
    } finally {
      await lock.release();
    }

    // Check AFTER releasing: a request that races this check can acquire the
    // free lock itself. Checking before release would strand that last event.
    if (read(requestFile) === consumed) return result;
  }
}
