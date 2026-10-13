'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const Q = require('./test-queue.js');

const DEVICE_TTL_MS = 10000;
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const LOG_BYTES = 512 * 1024;
const KEY_LINE = /^\*\* (BUILD|TEST)|: error:|Test Case .* (passed|failed)|Test run with|Executed \d+ test|✘|✔/;

function readTail(name) {
  let text = '';
  try {
    const fd = fs.openSync(name, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - LOG_BYTES);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
      if (start) text = text.slice(text.indexOf('\n') + 1);
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  return text;
}
// verify.mjs stages write xcodebuild output to their own log and name it in <id>.phase.json.
function tailLog(C, id, { lines = 200, raw = false } = {}) {
  const dir = path.dirname(Q.file(C, id));
  const main = readTail(path.join(dir, id + '.log'));
  if (main === null) return null;
  let stage = null;
  try { stage = JSON.parse(fs.readFileSync(path.join(dir, id + '.phase.json'), 'utf8')).log; } catch {}
  const extra = typeof stage === 'string' && path.isAbsolute(stage) && stage.endsWith('.log') ? readTail(stage) : null;
  const text = extra ? main + '\n' + extra : main;
  const all = text.split('\n').map((s) => s.slice(0, 400));
  return (raw ? all : all.filter((s) => KEY_LINE.test(s))).slice(-lines).join('\n');
}

function createServer(C, deps = {}) {
  let cache = { at: 0, devices: [] };
  const devices = () => {
    const now = Date.now();
    if (now - cache.at > DEVICE_TTL_MS) cache = { at: now, devices: (deps.listDevices || C.listDevices)('ios', deps) };
    return cache.devices;
  };
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    // Binding to loopback is not enough: a DNS-rebound page reaches 127.0.0.1 under its own hostname.
    if (!LOCAL_HOST.test(req.headers.host || '')) return send(403, 'text/plain', 'forbidden host');
    try {
      if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', PAGE);
      if (url.pathname === '/api/snapshot') return send(200, 'application/json', JSON.stringify(Q.snapshot(C, { ...deps, devices: devices() })));
      const log = url.pathname.match(/^\/api\/log\/(test_[a-f0-9]{16})$/);
      if (log) {
        const lines = Math.min(2000, Math.max(1, Number(url.searchParams.get('tail')) || 200));
        const text = tailLog(C, log[1], { lines, raw: url.searchParams.get('raw') === '1' });
        return text === null ? send(404, 'text/plain', 'no log') : send(200, 'text/plain; charset=utf-8', text);
      }
      send(404, 'text/plain', 'not found');
    } catch (e) { send(500, 'text/plain', e.message); }
  });
}

