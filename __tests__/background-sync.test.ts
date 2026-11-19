import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import CodeGraph from '../src/index';
import { acquireProject, type ProjectLease } from '../src/mcp/project-lifecycle';
import { clearProjectConfigCache, getWorkspaceConfigPath } from '../src/project-config';
import { FileWatcher, __emitWatchEventForTests, __setFsWatchForTests } from '../src/sync/watcher';

describe('workspace background resync rate', () => {
  let root: string;
  let watcher: FileWatcher | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-background-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, '.codegraph'));
    fs.writeFileSync(path.join(root, 'src', 'sample.ts'), 'export const original = 1;');
    vi.useFakeTimers();
  });

  afterEach(() => {
    watcher?.stop();
    watcher = undefined;
    __setFsWatchForTests(null);
    vi.unstubAllEnvs();
    vi.useRealTimers();
    clearProjectConfigCache();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function config(text: string): void {
    fs.writeFileSync(getWorkspaceConfigPath(root), text);
    clearProjectConfigCache();
  }

  function start(sync = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 })) {
    watcher = new FileWatcher(root, sync, { debounceMs: 100, inertForTests: true });
    expect(watcher.start()).toBe(true);
    return sync;
  }

  it('coalesces events at the configured rate and periodically reconciles without events', async () => {
    config('directories: [src]\nbackground:\n  intervalSeconds: 5\n');
    const sync = start();
    watcher!.ingestEventForTests('src/sample.ts');
    await vi.advanceTimersByTimeAsync(4_000);
    watcher!.ingestEventForTests('src/sample.ts');
    await vi.advanceTimersByTimeAsync(999);
    expect(sync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenLastCalledWith(undefined);
    // No event is emitted for this interval: the full reconcile still runs.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenLastCalledWith(undefined);
  });

  it('retains the legacy save debounce without an explicit background stanza', async () => {
    config('directories: [src]\n');
    const sync = start();
    watcher!.ingestEventForTests('src/sample.ts');
    await vi.advanceTimersByTimeAsync(100);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith(['src/sample.ts']);
    await vi.advanceTimersByTimeAsync(29_900);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenLastCalledWith(undefined);
  });

  it('never overlaps slow automatic syncs and stops all future work on shutdown', async () => {
    config('background: { intervalSeconds: 1 }\n');
    let finish!: (result: { filesChanged: number; durationMs: number }) => void;
    const sync = vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    start(sync);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sync).toHaveBeenCalledTimes(1);
    finish({ filesChanged: 1, durationMs: 4_000 });
    await vi.advanceTimersByTimeAsync(100);
    expect(sync).toHaveBeenCalledTimes(2);
    watcher!.stop();
    finish({ filesChanged: 0, durationMs: 0 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['enabled: false', 'intervalSeconds: 0'])('disables automatic work with %s', async (setting) => {
    config(`background: { ${setting} }\n`);
    const sync = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
    watcher = new FileWatcher(root, sync, { inertForTests: true });
    expect(watcher.start()).toBe(false);
    watcher.ingestEventForTests('src/sample.ts');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sync).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('loads edits inside the otherwise ignored data directory before the next scan', async () => {
    config('background: { intervalSeconds: 10 }\n');
    const sync = start();
    await vi.advanceTimersByTimeAsync(2_000);
    config('background: { intervalSeconds: 5 }\nexclude: [src]\n');
    watcher!.ingestEventForTests('.codegraph/config.yaml');
    await vi.advanceTimersByTimeAsync(2_999);
    expect(sync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sync).toHaveBeenCalledTimes(1);
    config('background: { enabled: false }\n');
    // Deliberately omit the config watcher event: the next timer must notice.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(watcher!.isActive()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails closed if a running workspace config becomes invalid', async () => {
    config('background: { intervalSeconds: 1 }\n');
    const sync = start();
    config('directories: [/outside]\n');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sync).not.toHaveBeenCalled();
    expect(watcher!.isDegraded()).toBe(true);
    expect(watcher!.getDegradedReason()).toContain('Invalid workspace');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps notification-only consumers immediate without periodic work', async () => {
    config('background: { enabled: false }\n');
    const notify = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
    watcher = new FileWatcher(root, notify, { backgroundSync: false, inertForTests: true, debounceMs: 100 });
    expect(watcher.start()).toBe(true);
    watcher.ingestEventForTests('src/sample.ts');
    await vi.advanceTimersByTimeAsync(100);
    expect(notify).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.runIf(process.platform === 'linux')('rate-limits rescanning directory topology after native events', async () => {
    config('background: { intervalSeconds: 1 }\n');
    const callbacks = new Map<string, (event: string, file: string) => void>();
    __setFsWatchForTests(((dir: fs.PathLike, _options: unknown, callback: (event: string, file: string) => void) => {
      callbacks.set(String(dir), callback);
      const handle = new EventEmitter() as fs.FSWatcher;
      handle.close = () => { callbacks.delete(String(dir)); };
      return handle;
    }) as typeof fs.watch);
    const sync = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
    watcher = new FileWatcher(root, sync);
    expect(watcher.start()).toBe(true);
    const added = path.join(root, 'new-source');
    fs.mkdirSync(added);
    fs.writeFileSync(path.join(added, 'new.ts'), 'export const added = 1;');
    callbacks.get(root)!('rename', 'new-source');
    await vi.advanceTimersByTimeAsync(500);
    config('background: { intervalSeconds: 5 }\n');
    watcher.ingestEventForTests('.codegraph/config.yaml');
    await vi.advanceTimersByTimeAsync(4_499);
    expect(callbacks.has(added)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(callbacks.has(added)).toBe(true);
  });

  it('does not broaden a running home workspace after its configured scope is removed', async () => {
    vi.stubEnv('HOME', root);
    vi.stubEnv('USERPROFILE', root);
    config('directories: [src]\nbackground: { intervalSeconds: 1 }\n');
    const sync = start();
    config('directories: ["."]\nbackground: { intervalSeconds: 1 }\n');
    watcher!.ingestEventForTests('.codegraph/config.yaml');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sync).not.toHaveBeenCalled();
    expect(watcher!.isPausedByConfig()).toBe(true);
    expect(watcher!.isActive()).toBe(false);
  });
});

describe('disabled background work preserves foreground indexing', () => {
  it('skips MCP startup sync and still runs explicit index and sync immediately', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-manual-sync-'));
    let cg: CodeGraph | undefined;
    let lease: ProjectLease | undefined;
    try {
      fs.mkdirSync(path.join(root, 'src'));
      fs.mkdirSync(path.join(root, '.codegraph'));
      fs.writeFileSync(getWorkspaceConfigPath(root), 'directories: [src]\nbackground: { enabled: false }\n');
      fs.writeFileSync(path.join(root, 'src', 'sample.ts'), 'export function original() { return 1; }');
      cg = CodeGraph.initSync(root);
      await cg.indexAll();
      fs.writeFileSync(path.join(root, 'src', 'sample.ts'), 'export function updated() { return 2; }');
      const sync = vi.spyOn(cg, 'sync');
      lease = acquireProject(root, () => cg!, { inertForTests: true });
      await lease.ready();
      expect(sync).not.toHaveBeenCalled();
      expect(cg.isWatching()).toBe(false);
      expect(cg.getNodesByKind('function').map((node) => node.name)).toContain('original');
      await cg.sync();
      expect(sync).toHaveBeenCalledTimes(1);
      expect(cg.getNodesByKind('function').map((node) => node.name)).toContain('updated');
    } finally {
      if (lease) await lease.release();
      else cg?.close();
      vi.restoreAllMocks();
      clearProjectConfigCache();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it.each([true, false])('does not run MCP startup catch-up with watch=%s', async (watch) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-disabled-engine-'));
    const { MCPEngine } = require('../dist/mcp/engine') as typeof import('../src/mcp/engine');
    const engine = new MCPEngine({ watch, queryPool: false });
    let cg: CodeGraph | undefined;
    try {
      fs.mkdirSync(path.join(root, 'src'));
      fs.mkdirSync(path.join(root, '.codegraph'));
      fs.writeFileSync(getWorkspaceConfigPath(root), 'directories: [src]\nbackground: { intervalSeconds: 0 }\n');
      fs.writeFileSync(path.join(root, 'src', 'sample.ts'), 'export function beforeStartup() { return 1; }');
      cg = CodeGraph.initSync(root);
      await cg.indexAll();
      fs.writeFileSync(path.join(root, 'src', 'sample.ts'), 'export function afterStartup() { return 2; }');
      await engine.ensureInitialized(root);
      await engine.getToolHandler().execute('codegraph_search', { query: 'beforeStartup' });
      expect(cg.getNodesByKind('function').map((node) => node.name)).toContain('beforeStartup');
      expect(cg.getNodesByKind('function').map((node) => node.name)).not.toContain('afterStartup');
    } finally {
      await engine.stop();
      cg?.close();
      clearProjectConfigCache();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it.each(['background: { enabled: false }', 'directories: [/outside]'])(
    'resumes a config pause corrected before the lifecycle poll: %s', async (paused) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-resume-background-'));
      let cg: CodeGraph | undefined;
      let lease: ProjectLease | undefined;
      const configure = (text: string): void => {
        fs.writeFileSync(getWorkspaceConfigPath(root), text + '\n');
        clearProjectConfigCache();
      };
      try {
        fs.mkdirSync(path.join(root, 'src'));
        fs.mkdirSync(path.join(root, '.codegraph'));
        configure('directories: [src]\nbackground: { intervalSeconds: 10 }');
        fs.writeFileSync(path.join(root, 'src', 'sample.ts'), 'export function original() { return 1; }');
        cg = CodeGraph.initSync(root);
        await cg.indexAll();
        lease = acquireProject(root, () => cg!, { inertForTests: true });
        await lease.ready();
        expect(cg.isWatching()).toBe(true);
        configure(paused);
        expect(__emitWatchEventForTests(root, '.codegraph/config.yaml')).toBe(true);
        expect(cg.isWatching()).toBe(false);
        expect(cg.isWatcherPausedByConfig()).toBe(true);
        // Both writes happen synchronously before a 1s lifecycle timer can
        // observe the invalid/disabled intermediate file.
        configure('directories: [src]\nbackground: { intervalSeconds: 10 }');
        fs.writeFileSync(path.join(root, 'src', 'sample.ts'), 'export function afterResume() { return 2; }');
        await lease.ready();
        expect(cg.isWatching()).toBe(true);
        expect(cg.isWatcherPausedByConfig()).toBe(false);
        expect(cg.getNodesByKind('function').map((node) => node.name)).toContain('afterResume');
      } finally {
        if (lease) await lease.release();
        else cg?.close();
        clearProjectConfigCache();
        fs.rmSync(root, { recursive: true, force: true });
      }
    }, 30_000,
  );
});
