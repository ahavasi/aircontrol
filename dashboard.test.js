'use strict';
require('./tmp-cleanup.js');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.AIRCONTROL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aircontrol-dash-'));
process.env.AIRCONTROL_DISABLE_LISTENER = '1';
const C = require('./coord.js');
const Q = require('./test-queue.js');
const D = require('./dashboard.js');

async function serve() {
  Q.atomic(C.configFile(), { testing: { ...Q.DEFAULTS, enabled: true } });
  fs.mkdirSync(Q.root(C), { recursive: true });
  const id = 'test_00000000000000d1';
  Q.atomic(Q.file(C, id), { id, sequence: 1, state: 'running', phase: 'build', kind: 'build', command: ['xcodebuild'], cwd: '/w/x', owner: 'o', ownerName: 'o', submittedAt: Date.now(), startedAt: Date.now() });
  fs.writeFileSync(path.join(Q.root(C), id + '.log'), 'noise\n** BUILD SUCCEEDED **\nmore noise\n/a.swift:1:2: error: boom\n');
  const server = D.createServer(C, { listDevices: () => [], readLeases: () => [] });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { id, base, close: () => new Promise((r) => server.close(r)) };
}
test('dashboard serves the page, a snapshot and filtered or raw log tails', async () => {
  const { id, base, close } = await serve();
  try {
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<title>Aircontrol Queue<\/title>/);
    assert.match(html, /id="stats" class="stats"/);
    for (const label of ['Running', 'Queued', 'Drains in', 'Build lane', 'Sim lane', 'Simulators']) assert.ok(html.includes("'" + label + "'"), label);
    const snap = await (await fetch(base + '/api/snapshot')).json();
    assert.equal(snap.jobs[0].id, id);
    assert.deepEqual(Object.keys(snap).sort(), ['at', 'config', 'devices', 'forecast', 'jobs', 'pipelines']);
    assert.equal(await (await fetch(`${base}/api/log/${id}`)).text(), '** BUILD SUCCEEDED **\n/a.swift:1:2: error: boom');
    assert.match(await (await fetch(`${base}/api/log/${id}?raw=1`)).text(), /^noise/);
  } finally { await close(); }
});
test('dashboard log endpoint rejects traversal and unknown jobs', async () => {
  const { base, close } = await serve();
  try {
    for (const p of ['/api/log/..%2F..%2Fetc%2Fpasswd', '/api/log/../config.json', '/api/log/test_xyz']) assert.equal((await fetch(base + p)).status, 404);
    assert.equal((await fetch(base + '/api/log/test_ffffffffffffffff')).status, 404);
  } finally { await close(); }
});
test('dashboard log tail follows the stage log named in the phase file', async () => {
  const { id, base, close } = await serve();
  try {
    const stage = path.join(Q.root(C), 'stage-x.log');
    fs.writeFileSync(stage, "Test Case '-[A b]' passed (1.0 seconds).\n");
    Q.atomic(path.join(Q.root(C), id + '.phase.json'), { phase: 'test', log: stage });
    assert.match(await (await fetch(`${base}/api/log/${id}`)).text(), /Test Case '-\[A b\]' passed/);
  } finally { await close(); }
});
test('dashboard refuses requests addressed to a foreign host (DNS rebinding)', async () => {
  const { base, close } = await serve();
  const http = require('http');
  const port = new URL(base).port;
  const status = (host) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/snapshot', headers: { host } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  try {
    assert.equal(await status('evil.example:' + port), 403);
    assert.equal(await status('127.0.0.1.evil.example'), 403);
    assert.equal(await status('localhost:' + port), 200);
    assert.equal(await status('127.0.0.1:' + port), 200);
  } finally { await close(); }
});
