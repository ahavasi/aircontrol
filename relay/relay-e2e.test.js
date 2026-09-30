'use strict';
// Two "machines" (separate data dirs) talking through a real relay process.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
process.env.AIRCONTROL_DIR = tmp('aircontrol-e2e-');
process.env.AIRCONTROL_DISABLE_LISTENER = '1';
process.env.AIRCONTROL_RELAY_AUTOSYNC = '0';
delete process.env.CLAUDE_CODE_REMOTE;
const C = require('../coord.js');

function repoWithOrigin(name) {
  const d = tmp(`aircontrol-${name}-`);
  const git = (a) => execFileSync('git', a, { cwd: d, stdio: 'ignore' });
  git(['init', '-q', '-b', 'main']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'i']);
  git(['remote', 'add', 'origin', 'git@github.com:me/app.git']);
  return d;
}

function asMachine(name, dir) {
  process.env.AIRCONTROL_DIR = dir;
  process.env.AIRCONTROL_MACHINE = name;
}

function quiet(fn) {
  const o = console.log;
  const out = [];
  console.log = (...a) => out.push(a.join(' '));
  try { return fn(); } finally { console.log = o; }
}

let server;
test.before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, 'dev-server.js')], { env: { ...process.env, ADMIN_TOKEN: 'adm' }, stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve) => server.stdout.once('data', (d) => resolve(String(d).trim())));
  process.env.AIRCONTROL_RELAY_URL = `http://127.0.0.1:${port}`;
  const r = await fetch(`${process.env.AIRCONTROL_RELAY_URL}/v1/tokens`, { method: 'POST', headers: { authorization: 'Bearer adm', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'all' }) });
  process.env.AIRCONTROL_RELAY_TOKEN = (await r.json()).token;
});
test.after(() => server && server.kill());

test('claims, guard, roster and messages cross machines through the relay', () => {
  const now = Date.now();
  const macDir = tmp('aircontrol-mac-');
  const cloudDir = tmp('aircontrol-cloud-');
  const macRepo = repoWithOrigin('mac');
  const cloudRepo = repoWithOrigin('cloud');

  asMachine('mac', macDir);
  C.cmdRegister({ session_id: 'mac-sess-1', cwd: macRepo }, now);
  quiet(() => C.cmdClaim({ session: 'mac-sess-1', intent: 'api work', paths: 'src/api' }, now));
  C.relaySync(now);

  asMachine('cloud-ab', cloudDir);
  C.cmdRegister({ session_id: 'session_cloud1', cwd: cloudRepo }, now);
  C.relaySync(now);

  const deny = C.computeGuardDecision({ session_id: 'session_cloud1', tool_name: 'Edit', tool_input: { file_path: path.join(cloudRepo, 'src/api/users.js') } }, now);
  assert.equal(deny.deny, true);
  assert.match(deny.reason, /@mac/);
  const allow = C.computeGuardDecision({ session_id: 'session_cloud1', tool_name: 'Edit', tool_input: { file_path: path.join(cloudRepo, 'docs/x.md') } }, now);
  assert.equal(allow.deny, false);

  assert.throws(() => C.cmdClaim({ session: 'session_cloud1', paths: 'src' }, now), /claimed by .+@mac/);

  let ctx = '';
  const w = process.stdout.write;
  process.stdout.write = (c) => { ctx += c; return true; };
  try { C.cmdInject({ session_id: 'session_cloud1', cwd: cloudRepo }, now); } finally { process.stdout.write = w; }
  assert.match(JSON.parse(ctx).hookSpecificOutput.additionalContext, /Other sessions in THIS repo:[\s\S]*@mac[\s\S]*"api work"/);

  quiet(() => C.cmdSend({ _: ['send', 'please', 'rebase'], session: 'session_cloud1', to: 'mac-sess-1' }, now));

  asMachine('mac', macDir);
  C.relaySync(now);
  const inbox = C.readInbox('mac-sess-1');
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].text, 'please rebase');
  assert.equal(inbox[0].from, 'session_cloud1');
  // acked on the next sync: never delivered twice
  fs.renameSync(inbox[0].file, inbox[0].file + '.read');
  C.relaySync(now);
  C.relaySync(now);
  assert.equal(C.readInbox('mac-sess-1').length, 0);
});

test('an unreachable relay never blocks a local claim', () => {
  const now = Date.now();
  const dir = tmp('aircontrol-down-');
  asMachine('mac', dir);
  const repo = repoWithOrigin('down');
  C.cmdRegister({ session_id: 'down-1', cwd: repo }, now);
  const saved = process.env.AIRCONTROL_RELAY_URL;
  process.env.AIRCONTROL_RELAY_URL = 'http://127.0.0.1:9';
  const errw = process.stderr.write;
  let err = '';
  process.stderr.write = (c) => { err += c; return true; };
  try { quiet(() => C.cmdClaim({ session: 'down-1', paths: 'lib' }, now)); } finally { process.stderr.write = errw; process.env.AIRCONTROL_RELAY_URL = saved; }
  assert.match(err, /relay unreachable/);
  assert.deepEqual(C.readSession('down-1').claims.paths, ['lib']);
  assert.equal(C.relaySyncQuiet(now, 0, { request: () => { throw new Error('down'); } }), false);
});

test('send wakes an idle Claude cloud session with a follow-up', () => {
  const now = Date.now();
  const dir = tmp('aircontrol-wake-');
  asMachine('mac', dir);
  const repo = repoWithOrigin('wake');
  C.cmdRegister({ session_id: 'mac-w', cwd: repo }, now);
  const request = (method, p) => (p === '/v1/sync' ? {
    sessions: [{ machine: 'cloud-zz', sessionId: 'session_zz', harness: 'claude', state: 'idle', cloudId: 'session_zz', lastSeen: new Date(now).toISOString(), claims: { paths: [], resources: [] }, repoKey: 'github.com/me/app', intent: 'x' }],
    inbox: [], undelivered: [],
  } : {});
  C.relaySync(now, { request });
  const woke = [];
  quiet(() => C.cmdSend({ _: ['send', 'hi'], session: 'mac-w', to: 'session_zz' }, now, { request, claudeSend: (id, text) => woke.push([id, text]) }));
  assert.equal(woke.length, 1);
  assert.equal(woke[0][0], 'session_zz');
  assert.match(woke[0][1], /sent you a message/);
});

test('cloud init writes gated repo hooks idempotently and an AGENTS.md block', () => {
  const init = require('../cloud-init.js');
  const once = init.applySettings({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] }, model: 'x' });
  const twice = init.applySettings(once);
  assert.deepEqual(twice, once);
  assert.equal(twice.model, 'x');
  assert.equal(twice.hooks.Stop.length, 2);
  for (const [event] of init.CLOUD_HOOKS) {
    const cmd = twice.hooks[event].find((e) => e.hooks[0].command.includes('.aircontrol')).hooks[0].command;
    assert.match(cmd, /^\[ "\$CLAUDE_CODE_REMOTE" = true \] \|\| exit 0;/);
  }
  const md = init.applyAgentsMd('# Repo\n');
  assert.equal(init.applyAgentsMd(md), md);
  assert.match(md, /cloud join --intent/);
});
