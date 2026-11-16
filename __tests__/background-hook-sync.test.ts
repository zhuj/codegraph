import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { createDatabase } from '../src/db/sqlite-adapter';
import { getWorkspaceConfigPath, clearProjectConfigCache } from '../src/project-config';
import { runBackgroundSync } from '../src/sync/background-sync';

function coordinatorPath(root: string): string {
  return path.join(root, '.codegraph', 'background-sync.sqlite');
}

function owner(root: string): { pid: number; token: string } | undefined {
  if (!fs.existsSync(coordinatorPath(root))) return undefined;
  const { db } = createDatabase(coordinatorPath(root), { readOnly: true });
  try { return db.prepare('SELECT pid, token FROM background_owner WHERE singleton = 1').get(); }
  finally { db.close(); }
}

async function seedOwner(root: string, pid: number, token: string): Promise<void> {
  await runBackgroundSync(root, async () => true);
  fs.unlinkSync(path.join(root, '.codegraph', 'background-sync.timestamp'));
  const { db } = createDatabase(coordinatorPath(root));
  try { db.prepare('INSERT INTO background_owner (singleton, pid, token) VALUES (1, ?, ?)').run(pid, token); }
  finally { db.close(); }
}

function deadPid(): number {
  const exited = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  if (exited.error || exited.status !== 0) throw exited.error ?? new Error('Could not create exited test process');
  return exited.pid;
}

