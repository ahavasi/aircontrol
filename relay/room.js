'use strict';

// The relay's whole state machine, free of any Cloudflare API so node tests can
// drive it. `storage` is the Durable Object storage surface (get/put/delete/list,
// all async); `adminHash` is the SHA-256 of the ADMIN_TOKEN Worker secret.
//
// A Durable Object processes one request at a time, which is what makes a claim
// check-then-write atomic across every machine: no second claim can interleave.

const STALE_MS = 30 * 60 * 1000;
const CLAIM_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_SESSIONS = 200;
const MAX_OUTBOX = 100;
const MAX_TEXT = 16 * 1024;
const MAX_QUEUE = 500;

// These three mirror coord.js on purpose (coord.js is installed as a single file
// and cannot import this one); room.test.js pins them to the same answers.
function boundaryPrefix(prefix, p) {
  const clean = (prefix.endsWith('/') ? prefix.slice(0, -1) : prefix).toLowerCase();
  const pl = p.toLowerCase();
  return pl === clean || pl.startsWith(clean + '/');
}
function pathsOverlap(a, b) { return boundaryPrefix(a, b) || boundaryPrefix(b, a); }
function holdsClaims(s) {
  const c = (s && s.claims) || {};
  return !!((c.paths || []).length || (c.resources || []).length);
}
function isExpired(s, nowMs) {
  const seen = Date.parse(s && s.lastSeen);
  if (!Number.isFinite(seen)) return true;
  return nowMs - seen >= (holdsClaims(s) ? CLAIM_TTL_MS : STALE_MS);
}

// Only deploy targets mean anything across machines: a stash or a simulator is
// local to the box that holds it.
function deployContends(a, b) {
  if (!a.startsWith('deploy') || !b.startsWith('deploy')) return false;
  return a === 'deploy' || b === 'deploy' || a === b;
}

const SAFE = /^[A-Za-z0-9._-]{1,128}$/;
function safeId(s) { return typeof s === 'string' && SAFE.test(s) && s !== '.' && s !== '..'; }
function str(v, max = 512) { return typeof v === 'string' ? v.slice(0, max) : undefined; }
function strList(v, max = 64) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length <= 512).slice(0, max) : [];
}

function cleanSession(s) {
  if (!s || typeof s !== 'object' || !safeId(s.sessionId)) return null;
  return {
    sessionId: s.sessionId,
    harness: str(s.harness, 32) || 'claude',
    repoKey: str(s.repoKey),
    repoName: str(s.repoName, 128),
    branch: str(s.branch, 256),
    intent: str(s.intent, 300) || '',
    claims: { paths: strList(s.claims && s.claims.paths), resources: strList(s.claims && s.claims.resources) },
    lastSeen: str(s.lastSeen, 40),
    state: str(s.state, 16),
    cloudId: str(s.cloudId, 128),
    nameSalt: Number.isInteger(s.nameSalt) ? s.nameSalt : 0,
  };
}

