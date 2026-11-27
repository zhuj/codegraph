import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';

it('reuses bounded worker parses without storing an obsolete snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-sync-parse-'));
  try {
    const result = spawnSync(process.execPath, [...WASM_RUNTIME_FLAGS, '-e', `
      const { CodeGraph } = require(process.argv[1]);
      const fs = require('node:fs');
      const path = require('node:path');
      const assert = require('node:assert/strict');
      const root = process.argv[2];
      const source = (name) => 'export function ' + name + '() { return 1; }\\n';
      const names = ['a.ts', 'b.ts', 'c.ts'];
      const put = (file, name) => fs.writeFileSync(path.join(root, file), source(name));
      (async () => {
        names.forEach((file, i) => put(file, 'initial' + i));
        const graph = await CodeGraph.init(root);
        try {
          await graph.indexAll();
          names.forEach((file, i) => put(file, 'queued' + i));
          const progress = [];
          const sync = await graph.sync({ paths: names, onProgress: (p) => {
            if (p.phase !== 'parsing') return;
            progress.push(p.currentFile);
            if (p.currentFile === 'a.ts') put('b.ts', 'newer1');
          }});
          assert.equal(sync.filesModified, 3);
          assert.deepEqual(sync.failedFilePaths ?? [], []);
          assert.deepEqual(progress, names);
          assert.equal(graph.getNodesInFile('a.ts').some(n => n.name === 'queued0'), true);
          assert.equal(graph.getNodesInFile('b.ts').some(n => n.name === 'queued1'), false);
          assert.equal(graph.getNodesInFile('b.ts').some(n => n.name === 'newer1'), true);
          assert.equal(graph.getNodesInFile('c.ts').some(n => n.name === 'queued2'), true);
        } finally { graph.close(); }
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `, resolve(__dirname, '../dist'), root], {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, CODEGRAPH_TELEMETRY: '0', CODEGRAPH_SYNTH_TIMINGS: '1', CODEGRAPH_SYNC_PARSE_WORKERS: '2' },
    });
    if (result.error) throw result.error;
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/\[phase-timing\] sync-parse-workers: \d+ms \(2\/3 reused\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
