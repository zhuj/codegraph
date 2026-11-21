import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph, DatabaseConnection, getDatabasePath, QueryBuilder } from '../src';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';
import { FileLock } from '../src/utils';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

describe('codegraph index --resume', () => {
  let fixture: string;
  let root: string;

  beforeEach(() => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-index-resume-'));
    root = path.join(fixture, 'project');
    fs.mkdirSync(root);
  });

  afterEach(() => fs.rmSync(fixture, { recursive: true, force: true }));

  function run(args: string[] = ['--resume'], preload?: string) {
    const nodeOptions = preload ? [...WASM_RUNTIME_FLAGS, '--require', preload] : WASM_RUNTIME_FLAGS;
    const result = spawnSync(process.execPath, [...nodeOptions, BIN, 'index', ...args, root, '--quiet'], {
      cwd: fixture,
      encoding: 'utf8',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_NO_FAST_INIT: '1', NO_COLOR: '1' },
    });
    if (result.error) throw result.error;
    return { status: result.status, out: result.stdout + result.stderr };
  }

  function query<T>(fn: (db: QueryBuilder) => T, readOnly = true): T {
    const db = DatabaseConnection.open(getDatabasePath(root), { readOnly });
    try { return fn(new QueryBuilder(db.getDb())); } finally { db.close(); }
  }

  const marker = () => query((db) => db.getMetadata('index_state'));
  const lockExists = (file: string) => fs.existsSync(path.join(path.dirname(getDatabasePath(root)), file));

  async function interruptAfterStore() {
    fs.writeFileSync(path.join(root, 'base.ts'), 'export function original() { return 1; }\n');
    fs.writeFileSync(path.join(root, 'caller.ts'), "import { original } from './base';\nexport function caller() { return original(); }\n");
    const graph = CodeGraph.initSync(root);
    try {
      await expect(graph.indexAll({ onProgress: ({ phase }) => {
        if (phase === 'resolving') throw new Error('fixture interrupted after store');
      } })).rejects.toThrow('fixture interrupted after store');
    } finally { graph.destroy(); }
    expect(marker()).toBe('indexing');
    expect(query((db) => db.getUnresolvedReferencesCount())).toBeGreaterThan(0);
  }

  it('keeps committed rows, resolves pending references, and indexes newly discovered files', async () => {
    await interruptAfterStore();
    const base = query((db) => db.getFileByPath('base.ts'));
    expect(base?.nodeCount).toBeGreaterThan(0);
    fs.writeFileSync(path.join(root, 'after.ts'), 'export function afterResume() { return 2; }\n');

    const result = run();

    expect(result.status, result.out).toBe(0);
    expect(marker()).toBe('complete');
    expect(query((db) => db.getFileByPath('base.ts'))).toEqual(base);
    expect(query((db) => db.getFileByPath('after.ts'))?.nodeCount).toBeGreaterThan(0);
    expect(query((db) => db.getUnresolvedReferencesCount())).toBe(0);
    const graph = CodeGraph.openSync(root, { readOnly: true });
    try {
      const original = graph.searchNodes('original').find(({ node }) => node.name === 'original')?.node;
      expect(original).toBeDefined();
      if (!original) throw new Error('Missing original definition');
      expect(graph.getCallers(original.id).some(({ node }) => node.name === 'caller')).toBe(true);
      expect(graph.isIndexStale()).toBe(false);
    } finally { graph.destroy(); }
  });

  it.each(['complete', 'partial', 'failed', 'missing marker', 'older engine', 'newer engine', 'unstamped engine'])(
    'refuses %s without replacing the database', async (state) => {
      await interruptAfterStore();
      query((db) => {
        if (state.endsWith('engine')) {
          db.setMetadata('indexing_with_extraction_version', state === 'older engine' ? '-1' : state === 'newer engine' ? '999999999' : '');
        } else {
          db.setMetadata('index_state', state === 'missing marker' ? '' : state);
        }
        db.setMetadata('resume_fixture_sentinel', 'untouched');
      }, false);
      const before = marker();

      const result = run();

      expect(result.status).toBe(1);
      expect(result.out).toMatch(/cannot resume.*codegraph index/is);
      expect(marker()).toBe(before);
      expect(query((db) => db.getMetadata('resume_fixture_sentinel'))).toBe('untouched');
      expect(lockExists('writer.pid')).toBe(false);
      expect(lockExists('rebuild.pid')).toBe(false);
      expect(lockExists('codegraph.lock')).toBe(false);
    },
  );

  it('refuses a missing database without initializing it', () => {
    const result = run();
    expect(result.status).toBe(1);
    expect(result.out).toMatch(/nothing to resume.*codegraph init/is);
    expect(fs.existsSync(getDatabasePath(root))).toBe(false);
  });

  it('does not take over an active index lock', async () => {
    await interruptAfterStore();
    const lock = new FileLock(path.join(path.dirname(getDatabasePath(root)), 'codegraph.lock'));
    lock.acquire();
    try {
      const result = run();
      expect(result.status).toBe(1);
      expect(result.out).toMatch(/file lock|database is locked/i);
      expect(marker()).toBe('indexing');
      expect(lockExists('codegraph.lock')).toBe(true);
      expect(lockExists('writer.pid')).toBe(false);
      expect(lockExists('rebuild.pid')).toBe(false);
    } finally { lock.release(); }
  });

  it('leaves the marker resumable on a failed source check', async () => {
    await interruptAfterStore();
    const source = path.join(root, 'base.ts');
    const preload = path.join(fixture, 'fail-stat.cjs');
    fs.writeFileSync(preload, `
      const fs = require('node:fs');
      const stat = fs.statSync;
      fs.statSync = function (file, ...args) {
        if (file === ${JSON.stringify(source)}) throw Object.assign(new Error('fixture stat failure'), { code: 'EIO' });
        return stat(file, ...args);
      };
      const promises = require('node:fs/promises');
      const statAsync = promises.stat;
      promises.stat = async function (file, ...args) {
        if (file === ${JSON.stringify(source)}) throw Object.assign(new Error('fixture stat failure'), { code: 'EIO' });
        return statAsync(file, ...args);
      };
    `);

    const result = run(['--resume'], preload);

    expect(result.status).toBe(1);
    expect(result.out).toMatch(/source checks failed.*base\.ts/is);
    expect(marker()).toBe('indexing');
    expect(query((db) => db.getFileByPath('base.ts'))?.nodeCount).toBeGreaterThan(0);
    expect(lockExists('codegraph.lock')).toBe(false);
    expect(lockExists('writer.pid')).toBe(false);
    expect(lockExists('rebuild.pid')).toBe(false);
  });

  it('still replaces the database when index is invoked without --resume', async () => {
    await interruptAfterStore();
    query((db) => db.setMetadata('resume_fixture_sentinel', 'old database'), false);

    const result = run([]);

    expect(result.status, result.out).toBe(0);
    expect(marker()).toBe('complete');
    expect(query((db) => db.getMetadata('resume_fixture_sentinel'))).toBeNull();
  });
});
