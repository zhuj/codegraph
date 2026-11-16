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

  it('selects the nearest marker at any depth without requiring a database', () => {
    marker(home);
    marker(workspace);
    const nearer = path.join(workspace, 'b', 'c');
    marker(nearer);
    expect(findNearestCodeGraphRoot(nested)).toBe(nearer);
    expect(isInitialized(nearer)).toBe(false);
    expect(resolveServerRoot(nested).root).toBeNull();
  });

  it('includes HOME but never discovers a marker above it', () => {
    marker(temp);
    expect(findNearestCodeGraphRoot(nested)).toBeNull();
    marker(home);
    expect(findNearestCodeGraphRoot(nested)).toBe(home);
    expect(findNearestCodeGraphRoot(home)).toBe(home);
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

  it('CLI init and manual sync from a deep child use the linked workspace and its scope', () => {
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
