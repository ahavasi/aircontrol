'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Room, sha256Hex, pathsOverlap, deployContends } = require('./room.js');
const coord = require('../coord.js');

function memStorage() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? structuredClone(m.get(k)) : undefined; },
    async put(k, v) { m.set(k, structuredClone(v)); },
    async delete(k) { return m.delete(k); },
    async list({ prefix = '', limit } = {}) {
      const out = new Map([...m.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit || Infinity).map(([k, v]) => [k, structuredClone(v)]));
      return out;
    },
    raw: m,
  };
}

async function room() {
  const r = new Room(memStorage(), await sha256Hex('admin-secret'));
  const { token } = await r.addToken('laptop');
  return { r, token };
}

const now = Date.parse('2026-09-30T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const sess = (id, extra = {}) => ({ sessionId: id, repoKey: 'github.com/me/app', intent: 'work', lastSeen: iso(now), claims: { paths: [], resources: [] }, ...extra });

test('pathsOverlap and deploy contention match coord.js', () => {
  for (const [a, b] of [['src', 'src/a.js'], ['src/', 'src'], ['Src/A', 'src/a/b'], ['src', 'srcx'], ['a/b', 'a']]) {
    assert.equal(pathsOverlap(a, b), coord.pathsOverlap(a, b), `${a} vs ${b}`);
  }
  assert.equal(deployContends('deploy', 'deploy:asc'), true);
  assert.equal(deployContends('deploy:asc', 'deploy:play'), false);
  assert.equal(deployContends('stash', 'stash'), false);
});

test('auth rejects missing, unknown and revoked tokens; admin only mints', async () => {
  const { r, token } = await room();
  assert.equal((await r.handle('GET', '/v1/status', '', null, now))[0], 401);
  assert.equal((await r.handle('GET', '/v1/status', 'nope', null, now))[0], 401);
  assert.equal((await r.handle('GET', '/v1/status', token, null, now))[0], 200);
  assert.equal((await r.handle('POST', '/v1/tokens', token, { name: 'x' }, now))[0], 403);
  const [st, minted] = await r.handle('POST', '/v1/tokens', 'admin-secret', { name: 'cloud' }, now);
  assert.equal(st, 200);
  assert.match(minted.token, /^acr_[0-9a-f]{64}$/);
  await r.handle('DELETE', '/v1/tokens/cloud', 'admin-secret', null, now);
  assert.equal((await r.handle('GET', '/v1/status', minted.token, null, now))[0], 401);
  // tokens are stored hashed, never raw
  assert.ok(![...r.storage.raw.keys()].some((k) => k.includes(minted.token)));
});

test('sync exchanges sessions across machines and routes messages with ack', async () => {
  const { r } = await room();
  await r.sync({ machine: 'mac', sessions: [sess('local-1')] }, now);
  const cloud = await r.sync({ machine: 'cloud-ab', sessions: [sess('session_x', { harness: 'claude' })] }, now);
  assert.deepEqual(cloud.sessions.map((s) => [s.sessionId, s.machine]), [['local-1', 'mac']]);
  const sent = await r.sync({ machine: 'cloud-ab', sessions: [sess('session_x')], outbox: [{ id: 'm1', from: 'session_x', to: 'local-1', text: 'hi' }, { id: 'm2', from: 'session_x', to: 'ghost', text: 'x' }] }, now);
  assert.deepEqual(sent.undelivered, ['m2']);
  const got = await r.sync({ machine: 'mac', sessions: [sess('local-1')] }, now);
  assert.equal(got.inbox.length, 1);
  assert.equal(got.inbox[0].fromMachine, 'cloud-ab');
  assert.equal(got.inbox[0].text, 'hi');
  const again = await r.sync({ machine: 'mac', sessions: [sess('local-1')], ack: ['m1'] }, now);
  assert.equal(again.inbox.length, 0);
});

test('sync rejects unsafe machine names and drops unsafe session ids', async () => {
  const { r } = await room();
  const [st] = await r.handle('POST', '/v1/sync', (await r.addToken('t')).token, { machine: '../x' }, now);
  assert.equal(st, 400);
  await r.sync({ machine: 'mac', sessions: [sess('../evil'), sess('ok-1')] }, now);
  const view = await r.sync({ machine: 'other', sessions: [] }, now);
  assert.deepEqual(view.sessions.map((s) => s.sessionId), ['ok-1']);
});

test('claim denies cross-machine overlap in the same repo only, and records atomically', async () => {
  const { r } = await room();
  await r.sync({ machine: 'mac', sessions: [sess('local-1', { claims: { paths: ['src/api'], resources: ['deploy:asc'] } })] }, now);
  const c1 = await r.claim({ machine: 'cloud-ab', sessionId: 'session_x', repoKey: 'github.com/me/app', paths: ['src/api/users.js'] }, now);
  assert.equal(c1.ok, false);
  assert.equal(c1.conflict.machine, 'mac');
  assert.equal(c1.conflict.claim, 'src/api');
  assert.equal((await r.claim({ machine: 'cloud-cd', sessionId: 'session_y', repoKey: 'github.com/me/other', paths: ['src/api'] }, now)).ok, true);
  assert.equal((await r.claim({ machine: 'cloud-ab', sessionId: 'session_x', repoKey: 'github.com/me/app', resources: ['deploy'] }, now)).ok, false);
  assert.equal((await r.claim({ machine: 'cloud-ab', sessionId: 'session_x', repoKey: 'github.com/me/app', paths: ['docs'], resources: ['deploy:play'] }, now)).ok, true);
  // recorded before the cloud machine syncs again: a third machine now collides with it
  const c3 = await r.claim({ machine: 'box', sessionId: 'b-1', repoKey: 'github.com/me/app', paths: ['docs/x.md'] }, now);
  assert.equal(c3.ok, false);
  assert.equal(c3.conflict.sessionId, 'session_x');
  // same machine never conflicts with itself at the relay
  assert.equal((await r.claim({ machine: 'mac', sessionId: 'local-2', repoKey: 'github.com/me/app', paths: ['src/api'] }, now)).ok, true);
});

test('expired claims stop conflicting and dead machines are pruned with their queues', async () => {
  const { r } = await room();
  const old = now - 3 * 3600e3;
  await r.sync({ machine: 'mac', sessions: [sess('local-1', { lastSeen: iso(old), claims: { paths: ['src'], resources: [] } })] }, old);
  await r.sync({ machine: 'cloud-ab', sessions: [sess('session_x', { lastSeen: iso(old) })], outbox: [{ id: 'm9', from: 'session_x', to: 'local-1', text: 'x' }] }, old);
  assert.equal((await r.claim({ machine: 'box', sessionId: 'b-1', repoKey: 'github.com/me/app', paths: ['src/a'] }, now)).ok, true);
  await r.sync({ machine: 'box', sessions: [sess('b-1')] }, now);
  assert.equal(r.storage.raw.has('m:mac'), false);
  assert.equal([...r.storage.raw.keys()].some((k) => k.startsWith('q:mac:')), false);
});
