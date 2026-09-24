'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const { WebSocketServer } = require('ws');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aircontrol-listener-test-'));
process.env.AIRCONTROL_DIR = root;
process.env.AIRCONTROL_CODEX_SOCKET = path.join(root, 'missing.sock');
process.env.AIRCONTROL_DISABLE_LISTENER = '1';
const C = require('./coord.js');
const L = require('./codex-listener.js');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture(id) {
  const now = Date.now();
  C.writeSession({ sessionId: id, harness: 'codex', worktree: root, startedAt: new Date(now).toISOString(),
    lastSeen: new Date(now).toISOString(), claims: { paths: [], resources: [] } });
  const dir = path.join(root, 'messages', id); fs.mkdirSync(dir, { recursive: true });
  const calls = [];
  const rpc = { request: async (method, params) => { calls.push({ method, params });
    return method === 'thread/read' ? { thread: { name: null, status: { type: 'idle' } } } : {}; } };
  const state = { pid: process.pid, ownerPid: null };
  const message = () => {
    const file = path.join(dir, Date.now() + '-sender.md'); fs.writeFileSync(file, 'Coordinate on this file'); return file;
  };
  return { calls, rpc, state, message };
}

test('startup names the thread without starting a model; retries do not overwrite later custom names', async () => {
  const f = fixture('naming');
  await L.tick('naming', f.state, f.rpc); await L.tick('naming', f.state, f.rpc);
  assert.deepEqual(f.calls.filter(c => c.method !== 'thread/read'), [
    { method: 'thread/name/set', params: { threadId: 'naming', name: C.friendlyName('naming') } },
  ]);
});
test('archive asks the local Codex daemon to archive exactly the finished thread', async () => {
  const calls = [];
  const rpc = {
    initialize: async () => { calls.push({ method: 'initialize' }); },
    request: async (method, params) => { calls.push({ method, params }); },
  };
  await L.archive({ session: 'finished-thread', rpc });
  assert.deepEqual(calls, [
    { method: 'initialize' },
    { method: 'thread/archive', params: { threadId: 'finished-thread' } },
  ]);
});
test('idle wakeup is queued once and preserves unread messages for the prompt hook', async () => {
  const f = fixture('idle'); const file = f.message();
  await L.tick('idle', f.state, f.rpc); await L.tick('idle', f.state, f.rpc);
  assert.equal(f.calls.filter(c => c.method === 'thread/queue/add').length, 1);
  assert.ok(fs.existsSync(file));
  const persisted = L.readState('idle');
  await L.tick('idle', persisted, f.rpc);
  assert.equal(f.calls.filter(c => c.method === 'thread/queue/add').length, 1, 'restart retains the pending wake');
  fs.renameSync(file, file + '.read'); await L.tick('idle', persisted, f.rpc);
  assert.equal(persisted.pendingWake, null);
});
test('queue failure leaves the inbox readable and reuses the correlation ID on retry', async () => {
  const f = fixture('retry'); const file = f.message(); let clientId;
  const original = f.rpc.request;
  f.rpc.request = async (method, params) => {
    if (method === 'thread/queue/add') { clientId = params.clientUserMessageId; throw new Error('offline'); }
    return original(method, params);
  };
  await assert.rejects(L.tick('retry', f.state, f.rpc), /offline/);
  assert.ok(fs.existsSync(file));
  f.rpc.request = original; await L.tick('retry', f.state, f.rpc);
  assert.equal(f.calls.find(c => c.method === 'thread/queue/add').params.clientUserMessageId, clientId);
});
test('active threads let Stop deliver; ended sessions do not reconnect', async () => {
  const f = fixture('active'); f.message();
  f.rpc.request = async (method, params) => { f.calls.push({ method, params });
    return { thread: { name: C.friendlyName('active'), status: { type: 'active' } } }; };
  await L.tick('active', f.state, f.rpc);
  assert.equal(f.calls.filter(c => c.method === 'thread/queue/add').length, 0);
  fs.unlinkSync(C.sessionFile('active')); f.calls.length = 0;
  assert.equal(await L.tick('active', f.state, f.rpc), false); assert.equal(f.calls.length, 0);
});
test('dead unowned sessions expire; live loaded idle threads keep their registry heartbeat', async () => {
  const f = fixture('expiry'); const future = Date.now() + 31 * 60000;
  f.rpc.request = async () => ({ thread: { status: { type: 'notLoaded' } } });
  assert.equal(await L.tick('expiry', f.state, f.rpc, future), false);
  f.rpc.request = async () => ({ thread: { status: { type: 'idle' } } });
  assert.equal(await L.tick('expiry', f.state, f.rpc, future), true);
  assert.equal(Date.parse(C.readSession('expiry').lastSeen), future);
});
test('only one watcher acquires a session lock and a dead owner can be recovered', () => {
  const release = L.acquire('singleton'); assert.ok(release); assert.equal(L.acquire('singleton'), null); release();
  const lock = L.listenerFile('singleton') + '.lock'; fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner'), JSON.stringify({ pid: 2147483647 }));
  const recovered = L.acquire('singleton'); assert.ok(recovered); recovered();
});
test('daemon monitor registers empty threads before their first prompt and handles pagination', async () => {
  const calls = [];
  const rpc = { request: async (method, params) => { calls.push({ method, params });
    if (method === 'thread/loaded/list') return params.cursor ? { data: ['pre-prompt-2'], nextCursor: null } : { data: ['pre-prompt-1'], nextCursor: 'next' };
    return { thread: { cwd: root, source: 'cli', path: null } };
  } };
  assert.deepEqual(await L.discover(rpc), ['pre-prompt-1', 'pre-prompt-2']);
  assert.equal(C.readSession('pre-prompt-1').harness, 'codex');
  assert.equal(C.readSession('pre-prompt-2').worktree, root);
  assert.equal(calls.filter(c => c.method === 'thread/start' || c.method === 'thread/resume').length, 0);
});
test('real Unix WebSocket RPC negotiates without compression and propagates server errors', async () => {
  const socket = path.join(root, 'rpc.sock');
  const server = http.createServer(); const wss = new WebSocketServer({ noServer: true });
  let compression;
  server.on('upgrade', (req, stream, head) => {
    compression = req.headers['sec-websocket-extensions'];
    wss.handleUpgrade(req, stream, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => ws.on('message', data => {
    const m = JSON.parse(data); if (!m.id) return;
    ws.send(JSON.stringify(m.method === 'initialize' ? { id: m.id, result: {} } : { id: m.id, error: { message: 'thread missing' } }));
  }));
  await new Promise(resolve => server.listen(socket, resolve)); const rpc = new L.Rpc(socket);
  try { await rpc.initialize(); assert.equal(compression, undefined);
    await assert.rejects(rpc.request('thread/read', { threadId: 'missing' }), /thread missing/);
  } finally { rpc.close(); for (const client of wss.clients) client.terminate(); await new Promise(resolve => server.close(resolve)); wss.close(); }
});
test('watcher exits and releases its lock after SessionEnd even when daemon is down', async () => {
  fixture('end-to-end');
  const fake = path.join(root, 'fake-codex'); fs.writeFileSync(fake, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const child = spawn(process.execPath, [path.join(__dirname, 'codex-listener.js'), '--session', 'end-to-end', '--binary', fake], { env: process.env, stdio: 'ignore' });
  const waitUntil = async fn => { const end = Date.now() + 3000;
    while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 20)); } };
  try {
    await waitUntil(() => L.readState('end-to-end')?.status === 'retrying');
    fs.unlinkSync(C.sessionFile('end-to-end'));
    // Inbox events wake the retry sleep too; there is no required model turn.
    fs.writeFileSync(path.join(root, 'messages', 'end-to-end', 'wake'), '');
    await waitUntil(() => child.exitCode !== null);
    assert.equal(child.exitCode, 0);
    assert.equal(L.readState('end-to-end').status, 'stopped');
    assert.equal(fs.existsSync(L.listenerFile('end-to-end') + '.lock'), false);
  } finally { if (child.exitCode === null) child.kill(); }
});
