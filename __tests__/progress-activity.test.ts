import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import stringWidth from 'fast-string-width';
import {
  createProgressActivity, withProgressActivity, reportCurrentDirectory,
  reportCurrentFile, workerActivity, withWorkerActivity, clearCurrentActivity,
  invalidateWorkerActivity, sampleProgressActivity, beginActivityPhase, stopProgressActivity,
} from '../src/progress-activity';
import { formatProgressPath } from '../src/ui/progress-path';

const root = path.resolve('activity-test-root');

describe('sampled current-directory activity', () => {
  it('publishes current directories without depending on progress callbacks', () => {
    const activity = createProgressActivity(root);
    expect(sampleProgressActivity(activity)).toBeNull();
    withProgressActivity(activity, () => {
      reportCurrentFile(path.join(root, 'src', 'models', 'a.ts'));
      expect(sampleProgressActivity(activity)?.directory).toBe('src/models');
      const first = sampleProgressActivity(activity)!.serial;
      for (let i = 0; i < 1000; i++) reportCurrentFile(path.join(root, 'src', 'models', `${i}.ts`));
      expect(sampleProgressActivity(activity)!.serial).toBe(first); // no write for same directory
      reportCurrentDirectory('empty/no-source-files');
      expect(sampleProgressActivity(activity)?.directory).toBe('empty/no-source-files');
      reportCurrentFile('root.ts');
      expect(sampleProgressActivity(activity)?.directory).toBe('.');
    });
  });

  it('shows running workers, not queued files or ordered completion on the main thread', () => {
    const activity = createProgressActivity(root);
    withProgressActivity(activity, () => {
      reportCurrentDirectory('main');
      const worker = workerActivity(1)!;
      expect(sampleProgressActivity(activity)?.directory).toBe('main'); // merely queued
      withWorkerActivity(worker, () => reportCurrentFile('slow/actually-parsing.ts'));
      reportCurrentDirectory('main/collecting-results');
      expect(sampleProgressActivity(activity)?.directory).toBe('slow');
      withWorkerActivity(worker, () => clearCurrentActivity());
      expect(sampleProgressActivity(activity)?.directory).toBe('main/collecting-results');
      // Already-queued chunks reuse this worker handle after normal completion.
      withWorkerActivity(worker, () => reportCurrentFile('next/start.ts'));
      expect(sampleProgressActivity(activity)?.directory).toBe('next');
    });
  });

  it('samples the most recently updated active worker and falls back when it finishes', () => {
    const activity = createProgressActivity(root);
    withProgressActivity(activity, () => {
      const a = workerActivity(1)!, b = workerActivity(2)!;
      withWorkerActivity(a, () => reportCurrentDirectory('one'));
      withWorkerActivity(b, () => reportCurrentDirectory('two'));
      expect(sampleProgressActivity(activity)?.directory).toBe('two');
      withWorkerActivity(b, clearCurrentActivity);
      expect(sampleProgressActivity(activity)?.directory).toBe('one');
      invalidateWorkerActivity(a);
      expect(sampleProgressActivity(activity)).toBeNull();
      withWorkerActivity(a, () => reportCurrentDirectory('stale/crashed'));
      expect(sampleProgressActivity(activity)).toBeNull();
      withWorkerActivity(workerActivity(1), () => reportCurrentDirectory('replacement'));
      expect(sampleProgressActivity(activity)?.directory).toBe('replacement');
    });
  });

  it('clears stale paths between phases and after stop, including late worker writes', () => {
    const activity = createProgressActivity(root);
    withProgressActivity(activity, () => {
      reportCurrentDirectory('first');
      const worker = workerActivity(1)!;
      beginActivityPhase(activity);
      expect(sampleProgressActivity(activity)).toBeNull();
      withWorkerActivity(worker, () => reportCurrentDirectory('old-phase'));
      expect(sampleProgressActivity(activity)).toBeNull();
      reportCurrentDirectory('first'); // same input, new phase must still publish
      expect(sampleProgressActivity(activity)?.directory).toBe('first');
      stopProgressActivity(activity);
      reportCurrentDirectory('late');
      expect(sampleProgressActivity(activity)).toBeNull();
    });
  });

  it('keeps concurrent operations isolated and is inert without a console channel', async () => {
    const a = createProgressActivity(root), b = createProgressActivity(root);
    await Promise.all([a, b].map((activity, i) => withProgressActivity(activity, async () => {
      await new Promise(resolve => setImmediate(resolve));
      reportCurrentDirectory(`operation-${i}`);
    })));
    reportCurrentDirectory('outside');
    expect(sampleProgressActivity(a)?.directory).toBe('operation-0');
    expect(sampleProgressActivity(b)?.directory).toBe('operation-1');
    expect(workerActivity(1)).toBeUndefined();
  });

  it('bounds Unicode payloads and escapes terminal control characters', () => {
    const activity = createProgressActivity(root);
    withProgressActivity(activity, () => reportCurrentDirectory('漢😀'.repeat(2000)));
    const stored = sampleProgressActivity(activity)!.directory;
    expect(stored.length).toBeLessThanOrEqual(2048);
    expect(stored.isWellFormed()).toBe(true);
    for (const columns of [5, 10, 20, 80]) {
      const label = formatProgressPath('a\x1b[2J\r\n\t\u202eb/漢😀/'.repeat(10), columns, stringWidth);
      expect(stringWidth(label)).toBeLessThanOrEqual(columns);
      expect(label).not.toMatch(/[\x00-\x1f\x7f-\x9f\u202e]/);
      expect(label).toMatch(/^ \[.*\]$/);
    }
  });

  it('animation samples new paths while the main thread is blocked, without new update messages', () => {
    const modulePath = path.resolve(__dirname, '../dist');
    const code = `
      const { Worker } = require('node:worker_threads');
      let updates = 0;
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function(m, ...rest) {
        if (m.type === 'update') updates++;
        return post.call(this, m, ...rest);
      };
      Object.defineProperty(process.stdout, 'isTTY', { value: true });
      Object.defineProperty(process.stdout, 'columns', { value: 100 });
      const { createShimmerProgress } = require(${JSON.stringify(modulePath + '/ui/shimmer-progress.js')});
      const { withProgressActivity, reportCurrentDirectory } = require(${JSON.stringify(modulePath + '/progress-activity.js')});
      (async () => {
        const ui = createShimmerProgress(process.cwd());
        const busy = (ms) => { const end = performance.now() + ms; while(performance.now() < end) {} };
        await withProgressActivity(ui.activity, async () => {
          ui.onProgress({phase:'linking', current:1, total:10});
          await new Promise(resolve => setTimeout(resolve, 200));
          reportCurrentDirectory('during/first'); busy(250);
          reportCurrentDirectory('during/second'); busy(250);
          // There is no onProgress or postMessage between these directory writes.
        });
        await ui.stop();
        process.stderr.write('updates=' + updates);
      })().catch(e => { console.error(e); process.exit(1); });
    `;
    const result = spawnSync(process.execPath, ['-e', code], {
      encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, NO_COLOR: '1' },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('updates=1');
    expect(result.stdout).toContain('[during/first]');
    expect(result.stdout).toContain('[during/second]');
  }, 20_000);
});