describe('managed hook background sync', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-hook-rate-'));
    fs.mkdirSync(path.join(root, '.codegraph'));
    configure('intervalSeconds: 5');
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
    clearProjectConfigCache();
    fs.rmSync(root, { recursive: true, force: true });
  });
  function configure(setting: string): void {
    fs.writeFileSync(getWorkspaceConfigPath(root), `background: { ${setting} }\n`);
    clearProjectConfigCache();
  }

  it('persists the rate across invocations and eventually processes the final request', async () => {
    const sync = vi.fn().mockResolvedValue('synced');
    expect(await runBackgroundSync(root, sync)).toBe('synced');
    const next = runBackgroundSync(root, sync);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await next).toBe('synced');
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent hooks while waiting after a recent foreground index', async () => {
    const sync = vi.fn().mockResolvedValue(true);
    const first = runBackgroundSync(root, sync, { lastIndexedAt: Date.now() });
    expect(await runBackgroundSync(root, sync)).toBeUndefined();
    expect(sync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await first).toBe(true);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(owner(root)).toBeUndefined();
  });

  it('schedules a second pass for a request arriving during the current sync', async () => {
    let finish!: (value: number) => void;
    const sync = vi.fn()
      .mockImplementationOnce(() => new Promise<number>((resolve) => { finish = resolve; }))
      .mockResolvedValue(2);
    const running = runBackgroundSync(root, sync);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(await runBackgroundSync(root, sync)).toBeUndefined();
    finish(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await running).toBe(2);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('stops within one second when background work is disabled during a wait', async () => {
    const sync = vi.fn().mockResolvedValue(true);
    const running = runBackgroundSync(root, sync, { lastIndexedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(2_000);
    configure('enabled: false');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await running).toBeUndefined();
    expect(sync).not.toHaveBeenCalled();
    expect(owner(root)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['enabled: false', 'intervalSeconds: 0'])('does no work or coordination writes with %s', async (setting) => {
    configure(setting);
    const sync = vi.fn();
    expect(await runBackgroundSync(root, sync)).toBeUndefined();
    expect(sync).not.toHaveBeenCalled();
    expect(fs.readdirSync(path.join(root, '.codegraph'))).toEqual(['config.yaml']);
  });

  it('releases the coordination lock when syncing fails', async () => {
    const sync = vi.fn().mockRejectedValue(new Error('failed sync'));
    await expect(runBackgroundSync(root, sync)).rejects.toThrow('failed sync');
    expect(owner(root)).toBeUndefined();
  });

  it('fails closed on a corrupt coordinator database without deleting it', async () => {
    const file = coordinatorPath(root);
    fs.writeFileSync(file, 'not a SQLite database');
    const sync = vi.fn();
    await expect(runBackgroundSync(root, sync)).rejects.toThrow(/database|SQLite/i);
    expect(sync).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe('not a SQLite database');
  });

  it('atomically reclaims the committed record of an exited owner', async () => {
    await seedOwner(root, deadPid(), 'exited-owner');
    const sync = vi.fn().mockResolvedValue(true);
    expect(await runBackgroundSync(root, sync)).toBe(true);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(owner(root)).toBeUndefined();
  });

  it('does not steal a committed record belonging to a live process', async () => {
    await seedOwner(root, process.pid, 'another-owner');
    const sync = vi.fn();
    expect(await runBackgroundSync(root, sync)).toBeUndefined();
    expect(sync).not.toHaveBeenCalled();
    expect(owner(root)).toEqual({ pid: process.pid, token: 'another-owner' });
  });
});

/** Real child processes prove SQLite serialization and crash recovery, not mocks. */
describe('background ownership across processes', () => {
  let root: string;
  const children: ChildProcess[] = [];
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-hook-ownership-'));
    fs.mkdirSync(path.join(root, '.codegraph'));
    fs.writeFileSync(getWorkspaceConfigPath(root), 'background: { intervalSeconds: 0.001 }\n');
  });
  afterEach(async () => {
    await Promise.all(children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await exited;
    }));
    clearProjectConfigCache();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function child(script: string, args: string[] = []) {
    const process = spawn(globalThis.process.execPath, ['-e', script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.push(process);
    const messages: string[] = [];
    let stderr = '';
    process.stdout!.resume();
    process.stderr!.on('data', (data) => { stderr += data; });
    process.on('message', (message) => { messages.push(String(message)); });
    const received = (wanted: string): Promise<void> => new Promise((resolve, reject) => {
      const deadline = Date.now() + 15_000;
      const check = () => {
        if (messages.includes(wanted)) { resolve(); return; }
        if (process.exitCode !== null || process.signalCode !== null || Date.now() > deadline) {
          reject(new Error(`Child did not send ${wanted}: ${stderr}`));
          return;
        }
        setTimeout(check, 10);
      };
      check();
    });
    return { process, messages, received };
  }

  it('serializes two stale reclaimers even when the first pauses after reading the dead owner', async () => {
    const stalePid = deadPid();
    await seedOwner(root, stalePid, 'stale-record');
    const barrier = path.join(root, 'release-first-reclaimer');
    const module = path.resolve(__dirname, '../dist/sync/background-sync.js');
    const script = `
      const fs = require('fs');
      const { runBackgroundSync } = require(process.argv[1]);
      const [root, stalePid, barrier, pause] = process.argv.slice(2);
      const kill = process.kill.bind(process);
      let paused = false;
      process.kill = (pid, signal) => {
        if (pause === 'yes' && !paused && pid === Number(stalePid) && signal === 0) {
          paused = true;
          process.send('read-stale');
          const deadline = Date.now() + 10000;
          const gate = new Int32Array(new SharedArrayBuffer(4));
          while (!fs.existsSync(barrier)) {
            if (Date.now() > deadline) throw new Error('reclaimer barrier timed out');
            Atomics.wait(gate, 0, 0, 20);
          }
        }
        return kill(pid, signal);
      };
      process.send('starting');
      runBackgroundSync(root, async () => {
        process.send('sync-start');
        await new Promise(resolve => process.once('message', resolve));
        process.send('sync-end');
      }).then(() => { process.send('done'); process.disconnect(); })
        .catch(error => { console.error(error); process.exit(1); });
    `;
    const first = child(script, [module, root, String(stalePid), barrier, 'yes']);
    await first.received('read-stale');
    const second = child(script, [module, root, String(stalePid), barrier, 'no']);
    await second.received('starting');
    // The second process gets a full opportunity to contend on BEGIN IMMEDIATE
    // while the first is paused at the exact stale-owner decision boundary.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(first.messages).not.toContain('sync-start');
    expect(second.messages).not.toContain('sync-start');
    expect(owner(root)?.token).toBe('stale-record');
    fs.writeFileSync(barrier, 'continue');
    await first.received('sync-start');
    await second.received('done');
    expect(second.messages).not.toContain('sync-start');
    expect(owner(root)?.pid).toBe(first.process.pid);
    first.process.send('finish');
    await first.received('done');
    expect(owner(root)).toBeUndefined();
  }, 30_000);

  it.each(['uncommitted', 'committed'])('recovers after an owner crashes with %s state', async (state) => {
    await seedOwner(root, deadPid(), 'previous-dead-owner');
    const writer = child(`
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN IMMEDIATE');
      db.prepare('UPDATE background_owner SET pid = ?, token = ? WHERE singleton = 1')
        .run(process.pid, 'crashing-owner');
      if (process.argv[2] === 'committed') db.exec('COMMIT');
      process.send('transaction-ready');
      setInterval(() => {}, 1000);
    `, [coordinatorPath(root), state]);
    await writer.received('transaction-ready');
    const exited = new Promise<void>((resolve) => writer.process.once('exit', () => resolve()));
    writer.process.kill('SIGKILL');
    await exited;
    const sync = vi.fn().mockResolvedValue(true);
    expect(await runBackgroundSync(root, sync)).toBe(true);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(owner(root)).toBeUndefined();
  }, 30_000);

  it('retries release after a contender holds a transaction past the SQLite busy timeout', async () => {
    let finish!: (value: boolean) => void;
    const running = runBackgroundSync(root, () => new Promise<boolean>((resolve) => { finish = resolve; }));
    const blocker = child(`
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN IMMEDIATE');
      process.send('transaction-ready');
      process.once('message', () => {
        setTimeout(() => {
          db.exec('COMMIT');
          db.close();
          process.send('done');
          process.disconnect();
        }, 1600);
        process.send('holding');
      });
    `, [coordinatorPath(root)]);
    await blocker.received('transaction-ready');
    blocker.process.send('contend-with-release');
    await blocker.received('holding');
    finish(true);
    await expect(running).resolves.toBe(true);
    await blocker.received('done');
    expect(owner(root)).toBeUndefined();
  }, 30_000);
});
