import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import {
  findNearestCodeGraphRoot,
  getCodeGraphDir,
  isInitialized,
  resolveServerRoot,
  resolveWorkspaceRoot,
  unsafeConfiguredIndexRootReason,
} from '../src/directory';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';
import { ToolHandler } from '../src/mcp/tools';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

describe('nearest .codegraph workspace discovery', () => {
  let temp: string;
  let home: string;
  let workspace: string;
  let nested: string;

  beforeEach(() => {
    temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-workspace-discovery-')));
    home = path.join(temp, 'home');
    workspace = path.join(home, 'a');
    nested = path.join(workspace, 'b', 'c', 'd', 'e', 'f', 'g', 'h');
    fs.mkdirSync(nested, { recursive: true });
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('CODEGRAPH_DIR', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  function marker(root: string): string {
    const dir = path.join(root, '.codegraph');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function cli(cwd: string, args: string[]) {
    return spawnSync(process.execPath, [...WASM_RUNTIME_FLAGS, BIN, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_TELEMETRY: '0', NO_COLOR: '1' },
    });
  }

  it('selects the nearest marker below HOME at any depth without requiring a database', () => {
    marker(home);
    marker(workspace);
    const nearer = path.join(workspace, 'b', 'c');
    marker(nearer);
    expect(findNearestCodeGraphRoot(nested)).toBe(nearer);
    expect(resolveWorkspaceRoot(nested)).toBe(nearer);
    expect(isInitialized(nearer)).toBe(false);
    expect(resolveServerRoot(nested).root).toBeNull();
    expect(resolveServerRoot(nested).workspaceRoot).toBe(nearer);
  });

  it('stops before HOME and never discovers its marker or a marker above it', () => {
    marker(temp);
    expect(findNearestCodeGraphRoot(nested)).toBeNull();
    expect(resolveWorkspaceRoot(nested)).toBe(nested);
    expect(resolveWorkspaceRoot(home)).toBe(home);
    marker(home);
    expect(findNearestCodeGraphRoot(nested)).toBeNull();
    expect(findNearestCodeGraphRoot(home)).toBeNull();
    expect(resolveWorkspaceRoot(nested)).toBe(nested);
    expect(resolveWorkspaceRoot(home)).toBe(home);
    expect(resolveServerRoot(nested)).toEqual({
      workspaceRoot: nested,
      root: null,
      viaSubScan: false,
      candidates: [],
    });
  });

  it('stops before HOME when the starting directory is reached through a symlink', () => {
    marker(home);
    marker(temp);
    const alias = path.join(temp, 'home-alias');
    fs.symlinkSync(home, alias, 'junction');
    const aliasedNested = path.join(alias, path.relative(home, nested));
    expect(findNearestCodeGraphRoot(aliasedNested)).toBeNull();
    expect(resolveWorkspaceRoot(aliasedNested)).toBe(aliasedNested);
    marker(workspace);
    expect(findNearestCodeGraphRoot(aliasedNested)).toBe(workspace);
  });

  it('stops before an alias to HOME inside HOME while retaining a nearer workspace', () => {
    marker(home);
    marker(temp);
    const alias = path.join(home, 'home-link');
    fs.symlinkSync(home, alias, 'junction');
    const aliasedWorkspace = path.join(alias, path.relative(home, workspace));
    const aliasedNested = path.join(alias, path.relative(home, nested));
    expect(fs.existsSync(aliasedNested)).toBe(true);
    expect(findNearestCodeGraphRoot(aliasedNested)).toBeNull();
    expect(resolveWorkspaceRoot(aliasedNested)).toBe(aliasedNested);

    marker(workspace);
    expect(findNearestCodeGraphRoot(aliasedNested)).toBe(aliasedWorkspace);
    expect(resolveWorkspaceRoot(aliasedNested)).toBe(aliasedWorkspace);
  });

  it('stops before an outside alias to HOME when the starting path does not exist', () => {
    marker(home);
    marker(temp);
    const alias = path.join(temp, 'home-link');
    fs.symlinkSync(home, alias, 'junction');
    const aliasedWorkspace = path.join(alias, path.relative(home, workspace));
    const missing = path.join(aliasedWorkspace, 'missing', 'deep');
    expect(fs.existsSync(missing)).toBe(false);
    expect(findNearestCodeGraphRoot(missing)).toBeNull();
    expect(resolveWorkspaceRoot(missing)).toBe(missing);

    marker(workspace);
    expect(findNearestCodeGraphRoot(missing)).toBe(aliasedWorkspace);
    expect(resolveWorkspaceRoot(missing)).toBe(aliasedWorkspace);
  });

  it.each([1, 2])('keeps the current directory when only %i descendant workspaces are indexed', (count) => {
    fs.writeFileSync(path.join(workspace, 'package.json'), '{"private":true}');
    for (let i = 0; i < count; i++) {
      const child = path.join(workspace, `service-${i}`);
      fs.mkdirSync(child);
      CodeGraph.initSync(child).close();
    }

    expect(findNearestCodeGraphRoot(workspace)).toBeNull();
    expect(resolveWorkspaceRoot(workspace)).toBe(workspace);
    expect(resolveServerRoot(workspace)).toEqual({
      workspaceRoot: workspace,
      root: null,
      viaSubScan: false,
      candidates: [],
    });
    expect(fs.existsSync(getCodeGraphDir(workspace))).toBe(false);
  });

  it('supports projects outside HOME', () => {
    const outside = path.join(temp, 'work');
    const deep = path.join(outside, 'src', 'lib');
    fs.mkdirSync(deep, { recursive: true });
    marker(outside);
    expect(findNearestCodeGraphRoot(deep)).toBe(outside);
  });

  it('ignores a regular file named .codegraph', () => {
    marker(workspace);
    fs.writeFileSync(path.join(nested, '.codegraph'), 'not a directory');
    expect(findNearestCodeGraphRoot(nested)).toBe(workspace);
  });

  it('follows a data-directory symlink without changing the workspace root', () => {
    const storage = path.join(temp, 'index-storage');
    fs.mkdirSync(storage);
    fs.symlinkSync(storage, path.join(workspace, '.codegraph'), 'junction');
    fs.writeFileSync(path.join(storage, 'config.yaml'), 'directories: [b/c]\n');
    expect(findNearestCodeGraphRoot(nested)).toBe(workspace);
    expect(fs.realpathSync(getCodeGraphDir(workspace))).toBe(storage);
  });

  it('does not borrow an ancestor index across an uninitialized workspace', async () => {
    const parent = CodeGraph.initSync(workspace);
    parent.close();
    marker(path.join(workspace, 'b'));
    expect(resolveServerRoot(nested).root).toBeNull();
    const result = await new ToolHandler(null).execute('codegraph_explore', {
      query: 'anything', projectPath: nested,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content.map((entry: any) => entry.text).join('\n')).toContain('has no initialized index');
  });

  it('creates config.yaml on initialization and preserves a pre-existing config', () => {
    const fresh = CodeGraph.initSync(workspace);
    fresh.close();
    const file = path.join(getCodeGraphDir(workspace), 'config.yaml');
    expect(fs.readFileSync(file, 'utf8')).toContain('intervalSeconds: 30');
    const custom = 'directories: [b/c]\nbackground: { enabled: false }\n';
    fs.writeFileSync(file, custom);
    const opened = CodeGraph.openSync(workspace);
    opened.close();
    expect(fs.readFileSync(file, 'utf8')).toBe(custom);
  });

  it('permits a HOME workspace only when directories explicitly narrow the scan', () => {
    const config = path.join(marker(home), 'config.yaml');
    expect(unsafeConfiguredIndexRootReason(home)).toContain('home');
    fs.writeFileSync(config, 'directories: [a/b, projects]\n');
    expect(unsafeConfiguredIndexRootReason(home)).toBeNull();
    fs.writeFileSync(config, 'directories: [.]\n');
    expect(unsafeConfiguredIndexRootReason(home)).toContain('home');
    fs.symlinkSync(home, path.join(home, 'home-link'), 'junction');
    fs.writeFileSync(config, 'directories: [home-link]\n');
    expect(unsafeConfiguredIndexRootReason(home)).toContain('home');
    expect(unsafeConfiguredIndexRootReason(temp)).toContain('parent');
  });

  it.each(['absent', 'per-user state', 'initialized', 'initialized symlink'] as const)(
    'CLI init falls back to cwd with %s HOME data, then index and sync keep that workspace',
    (homeData) => {
      // HOME's per-user state, a marker above HOME, and an indexed child are all
      // outside the project search. None may replace cwd as the fallback.
      marker(temp);
      const homeState = path.join(getCodeGraphDir(home), 'user-state.json');
      if (homeData !== 'absent') {
        if (homeData === 'initialized symlink') {
          const storage = path.join(temp, 'home-data');
          fs.mkdirSync(storage);
          fs.symlinkSync(storage, getCodeGraphDir(home), 'junction');
        } else {
          marker(home);
        }
        fs.writeFileSync(homeState, '{"preserve":"per-user state"}\n');
        if (homeData.startsWith('initialized')) CodeGraph.initSync(home).close();
      }
      fs.writeFileSync(path.join(nested, 'package.json'), '{"private":true}');
      const child = path.join(nested, 'service');
      fs.mkdirSync(child);
      CodeGraph.initSync(child).close();
      const source = path.join(nested, 'sample.py');
      fs.writeFileSync(source, 'def fallback_initial():\n    return 1\n');
      expect(resolveWorkspaceRoot(nested)).toBe(nested);
      expect(resolveServerRoot(nested).root).toBeNull();

      const beforeInit = cli(nested, ['index', '--quiet']);
      expect(beforeInit.error).toBeUndefined();
      expect(beforeInit.status, beforeInit.stdout + beforeInit.stderr).toBe(1);
      expect(beforeInit.stdout + beforeInit.stderr).toContain(`not initialized in ${nested}`);
      expect(fs.existsSync(getCodeGraphDir(nested))).toBe(false);

      const initialized = cli(nested, ['init', '--yes']);
      expect(initialized.error).toBeUndefined();
      expect(initialized.status, initialized.stdout + initialized.stderr).toBe(0);
      expect(isInitialized(nested)).toBe(true);
      expect(fs.existsSync(path.join(getCodeGraphDir(nested), 'config.yaml'))).toBe(true);
      expect(fs.existsSync(getCodeGraphDir(home))).toBe(homeData !== 'absent');
      expect(fs.existsSync(getCodeGraphDir(workspace))).toBe(false);

      const readFunctions = (root: string = nested): string[] => {
        const graph = CodeGraph.openSync(root);
        try { return graph.getNodesByKind('function').map((node) => node.name); }
        finally { graph.close(); }
      };
      expect(readFunctions()).toEqual(['fallback_initial']);
      fs.writeFileSync(source, 'def fallback_reindexed():\n    return 2\n');
      const indexed = cli(nested, ['index', '--quiet']);
      expect(indexed.error).toBeUndefined();
      expect(indexed.status, indexed.stdout + indexed.stderr).toBe(0);
      expect(readFunctions()).toEqual(['fallback_reindexed']);

      fs.writeFileSync(source, 'def fallback_synced():\n    return 3\n');
      const synced = cli(nested, ['sync']);
      expect(synced.error).toBeUndefined();
      expect(synced.status, synced.stdout + synced.stderr).toBe(0);
      expect(readFunctions()).toEqual(['fallback_synced']);
      expect(resolveServerRoot(nested).root).toBe(nested);
      if (homeData !== 'absent') {
        expect(fs.readFileSync(homeState, 'utf8')).toBe('{"preserve":"per-user state"}\n');
        expect(isInitialized(home)).toBe(homeData.startsWith('initialized'));
        if (homeData.startsWith('initialized')) expect(readFunctions(home)).toEqual([]);
      }
      if (homeData === 'initialized symlink') {
        expect(fs.lstatSync(getCodeGraphDir(home)).isSymbolicLink()).toBe(true);
      }
    },
    60_000,
  );

  it('CLI init and manual sync from a deep child use the linked workspace and its scope', () => {
    CodeGraph.initSync(home).close();
    const storage = path.join(temp, 'shared-index');
    fs.mkdirSync(storage);
    fs.symlinkSync(storage, path.join(workspace, '.codegraph'), 'junction');
    fs.writeFileSync(path.join(storage, 'config.yaml'), [
      'directories: [x/y/z, x/w, a/b/c]',
      'exclude: [node_modules, "**/excluded/**"]',
      'background: { enabled: false, intervalSeconds: 3600 }',
      '',
    ].join('\n'));
    const write = (relative: string, name: string): void => {
      const file = path.join(workspace, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `def ${name}():\n    return 1\n`);
    };
    write('x/y/z/one.py', 'selected_one');
    write('x/w/two.py', 'selected_two');
    write('a/b/c/three.py', 'selected_three');
    write('unselected/four.py', 'unselected_four');
    write('x/y/z/node_modules/skip.py', 'excluded_dependency');
    write('x/w/excluded/skip.py', 'excluded_extra');
    const cwd = path.join(workspace, 'x', 'y', 'z', 'deep');
    fs.mkdirSync(cwd);
    const initialized = cli(cwd, ['init', '--yes']);
    expect(initialized.error).toBeUndefined();
    expect(initialized.status, initialized.stdout + initialized.stderr).toBe(0);
    expect(fs.existsSync(path.join(cwd, '.codegraph'))).toBe(false);
    const readFunctions = (): string[] => {
      const graph = CodeGraph.openSync(workspace);
      try { return graph.getNodesByKind('function').map((node) => node.name).sort(); }
      finally { graph.close(); }
    };
    expect(readFunctions()).toEqual(['selected_one', 'selected_three', 'selected_two']);
    write('x/y/z/one.py', 'manually_synced');
    const synced = cli(cwd, ['sync']);
    expect(synced.error).toBeUndefined();
    expect(synced.status, synced.stdout + synced.stderr).toBe(0);
    expect(readFunctions()).toEqual(['manually_synced', 'selected_three', 'selected_two']);
  }, 60_000);
});
