'use strict';
// A local stand-in for the Worker: the same Room over node's http with
// in-memory storage. Used by the test suite; handy for trying the relay without
// deploying. Usage: ADMIN_TOKEN=… node relay/dev-server.js [port]  (prints the port)
const http = require('http');
const { Room, sha256Hex } = require('./room.js');

function memStorage() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? structuredClone(m.get(k)) : undefined; },
    async put(k, v) { m.set(k, structuredClone(v)); },
    async delete(k) { return m.delete(k); },
    async list({ prefix = '', limit } = {}) {
      return new Map([...m.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit || Infinity).map(([k, v]) => [k, structuredClone(v)]));
    },
  };
}

async function main() {
  const room = new Room(memStorage(), process.env.ADMIN_TOKEN ? await sha256Hex(process.env.ADMIN_TOKEN) : null);
  let chain = Promise.resolve();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      // Serialize like a Durable Object does.
      chain = chain.then(async () => {
        let body = null;
        if (req.method === 'POST') { try { body = JSON.parse(raw || '{}'); } catch { body = null; } }
        const auth = req.headers.authorization || '';
        const url = new URL(req.url, 'http://x');
        const [status, payload] = await room.handle(req.method, url.pathname, auth.startsWith('Bearer ') ? auth.slice(7) : '', body);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      });
    });
  });
  server.listen(Number(process.argv[2] || 0), '127.0.0.1', () => process.stdout.write(`${server.address().port}\n`));
}

main();
