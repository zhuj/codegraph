import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  clearProjectConfigCache, ensureWorkspaceConfig, getWorkspaceConfigPath,
  addIncludeIgnoredPatterns, loadIncludeIgnoredPatterns,
  hasBackgroundConfig, hasExplicitScanDirectories, loadBackgroundConfig,
  loadExcludePatterns, loadExtensionOverrides, loadScanDirectories,
} from '../src/project-config';
import { buildScopeIgnore, scanDirectory, scanDirectoryAsync } from '../src/extraction';
import { CodeGraph, DatabaseConnection, getDatabasePath } from '../src';

let root: string;
let graph: CodeGraph | undefined;
const write = (relative: string, contents = 'export function example() { return 1; }\n') => {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
};
const config = (yaml: string) => {
  const file = getWorkspaceConfigPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml);
};
const files = () => graph!.getFiles().map((f) => f.path).sort();
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-workspace-config-'));
  clearProjectConfigCache();
});
afterEach(() => {
  graph?.close(); graph = undefined;
  clearProjectConfigCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('workspace YAML configuration', () => {
  it('keeps defaults when absent and writes an editable template only once', () => {
    expect(loadScanDirectories(root)).toEqual(['.']);
    expect(hasExplicitScanDirectories(root)).toBe(false);
    expect(loadBackgroundConfig(root)).toEqual({ enabled: true, intervalSeconds: 30 });
    expect(hasBackgroundConfig(root)).toBe(false);
    expect(ensureWorkspaceConfig(root)).toBe(true);
    expect(hasBackgroundConfig(root)).toBe(true);
    config('directories: [a/b]\nbackground: { enabled: false, intervalSeconds: 120 }\n');
    const original = fs.readFileSync(getWorkspaceConfigPath(root), 'utf8');
    expect(ensureWorkspaceConfig(root)).toBe(false);
    expect(fs.readFileSync(getWorkspaceConfigPath(root), 'utf8')).toBe(original);
    expect(loadScanDirectories(root)).toEqual(['a/b']);
    expect(loadBackgroundConfig(root)).toEqual({ enabled: false, intervalSeconds: 120 });
  });

  it('preserves legacy settings unless the YAML explicitly overrides that field', () => {
    write('codegraph.json', JSON.stringify({ exclude: ['legacy/'], extensions: { '.custom': 'typescript' } }));
    ensureWorkspaceConfig(root);
    expect(loadExcludePatterns(root)).toEqual(['legacy/']);
    expect(loadExtensionOverrides(root)).toEqual({ '.custom': 'typescript' });
    config('directories: [src]\nexclude: [vendor/]\n');
    expect(loadExcludePatterns(root)).toEqual(['vendor/']);
    expect(loadExtensionOverrides(root)).toEqual({ '.custom': 'typescript' });
    config('exclude: []\n');
    expect(loadExcludePatterns(root)).toEqual([]);
    fs.unlinkSync(getWorkspaceConfigPath(root));
    expect(loadExcludePatterns(root)).toEqual(['legacy/']);
  });

  it('normalizes overlapping literal directories while preserving the empty selection', () => {
    config("directories: [./x/y/, x/y/z, x/w, 'a\\b\\c', x/w]\n");
    expect(loadScanDirectories(root)).toEqual(['x/y', 'x/w', 'a/b/c']);
    config('directories: []\n');
    expect(loadScanDirectories(root)).toEqual([]);
    expect(hasExplicitScanDirectories(root)).toBe(true);
  });

  it.each([
    'directories: [../outside]', 'directories: [/absolute]', 'directories: [C:\\outside]',
    'directories: [x/../../y]', 'directories: ["**/src"]', 'directories: src',
    'directories: [src, null]', 'directories: [src, ""]', 'directories: [',
    'directories: [src]\ndirectories: [other]', 'directory: [src]',
    'exclude: node_modules', 'exclude: [vendor, 42]',
    'background: { enabled: "false" }', 'background: { intervalSeconds: -1 }',
    'background: { intervalSeconds: 0.0001 }', 'background: { intervalSeconds: .inf }',
    'background: { intervalSeconds: 2147484 }', 'background: { rate: 30 }',
    '- src',
  ])('fails closed for invalid YAML: %s', (yaml) => {
    write('outside.ts');
    config(yaml);
    expect(() => loadScanDirectories(root)).toThrow(/Invalid workspace config/);
    expect(() => scanDirectory(root)).toThrow(/Invalid workspace config/);
  });

  it('supports zero to disable background work without changing the scan selection', () => {
    config('directories: [src]\nbackground: { intervalSeconds: 0 }\n');
    expect(loadBackgroundConfig(root)).toEqual({ enabled: false, intervalSeconds: 0 });
    expect(loadScanDirectories(root)).toEqual(['src']);
  });

  it('updates the active YAML for include-ignored edits without losing comments or legacy patterns', () => {
    write('codegraph.json', JSON.stringify({ includeIgnored: ['old/'] }));
    config('# Keep this comment\ndirectories: [repos]\n');
    expect(addIncludeIgnoredPatterns(root, ['old/', 'repos/'])).toBe(1);
    expect(loadIncludeIgnoredPatterns(root)).toEqual(['old/', 'repos/']);
    const content = fs.readFileSync(getWorkspaceConfigPath(root), 'utf8');
    expect(content).toContain('# Keep this comment');
    expect(addIncludeIgnoredPatterns(root, ['repos/'])).toBe(0);
    expect(fs.readFileSync(getWorkspaceConfigPath(root), 'utf8')).toBe(content);
  });

  it.runIf(process.platform !== 'win32')('resolves directories relative to the workspace when .codegraph is a symlink', () => {
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-config-target-'));
    try {
      fs.symlinkSync(external, path.join(root, '.codegraph'), 'dir');
      config('directories: [src]\n');
      write('src/local.ts');
      write('other/outside.ts');
      fs.mkdirSync(path.join(external, 'src'));
      fs.writeFileSync(path.join(external, 'src/not-workspace.ts'), 'export const wrong = true;');
      expect(scanDirectory(root)).toEqual(['src/local.ts']);
    } finally { fs.rmSync(external, { recursive: true, force: true }); }
  });
});

describe('configured scan scope', () => {
  it.each([false, true])('selects multiple directory trees and excludes nested dependencies (git=%s)', async useGit => {
    write('x/y/z/one.ts'); write('x/w/two.ts'); write('a/b/c/three.ts');
    write('x/y/peer.ts'); write('x/wrong/peer.ts'); write('root.ts');
    write('x/w/node_modules/package/dependency.ts'); write('a/b/c/generated/no.ts');
    if (useGit) { git('init', '-q'); git('add', '-A'); }
    config('directories: [x/y/z, x/w, a/b/c]\nexclude: [node_modules, "**/generated/**"]\n');
    const expected = ['a/b/c/three.ts', 'x/w/two.ts', 'x/y/z/one.ts'];
    expect(scanDirectory(root).sort()).toEqual(expected);
    expect((await scanDirectoryAsync(root)).sort()).toEqual(expected);
    const scope = buildScopeIgnore(root);
    for (const dir of ['x/', 'x/y/', 'x/y/z/', 'a/', 'a/b/']) expect(scope.ignores(dir)).toBe(false);
    for (const p of ['x/other/', 'other/', 'root.ts', 'x/y/peer.ts', 'x/w/node_modules/a.ts']) expect(scope.ignores(p)).toBe(true);
    config('directories: []\n');
    expect(scanDirectory(root)).toEqual([]);
  });

  it('does not let force-include patterns escape the selected directories', () => {
    write('.gitignore', 'private/\nother/\n');
    write('private/allowed/main.ts'); write('private/outside.ts'); write('other/main.ts');
    write('private/allowed/excluded/no.ts');
    config('directories: [private/allowed]\ninclude: [private/, other/]\nexclude: ["**/excluded/**"]\n');
    expect(scanDirectory(root)).toEqual(['private/allowed/main.ts']);
    const scope = buildScopeIgnore(root);
    expect(scope.ignores('private/')).toBe(false);
    expect(scope.ignores('private/outside.ts')).toBe(true);
    expect(scope.ignores('other/main.ts')).toBe(true);
  });

  it('respects selected nested repositories and keeps unrelated repositories out', () => {
    write('repos/one/src/yes.ts'); write('repos/two/src/no.ts'); write('top.ts');
    git('init', '-q');
    execFileSync('git', ['init', '-q'], { cwd: path.join(root, 'repos/one') });
    execFileSync('git', ['init', '-q'], { cwd: path.join(root, 'repos/two') });
    config('directories: [repos/one/src]\n');
    expect(scanDirectory(root)).toEqual(['repos/one/src/yes.ts']);
  });
});

describe('scope changes reconcile the persisted index', () => {
  it('rejects invalid YAML before creating a new index database', async () => {
    config('directories: [');
    expect(() => CodeGraph.initSync(root)).toThrow(/Invalid workspace config/);
    await expect(CodeGraph.init(root)).rejects.toThrow(/Invalid workspace config/);
    expect(fs.existsSync(path.join(root, '.codegraph/codegraph.db'))).toBe(false);
  });

  it('validates rebuild scope before deleting the last good index', async () => {
    write('one/retained.ts');
    graph = CodeGraph.initSync(root);
    await graph.indexAll();
    graph.close(); graph = undefined;
    config('directories: [');
    await expect(CodeGraph.recreate(root)).rejects.toThrow(/Invalid workspace config/);
    graph = CodeGraph.openSync(root);
    expect(files()).toEqual(['one/retained.ts']);
    graph.close(); graph = undefined;
    // An older workspace without YAML gains the default before a valid rebuild.
    fs.unlinkSync(getWorkspaceConfigPath(root));
    graph = await CodeGraph.recreate(root);
    expect(fs.existsSync(getWorkspaceConfigPath(root))).toBe(true);
    expect(loadScanDirectories(root)).toEqual(['.']);
  });

  it('explicit-file indexing respects configured directories and excludes, removing stale rows', async () => {
    write('one/kept.ts'); write('one/excluded/no.ts'); write('two/outside.ts');
    graph = CodeGraph.initSync(root);
    await graph.indexAll();
    config('directories: [one]\nexclude: ["**/excluded/**"]\n');
    const result = await graph.indexFiles(['one/kept.ts', 'one/excluded/no.ts', 'two/outside.ts']);
    expect(result.success).toBe(true);
    expect(files()).toEqual(['one/kept.ts']);
    expect(result.errors.filter((error) => error.code === 'outside_scope')).toHaveLength(2);
  });

  it('full index removes rows from deselected directories and explicit exclusions', async () => {
    write('one/kept.ts'); write('one/generated/no.ts'); write('two/removed.ts');
    graph = CodeGraph.initSync(root);
    await graph.indexAll();
    expect(files()).toContain('two/removed.ts');
    config('directories: [one]\nexclude: ["**/generated/**"]\n');
    await graph.indexAll();
    expect(files()).toEqual(['one/kept.ts']);
  });

  it('sync sees YAML-only scope edits even with a clean Git worktree', async () => {
    write('one/source.ts'); write('two/source.ts');
    write('.gitignore', '.codegraph/\n');
    git('init', '-q'); git('add', '-A');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
    config('directories: [one]\n');
    graph = CodeGraph.initSync(root);
    await graph.indexAll();
    expect(files()).toEqual(['one/source.ts']);
    config('directories: [two]\n');
    expect(graph.getChangedFiles()).toEqual({ added: ['two/source.ts'], modified: [], removed: ['one/source.ts'] });
    // Even a source-specific watch event must reconcile the changed scope.
    await graph.sync({ paths: ['two/source.ts'] });
    expect(files()).toEqual(['two/source.ts']);
    config('directories: []\n');
    await graph.sync();
    expect(files()).toEqual([]);
  });

  it('a malformed config cannot erase the existing index or broaden a sync', async () => {
    write('one/source.ts'); write('two/private.ts');
    config('directories: [one]\n');
    graph = CodeGraph.initSync(root);
    await graph.indexAll();
    config('directories: [');
    await expect(graph.sync()).rejects.toThrow(/Invalid workspace config/);
    expect(files()).toEqual(['one/source.ts']);
  });

  it('the first scoped sync of a legacy index reconciles the entire configured scope', async () => {
    write('one/kept.ts'); write('two/removed.ts');
    graph = CodeGraph.initSync(root);
    await graph.indexAll();
    graph.close(); graph = undefined;
    const db = DatabaseConnection.open(getDatabasePath(root));
    try { db.getDb().prepare('DELETE FROM project_metadata WHERE key = ?').run('indexed_scope_config'); }
    finally { db.close(); }
    config('directories: [one]\n');
    graph = CodeGraph.openSync(root);
    await graph.sync({ paths: ['one/kept.ts'] });
    expect(files()).toEqual(['one/kept.ts']);
  });
});
