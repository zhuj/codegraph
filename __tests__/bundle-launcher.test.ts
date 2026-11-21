import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const windows = process.platform === 'win32';
const bash = windows
  ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git/bin/bash.exe')
  : 'bash';
const recipe = fs.readFileSync(path.resolve('scripts/build-bundle.sh'), 'utf8');
// Execute the release recipe itself without downloading Bun or rebuilding the UI.
const launcherRecipe = recipe.slice(recipe.indexOf('# 4. Vendored'), recipe.indexOf('# 5. Archive'));
const archiveRecipe = recipe.slice(recipe.indexOf('# 5. Archive'));
const roots: string[] = [];
const env = { ...process.env, CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_NO_PROMPT_HOOK: '1' };

function shell(script: string, args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}, input?: string) {
  // A file avoids Windows command-line quoting altering the recipe's printf
  // escapes or our argument fixtures before Bash even reads them.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-shell-'));
  roots.push(root);
  const file = path.join(root, 'test.sh');
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  fs.writeFileSync(file, `set -- ${args.map(quote).join(' ')}\n${script}`);
  return spawnSync(bash, ['--noprofile', '--norc', file], {
    encoding: 'utf8', timeout: 30_000, env: { ...env, ...extraEnv }, input,
  });
}

function stage(osfam = windows ? 'win32' : process.platform) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph bundle space '));
  roots.push(root);
  const bundle = path.join(root, `codegraph-${osfam}-x64`);
  fs.mkdirSync(path.join(bundle, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(bundle, 'lib/dist/bin'), { recursive: true });
  const convert = windows ? '$(cygpath -u "$1")' : '$1';
  const runtime = windows ? '$(cygpath -u "$2")' : '$2';
  // Use the test runner's JS executable as a stand-in so the launcher
  // fixtures do not require a second runtime on the test host.
  const result = shell(`set -eu\nSTAGE="${convert}"\nBUN_BIN="${runtime}"\nOSFAM="$3"\n${launcherRecipe}`, [bundle, process.execPath, osfam]);
  expect(result.status, result.stderr || String(result.error)).toBe(0);
  return { root, bundle };
}

function invoke(bundle: string, command: string, args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}, input?: string) {
  const convert = windows ? '$(cygpath -u "$1")' : '$1';
  // No host Bun on this PATH: execution must use the runtime in the bundle.
  return shell(`STAGE="${convert}"\nshift\nPATH="$STAGE/bin:/usr/bin:/bin"\nexport PATH\n${command}`,
    [bundle, ...args], extraEnv, input);
}

function probe(bundle: string) {
  fs.writeFileSync(path.join(bundle, 'lib/dist/bin/codegraph.js'), `
console.log(JSON.stringify({args: process.argv.slice(2), flags: process.execArgv,
  host: process.env.CODEGRAPH_HOST_PPID, exe: process.execPath}));
process.exit(23);
`);
}

