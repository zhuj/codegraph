/**
 * Best-effort current-directory state for a console progress animation.
 * Producers only replace a bounded shared-memory snapshot. The animation
 * samples it on its own clock; there are no per-path messages, locks, waits,
 * or terminal writes on the indexing path. Not part of index correctness.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import * as path from 'node:path';

const SLOTS = 33; // main thread + up to 16 parsers + up to 16 resolvers
const PATH_UNITS = 2048;
const HEADER_INTS = 4;
const SLOT_INTS = 6 + PATH_UNITS / 2;
const VERSION = 0, GENERATION = 1, EPOCH = 2, SERIAL = 3, LENGTH = 4, TOKEN = 5;

export interface ProgressActivity {
  buffer: SharedArrayBuffer;
  root: string;
}

/** Structured-cloneable handle; one active producer per worker slot. */
export interface WorkerActivity extends ProgressActivity {
  slot: number;
  epoch: number;
  token: number;
}

export function createProgressActivity(root: string): ProgressActivity {
  return { root: path.resolve(root), buffer: new SharedArrayBuffer((HEADER_INTS + SLOTS * SLOT_INTS) * 4) };
}

export function activityEpoch(activity: ProgressActivity): number {
  return Atomics.load(new Int32Array(activity.buffer), 0);
}

/** Phase transitions invalidate old worker snapshots without waiting for them. */
export function beginActivityPhase(activity: ProgressActivity): void {
  Atomics.add(new Int32Array(activity.buffer), 0, 1);
}

export function stopProgressActivity(activity: ProgressActivity): void {
  Atomics.store(new Int32Array(activity.buffer), 2, 1);
  beginActivityPhase(activity);
}

class ActivityWriter {
  private readonly all: Int32Array;
  private readonly header: Int32Array;
  private readonly text: Uint16Array;
  private lastPath: string | undefined;
  private lastFile: string | undefined;
  private lastEpoch = -1;

  constructor(readonly activity: ProgressActivity | WorkerActivity) {
    this.all = new Int32Array(activity.buffer);
    const slot = 'slot' in activity ? activity.slot : 0;
    const offset = HEADER_INTS + slot * SLOT_INTS;
    this.header = new Int32Array(activity.buffer, offset * 4, 6);
    this.text = new Uint16Array(activity.buffer, (offset + 6) * 4, PATH_UNITS);
  }

  directory(dir: string): void {
    this.lastFile = undefined;
    const epoch = 'epoch' in this.activity ? this.activity.epoch : Atomics.load(this.all, 0);
    if (Atomics.load(this.all, 2) !== 0 || epoch !== Atomics.load(this.all, 0)) return;
    const token = 'token' in this.activity ? this.activity.token : 0;
    if (Atomics.load(this.header, GENERATION) !== token) return;
    if (dir === this.lastPath && epoch === this.lastEpoch) return;
    this.lastPath = dir;
    this.lastEpoch = epoch;
    const relative = path.isAbsolute(dir) ? path.relative(this.activity.root, dir) : dir;
    let value = relative.replace(/\\/g, '/') || '.';
    if (value.length > PATH_UNITS) {
      let suffix = value.slice(-(PATH_UNITS - 3));
      if (/[\uDC00-\uDFFF]/.test(suffix[0]!)) suffix = suffix.slice(1);
      value = '...' + suffix;
    }
    const length = value.length;
    Atomics.add(this.header, VERSION, 1); // odd = in flight; readers never spin
    for (let i = 0; i < length; i++) this.text[i] = value.charCodeAt(i);
    Atomics.store(this.header, EPOCH, epoch);
    Atomics.store(this.header, TOKEN, token);
    Atomics.store(this.header, LENGTH, length);
    Atomics.store(this.header, SERIAL, Atomics.add(this.all, 1, 1) + 1);
    Atomics.add(this.header, VERSION, 1);
  }

