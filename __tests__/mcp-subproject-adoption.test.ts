/**
 * MCP current-directory fallback and no-default diagnostics.
 *
 * With no .codegraph marker at or above cwd, the server retains cwd even
 * when indexed projects exist beneath it. Tools remain available with
 * initialization guidance, and a newly initialized cwd is picked up live.
 *
 * Same real-subprocess harness as mcp-roots.test.ts — no mocking.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { once } from 'events';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function spawnServer(cwd: string): ChildProcessWithoutNullStreams {
  // --no-watch keeps the test deterministic; CODEGRAPH_NO_DAEMON keeps the
  // session in direct mode so no detached daemon outlives the test.
  return spawn(process.execPath, [...WASM_RUNTIME_FLAGS, BIN, 'serve', '--mcp', '--no-watch'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
  }) as ChildProcessWithoutNullStreams;
}

function collectMessages(child: ChildProcessWithoutNullStreams): Array<Record<string, any>> {
  const messages: Array<Record<string, any>> = [];
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try { messages.push(JSON.parse(line)); } catch { /* ignore non-JSON */ }
    }
  });
  return messages;
}

function collectStderr(child: ChildProcessWithoutNullStreams): { text: () => string } {
  let buf = '';
  child.stderr.on('data', (chunk) => { buf += chunk.toString('utf8'); });
  return { text: () => buf };
}

function waitForMessage(
  messages: ReadonlyArray<Record<string, any>>,
  predicate: (m: Record<string, any>) => boolean,
  timeoutMs: number,
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const hit = messages.find(predicate);
      if (hit) return resolve(hit);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`Timed out. Messages so far: ${JSON.stringify(messages)}`));
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

function send(child: ChildProcessWithoutNullStreams, msg: object): void {
  child.stdin.write(JSON.stringify(msg) + '\n');
}

const CLIENT_INFO = { name: 'test', version: '0.0.0' };

/** Create ws/<name> with one source file and an initialized .codegraph/. */
async function makeIndexedChild(ws: string, name: string): Promise<string> {
  const dir = path.join(ws, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.ts'), `export function hello_${name}() { return 1; }\n`);
  const cg = await CodeGraph.init(dir);
  cg.close();
  return dir;
}

/** initialize without rootUri or a roots capability, then notify initialized. */
async function initializeSession(
  child: ChildProcessWithoutNullStreams,
  messages: Array<Record<string, any>>,
): Promise<Record<string, any>> {
  send(child, {
    jsonrpc: '2.0', id: 0, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: CLIENT_INFO },
  });
  const initResult = await waitForMessage(messages, (m) => m.id === 0 && !!m.result, 5000);
  send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });
  return initResult;
}

async function callStatus(
  child: ChildProcessWithoutNullStreams,
  messages: Array<Record<string, any>>,
  id: number,
): Promise<string> {
  send(child, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'codegraph_status', arguments: {} } });
  const resp = await waitForMessage(messages, (m) => m.id === id, 10000);
  return resp.result.content[0].text as string;
}

async function driveStatusCall(
  child: ChildProcessWithoutNullStreams,
  messages: Array<Record<string, any>>,
): Promise<{ initResult: Record<string, any>; statusText: string }> {
  const initResult = await initializeSession(child, messages);
  return { initResult, statusText: await callStatus(child, messages, 1) };
}

