/**
 * Pin the Node-25 block banner content. The banner replaced a soft
 * `console.warn` because the warning was scrolling off-screen before
 * the OOM crash 30 seconds later, generating duplicate bug reports
 * (#54, #81, #140). The recipe and override env var below are
 * load-bearing — if any of them get edited away, this test catches it.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { buildNode25BlockBanner, buildNodeTooOldBanner, MIN_NODE_MAJOR } from '../src/bin/node-version-check';

describe('buildNode25BlockBanner', () => {
  it('embeds the reported Node version in the header', () => {
    expect(buildNode25BlockBanner('25.9.0')).toContain(
      'Unsupported Node.js version: 25.9.0'
    );
  });

  it('names the V8 turboshaft WASM root cause and the OOM symptom', () => {
    const banner = buildNode25BlockBanner('25.7.0');
    expect(banner).toContain('V8 WASM JIT');
    expect(banner).toContain('turboshaft');
    expect(banner).toContain('Fatal process out of memory: Zone');
  });

  it('points users to Node 22 LTS via nvm and Homebrew', () => {
    const banner = buildNode25BlockBanner('25.7.0');
    expect(banner).toContain('Node.js 22 LTS');
    expect(banner).toContain('nvm install 22');
    expect(banner).toContain('brew install node@22');
  });

  it('documents the CODEGRAPH_ALLOW_UNSAFE_NODE override', () => {
    const banner = buildNode25BlockBanner('25.7.0');
    expect(banner).toContain('CODEGRAPH_ALLOW_UNSAFE_NODE=1');
  });

  it('links to issue #81 for the root-cause writeup', () => {
    expect(buildNode25BlockBanner('25.7.0')).toContain(
      'github.com/colbymchenry/codegraph/issues/81'
    );
  });
});

describe('buildNodeTooOldBanner', () => {
  it('embeds the reported Node version in the header', () => {
    expect(buildNodeTooOldBanner('18.20.0')).toContain(
      'Unsupported Node.js version: 18.20.0'
    );
  });

  it('states the supported floor matching MIN_NODE_MAJOR', () => {
    expect(MIN_NODE_MAJOR).toBe(20);
    expect(buildNodeTooOldBanner('18.0.0')).toContain(
      `requires Node.js ${MIN_NODE_MAJOR} or newer`
    );
  });

  it('points users to Node 22 LTS via nvm and Homebrew', () => {
    const banner = buildNodeTooOldBanner('16.0.0');
    expect(banner).toContain('Node.js 22 LTS');
    expect(banner).toContain('nvm install 22');
    expect(banner).toContain('brew install node@22');
  });

  it('documents the CODEGRAPH_ALLOW_UNSAFE_NODE override', () => {
    expect(buildNodeTooOldBanner('18.0.0')).toContain('CODEGRAPH_ALLOW_UNSAFE_NODE=1');
  });
});

const cli = resolve(__dirname, '../dist/bin/codegraph.js');
const library = resolve(__dirname, '../dist/index.js');

/** Model runtimes that may not be installed on the Node test runner. */
function launchAsBun(version: string, args: string[], allowUnsafeNode = false) {
  const dir = mkdtempSync(join(tmpdir(), 'cg-bun-startup-'));
  try {
    const preload = join(dir, 'runtime.cjs');
    writeFileSync(preload, `
      Object.defineProperties(process.versions, {
        bun: { value: ${JSON.stringify(version)} },
        node: { value: '26.3.0' },
      });
      const cp = require('node:child_process');
      const spawnSync = cp.spawnSync;
      cp.spawnSync = (executable, args, ...options) => {
        if (args.includes('--liftoff-only')) throw Error('Unexpected V8 relaunch under Bun');
        return spawnSync(executable, args, ...options);
      };
    `);
    const env = { ...process.env };
    delete env.CODEGRAPH_ALLOW_UNSAFE_NODE;
    delete env.CODEGRAPH_NO_RELAUNCH;
    delete env.CODEGRAPH_WASM_RELAUNCHED;
    if (allowUnsafeNode) env.CODEGRAPH_ALLOW_UNSAFE_NODE = '1';
    return spawnSync(process.execPath, ['--require', preload, ...args], {
      encoding: 'utf8', env, timeout: 10_000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('compiled entry points under Bun', () => {
  it.each(['1.4.4', '1.4.10', '1.5.0', '2.0.0'])(
    'starts on Bun %s without a Node override or V8 relaunch', (version) => {
      const result = launchAsBun(version, [cli, '--version']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
      expect(result.stderr).not.toContain('Unsupported Node.js');
    },
  );

  it.each(['1.3.99', '1.4.3', '1.4.4-canary.1'])(
    'rejects Bun %s even when the Node override is set', (version) => {
      const result = launchAsBun(version, [cli, '--version'], true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`Bun ${version}`);
      expect(result.stderr).toContain('1.4.4');
      expect(result.stderr).not.toContain('Unsupported Node.js');
      expect(result.stderr).not.toContain('Unexpected V8 relaunch');
    },
  );

  it('allows the compiled library to load on Bun 1.4.4', () => {
    const result = launchAsBun('1.4.4', ['-e', `require(${JSON.stringify(library)});`]);
    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects loading the compiled library on Bun 1.4.3', () => {
    const result = launchAsBun('1.4.3', ['-e', `require(${JSON.stringify(library)});`]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Bun 1.4.3');
    expect(result.stderr).toContain('1.4.4');
  });
});