  file(file: string): void {
    const epoch = Atomics.load(this.all, 0);
    if (file === this.lastFile && epoch === this.lastEpoch) return;
    this.directory(path.dirname(file.replace(/\\/g, '/')));
    this.lastFile = file;
  }

  clear(): void {
    // The same worker owns this payload until the job finishes. A later queued
    // chunk can reuse the slot/token; only crashes invalidate the token.
    if ('slot' in this.activity && Atomics.load(this.header, GENERATION) === this.activity.token) {
      Atomics.add(this.header, VERSION, 1);
      Atomics.store(this.header, LENGTH, 0);
      Atomics.add(this.header, VERSION, 1);
    }
  }
}

const current = new AsyncLocalStorage<ActivityWriter>();

/** Scope the optional UI state to one operation, never a process-wide last path. */
export function withProgressActivity<T>(activity: ProgressActivity | undefined, work: () => T): T {
  return activity ? current.run(new ActivityWriter(activity), work) : work();
}

export function reportCurrentFile(file: string): void { current.getStore()?.file(file); }
export function reportCurrentDirectory(dir: string): void { current.getStore()?.directory(dir); }

/** Called at dispatch; only the worker reports when it actually STARTS work. */
export function workerActivity(slot: number): WorkerActivity | undefined {
  const activity = current.getStore()?.activity;
  if (!activity || slot < 1 || slot >= SLOTS) return undefined;
  const all = new Int32Array(activity.buffer);
  return {
    buffer: activity.buffer, root: activity.root, slot,
    epoch: Atomics.load(all, 0),
    token: Atomics.load(all, HEADER_INTS + slot * SLOT_INTS + GENERATION),
  };
}

/** Drop a crashed/terminated worker's last path from the next animation frame. */
export function invalidateWorkerActivity(activity: WorkerActivity | undefined): void {
  if (!activity) return;
  const all = new Int32Array(activity.buffer);
  Atomics.compareExchange(all, HEADER_INTS + activity.slot * SLOT_INTS + GENERATION, activity.token, activity.token + 1);
}

export function withWorkerActivity<T>(activity: WorkerActivity | undefined, work: () => T): T {
  if (!activity) return work();
  const writer = new ActivityWriter(activity);
  return current.run(writer, work);
}

/** Run this from worker finally blocks; never retain a completed path as active. */
export function clearCurrentActivity(): void { current.getStore()?.clear(); }

export interface ActivitySnapshot { directory: string; epoch: number; serial: number; slot: number }

/**
 * Single, bounded read attempt per slot: skip a torn/in-flight value and try
 * again next frame. Workers take precedence over the main thread's prefetch /
 * ordered result-admission path. Among workers, show the most recently active.
 */
export function sampleProgressActivity(activity: ProgressActivity): ActivitySnapshot | null {
  const all = new Int32Array(activity.buffer);
  if (Atomics.load(all, 2)) return null;
  const epoch = Atomics.load(all, 0);
  let selected: ActivitySnapshot | null = null;
  for (let slot = 0; slot < SLOTS; slot++) {
    const offset = HEADER_INTS + slot * SLOT_INTS;
    const h = new Int32Array(activity.buffer, offset * 4, 6);
    const version = Atomics.load(h, VERSION);
    if (version & 1 || Atomics.load(h, EPOCH) !== epoch) continue;
    const token = Atomics.load(h, TOKEN);
    if (Atomics.load(h, GENERATION) !== token) continue;
    const length = Atomics.load(h, LENGTH);
    if (length <= 0 || length > PATH_UNITS) continue;
    const serial = Atomics.load(h, SERIAL);
    if (selected && selected.slot > 0 && (serial - selected.serial | 0) <= 0) continue;
    const text = new Uint16Array(activity.buffer, (offset + 6) * 4, length);
    const directory = String.fromCharCode(...text);
    if (version !== Atomics.load(h, VERSION) || token !== Atomics.load(h, GENERATION)) continue;
    selected = { directory, epoch, serial, slot };
  }
  return epoch === Atomics.load(all, 0) && !Atomics.load(all, 2) ? selected : null;
}