async function cli(C, args) {
  const port = args.port === undefined ? 7788 : Number(args.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid --port');
  const server = createServer(C);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  console.log(`aircontrol dashboard: ${url} (Ctrl-C to stop)`);
  if (!args.open) return;
  // Inside cmux, a browser split keeps the dashboard beside the agent's terminal.
  if (process.env.CMUX_SURFACE_ID) execFile('cmux', ['browser', 'open', url, '--focus', 'false'], (e) => { if (e) execFile('open', [url], () => {}); });
  else execFile('open', [url], () => {});
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aircontrol Queue</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#16181d;--mute:#667085;--line:#e4e7ec;--accent:#4f46e5;--ok:#12805c;--bad:#c4320a;--warn:#b54708;--track:#eef0f4}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0f1115;--card:#171a21;--ink:#e6e8ee;--mute:#8b93a7;--line:#262b36;--accent:#818cf8;--ok:#3ccf91;--bad:#f97066;--warn:#fdb022;--track:#222733}}
:root[data-theme=dark]{--bg:#0f1115;--card:#171a21;--ink:#e6e8ee;--mute:#8b93a7;--line:#262b36;--accent:#818cf8;--ok:#3ccf91;--bad:#f97066;--warn:#fdb022;--track:#222733}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:20px 16px 48px}
header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}h1{font-size:20px;margin:0}
#updated{font-size:12px}#updated.off{color:var(--bad)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-bottom:8px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px;min-width:0}
.stat b{display:block;font-size:20px;font-weight:600;line-height:1.2;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stat small{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--mute);margin-bottom:2px}
.stat .sub{display:block;font-size:12px;color:var(--mute);margin-top:2px}
.stat.hot b{color:var(--accent)}
.mute{color:var(--mute)}.mono{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--mute);margin:24px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:8px;cursor:pointer}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.grow{flex:1;min-width:0}
.title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pill{font-size:12px;padding:1px 8px;border-radius:99px;border:1px solid var(--line);white-space:nowrap}
.pill.running,.pill.starting,.pill.cleaning{color:var(--accent);border-color:var(--accent)}.pill.succeeded{color:var(--ok);border-color:var(--ok)}
.pill.failed,.pill.blocked,.pill.cancelled{color:var(--bad);border-color:var(--bad)}.pill.queued{color:var(--mute)}
.bar{height:6px;background:var(--track);border-radius:99px;overflow:hidden;margin-top:8px}.bar>i{display:block;height:100%;background:var(--accent);transform-origin:left;transition:transform .8s}
.bar.over>i{background:var(--warn)}
.steps{display:flex;gap:4px;margin-top:8px}.steps span{flex:1;font-size:11px;text-align:center;padding:2px 0;border-radius:6px;background:var(--track);color:var(--mute)}
.steps span.done{color:var(--ink)}.steps span.now{background:var(--accent);color:#fff}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px}
.chunks{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
pre{white-space:pre-wrap;word-break:break-word;margin:10px 0 0;max-height:360px;overflow:auto;background:var(--bg);border-radius:8px;padding:10px}
.empty{padding:14px;border:1px dashed var(--line);border-radius:12px;color:var(--mute)}
button{font:inherit;font-size:12px;background:none;border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:2px 8px;cursor:pointer}
</style></head><body><main>
<header><h1>Aircontrol queue</h1><span id="updated" class="mute"></span></header>
<div id="stats" class="stats"></div>
<h2>Running</h2><div id="running"></div>
<h2>Queued</h2><div id="queued"></div>
<h2>Verify runs</h2><div id="pipelines"></div>
<h2>Simulators</h2><div id="devices" class="grid"></div>
<h2>Finished (30 min)</h2><div id="recent"></div>
</main><script>
const open = new Set(); const raw = new Set(); const logs = {};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const clock = (ms) => { if (ms == null) return '–'; const t = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); };
const STEPS = [['queued','queued'],['starting','start'],['boot','boot'],['build','build'],['command','run'],['test','test'],['cleanup','cleanup']];
function steps(j) {
  const at = j.state === 'queued' ? 0 : Math.max(0, STEPS.findIndex(([k]) => k === j.phase));
  return '<div class="steps">' + STEPS.map(([, l], i) => '<span class="' + (i < at ? 'done' : i === at ? 'now' : '') + '">' + l + '</span>').join('') + '</div>';
}
function bar(j, now) {
  if (!j.estimateMs) return '';
  const ran = j.commandStartedAt ? now - j.commandStartedAt : 0;
  const pct = Math.min(100, Math.round(100 * ran / j.estimateMs));
  return '<div class="bar' + (ran > j.estimateMs ? ' over' : '') + '"><i style="transform:scaleX(' + pct / 100 + ')"></i></div>';
}
function job(j, now, full) {
  const elapsed = j.startedAt ? (j.finishedAt || now) - j.startedAt : now - j.submittedAt;
  const right = j.state === 'queued' ? '#' + j.queuePosition + (j.waitReason ? ' · ' + esc(j.waitReason) : '') + (j.estimateMs ? ' · est ' + clock(j.estimateMs) : '') +
      (j.startsInMs !== undefined ? ' · starts in ~' + clock(j.startsInMs) + ' · done ~' + new Date(now + j.etaMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '')
    : clock(elapsed) + (j.remainingMs > 0 ? ' · ~' + clock(j.remainingMs) + ' left' : '');
  let html = '<div class="card" data-id="' + j.id + '"><div class="row"><span class="pill ' + j.state + '">' + esc(j.phaseLabel) + '</span>' +
    '<span class="grow title">' + esc(j.label) + '</span><span class="mute">' + right + '</span></div>' +
    '<div class="row mute" style="margin-top:4px;font-size:12px"><span>' + esc(j.ownerName) + '</span><span>' + esc(j.worktree || '') + '</span>' +
    (j.device ? '<span>📱 ' + esc(j.device.name) + '</span>' : '') + (j.progressText ? '<span>' + esc(j.progressText) + '</span>' : '') +
    (j.error ? '<span style="color:var(--bad)">' + esc(j.error) + '</span>' : '') + '<span class="mono">' + j.id + '</span></div>';
  if (full) html += steps(j) + bar(j, now);
  if (open.has(j.id)) html += '<div class="row" style="margin-top:8px"><button data-raw="' + j.id + '">' + (raw.has(j.id) ? 'key lines' : 'raw log') + '</button></div><pre class="mono">' + esc(logs[j.id] ?? 'loading…') + '</pre>';
  return html + '</div>';
}
const fill = (id, items, empty) => { document.getElementById(id).innerHTML = items.length ? items.join('') : '<div class="empty">' + empty + '</div>'; };
async function refreshLogs() {
  await Promise.all([...open].map(async (id) => { try { const r = await fetch('/api/log/' + id + '?tail=200' + (raw.has(id) ? '&raw=1' : '')); logs[id] = r.ok ? await r.text() : 'no log yet'; } catch {} }));
}
let last;
function render(s) {
  const now = Date.now();
  const active = s.jobs.filter((j) => ['starting','running','cleaning'].includes(j.state));
  const queued = s.jobs.filter((j) => j.state === 'queued');
  const done = s.jobs.filter((j) => ['succeeded','failed','cancelled','blocked'].includes(j.state));
  const stat = (label, value, sub, cls) => '<div class="stat' + (cls ? ' ' + cls : '') + '"><small>' + label + '</small><b>' + value + '</b>' + (sub ? '<span class="sub">' + sub + '</span>' : '') + '</div>';
  const at = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const pending = active.length + queued.length;
  const f = pending && s.forecast ? s.forecast : null;
  const tiles = [
    stat('Running', active.length, active.length ? esc(active.map((j) => j.label).join(', ')) : 'idle', active.length ? 'hot' : ''),
    stat('Queued', queued.length, queued.length ? (f && f.unknownEstimates ? f.unknownEstimates + ' of ' + queued.length + ' estimated' : 'durations known') : 'empty'),
    stat('Drains in', f ? '~' + clock(f.drainMs) : '—', f ? 'done by ' + at(f.finishAt) : 'nothing pending'),
  ];
  if (f && f.lanes) tiles.push(stat('Build lane', clock(f.lanes.build), 'compile work queued'), stat('Sim lane', clock(f.lanes.simulator), 'simulator work queued'));
  tiles.push(stat('Simulators', s.devices.filter((d) => d.holder).length + '/' + s.config.maxSimulators, s.config.overlap ? 'overlap on' : 'serial'));
  document.getElementById('stats').innerHTML = tiles.join('');
  const up = document.getElementById('updated'); up.textContent = 'updated ' + new Date(s.at).toLocaleTimeString(); up.classList.remove('off');
  fill('running', active.map((j) => job(j, now, true)), 'Nothing running.');
  fill('queued', queued.map((j) => job(j, now, false)), 'Queue empty.');
  fill('pipelines', s.pipelines.map((p) => {
    const members = p.jobs.map((id) => s.jobs.find((j) => j.id === id)).filter(Boolean);
    const icon = (j) => j.state === 'succeeded' ? '✓' : ['failed','blocked','cancelled'].includes(j.state) ? '✗' : j.state === 'queued' ? '·' : '▶';
    return '<div class="card"><div class="row"><span class="pill ' + p.state + '">' + p.state + '</span><span class="grow title">' + esc(p.name) + '</span><span class="mute">' + esc(p.ownerName) + ' · ' + esc(p.worktree || '') + '</span></div>' +
      '<div class="chunks">' + members.map((j) => '<span class="pill ' + j.state + '" title="' + j.id + '">' + icon(j) + ' ' + esc(j.label) + (j.tests ? ' (' + j.tests + ')' : '') + '</span>').join('') + '</div></div>';
  }), 'No verify runs in the last 30 minutes.');
  fill('devices', s.devices.map((d) => '<div class="card" style="cursor:default"><div class="row"><span class="grow title">' + esc(d.name) + '</span><span class="pill ' + (d.state === 'booted' ? 'running' : '') + '">' + esc(d.state) + '</span></div>' +
    '<div class="mute" style="font-size:12px;margin-top:4px">' + esc(d.runtime) + '<br>' + (d.holder ? 'leased by ' + esc(d.holder) + (d.jobId ? ' · ' + d.jobId.slice(0, 13) + '…' : '') : 'free') + '</div></div>'), 'No agent simulators.');
  fill('recent', done.map((j) => job(j, now, false)), 'Nothing finished recently.');
}
async function poll() {
  try { last = await (await fetch('/api/snapshot')).json(); await refreshLogs(); render(last); } catch (e) { const up = document.getElementById('updated'); up.textContent = 'disconnected: ' + e.message; up.classList.add('off'); }
  setTimeout(poll, 2000);
}
document.addEventListener('click', async (e) => {
  const r = e.target.closest('[data-raw]');
  if (r) { const id = r.dataset.raw; raw.has(id) ? raw.delete(id) : raw.add(id); await refreshLogs(); render(last); return; }
  const c = e.target.closest('.card[data-id]');
  if (!c || e.target.closest('pre')) return;
  const id = c.dataset.id; open.has(id) ? open.delete(id) : open.add(id); await refreshLogs(); render(last);
});
poll();
</script></body></html>`;

module.exports = { createServer, tailLog, cli, PAGE };
