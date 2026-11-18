import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  activityEpoch, beginActivityPhase, createProgressActivity,
  reportCurrentDirectory, withProgressActivity,
} from '../src/progress-activity';
import { ShimmerState } from '../src/ui/shimmer-state';
import type { ShimmerProgress } from '../src/ui/shimmer-progress';

const root = path.resolve('shimmer-cadence-fixture');

/**
 * Exercise the shipped worker/wrapper with only their process boundaries
 * replaced. A controlled clock avoids timing tolerances or slow-machine flakes;
 * the actual shared-state and directory sampling implementations remain in use.
 */
function loadBuilt<T>(file: string, overrides: Record<string, unknown>, globals: Record<string, unknown>): T {
  const filename = path.resolve(__dirname, '../dist/ui', file);
  const originalRequire = createRequire(filename);
  const module = { exports: {} };
  const evaluate = runInNewContext(
    `(function(require, module, exports, __dirname, __filename) {\n${readFileSync(filename, 'utf8')}\n})`,
    { process, console, Buffer, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, ...globals },
    { filename },
  );
  evaluate(
    (id: string) => Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : originalRequire(id),
    module, module.exports, path.dirname(filename), filename,
  );
  return module.exports as T;
}

function workerHarness(colors = false) {
  let now = 0;
  let interval: (() => void) | undefined;
  let intervalMs = 0;
  let running = false;
  const writes: string[] = [];
  const port = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
  const activity = createProgressActivity(root);
  const progress = new ShimmerState();
  loadBuilt('shimmer-worker.js', {
    worker_threads: {
      parentPort: port,
      workerData: { startTime: 0, colors, activity, progress: progress.buffer, columns: 120 },
    },
    fs: { writeSync: (_fd: number, text: string) => { writes.push(text); return text.length; } },
    '../worker-teardown': { collectBeforeExit: vi.fn() },
  }, {
    Date: class extends Date { static now() { return now; } },
    setInterval(callback: () => void, ms: number) {
      expect(interval).toBeUndefined(); // one clock, no separate path/count timer
      interval = callback;
      intervalMs = ms;
      running = true;
      return 1;
    },
    clearInterval() { running = false; },
  });
  return {
    writes, port, progress, activity,
    get intervalMs() { return intervalMs; },
    tick(time: number) { now = time; if (running) interval!(); },
    directory(value: string) { withProgressActivity(activity, () => reportCurrentDirectory(value)); },
    update(phaseName: string, count: number, percent = -1) {
      progress.update({ phaseName, percent, count, epoch: activityEpoch(activity) });
    },
  };
}

function mainHarness(isTTY = true) {
  const writes: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    isTTY, columns: 100,
    write(text: string) { writes.push(text); return true; },
  });
  const workers: FakeWorker[] = [];
  class FakeWorker extends EventEmitter {
    readonly messages: Array<{ type: string }> = [];
    readonly workerData: { progress: SharedArrayBuffer; colors: boolean };
    constructor(_filename: string, options: { workerData: FakeWorker['workerData'] }) {
      super();
      this.workerData = options.workerData;
      workers.push(this);
    }
    postMessage(message: { type: string }) {
      this.messages.push(message);
      if (message.type === 'stop') queueMicrotask(() => this.emit('message', { type: 'stopped' }));
    }
    terminate = vi.fn(async () => { this.emit('exit', 0); return 0; });
  }
  const { createShimmerProgress } = loadBuilt<{ createShimmerProgress(root: string): ShimmerProgress }>(
    'shimmer-progress.js', { worker_threads: { Worker: FakeWorker } },
    { process: { stdout, cwd: () => root } },
  );
  const ui = createShimmerProgress(root);
  // The explicit ready signal, rather than a synthetic "online" event, covers
  // the production startup/teardown handshake used on Windows.
  workers[0]?.emit('message', { type: 'ready' });
  return { ui, writes, stdout, workers };
}

afterEach(() => vi.unstubAllEnvs());

