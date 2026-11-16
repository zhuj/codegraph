import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { pathToFileURL } from 'url';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { once } from 'events';
import { CodeGraph } from '../src';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';
import { recordSpawns, removeSpawnLog, settleLosingCandidates } from './daemon-candidates';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const GUARD = path.resolve(__dirname, 'fixtures/deny-network.cjs');

/** Some CI sandboxes deny AF_UNIX too; their supported path is direct fallback. */
async function localIpcRefusal(): Promise<string | null> {
  const address = process.platform === 'win32'
    ? `\\\\.\\pipe\\codegraph-offline-probe-${process.pid}`
    : path.join(os.tmpdir(), `codegraph-offline-probe-${process.pid}.sock`);
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code ?? '')) resolve(error.code!);
      else reject(error);
    });
    server.listen(address, () => server.close(() => resolve(null)));
  });
}

async function until<T>(get: () => T | undefined | false, label: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = get();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

describe('default offline behavior', () => {
  let fixture: string;
  let root: string;
  let networkLog: string;
  let env: NodeJS.ProcessEnv;
  let children: ChildProcessWithoutNullStreams[];

  beforeEach(() => {
    fixture = fs.mkdtempSync(path.join(os.homedir(), 'codegraph-offline-'));
    root = path.join(fixture, 'project');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'hello.ts'), 'export function offlineHello() { return 42; }\n');
    networkLog = path.join(fixture, 'network.jsonl');
    fs.writeFileSync(networkLog, '');
    env = { ...process.env, CG_TEST_NETWORK_LOG: networkLog };
    // Exercise actual defaults, not Vitest's protective opt-outs.
    for (const key of ['CODEGRAPH_TELEMETRY', 'DO_NOT_TRACK', 'CODEGRAPH_UPDATE_CHECK',
      'CODEGRAPH_NO_UPDATE_CHECK', 'CODEGRAPH_NO_DAEMON', 'CODEGRAPH_DAEMON_INTERNAL']) delete env[key];
    children = [];
  });

  const daemonPid = (): number | null => {
    try { return JSON.parse(fs.readFileSync(path.join(root, '.codegraph', 'daemon.pid'), 'utf8')).pid ?? null; }
    catch { return null; }
  };

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
    }
    await settleLosingCandidates(root, daemonPid);
    const pid = daemonPid();
    if (pid && pid !== process.pid) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already stopped */ }
      await until(() => !fs.existsSync(path.join(root, '.codegraph', 'daemon.pid')), 'daemon shutdown');
    }
    removeSpawnLog(root);
    await fs.promises.rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function launch(args: string[], overrides: NodeJS.ProcessEnv = {}) {
    const recorder = recordSpawns(root);
    const child = spawn(process.execPath, [...WASM_RUNTIME_FLAGS, '--require', GUARD, ...recorder.args, BIN, ...args], {
      cwd: root,
      env: { ...env, ...recorder.env, ...overrides },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.stdin.on('error', () => { /* reported by exit/timeout */ });
    return { child, stdout: () => stdout, stderr: () => stderr };
  }

  function assertOffline() {
    const attempts = fs.readFileSync(networkLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(attempts.filter(attempt => attempt.kind === 'forbidden')).toEqual([]);
    const stateDir = path.join(os.homedir(), '.codegraph');
    const stateFiles = fs.existsSync(stateDir) ? fs.readdirSync(stateDir) : [];
    expect(stateFiles.filter(name => name.startsWith('telemetry') || name === 'update-check.json')).toEqual([]);
    return attempts;
  }

  it('initializes, indexes, queries and configures an agent without external traffic or telemetry state', async () => {
    for (const args of [
      ['init', '--yes'], ['index', '--quiet'], ['sync'], ['status'], ['query', 'offlineHello'],
      ['install', '--yes', '--target', 'opencode', '--location', 'global'],
    ]) {
      const process = launch(args);
      const [code] = await once(process.child, 'close');
      expect(code, `${args.join(' ')}\n${process.stderr()}\n${process.stdout()}`).toBe(0);
      expect(assertOffline()).toEqual([]);
    }
  }, 45_000);

  it.each(['direct', 'daemon'])('serves MCP tools in %s mode without external connections or auxiliary TCP ports', async mode => {
    const ipcRefusal = mode === 'daemon' ? await localIpcRefusal() : null;
    const cg = await CodeGraph.init(root);
    await cg.indexAll();
    cg.destroy();
    const process = launch(['serve', '--mcp'], mode === 'direct'
      ? { CODEGRAPH_NO_DAEMON: '1' }
      : { CODEGRAPH_MCP_LOG_ATTACH: '1' });
    const send = (message: unknown) => process.child.stdin.write(JSON.stringify(message) + '\n');
    const response = (id: number) => {
      for (const line of process.stdout().split('\n')) {
        try { const value = JSON.parse(line); if (value.id === id) return value; } catch { /* partial frame */ }
      }
      return undefined;
    };
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'offline-test', version: '1' },
      rootUri: pathToFileURL(root).href,
    } });
    expect((await until(() => response(1), `initialize: ${process.stderr()}`)).result.serverInfo.name).toBe('codegraph');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'codegraph_explore', arguments: { query: 'offlineHello' } } });
    const result = await until(() => response(2), `tool response: ${process.stderr()}`);
    expect(result.error).toBeUndefined();
    expect(result.result.isError).not.toBe(true);
    expect(JSON.stringify(result.result)).toContain('offlineHello');
    if (mode === 'daemon' && !ipcRefusal) await until(() => !!daemonPid(), 'shared daemon startup');
    const attempts = assertOffline();
    if (mode === 'daemon') {
      expect(attempts.some(attempt => attempt.kind === 'ipc' && attempt.operation === 'listen')).toBe(true);
      if (ipcRefusal) {
        // The same MCP request succeeded above through the direct fallback;
        // blocked local IPC must never cause a fallback to a TCP listener.
        expect(fs.readFileSync(path.join(root, '.codegraph', 'daemon.log'), 'utf8')).toContain(ipcRefusal);
      }
    }
    else expect(attempts).toEqual([]);
  }, 35_000);
});
