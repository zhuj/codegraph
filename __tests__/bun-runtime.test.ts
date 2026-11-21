import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

// The suite itself stays on Node. Set CODEGRAPH_TEST_BUN to a local Bun binary
// to exercise the actual runtime without making it a test-runner dependency.
const bun = process.platform === 'linux' ? process.env.CODEGRAPH_TEST_BUN : undefined;
const cli = resolve(__dirname, '../dist/bin/codegraph.js');
const library = resolve(__dirname, '../dist/index.js');
const prebuild = resolve(__dirname, `../codegraph-kernel/prebuilds/linux-${process.arch}/codegraph-kernel.node`);

function exerciseCompiledEngine(executable: string, kernel: 'native' | 'wasm'): void {
  const cwd = mkdtempSync(join(tmpdir(), `cg-bun-${kernel}-`));
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEGRAPH_DIR: '.codegraph-bun-smoke',
      CODEGRAPH_KERNEL: kernel === 'native' ? '1' : '0',
      CODEGRAPH_KERNEL_LANGS: 'typescript',
      CODEGRAPH_KERNEL_PATH: prebuild,
      CODEGRAPH_KERNEL_DEBUG: '1',
      CODEGRAPH_TELEMETRY: '0',
      CODEGRAPH_NO_UPDATE_CHECK: '1',
    };
    delete env.CODEGRAPH_ALLOW_UNSAFE_NODE;
    delete env.CODEGRAPH_NO_RELAUNCH;
    delete env.CODEGRAPH_WASM_RELAUNCHED;
    const run = (args: string[]) => {
      const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 10_000 });
      expect(result.status, result.error?.message ?? `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).not.toContain('Unsupported Node.js');
      return result;
    };

    const source = join(cwd, 'fixture.ts');
    writeFileSync(source, 'export function original() { return 1; }\n');
    const init = run([cli, 'init', '--yes']);
    if (kernel === 'native') expect(init.stderr).toContain('[codegraph-kernel] loaded');
    writeFileSync(source, 'export function updated() { return 2; }\nexport function reader() { return updated(); }\n');
    run([cli, 'sync']);

    const status = JSON.parse(run([cli, 'status', '--json']).stdout);
    expect(status).toMatchObject({ initialized: true, backend: 'node-sqlite', fileCount: 1 });
    const results = JSON.parse(run([cli, 'query', 'updated', '--json']).stdout);
    expect(results).toEqual([expect.objectContaining({
      node: expect.objectContaining({ name: 'updated', filePath: 'fixture.ts' }),
    })]);

    const api = run(['-e', `
      const { CodeGraph } = require(${JSON.stringify(library)});
      const graph = CodeGraph.openSync(process.cwd(), { readOnly: true });
      try {
        const [first] = graph.searchNodes('updated');
        if (!first) throw Error('Missing symbol updated');
        console.log(JSON.stringify(graph.getCallers(first.node.id).map(({ node }) => node.name)));
      } finally {
        graph.close();
      }
    `]);
    expect(JSON.parse(api.stdout)).toEqual(['reader']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

it.skipIf(!bun)('indexes, syncs and reads through compiled CodeGraph under Bun with WASM', () => {
  if (bun) exerciseCompiledEngine(bun, 'wasm');
});

it.skipIf(!bun || !existsSync(prebuild))('indexes, syncs and reads through compiled CodeGraph under Bun with the native kernel', () => {
  if (bun) exerciseCompiledEngine(bun, 'native');
});