function checkForwarding(bundle: string) {
  probe(bundle);
  const args = ['two words', '', 'quote"value', "single'value", '$literal', '*.ts', 'a&b'];
  const result = invoke(bundle, 'codegraph "$@"', args, { CODEGRAPH_HOST_PPID: '12345' });
  expect(result.status, result.stderr).toBe(23);
  const output = JSON.parse(result.stdout);
  expect(output.args).toEqual(args);
  expect(output.flags).toEqual([]);
  expect(output.host).toBe('12345');
  expect(fs.realpathSync(output.exe)).toBe(fs.realpathSync(path.join(bundle, windows ? 'bun.exe' : 'bun')));
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('bundled launchers (#1278)', () => {
  it.runIf(!windows)('preserves POSIX arguments, exit status and host PID without V8 flags', () => {
    checkForwarding(stage().bundle);
  });

  it.runIf(windows)('forwards Git Bash arguments, exit status and host PID from a spaced path without V8 flags', () => {
    checkForwarding(stage().bundle);
  });

  it.runIf(!windows)('resolves chained symlinks and supplies the parent PID when none is inherited', () => {
    const { root, bundle } = stage();
    probe(bundle);
    fs.symlinkSync(path.join(bundle, 'bin/codegraph'), path.join(root, 'absolute-link'));
    fs.symlinkSync('absolute-link', path.join(root, 'relative-link'));
    const result = shell(`unset CODEGRAPH_HOST_PPID
printf '%s\\n' "$$"
"$1"
exit "$?"`, [path.join(root, 'relative-link')]);
    expect(result.status, result.stderr).toBe(23);
    const [parent, output] = result.stdout.trim().split('\n');
    expect(JSON.parse(output).host).toBe(parent);
  });

  it.runIf(windows)('runs the real CLI and prompt hook in Git Bash, and keeps cmd and PowerShell working', () => {
    const { bundle } = stage();
    fs.rmSync(path.join(bundle, 'lib/dist'), { recursive: true });
    fs.symlinkSync(path.resolve('dist'), path.join(bundle, 'lib/dist'), 'junction');
    const version = require('../package.json').version;
    const result = invoke(bundle, 'codegraph --version');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(version);
    const hook = invoke(bundle, 'codegraph prompt-hook', [], {}, '{"prompt":"test"}\n');
    expect(hook.status, hook.stderr).toBe(0);
    const bin = path.join(bundle, 'bin');
    for (const [exe, args] of [
      ['cmd.exe', ['/d', '/s', '/c', 'codegraph --version']],
      ['powershell.exe', ['-NoProfile', '-Command', 'codegraph --version']],
    ] as const) {
      const control = spawnSync(exe, [...args], {
        cwd: bin, encoding: 'utf8', timeout: 30_000,
        env: {
          ...Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== 'path')),
          Path: `${bin};${process.env.Path || process.env.PATH}`,
        },
      });
      expect(control.status, control.stderr).toBe(0);
      expect(control.stdout.trim(), exe).toBe(version);
    }
  });

  it.runIf(!windows).each(['x64', 'arm64'])('ships both launchers in the Windows %s archive', (arch) => {
    const { root, bundle } = stage('win32');
    const target = `win32-${arch}`;
    if (arch !== 'x64') fs.renameSync(bundle, path.join(root, `codegraph-${target}`));
    const result = shell(`set -eu\nWORK="$1"\nOUT="$1/release"\nOSFAM=win32\nTARGET="$2"\n${archiveRecipe}`, [root, target]);
    expect(result.status, result.stderr).toBe(0);
    const list = spawnSync('unzip', ['-Z1', path.join(root, 'release', `codegraph-${target}.zip`)], { encoding: 'utf8' });
    expect(list.status, list.stderr).toBe(0);
    const entries = list.stdout.split('\n');
    for (const file of ['bin/codegraph', 'bin/codegraph.cmd', 'bun.exe']) {
      expect(entries).toContain(`codegraph-${target}/${file}`);
    }
    const cmd = fs.readFileSync(path.join(root, `codegraph-${target}`, 'bin/codegraph.cmd'), 'utf8');
    expect(cmd).toBe('@"%~dp0..\\bun.exe" "%~dp0..\\lib\\dist\\bin\\codegraph.js" %*\r\n');
  });
});

describe('bundled Bun runtime', () => {
  it('pins the bundled runtime and the release build host to the same Bun version, at least 1.4.4', () => {
    // The release workflow passes only the target, so the recipe's default
    // version is the Bun every release bundles.
    const workflow = fs.readFileSync(path.resolve('.github/workflows/release.yml'), 'utf8');
    const calls = [...workflow.matchAll(/^\s*bash scripts\/(build-bundle\.sh[^\r\n]*)/gm)];
    expect(calls.length).toBeGreaterThan(0);
    for (const [, command] of calls) expect(command.trim()).toBe('build-bundle.sh "$t"');

    const pin = /^BUN_VERSION="\$\{2:-((\d+)\.(\d+)\.(\d+))\}"\r?$/m.exec(recipe);
    if (!pin) throw new Error('Missing default BUN_VERSION in scripts/build-bundle.sh');
    const [, version, ...parts] = pin;
    const [major, minor, patch] = parts.map(Number);
    expect(major > 1 || (major === 1 && (minor > 4 || (minor === 4 && patch >= 4)))).toBe(true);
    expect(workflow).toMatch(new RegExp(`^\\s+bun-version: ${version.replace(/\./g, '\\.')}\\s*$`, 'm'));
  });
});