async function sha256Hex(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return 'acr_' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

class Room {
  constructor(storage, adminHash) {
    this.storage = storage;
    this.adminHash = adminHash || null;
  }

  async auth(bearer) {
    if (!bearer) throw new HttpError(401, 'missing token');
    const h = await sha256Hex(bearer);
    if (this.adminHash && h === this.adminHash) return { name: 'admin', scope: 'admin' };
    const t = await this.storage.get(`tok:${h}`);
    if (!t) throw new HttpError(401, 'unknown or revoked token');
    return t;
  }

  async machines() {
    const all = await this.storage.list({ prefix: 'm:' });
    return [...all.entries()].map(([k, v]) => ({ machine: k.slice(2), ...v }));
  }

  // Every live session on every machine, each tagged with the machine that owns it.
  async liveSessions(nowMs) {
    const out = [];
    for (const m of await this.machines()) {
      for (const s of m.sessions || []) if (!isExpired(s, nowMs)) out.push({ ...s, machine: m.machine });
    }
    return out;
  }

  async sync(body, nowMs) {
    const machine = body && body.machine;
    if (!safeId(machine)) throw new HttpError(400, 'bad machine name');
    const sessions = (Array.isArray(body.sessions) ? body.sessions : []).slice(0, MAX_SESSIONS).map(cleanSession).filter(Boolean);
    await this.storage.put(`m:${machine}`, { sessions, seen: new Date(nowMs).toISOString() });

    for (const id of strList(body.ack, MAX_QUEUE)) {
      if (safeId(id)) await this.storage.delete(`q:${machine}:${id}`);
    }

    const live = await this.liveSessions(nowMs);
    const owner = new Map(live.map((s) => [s.sessionId, s.machine]));
    const undelivered = [];
    for (const m of (Array.isArray(body.outbox) ? body.outbox : []).slice(0, MAX_OUTBOX)) {
      if (!m || !safeId(m.id) || !safeId(m.to) || !safeId(m.from) || typeof m.text !== 'string') continue;
      const dest = owner.get(m.to);
      if (!dest || dest === machine) { undelivered.push(m.id); continue; }
      await this.storage.put(`q:${dest}:${m.id}`, {
        id: m.id, to: m.to, from: m.from, fromMachine: machine, text: m.text.slice(0, MAX_TEXT), ts: new Date(nowMs).toISOString(),
      });
    }

    await this.prune(nowMs);
    const inbox = [...(await this.storage.list({ prefix: `q:${machine}:`, limit: MAX_QUEUE })).values()];
    return { sessions: live.filter((s) => s.machine !== machine), inbox, undelivered };
  }

  async claim(body, nowMs) {
    const machine = body && body.machine;
    if (!safeId(machine) || !safeId(body.sessionId)) throw new HttpError(400, 'bad machine or session');
    const paths = strList(body.paths);
    const resources = strList(body.resources);
    const repoKey = str(body.repoKey);
    for (const o of await this.liveSessions(nowMs)) {
      if (o.machine === machine) continue; // same-machine contention is the local guard's job
      const c = o.claims || {};
      if (repoKey && o.repoKey === repoKey) {
        for (const mine of paths) {
          const held = (c.paths || []).find((p) => pathsOverlap(p, mine));
          if (held) return { ok: false, conflict: { sessionId: o.sessionId, machine: o.machine, claim: held, mine, intent: o.intent, nameSalt: o.nameSalt } };
        }
      }
      for (const mine of resources) {
        const held = (c.resources || []).find((r) => deployContends(r, mine));
        if (held) return { ok: false, conflict: { sessionId: o.sessionId, machine: o.machine, claim: held, mine, intent: o.intent, nameSalt: o.nameSalt } };
      }
    }
    // Record it now, so a claim racing in from a third machine before this one's
    // next sync still sees it.
    const rec = (await this.storage.get(`m:${machine}`)) || { sessions: [] };
    let s = rec.sessions.find((x) => x.sessionId === body.sessionId);
    if (!s) {
      s = cleanSession({ sessionId: body.sessionId, repoKey, intent: str(body.intent, 300), claims: { paths: [], resources: [] } });
      rec.sessions.push(s);
    }
    s.lastSeen = new Date(nowMs).toISOString();
    if (repoKey) s.repoKey = repoKey;
    if (body.intent) s.intent = str(body.intent, 300);
    s.claims = {
      paths: [...new Set([...(s.claims.paths || []), ...paths])],
      resources: [...new Set([...(s.claims.resources || []), ...resources])],
    };
    rec.seen = new Date(nowMs).toISOString();
    await this.storage.put(`m:${machine}`, rec);
    return { ok: true };
  }

  async prune(nowMs) {
    for (const m of await this.machines()) {
      const live = (m.sessions || []).filter((s) => !isExpired(s, nowMs));
      if (!live.length && nowMs - Date.parse(m.seen || 0) >= CLAIM_TTL_MS) {
        await this.storage.delete(`m:${m.machine}`);
        const q = await this.storage.list({ prefix: `q:${m.machine}:` });
        for (const k of q.keys()) await this.storage.delete(k);
      }
    }
  }

  async addToken(name, scope = 'machine') {
    if (!safeId(name)) throw new HttpError(400, 'bad token name');
    if (scope !== 'machine') throw new HttpError(400, 'only machine tokens can be minted');
    for (const [k, v] of await this.storage.list({ prefix: 'tok:' })) {
      if (v.name === name) await this.storage.delete(k);
    }
    const token = randomToken();
    await this.storage.put(`tok:${await sha256Hex(token)}`, { name, scope, created: new Date().toISOString() });
    return { name, token };
  }

  async revokeToken(name) {
    let n = 0;
    for (const [k, v] of await this.storage.list({ prefix: 'tok:' })) {
      if (v.name === name) { await this.storage.delete(k); n++; }
    }
    return { revoked: n };
  }

  async listTokens() {
    return [...(await this.storage.list({ prefix: 'tok:' })).values()].map((t) => ({ name: t.name, created: t.created }));
  }

  // One entry point for the Worker: (method, path, bearer, body) → [status, json].
  async handle(method, pathname, bearer, body, nowMs = Date.now()) {
    try {
      const who = await this.auth(bearer);
      const admin = who.scope === 'admin';
      if (method === 'POST' && pathname === '/v1/sync') return [200, await this.sync(body, nowMs)];
      if (method === 'POST' && pathname === '/v1/claim') return [200, await this.claim(body, nowMs)];
      if (method === 'GET' && pathname === '/v1/status') {
        return [200, { ok: true, as: who.name, machines: (await this.machines()).map((m) => ({ machine: m.machine, seen: m.seen, sessions: (m.sessions || []).length })) }];
      }
      if (pathname === '/v1/tokens' || pathname.startsWith('/v1/tokens/')) {
        if (!admin) throw new HttpError(403, 'admin token required');
        if (method === 'GET') return [200, await this.listTokens()];
        if (method === 'POST') return [200, await this.addToken(body && body.name)];
        if (method === 'DELETE') return [200, await this.revokeToken(decodeURIComponent(pathname.slice('/v1/tokens/'.length)))];
      }
      throw new HttpError(404, 'not found');
    } catch (e) {
      return [e.status || 500, { error: e.status ? e.message : 'internal error' }];
    }
  }
}

module.exports = { Room, HttpError, sha256Hex, randomToken, pathsOverlap, isExpired, deployContends, cleanSession, safeId };
