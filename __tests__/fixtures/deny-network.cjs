/**
 * Preloaded into the real CLI and its daemon/workers. Record every forbidden
 * network attempt before rejecting it, including attempts product code catches
 * silently. Local Unix sockets / Windows named pipes remain available for IPC.
 */
const fs = require('node:fs');
const net = require('node:net');
const log = process.env.CG_TEST_NETWORK_LOG;

if (log) {
  function record(kind, operation) {
    fs.appendFileSync(log, JSON.stringify({ kind, operation, pid: process.pid }) + '\n');
  }
  function deny(operation) {
    record('forbidden', operation);
    throw new Error('Network disabled by the test: ' + operation);
  }
  function ipcPath(args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const value = typeof first === 'string' ? first : first && typeof first === 'object' ? first.path : null;
    return typeof value === 'string' && value.length > 0 && !/^\d+$/.test(value);
  }

  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    if (!ipcPath(args)) return deny('tcp-listen');
    record('ipc', 'listen');
    return listen.apply(this, args);
  };
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    if (!ipcPath(args)) return deny('tcp-connect');
    return connect.apply(this, args);
  };
  for (const module of ['node:http', 'node:https']) {
    const api = require(module);
    api.request = () => deny(module + ':request');
    api.get = () => deny(module + ':get');
  }
  require('node:tls').connect = () => deny('tls-connect');
  require('node:dgram').createSocket = () => deny('udp-socket');
  globalThis.fetch = async () => deny('fetch');

  // A default installer must not launch an external package download either.
  const cp = require('node:child_process');
  for (const method of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync']) {
    const original = cp[method];
    cp[method] = function (...args) {
      if (typeof args[0] === 'string' && /\b(?:npm(?:\.cmd)?\s+(?:i|install)|curl|wget)\b/.test(args[0])) {
        return deny('external-download');
      }
      return original.apply(this, args);
    };
  }
}
