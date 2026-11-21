import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { ExtractionOrchestrator } from '../src/extraction';

vi.mock('fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('fs')>();
  return {
    ...fs,
    existsSync: vi.fn(fs.existsSync),
    openSync: vi.fn(fs.openSync),
    readdirSync: vi.fn(fs.readdirSync),
    statSync: vi.fn(fs.statSync),
  };
});

vi.mock('fs/promises', async (importOriginal) => {
  const fsp = await importOriginal<typeof import('fs/promises')>();
  return { ...fsp, stat: vi.fn(fsp.stat) };
});

function gate() {
  let release = () => {};
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

describe('sync filesystem reconciliation', () => {
  const file = 'src/keep.ts';
  let temp: string;
  let root: string;
  let source: string;
  let connection: DatabaseConnection;
  let queries: QueryBuilder;
  let extraction: ExtractionOrchestrator;

  const nodeIds = () => queries.getNodesByFiles([file]).map((node) => node.id).sort();

  function seedFiles(paths: string[], gone: string[]) {
    const indexed = queries.getFileByPath(file);
    if (!indexed) throw new Error('Missing indexed fixture');
    for (const filePath of [...paths].reverse()) {
      const full = path.join(root, filePath);
      fs.writeFileSync(full, 'export function keep() { return 1; }\n');
      const stat = fs.statSync(full);
      queries.upsertFile({ ...indexed, path: filePath, size: stat.size, modifiedAt: stat.mtimeMs });
      if (gone.includes(filePath)) fs.unlinkSync(full);
    }
  }

  const optedInDir = 'hidden-src';
  const optedInFile = `${optedInDir}/kept.ts`;

  function writeOptInConfig(exclude: string[] = []) {
    fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ include: [`${optedInDir}/**`], exclude }));
  }

  async function indexOptIn(mode: string, files = [optedInFile]) {
    if (mode === 'git') execFileSync('git', ['init', '--quiet', root]);
    fs.writeFileSync(path.join(root, '.gitignore'), `${optedInDir}/\n`);
    writeOptInConfig();
    fs.mkdirSync(path.join(root, optedInDir));
    for (const candidate of files) {
      fs.writeFileSync(path.join(root, candidate), 'export function beforeDiscoveryFailure() { return 1; }\n');
    }
    const result = await extraction.sync();
    expect(result.addedFilePaths).toEqual(expect.arrayContaining(files));
    expect(extraction.takeManifestEvidence() !== null).toBe(mode === 'git');
  }

  async function failOptInRead(code: string) {
    const { readdirSync } = await vi.importActual<typeof fs>('fs');
    const directory = path.join(root, optedInDir);
    return vi.mocked(fs.readdirSync).mockImplementation(((...args: Parameters<typeof readdirSync>) => {
      if (typeof args[0] === 'string' && path.resolve(args[0]) === directory) {
        throw Object.assign(new Error(code), { code });
      }
      return readdirSync(...args);
    }) as typeof readdirSync);
  }

  beforeEach(async () => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-observation-'));
    root = path.join(temp, 'checkout');
    source = path.join(root, file);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'export function keep() { return 1; }\n');
    connection = DatabaseConnection.initialize(path.join(temp, 'graph.db'));
    queries = new QueryBuilder(connection.getDb());
    extraction = new ExtractionOrchestrator(root, queries);
    await extraction.indexAll();
    expect(nodeIds()).not.toHaveLength(0);
  });

  afterEach(() => {
    vi.resetAllMocks();
    connection?.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  it.each([
    ['full', 'EIO'], ['full', 'ESTALE'], ['full', 'EACCES'],
    ['scoped', 'EIO'], ['scoped', 'ESTALE'], ['scoped', 'EACCES'],
  ])('preserves indexed rows on %s sync when stat fails with %s', async (mode, code) => {
    const before = queries.getFileByPath(file);
    const nodes = nodeIds();
    const { existsSync, statSync } = await vi.importActual<typeof fs>('fs');
    const { stat } = await vi.importActual<typeof fsp>('fs/promises');
    const syncStat = vi.mocked(fs.statSync);
    const asyncStat = vi.mocked(fsp.stat);
    if (mode === 'scoped') {
      syncStat.mockImplementation(((...args: Parameters<typeof statSync>) => {
        if (args[0] === source) throw Object.assign(new Error(code), { code });
        return statSync(...args);
      }) as typeof statSync);
    } else {
      asyncStat.mockImplementation((async (...args: Parameters<typeof stat>) => {
        if (args[0] === source) throw Object.assign(new Error(code), { code });
        return stat(...args);
      }) as typeof stat);
    }
    // The native existsSync returns false on an I/O error without calling the
    // JavaScript statSync function, so reproduce that symptom independently.
    const exists = vi.mocked(fs.existsSync).mockImplementation((name) => name !== source && existsSync(name));
    syncStat.mockClear();
    asyncStat.mockClear();
    exists.mockClear();

    const result = await extraction.sync(undefined, mode === 'scoped' ? [file] : undefined);

    expect(result.filesRemoved).toBe(0);
    expect(result.failedFilePaths).toEqual([file]);
    expect(queries.getFileByPath(file)).toEqual(before);
    expect(nodeIds()).toEqual(nodes);
    expect(syncStat.mock.calls.filter(([name]) => name === source)).toHaveLength(mode === 'scoped' ? 1 : 0);
    expect(asyncStat.mock.calls.filter(([name]) => name === source)).toHaveLength(mode === 'full' ? 1 : 0);
    expect(exists.mock.calls.filter(([name]) => name === source)).toHaveLength(0);
  });

  it('preserves an omitted indexed file when its subtree listing fails', async () => {
    const before = queries.getFileByPath(file);
    const nodes = nodeIds();
    const { readdirSync } = await vi.importActual<typeof fs>('fs');
    vi.mocked(fs.readdirSync).mockImplementation(((...args: Parameters<typeof readdirSync>) => {
      if (args[0] === path.dirname(source)) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return readdirSync(...args);
    }) as typeof readdirSync);

    const result = await extraction.sync();

    expect(result.filesRemoved).toBe(0);
    expect(result.failedFilePaths).toEqual([file]);
    expect(queries.getFileByPath(file)).toEqual(before);
    expect(nodeIds()).toEqual(nodes);
  });

  it.each([['git', 'EIO'], ['walk', 'EACCES']])('retains Git-ignored opt-ins after %s discovery hits %s and retries them', async (mode, code) => {
    await indexOptIn(mode);
    const abs = path.join(root, optedInFile);
    const before = queries.getFileByPath(optedInFile);
    const nodes = queries.getNodesByFiles([optedInFile]);
    fs.writeFileSync(abs, 'export function discoveredAfterRetry() { return 222; }\n');
    const read = await failOptInRead(code);

    const interrupted = await extraction.sync();

    expect(read.mock.results.some(({ type }) => type === 'throw')).toBe(true);
    expect(fs.statSync(abs).isFile()).toBe(true);
    expect(interrupted.filesRemoved).toBe(0);
    expect(interrupted.failedFilePaths).toEqual([optedInFile]);
    expect(queries.getFileByPath(optedInFile)).toEqual(before);
    expect(queries.getNodesByFiles([optedInFile])).toEqual(nodes);

    read.mockReset();
    const retry = await extraction.sync();
    expect(retry.failedFilePaths).toBeUndefined();
    expect(retry.changedFilePaths).toEqual([optedInFile]);
    expect(retry.filesModified).toBe(1);
    expect(retry.filesAdded).toBe(0);
    expect(queries.getNodesByFiles([optedInFile]).some(({ name }) => name === 'discoveredAfterRetry')).toBe(true);
  });

  it('removes an explicitly excluded opt-in even with unknown coverage of its parent', async () => {
    const excluded = `${optedInDir}/excluded.ts`;
    await indexOptIn('git', [optedInFile, excluded]);
    writeOptInConfig([excluded]);
    await failOptInRead('EIO');

    const result = await extraction.sync();

    expect(result.failedFilePaths).toEqual([optedInFile]);
    expect(result.removedFilePaths).toEqual([excluded]);
    expect(queries.getFileByPath(optedInFile)).not.toBeNull();
    expect(queries.getFileByPath(excluded)).toBeNull();
    expect(fs.existsSync(path.join(root, excluded))).toBe(true);
  });

  it('removes an opted-in subtree that really disappeared', async () => {
    await indexOptIn('walk');
    fs.renameSync(path.join(root, optedInDir), path.join(temp, 'removed-opt-in'));

    const result = await extraction.sync();

    expect(result.failedFilePaths).toBeUndefined();
    expect(result.removedFilePaths).toEqual([optedInFile]);
    expect(queries.getFileByPath(optedInFile)).toBeNull();
  });

  it.each(['full', 'scoped'])('deletes the row on %s sync when the source file is removed', async (mode) => {
    fs.unlinkSync(source);

    const result = await extraction.sync(undefined, mode === 'scoped' ? [file] : undefined);

    expect(result.removedFilePaths).toEqual([file]);
    expect(queries.getFileByPath(file)).toBeNull();
    expect(nodeIds()).toEqual([]);
  });

  it('deletes the row when a former parent directory becomes a regular file', async () => {
    fs.renameSync(path.dirname(source), path.join(temp, 'old-src'));
    fs.writeFileSync(path.dirname(source), 'replacement');

    const result = await extraction.sync(undefined, [file]);

    expect(result.removedFilePaths).toEqual([file]);
    expect(queries.getFileByPath(file)).toBeNull();
  });

  it.each(['codegraph.json', '.gitignore'])('removes an existing file excluded by %s', async (config) => {
    fs.writeFileSync(path.join(root, config), config === 'codegraph.json'
      ? JSON.stringify({ exclude: [file] }) : `${file}\n`);

    const result = await extraction.sync(undefined, [file]);

    expect(result.removedFilePaths).toEqual([file]);
    expect(fs.existsSync(source)).toBe(true);
    expect(queries.getFileByPath(file)).toBeNull();
  });

  it('rejects deletion when the source root is replaced during the scan', async () => {
    const before = queries.getFileByPath(file);
    const nodes = nodeIds();

    await expect(extraction.sync(({ phase, current }) => {
      if (phase !== 'scanning' || current !== 0) return;
      fs.renameSync(root, path.join(temp, 'old-checkout'));
      fs.mkdirSync(root);
    })).rejects.toThrow(/source root/i);

    expect(queries.getFileByPath(file)).toEqual(before);
    expect(nodeIds()).toEqual(nodes);
  });

  it('pages the tracked inventory without eager loads and removes rows in path order', async () => {
    const paths = Array.from({ length: 520 }, (_, i) => `src/fixture-${String(i).padStart(3, '0')}.ts`);
    const gone = ['src/fixture-002.ts', 'src/fixture-255.ts', 'src/fixture-256.ts', 'src/fixture-519.ts'];
    seedFiles(paths, gone);
    const eager = vi.spyOn(queries, 'getAllFiles');
    const pages = 'getFilesPage' in queries ? vi.spyOn(queries, 'getFilesPage') : undefined;

    const result = await extraction.sync();

    expect(eager).not.toHaveBeenCalled();
    expect(pages?.mock.results.map(({ value }) => value.length)).toEqual([256, 256, 9]);
    expect(pages?.mock.calls).toEqual([[null, 256], ['src/fixture-255.ts', 256], ['src/fixture-511.ts', 256]]);
    expect(result.removedFilePaths).toEqual(gone);
    expect(result.filesAdded).toBe(0);
    expect(result.filesModified).toBe(0);
  });

  it('overlaps at most eight full-sync stats and publishes failures and removals in SQL order', async () => {
    const paths = Array.from({ length: 17 }, (_, i) => `src/parallel-${String(i).padStart(2, '0')}.ts`);
    const gone = ['src/parallel-02.ts', 'src/parallel-10.ts'];
    const failures = ['src/parallel-00.ts', 'src/parallel-06.ts'];
    seedFiles(paths, gone);
    const ordered = [...paths, file].sort();
    const relFor = new Map(ordered.map((rel) => [path.join(root, rel), rel]));
    const { stat } = await vi.importActual<typeof fsp>('fs/promises');
    const firstStarted = gate();
    const releaseWave = gate();
    const releaseFirstFault = gate();
    const laterFault = gate();
    const started: string[] = [];
    const completedFaults: string[] = [];
    let inFlight = 0;
    let peak = 0;
    vi.mocked(fsp.stat).mockImplementation((async (...args: Parameters<typeof stat>) => {
      const rel = typeof args[0] === 'string' ? relFor.get(args[0]) : undefined;
      if (!rel) return stat(...args);
      started.push(rel);
      peak = Math.max(peak, ++inFlight);
      firstStarted.release();
      try {
        await releaseWave.wait;
        if (rel === failures[0]) await releaseFirstFault.wait;
        if (failures.includes(rel)) {
          completedFaults.push(rel);
          if (rel === failures[1]) laterFault.release();
          throw Object.assign(new Error('injected stat failure'), { code: 'EIO' });
        }
        return await stat(...args);
      } finally {
        inFlight--;
      }
    }) as typeof stat);
    vi.mocked(fs.statSync).mockClear();
    vi.mocked(fs.openSync).mockClear();

    const removed: string[] = [];
    const sync = extraction.sync(undefined, undefined, undefined, (name) => removed.push(name));
    let firstWave: string[];
    try {
      // A sequential implementation must fail the assertion, not deadlock on a barrier.
      await Promise.race([firstStarted.wait, sync]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      firstWave = [...started];
      releaseWave.release();
      if (firstWave.includes(failures[1])) await laterFault.wait;
    } finally {
      releaseWave.release();
      releaseFirstFault.release();
    }
    const result = await sync;

    expect(firstWave).toEqual(ordered.slice(0, 8));
    expect(peak).toBe(8);
    expect(started).toEqual(ordered);
    expect(completedFaults).toEqual([...failures].reverse());
    expect(result.failedFilePaths).toEqual(failures);
    expect(result.removedFilePaths).toEqual(gone);
    expect(removed).toEqual(gone);
    expect(vi.mocked(fs.statSync).mock.calls.filter(([name]) => typeof name === 'string' && relFor.has(name))).toHaveLength(0);
    expect(vi.mocked(fs.openSync).mock.calls.filter(([name]) => typeof name === 'string' && relFor.has(name))).toHaveLength(0);
  });

  it('rechecks the root before applying an absence observed after the checkout is replaced', async () => {
    const before = queries.getFileByPath(file);
    const nodes = nodeIds();
    const { stat } = await vi.importActual<typeof fsp>('fs/promises');
    const started = gate();
    const resumeStat = gate();
    vi.mocked(fsp.stat).mockImplementation((async (...args: Parameters<typeof stat>) => {
      if (args[0] === source) {
        started.release();
        await resumeStat.wait;
      }
      return stat(...args);
    }) as typeof stat);

    const sync = extraction.sync();
    try {
      await Promise.race([started.wait, sync.then(() => { throw new Error('sync finished before the stat barrier'); })]);
      fs.renameSync(root, path.join(temp, 'old-checkout'));
      fs.mkdirSync(root);
    } finally {
      resumeStat.release();
    }

    await expect(sync).rejects.toThrow(/source root/i);
    expect(queries.getFileByPath(file)).toEqual(before);
    expect(nodeIds()).toEqual(nodes);
  });

  it('does not reread touched-identical bytes on the next sync or clear recorded errors', async () => {
    const indexed = queries.getFileByPath(file);
    if (!indexed) throw new Error('Missing indexed fixture');
    const errors = [{ filePath: file, message: 'fixture warning', severity: 'warning' as const }];
    queries.upsertFile({ ...indexed, errors });
    const touched = new Date(indexed.modifiedAt + 5_000);
    fs.utimesSync(source, touched, touched);
    const touchedMtime = fs.statSync(source).mtimeMs;
    const opens = vi.mocked(fs.openSync);
    opens.mockClear();
    const countSourceReads = () => opens.mock.calls.filter(([name]) => name === source).length;
    const nodes = nodeIds();

    const first = await extraction.sync();
    const firstReads = countSourceReads();
    const second = await extraction.sync();

    expect(first.filesModified).toBe(0);
    expect(second.filesModified).toBe(0);
    expect(firstReads).toBe(1);
    expect(countSourceReads()).toBe(1);
    expect(queries.getFileByPath(file)).toEqual({ ...indexed, modifiedAt: touchedMtime, errors });
    expect(nodeIds()).toEqual(nodes);
  });

  it.each(['file stat', 'indexed row'])('does not advance a timestamp when the %s changed during reading', async (changed) => {
    const indexed = queries.getFileByPath(file);
    if (!indexed) throw new Error('Missing indexed fixture');
    const touched = new Date(indexed.modifiedAt + 5_000);
    const retouched = new Date(indexed.modifiedAt + 10_000);
    const replacement = { ...indexed, indexedAt: indexed.indexedAt + 1 };
    fs.utimesSync(source, touched, touched);
    const { openSync } = await vi.importActual<typeof fs>('fs');
    let injected = false;
    vi.mocked(fs.openSync).mockImplementation((...args: Parameters<typeof openSync>) => {
      if (args[0] === source && !injected) {
        injected = true;
        if (changed === 'file stat') fs.utimesSync(source, retouched, retouched);
        else queries.upsertFile(replacement);
      }
      return openSync(...args);
    });

    const result = await extraction.sync();

    expect(injected).toBe(true);
    expect(result.filesModified).toBe(0);
    expect(queries.getFileByPath(file)).toEqual(changed === 'file stat' ? indexed : replacement);
  });

  it('rebuilds a wiped zero-node row as an add on full sync', async () => {
    const indexed = queries.getFileByPath(file);
    if (!indexed) throw new Error('Missing indexed fixture');
    const nodes = nodeIds();
    queries.deleteNodesByFile(file);
    queries.upsertFile({ ...indexed, nodeCount: 0 });

    const result = await extraction.sync();

    expect(result.addedFilePaths).toEqual([file]);
    expect(result.filesRemoved).toBe(0);
    expect(nodeIds()).toEqual(nodes);
  });
});