describe('bundled Bun integrity (#2780)', () => {
  const targets = [
    ['darwin-arm64', 'bun-darwin-aarch64', 'bun'],
    ['darwin-x64', 'bun-darwin-x64-baseline', 'bun'],
    ['linux-arm64', 'bun-linux-aarch64', 'bun'],
    ['linux-x64', 'bun-linux-x64-baseline', 'bun'],
    ['win32-arm64', 'bun-windows-aarch64', 'bun.exe'],
    ['win32-x64', 'bun-windows-x64-baseline', 'bun.exe'],
  ] as const;
  const release = 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.4';

  // Replace only the remote service. The recipe still chooses the URL, verifies
  // the checksum, and unpacks a real ZIP with the upstream layout.
  function download([target, dist, runtime]: typeof targets[number], sums: (sha: string, archive: string) => string | undefined) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-bun-download-'));
    roots.push(root);
    const site = path.join(root, 'site');
    const work = path.join(root, 'work');
    fs.mkdirSync(path.join(site, dist), { recursive: true });
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(site, dist, runtime), '#!/bin/sh\n');
    const archive = `${dist}.zip`;
    const arg = (n: number) => windows ? `$(cygpath -u "$${n}")` : `$${n}`;
    const pack = windows
      ? spawnSync('powershell.exe', ['-NoProfile', '-Command',
          'Compress-Archive -LiteralPath $env:FIXTURE_DIR -DestinationPath $env:FIXTURE_ZIP'], {
          encoding: 'utf8', env: { ...env, FIXTURE_DIR: path.join(site, dist), FIXTURE_ZIP: path.join(site, archive) },
        })
      : shell('set -eu\ncd "$1"\nzip -qr "$2" "$3"', [site, archive, dist]);
    expect(pack.status, pack.stderr).toBe(0);
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(site, archive))).digest('hex');
    const published = sums(sha, archive);
    if (published !== undefined) fs.writeFileSync(path.join(site, 'SHASUMS256.txt'), published);
    const step = recipe.slice(recipe.indexOf('# 1. Download'), recipe.indexOf('# 2. Build'));
    const result = shell(`set -euo pipefail
WORK="${arg(1)}"
SITE="${arg(2)}"
TARGET="$3" OSFAM="\${3%-*}" BUN_VERSION=1.4.4
curl() {
  local url='' out=''
  while [ $# -gt 0 ]; do
    case "$1" in -o) out="$2"; shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac
  done
  printf '%s\\n' "$url" >> "$WORK/urls"
  cp "$SITE/\${url##*/}" "$out"
}
${step}
printf 'BUN_BIN=%s\\n' "$BUN_BIN"`, [work, site, target]);
    const urls = fs.existsSync(path.join(work, 'urls'))
      ? fs.readFileSync(path.join(work, 'urls'), 'utf8').trim().split('\n')
      : [];
    return { result, work, urls };
  }

  it.each(targets)('verifies and unpacks the official %s runtime', (target, dist, runtime) => {
    const { result, work, urls } = download([target, dist, runtime], (sha, archive) =>
      `${'f'.repeat(64)}  ${dist}-profile.zip\n${sha}  ${archive}\n`);
    expect(result.status, result.stderr).toBe(0);
    expect(urls).toEqual([
      `${release}/${dist}.zip`,
      `${release}/SHASUMS256.txt`,
    ]);
    expect(fs.existsSync(path.join(work, dist, runtime))).toBe(true);
    expect(result.stdout.trim().split(/\r?\n/).pop()).toMatch(`/${dist}/${runtime}`);
  });

  const invalidSums: [string, (sha: string, archive: string) => string | undefined][] = [
    ['wrong digest', (_, archive) => `${'0'.repeat(64)}  ${archive}\n`],
    ['missing entry', (sha) => `${sha}  bun-linux-aarch64.zip\n`],
    ['malformed digest', (_, archive) => `not-hex  ${archive}\n`],
    ['duplicate entries', (sha, archive) => `${sha}  ${archive}\n${sha}  ${archive}\n`],
    ['missing checksum asset', () => undefined],
  ];
  it.each(invalidSums)('refuses to unpack a Bun download with %s', (_, sums) => {
    const fixture = targets[3];
    const { result, work, urls } = download(fixture, sums);
    const archive = `${fixture[1]}.zip`;
    expect(result.status).toBe(1);
    expect(urls).toEqual([`${release}/${archive}`, `${release}/SHASUMS256.txt`]);
    expect(fs.existsSync(path.join(work, archive))).toBe(true);
    expect(fs.existsSync(path.join(work, fixture[1]))).toBe(false);
  });
});
