import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { DatabaseConnection } from '../src/db';
import * as activity from '../src/progress-activity';
import { MAX_SOURCE_FILE_SIZE_BYTES } from '../src/file-limits';

describe('in-place indexAll', () => {
  let root: string;
  let graph: CodeGraph;

  function write(file: string, content: string): void {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  function checkFts(): void {
    graph['db'].getDb().exec("INSERT INTO nodes_fts(nodes_fts, rank) VALUES ('integrity-check', 1)");
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bulk-reindex-'));
    graph = CodeGraph.initSync(root);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    graph.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('counts an unchanged file as indexed without parsing it or rebuilding FTS', async () => {
    write('entry.ts', 'export function stableName() { return 1; }\n');
    const bulkFts = vi.spyOn(DatabaseConnection.prototype, 'beginBulkNodeLoad');
    expect((await graph.indexAll()).success).toBe(true);
    expect(bulkFts).toHaveBeenCalledOnce();
    const parseActivity = vi.spyOn(activity, 'reportCurrentFile');
    bulkFts.mockClear();
    const progress: number[] = [];
    let parseReports = 0;

    const result = await graph.indexAll({ onProgress: (p) => {
      if (p.phase !== 'parsing') return;
      progress.push(p.current);
      if (p.current === 0) parseActivity.mockClear();
      else parseReports = parseActivity.mock.calls.filter(([file]) => file === 'entry.ts').length;
    } });

    expect(result).toMatchObject({ success: true, filesIndexed: 1, filesSkipped: 0, filesDiscovered: 1, nodesCreated: 0, edgesCreated: 0 });
    expect(progress).toEqual([0, 1, 1]);
    expect(parseReports).toBe(0);
    expect(bulkFts).not.toHaveBeenCalled();
    checkFts();
  });

  it('updates search and keeps incoming calls on sparse edits with unchanged mtimes', async () => {
    const stamp = new Date(2025, 0, 1);
    const edited = path.join(root, 'target.ts');
    write('target.ts', 'export function reached() { return 1; }\nexport function oldName() {}\n');
    fs.utimesSync(edited, stamp, stamp);
    write('caller.ts', "import { reached } from './target';\nexport function caller() { reached(); }\n");
    write('remove.ts', 'export function discarded() {}\n');
    expect((await graph.indexAll()).success).toBe(true);
    const bulkFts = vi.spyOn(DatabaseConnection.prototype, 'beginBulkNodeLoad');
    write('target.ts', '\nexport function reached() { return 1; }\nexport function newName() {}');
    fs.utimesSync(edited, stamp, stamp);
    fs.unlinkSync(path.join(root, 'remove.ts'));

    expect((await graph.indexAll()).success).toBe(true);

    expect(bulkFts).not.toHaveBeenCalled();
    expect(graph.searchNodes('newName').some(({ node }) => node.name === 'newName')).toBe(true);
    expect(graph.searchNodes('oldName')).toEqual([]);
    expect(graph.searchNodes('discarded')).toEqual([]);
    const reached = graph.getNodesInFile('target.ts').find((node) => node.name === 'reached');
    if (!reached) throw new Error('Missing target');
    expect(graph.getCallers(reached.id).map(({ node }) => node.name)).toContain('caller');
    checkFts();
  });

  it('replaces an unchanged file when its extension override changes', async () => {
    write('codegraph.json', JSON.stringify({ extensions: { '.custom': 'javascript' } }));
    write('entry.custom', 'export function stableName() {}\n');
    expect((await graph.indexAll()).success).toBe(true);
    expect(graph.getNodesInFile('entry.custom').map((node) => node.language)).toContain('javascript');
    write('codegraph.json', JSON.stringify({ extensions: { '.custom': 'typescript' } }));

    expect((await graph.indexAll()).success).toBe(true);

    expect(graph.getNodesInFile('entry.custom').map((node) => node.language)).toContain('typescript');
    checkFts();
  });

  it('removes stale route nodes when the extraction detector drops a framework', async () => {
    write('package.json', JSON.stringify({ dependencies: { express: '*' } }));
    write('entry.js', "const app = express();\napp.get('/framework-reindex', (req, res) => res.send('ok'));\n");
    expect((await graph.indexAll()).success).toBe(true);
    expect(graph.getNodesByKind('route').map((node) => node.name)).toContain('GET /framework-reindex');
    fs.unlinkSync(path.join(root, 'package.json'));

    expect((await graph.indexAll()).success).toBe(true);

    expect(graph.getNodesByKind('route').map((node) => node.name)).not.toContain('GET /framework-reindex');
    checkFts();
  });

  it('re-extracts routes after per-app gating changes without changing detected names', async () => {
    const route = 'apps/web/app/api/check/route.ts';
    write('package.json', JSON.stringify({ dependencies: { next: '*', 'expo-router': '*' } }));
    write('apps/web/package.json', JSON.stringify({ dependencies: { next: '*' } }));
    write(route, 'export function GET() {}\n');
    expect((await graph.indexAll()).success).toBe(true);
    const previousNames = graph['orchestrator'].getDetectedFrameworkNames();
    expect(graph.getNodesInFile(route).map((node) => node.name)).toContain('GET /api/check');
    write('apps/web/package.json', JSON.stringify({ dependencies: { 'expo-router': '*' } }));

    expect((await graph.indexAll()).success).toBe(true);

    expect(graph['orchestrator'].getDetectedFrameworkNames()).toEqual(previousNames);
    expect(graph.getNodesInFile(route).map((node) => node.name)).not.toContain('GET /api/check');
    checkFts();
  });

  it('checks a file written by another indexing operation after the bulk stamp', async () => {
    const route = 'apps/web/app/api/check/route.ts';
    const previousAppSettings = JSON.stringify({ dependencies: { next: '*' } });
    write('package.json', JSON.stringify({ dependencies: { next: '*', 'expo-router': '*' } }));
    write('apps/web/package.json', previousAppSettings);
    write(route, 'export function GET() {}\n');
    expect((await graph.indexAll()).success).toBe(true);
    write('apps/web/package.json', JSON.stringify({ dependencies: { 'expo-router': '*' } }));
    write(route, 'export function GET() { return 1; }\n');
    graph.close();
    graph = CodeGraph.openSync(root);
    expect((await graph.indexFiles([route])).success).toBe(true);
    expect(graph.getNodesInFile(route).map((node) => node.name)).not.toContain('GET /api/check');
    write('apps/web/package.json', previousAppSettings);
    const bulkFts = vi.spyOn(DatabaseConnection.prototype, 'beginBulkNodeLoad');

    expect((await graph.indexAll()).success).toBe(true);

    expect(graph.getNodesInFile(route).map((node) => node.name)).toContain('GET /api/check');
    expect(bulkFts).not.toHaveBeenCalled();
    checkFts();
  });

  it('reparses wiped, missing and failed rows and reports size skips', async () => {
    for (const file of ['wiped', 'missing', 'failed']) write(`${file}.ts`, `export function ${file}() {}\n`);
    write('oversize.ts', ' '.repeat(MAX_SOURCE_FILE_SIZE_BYTES + 1));
    expect((await graph.indexAll()).success).toBe(true);
    const db = graph['db'].getDb();
    db.exec("DELETE FROM nodes WHERE file_path = 'wiped.ts'; UPDATE files SET node_count = 0 WHERE path = 'wiped.ts'");
    graph['queries'].deleteFile('missing.ts');
    db.prepare("UPDATE files SET errors = ? WHERE path = 'failed.ts'").run(JSON.stringify([
      { severity: 'error', code: 'parse_error', message: 'failed parse' },
    ]));
    const parseActivity = vi.spyOn(activity, 'reportCurrentFile');

    const result = await graph.indexAll();

    expect(result).toMatchObject({ success: true, filesIndexed: 3, filesSkipped: 1, filesErrored: 0 });
    expect(result.errors).toEqual([expect.objectContaining({ code: 'size_exceeded', filePath: 'oversize.ts' })]);
    for (const file of ['wiped', 'missing', 'failed']) {
      expect(parseActivity).toHaveBeenCalledWith(`${file}.ts`);
      expect(graph.getNodesInFile(`${file}.ts`).map((node) => node.name)).toContain(file);
    }
    expect(graph['queries'].getFileByPath('failed.ts')?.errors).toBeUndefined();
    checkFts();
  });

  it.each(['unknown bulk inputs', 'old extraction version', 'partial index'])('reparses when prior compatibility is unproven: %s', async (reason) => {
    write('entry.ts', 'export function currentExtraction() {}\n');
    expect((await graph.indexAll()).success).toBe(true);
    const db = graph['db'].getDb();
    db.exec("UPDATE nodes SET name = 'staleExtraction' WHERE name = 'currentExtraction'");
    if (reason === 'unknown bulk inputs') {
      db.exec("DELETE FROM project_metadata WHERE key = 'bulk_extraction_inputs'");
    } else if (reason === 'old extraction version') {
      graph['queries'].setMetadata('indexed_with_extraction_version', '0');
    } else {
      graph['queries'].setMetadata('index_state', 'partial');
    }

    expect((await graph.indexAll()).success).toBe(true);

    expect(graph.getNodesInFile('entry.ts').map((node) => node.name)).toContain('currentExtraction');
    expect(graph.getIndexState()).toBe('complete');
    checkFts();
  });

  it('does not certify a cancelled incompatible rewrite', async () => {
    write('first.ts', 'export function first() {}\n');
    write('second.ts', 'export function second() {}\n');
    expect((await graph.indexAll()).success).toBe(true);
    write('codegraph.json', JSON.stringify({ exclude: ['not-present.ts'] }));
    const controller = new AbortController();

    const result = await graph.indexAll({ signal: controller.signal, onProgress: (progress) => {
      if (progress.phase === 'parsing' && progress.current === 1) controller.abort();
    } });

    expect(result).toMatchObject({ success: false, filesIndexed: 1 });
    expect(graph.getIndexState()).toBe('failed');
    expect(graph['queries'].getMetadata('bulk_extraction_inputs')).toBe('');
    checkFts();
  });

  it('counts covered files but no new graph rows when a compatible run is cancelled', async () => {
    write('first.ts', 'export function first() {}\n');
    write('second.ts', 'export function second() {}\n');
    expect((await graph.indexAll()).success).toBe(true);
    const controller = new AbortController();

    const result = await graph.indexAll({ signal: controller.signal, onProgress: (progress) => {
      if (progress.phase === 'parsing' && progress.current === 1) controller.abort();
    } });

    expect(result).toMatchObject({ success: false, filesIndexed: 1, nodesCreated: 0, edgesCreated: 0 });
    expect(graph.getIndexState()).toBe('failed');
    checkFts();
  });

  it('repairs FTS on open after an interrupted bulk window', async () => {
    write('entry.ts', 'export function existingName() {}\n');
    expect((await graph.indexAll()).success).toBe(true);
    graph['db'].beginBulkNodeLoad();
    graph['db'].getDb().exec("UPDATE nodes SET docstring = 'keywordfrompartialwrite' WHERE name = 'existingName'");
    graph.close();

    graph = CodeGraph.openSync(root);

    const db = graph['db'].getDb();
    expect(db.prepare("SELECT count(*) AS count FROM nodes_fts WHERE nodes_fts MATCH 'keywordfrompartialwrite'").get())
      .toEqual({ count: 1 });
    checkFts();
  });
});