describe('MCP keeps cwd when no ancestor workspace exists', () => {
  let ws: string;
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeEach(() => {
    ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-ws-')));
  });

  afterEach(async () => {
    // Spawn with the runtime flags so this is the server, not a relauncher
    // whose grandchild would retain the Windows cwd/database handles.
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
    }
    child = null;
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('does not adopt a single indexed child, even when cwd has a .git directory', async () => {
    fs.mkdirSync(path.join(ws, '.git'));
    await makeIndexedChild(ws, 'service-a');

    child = spawnServer(ws);
    const messages = collectMessages(child);
    const stderr = collectStderr(child);

    const { initResult, statusText } = await driveStatusCall(child, messages);

    expect(statusText).toContain('No CodeGraph project is loaded');
    expect(statusText).toContain(ws);
    expect(statusText).toContain('codegraph init');
    expect(statusText).not.toContain('service-a');
    expect(stderr.text()).toContain('no default project, live sync disabled');
    expect(stderr.text()).not.toContain('adopted the single indexed sub-project');
    expect(fs.existsSync(path.join(ws, '.codegraph'))).toBe(false);
    const instructions = initResult.result.instructions as string;
    expect(instructions).toContain('per-project; pass projectPath');
  }, 20000);

  it('does not discover or list indexed descendants of a workspace manifest', async () => {
    fs.writeFileSync(path.join(ws, 'package.json'), '{"private":true,"workspaces":["service-*"]}');
    await makeIndexedChild(ws, 'service-a');
    await makeIndexedChild(ws, 'service-b');

    child = spawnServer(ws);
    const messages = collectMessages(child);
    const stderr = collectStderr(child);

    const { initResult, statusText } = await driveStatusCall(child, messages);

    expect(statusText).toContain('No CodeGraph project is loaded');
    expect(statusText).toContain(ws);
    expect(statusText).not.toContain('Indexed sub-projects were found below it');
    expect(statusText).not.toContain('service-a');
    expect(statusText).not.toContain('service-b');
    expect(statusText).toContain('projectPath');
    expect(stderr.text()).toContain('no default project, live sync disabled');
    expect(stderr.text()).not.toContain('Indexed sub-projects found:');
    expect(fs.existsSync(path.join(ws, '.codegraph'))).toBe(false);
    const instructions = initResult.result.instructions as string;
    expect(instructions).toContain('per-project; pass projectPath');
  }, 20000);

  it('also keeps an unindexed cwd with no manifest or .git directory', async () => {
    await makeIndexedChild(ws, 'service-a');

    child = spawnServer(ws);
    const messages = collectMessages(child);
    const stderr = collectStderr(child);

    const { statusText } = await driveStatusCall(child, messages);

    expect(statusText).toContain('No CodeGraph project is loaded');
    expect(statusText).not.toContain('Indexed sub-projects were found below it');
    expect(stderr.text()).toContain('no default project, live sync disabled');
    expect(stderr.text()).not.toContain('Indexed sub-projects found:');
  }, 20000);

  it('ignores a child initialized after startup, then picks up cwd initialized later', async () => {
    fs.writeFileSync(path.join(ws, 'package.json'), '{"private":true}');
    child = spawnServer(ws);
    const messages = collectMessages(child);
    const stderr = collectStderr(child);
    const initResult = await initializeSession(child, messages);
    expect(initResult.result.instructions).toContain('per-project; pass projectPath');

    // Create the child after the handshake and before the first tool call:
    // this exercises the live retry without relying on a scan-throttle delay.
    await makeIndexedChild(ws, 'new-child');
    const withoutRoot = await callStatus(child, messages, 1);
    expect(withoutRoot).toContain('No CodeGraph project is loaded');
    expect(withoutRoot).toContain(ws);
    expect(withoutRoot).not.toContain('new-child');
    expect(fs.existsSync(path.join(ws, '.codegraph'))).toBe(false);

    fs.writeFileSync(path.join(ws, 'root.py'), 'def workspace_retry_marker():\n    return 1\n');
    const current = await CodeGraph.init(ws);
    try { await current.indexFiles(['root.py']); }
    finally { current.close(); }
    const initialized = await callStatus(child, messages, 2);
    expect(initialized).toContain('CodeGraph Status');
    expect(initialized).not.toContain('No CodeGraph project is loaded');
    send(child, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'codegraph_search', arguments: { query: 'workspace_retry_marker' } },
    });
    const search = await waitForMessage(messages, (message) => message.id === 3, 10000);
    expect(search.result.content[0].text).toContain('workspace_retry_marker');
    expect(stderr.text()).not.toContain('adopted the single indexed sub-project');
  }, 30000);
});