describe('progress output follows the animation clock', () => {
  it('reads bounded complete snapshots without waiting for a concurrent writer', () => {
    const writer = new ShimmerState();
    const reader = new ShimmerState(writer.buffer);
    expect(reader.sample()).toBeNull();
    writer.update({ phaseName: 'x'.repeat(511) + '😀', percent: -1, count: 2 ** 32 + 1, epoch: 7 });
    const first = reader.sample()!;
    expect(first.phaseName.length).toBeLessThanOrEqual(512);
    expect(first.phaseName.isWellFormed()).toBe(true);
    expect(first).toMatchObject({ percent: -1, count: 2 ** 32 + 1, epoch: 7 });

    // Hold the shared version at "writer in flight". The read must return
    // immediately so a stalled producer can never block the animation timer.
    const version = new Int32Array(writer.buffer, 0, 1);
    Atomics.add(version, 0, 1);
    expect(reader.sample()).toBeNull();
    Atomics.add(version, 0, 1);
    writer.update({ phaseName: 'Parsing code', percent: 42, count: 0, epoch: 8 });
    expect(reader.sample()).toEqual({ phaseName: 'Parsing code', percent: 42, count: 0, epoch: 8 });
  });

  it('coalesces directory and number bursts until the next animation change', () => {
    const h = workerHarness(true);
    expect(h.intervalMs).toBe(150);
    for (let i = 1; i <= 1000; i++) {
      h.update('Scanning files', i);
      h.directory(`src/folder-${i}`);
    }
    expect(h.writes).toEqual([]);

    h.tick(150);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toContain('1,000 found');
    expect(h.writes[0]).toContain('[src/folder-1000]');

    h.update('Scanning files', 1001);
    h.directory('src/latest');
    h.tick(151);
    h.tick(299);
    expect(h.writes).toHaveLength(1); // same animation frame, even if polled again

    h.tick(300);
    expect(h.writes).toHaveLength(2);
    expect(h.writes[1]).toContain('1,001 found');
    expect(h.writes[1]).toContain('[src/latest]');
    h.port.emit('message', { type: 'stop' });
  });

  it('samples phase, percent, directory, and resize together without immediate writes', () => {
    const h = workerHarness();
    h.update('Scanning files', 5);
    h.directory('scan');
    h.tick(150);

    beginActivityPhase(h.activity);
    h.update('Parsing code', 0, 73);
    h.directory('src/new-phase');
    // Leave room even for the worker's conservative pre-import width estimate.
    h.port.emit('message', { type: 'resize', columns: 100 });
    expect(h.writes).toHaveLength(1);

    h.tick(300);
    expect(h.writes).toHaveLength(1); // NO_COLOR: star shape has not changed yet
    h.tick(450);
    expect(h.writes).toHaveLength(2);
    expect(h.writes[1]).toContain('Parsing code');
    expect(h.writes[1]).toContain('73%');
    expect(h.writes[1]).toContain('[src/new-phase]');
    expect(h.writes[1]).not.toContain('[scan]');
    // NO_COLOR still allows cursor rewriting, but never emits SGR styling.
    expect(h.writes.join('')).not.toMatch(/\x1b\[[0-9;]*m/);
    h.port.emit('message', { type: 'stop' });
    const stoppedWrites = h.writes.length;
    h.tick(600);
    expect(h.writes).toHaveLength(stoppedWrites);
  });

  it('keeps the original three-animation-frame star cadence', () => {
    const h = workerHarness();
    h.update('Linking dynamic dispatch', 0);
    for (const time of [150, 300, 450, 600, 750, 900]) h.tick(time);
    expect(h.writes).toHaveLength(3);
    // With no colors, redundant frames are skipped until the star itself changes.
    expect(h.writes[0]).not.toBe(h.writes[1]);
    expect(h.writes[1]).not.toBe(h.writes[2]);
    h.port.emit('message', { type: 'stop' });
  });

  it('processing callbacks only replace state and final completion lines flush once', async () => {
    vi.stubEnv('NO_COLOR', '1');
    const h = mainHarness();
    const worker = h.workers[0]!;
    expect(worker.workerData.colors).toBe(false);
    for (let i = 1; i <= 1000; i++) h.ui.onProgress({ phase: 'scanning', current: i, total: 0 });
    h.ui.onProgress({ phase: 'parsing', current: 1, total: 10 });
    h.ui.onProgress({ phase: 'parsing', current: 7, total: 10 });
    expect(h.writes).toEqual([]);
    expect(worker.messages).toEqual([]);
    expect(new ShimmerState(worker.workerData.progress).sample()).toMatchObject({
      phaseName: 'Parsing code', percent: 70, count: 0,
    });

    h.stdout.emit('resize');
    expect(h.writes).toEqual([]);
    expect(worker.messages.map(message => message.type)).toEqual(['resize']);

    const stopped = h.ui.stop();
    h.ui.onProgress({ phase: 'linking', current: 2, total: 10 });
    await Promise.all([stopped, h.ui.stop()]);
    await h.ui.stop();
    const output = h.writes.join('');
    expect(output.match(/Scanning files/g)).toHaveLength(1);
    expect(output).toContain('1,000 found');
    expect(output.match(/Parsing code/g)).toHaveLength(1);
    expect(output).not.toContain('Linking dynamic dispatch');
    expect(output).not.toMatch(/\x1b\[[0-9;]*m/);
    expect(worker.messages.filter(message => message.type === 'stop')).toHaveLength(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(h.stdout.listenerCount('resize')).toBe(0);
    const finalWriteCount = h.writes.length;
    h.ui.onProgress({ phase: 'scanning', current: 2000, total: 0 });
    h.stdout.emit('resize');
    expect(h.writes).toHaveLength(finalWriteCount);
  });

  it('keeps redirected output plain and creates no animation worker', async () => {
    const h = mainHarness(false);
    h.ui.onProgress({ phase: 'scanning', current: 1, total: 0 });
    h.ui.onProgress({ phase: 'scanning', current: 99, total: 0 });
    h.ui.onProgress({ phase: 'parsing', current: 1, total: 1 });
    await h.ui.stop();
    expect(h.workers).toEqual([]);
    expect(h.writes).toEqual(['Scanning files...\n', 'Parsing code...\n']);
    expect(h.writes.join('')).not.toMatch(/[\r\x1b]/);
  });
});
