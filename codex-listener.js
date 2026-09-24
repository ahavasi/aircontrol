#!/usr/bin/env node
'use strict';
// A small mailbox watcher, not an agent. No model runs until a message arrives.
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { randomUUID } = require('crypto');
const WebSocket = require('ws');
const C = require('./coord.js');

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function listenerFile(id) { return path.join(path.dirname(C.sessionFile(id)), '..', 'listeners', id + '.json'); }
function readState(id) { try { return JSON.parse(fs.readFileSync(listenerFile(id), 'utf8')); } catch { return null; } }
function writeState(id, state) {
  const file = listenerFile(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function codexBinary() {
  const candidates = [process.env.AIRCONTROL_CODEX_BINARY, path.join(C.codexHome(), 'packages', 'standalone', 'current', 'codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex',
    ...(process.env.PATH || '').split(path.delimiter).map(p => path.join(p, 'codex'))];
  return candidates.find(p => p && fs.existsSync(p));
}
function ownerPid() {
  try {
    const rows = C.parseProcTable(execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8', timeout: 1500 }));
    const byPid = new Map(rows.map(p => [p.pid, p]));
    let row = byPid.get(process.pid);
    for (let n = 0; row && n < 16; n++, row = byPid.get(row.ppid)) {
      if (/^codex(?:-[a-z0-9]+)*$/i.test(path.basename(row.command))) return row.pid;
    }
  } catch {}
  return null;
}

// Each child claims its own exclusive lock. Concurrent SessionStart/first-prompt
// hooks can spawn two candidates, but only one can connect or enqueue messages.
function acquire(id) {
  const lock = listenerFile(id) + '.lock';
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try { fs.mkdirSync(lock); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let owner;
    try { owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner'), 'utf8')); } catch {}
    if (owner ? alive(owner.pid) : Date.now() - fs.statSync(lock).mtimeMs < 30000) return null;
    fs.rmSync(lock, { recursive: true, force: true });
    try { fs.mkdirSync(lock); } catch { return null; }
  }
  fs.writeFileSync(path.join(lock, 'owner'), JSON.stringify({ pid: process.pid }));
  return () => fs.rmSync(lock, { recursive: true, force: true });
}

function ensureListener(input, { manual = false } = {}) {
  if (process.env.AIRCONTROL_DISABLE_LISTENER === '1') return;
  const id = input.session_id;
  const session = C.isSafeComponent(id) && C.readSession(id);
  if (!session || session.harness !== 'codex') return;
  const previous = readState(id);
  if (previous && alive(previous.pid)) return;
  const binary = codexBinary();
  if (!binary) return;
  const args = [__filename, '--session', id, '--binary', binary];
  const owner = manual ? (previous && alive(previous.ownerPid) ? previous.ownerPid : null) : ownerPid();
  if (owner) args.push('--owner', String(owner));
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', cwd: session.worktree });
  child.on('error', () => {});
  child.unref();
}

// Codex's control socket uses WebSocket over Unix. The CLI's `proxy` is a
// raw byte relay (not a JSONL bridge), so speak the protocol directly.
class Rpc {
  constructor(socketPath = process.env.AIRCONTROL_CODEX_SOCKET || path.join(C.codexHome(), 'app-server-control', 'app-server-control.sock')) {
    this.pending = new Map(); this.next = 0;
    this.socket = new WebSocket('ws+unix://' + socketPath + ':/', { perMessageDeflate: false, handshakeTimeout: 5000, maxPayload: 16 * 1024 * 1024 });
    this.ready = new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    // Rejections are also observed by initialize/request; attach a handler now
    // so a failed connect cannot become an unhandled rejection between calls.
    this.ready.catch(() => {});
    this.socket.on('error', e => this.fail(e));
    this.socket.on('close', () => this.fail(new Error('Codex daemon disconnected')));
    this.socket.on('message', data => {
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || 'Codex RPC failed'));
      else p.resolve(msg.result);
    });
  }
  fail(error) {
    this.error = error;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
  async request(method, params) {
    await this.ready;
    if (this.error) throw this.error;
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex RPC timed out')); }, 8000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), e => { if (e) this.fail(e); });
    });
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'aircontrol', version: '1.0.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
    this.socket.send(JSON.stringify({ method: 'initialized', params: {} }));
  }
  close() { this.fail(new Error('connection closed')); this.socket.terminate(); }
}

const WAKE_MESSAGE = '[aircontrol] Coordination messages are waiting in your aircontrol inbox. '
  + 'Handle the messages supplied by the UserPromptSubmit hook, then continue your existing task. '
  + 'If the inbox was already handled by a Stop hook, no further action is needed.';

async function tick(id, state, rpc, now = Date.now()) {
  const session = C.readSession(id);
  if (!session || (state.ownerPid && !alive(state.ownerPid))) return false;
  const result = await rpc.request('thread/read', { threadId: id, includeTurns: false });
  const thread = result.thread;
  const loaded = thread.status && thread.status.type !== 'notLoaded';
  if (state.seenLoaded && !loaded && !state.ownerPid) return false;
  if (loaded) state.seenLoaded = true;
  if (!loaded && !state.ownerPid && C.isExpired(session, now)) return false;
  if (!state.named) {
    const name = C.friendlyName(id);
    if (thread.name !== name) await rpc.request('thread/name/set', { threadId: id, name });
    state.named = true;
  }
  // A resumed thread can outlive its original listener; never keep a dead registry
  // entry alive simply because this watcher exists.
  if ((loaded || alive(state.ownerPid)) && now - Date.parse(session.lastSeen) >= 60000) {
    C.updateSession(id, s => { s.lastSeen = new Date(now).toISOString(); return s; });
  }
  const inbox = C.readInbox(id);
  const files = inbox.map(m => path.basename(m.file));
  if (!files.length) state.pendingWake = null;
  // Let Stop handle an active shared-daemon thread without adding a redundant turn.
  if (files.length && !(thread.status && thread.status.type === 'active')) {
    if (!state.pendingWake || !state.pendingWake.files.some(f => files.includes(f))) {
      state.pendingWake = { files, clientId: randomUUID(), sent: false };
      writeState(id, state);
    }
    if (!state.pendingWake.sent) {
      await rpc.request('thread/queue/add', { threadId: id,
        input: [{ type: 'text', text: WAKE_MESSAGE, text_elements: [] }], clientUserMessageId: state.pendingWake.clientId });
      state.pendingWake.sent = true;
    }
  }
  state.status = loaded ? 'listening' : 'listening (embedded session; title may require reopening)';
  state.checkedAt = new Date(now).toISOString();
  delete state.error;
  writeState(id, state);
  return true;
}

async function discover(rpc) {
  let cursor = null;
  const found = [];
  do {
    const page = await rpc.request('thread/loaded/list', { cursor, limit: 100 });
    for (const id of page.data) {
      if (!C.isSafeComponent(id)) continue;
      if (!C.readSession(id)) {
        const { thread } = await rpc.request('thread/read', { threadId: id, includeTurns: false });
        // Subagents have their own native coordination and do not run root hooks.
        if (typeof thread.source === 'object' && thread.source && 'subAgent' in thread.source) continue;
        C.cmdRegister({ session_id: id, cwd: thread.cwd, transcript_path: thread.path }, Date.now(), 'codex');
      }
      ensureListener({ session_id: id }, { manual: true });
      found.push(id);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return found;
}

async function archive(args) {
  const id = args.session;
  if (!C.isSafeComponent(id)) throw new Error('invalid session ID');
  const rpc = args.rpc || new Rpc();
  try {
    await rpc.initialize();
    await rpc.request('thread/archive', { threadId: id });
  } finally {
    if (!args.rpc) rpc.close();
  }
}

async function monitor(args) {
  let rpc, stopped = false, wake;
  const stop = () => { stopped = true; if (wake) wake(); if (rpc) rpc.close(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  const status = { pid: process.pid, status: 'connecting' };
  try {
    while (!stopped) {
      try {
        if (!rpc) {
          // Native start is idempotent and uses Codex's own daemon lock. No
          // thread is resumed, and remote control is never enabled here.
          execFileSync(args.binary || codexBinary(), ['app-server', 'daemon', 'start'], { stdio: 'ignore', timeout: 12000 });
          rpc = new Rpc(); await rpc.initialize();
        }
        status.threads = await discover(rpc);
        status.status = 'listening';
      } catch {
        status.status = 'retrying';
        if (rpc) rpc.close(); rpc = null;
      }
      status.checkedAt = new Date().toISOString(); writeState('monitor', status);
      await new Promise(resolve => { const timer = setTimeout(done, rpc ? 1000 : 5000);
        function done() { clearTimeout(timer); wake = null; resolve(); } wake = done; });
    }
  } finally {
    if (rpc) rpc.close(); status.pid = null; status.status = 'stopped'; writeState('monitor', status);
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
  }
}

async function run(args) {
  const id = args.session;
  if (!C.isSafeComponent(id)) throw new Error('invalid session ID');
  const release = acquire(id);
  if (!release) return;
  const old = readState(id);
  const session = C.readSession(id);
  if (!session) { release(); return; }
  const state = { ...(old && old.sessionStartedAt === session.startedAt ? old : {}), pid: process.pid,
    ownerPid: Number(args.owner) || null, sessionStartedAt: session.startedAt, status: 'connecting' };
  writeState(id, state);
  let rpc, stopped = false, wake;
  const stop = () => { stopped = true; if (wake) wake(); if (rpc) rpc.close(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  const inboxDir = path.join(path.dirname(C.sessionFile(id)), '..', 'messages', id);
  fs.mkdirSync(inboxDir, { recursive: true });
  const watcher = fs.watch(inboxDir, () => { if (wake) wake(); });
  watcher.on('error', () => {}); // polling remains the fallback
  try {
    while (!stopped) {
      if (!C.readSession(id) || (state.ownerPid && !alive(state.ownerPid))) break;
      try {
        if (!rpc) { rpc = new Rpc(); await rpc.initialize(); }
        if (!await tick(id, state, rpc)) break;
      } catch {
        state.status = 'retrying';
        state.error = 'Codex daemon unavailable or thread not ready; inbox remains unread';
        state.checkedAt = new Date().toISOString(); writeState(id, state);
        if (rpc) rpc.close(); rpc = null;
        const current = C.readSession(id);
        if (!current || (!state.ownerPid && C.isExpired(current, Date.now()))) break;
      }
      await new Promise(resolve => { const timer = setTimeout(done, rpc ? 2000 : 10000);
        function done() { clearTimeout(timer); wake = null; resolve(); } wake = done; });
    }
  } finally {
    watcher.close(); if (rpc) rpc.close();
    state.pid = null; state.status = 'stopped'; writeState(id, state); release();
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
  }
}

module.exports = { alive, listenerFile, readState, writeState, acquire, ensureListener, Rpc, tick, run, discover, archive, monitor, WAKE_MESSAGE };
if (require.main === module) {
  const args = C.parseArgs(process.argv.slice(2));
  (args.monitor ? monitor(args) : args.archive ? archive(args) : run(args)).catch(() => { process.exitCode = 1; });
}
