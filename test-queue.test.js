'use strict';
require('./tmp-cleanup.js');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
process.env.AIRCONTROL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aircontrol-queue-'));
process.env.AIRCONTROL_DISABLE_LISTENER = '1';
const C = require('./coord.js');
const Q = require('./test-queue.js');
const device = { platform: 'ios', name: 'Aircontrol-Agent', key: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE', runtime: 'iOS 26.5', state: 'shutdown' };
function setup(patch = {}) {
  process.env.AIRCONTROL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aircontrol-queue-'));
  Q.atomic(C.configFile(), { testing: { ...Q.DEFAULTS, enabled: true, ...patch } });
  const session = { sessionId: 'queue-owner', repo: 'repo', worktree: process.cwd(), lastSeen: new Date().toISOString() };
  C.writeSession(session);
  return session;
}
const options = (kind = 'build') => ({ kind, command: [process.execPath, '-e', 'process.exit(0)'], cwd: __dirname });
const noRunner = { ensureRunner() {}, listDevices: () => [device], allowCommand: true };
const deps = { listIos: () => [device], externalBuilds: () => 0, shutdownDevice: () => true, appInstalled: () => false };
async function waitFor(fn, timeout = 12000) {
  const begin = Date.now();
  while (Date.now() - begin < timeout) { if (fn()) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('fixture timed out');
}

test('simultaneous submit assigns FIFO sequence and status positions', async () => {
  const session = setup();
  const submitted = await Promise.all(Array.from({ length: 8 }, () => Q.submit(C, options(), session, noRunner)));
  assert.equal(new Set(submitted.map((j) => j.sequence)).size, 8);
  assert.deepEqual(Q.status(C).map((j) => j.queuePosition), [1, 2, 3, 4, 5, 6, 7, 8]);
});
test('strict runtime, exact names, protected and non-iOS devices are rejected', async () => {
  const session = setup({ protectedDevices: [device.key] });
  assert.equal(Q.deviceAllowed(device, Q.config(C)), false);
  await assert.rejects(Q.submit(C, options('ios-test'), session, noRunner), /no compatible/);
  setup();
  assert.equal(Q.deviceAllowed({ ...device, runtime: 'iOS 27.0' }, Q.config(C)), false);
  assert.equal(Q.deviceAllowed({ ...device, name: 'Aircontrol-Agent-extra' }, Q.config(C)), false);
  assert.equal(Q.deviceAllowed({ ...device, platform: 'android' }, Q.config(C)), false);
  const result = C.acquireDevice({ sessionId: 'queue-owner', prefer: 'Missing', platform: 'ios', nowMs: Date.now() }, deps);
  assert.equal(result.ok, false);
});
test('manual leases and active jobs consume capacity; outside builds drain first', () => {
  setup();
  const cfg = Q.config(C);
  assert.equal(Q.capacity(C, cfg, [], 'build', 1), false);
  assert.equal(Q.capacity(C, cfg, [{ state: 'running', kind: 'build' }], 'build', 0), false);
  C.tryLease({ ...device, sessionId: 'manual-owner', acquiredAt: new Date().toISOString() });
  assert.equal(Q.capacity(C, cfg, [], 'ios-test', 0), false);
  assert.equal(Q.capacity(C, cfg, [], 'build', 0), true);
  assert.equal(C.acquireDevice({ sessionId: 'another', platform: 'ios', nowMs: Date.now() }, deps).reason, 'host-capacity');
  assert.equal(C.acquireDevice({ sessionId: 'another', platform: 'android', nowMs: Date.now() }, { ...deps, listAndroid: () => [{ platform: 'android', key: 'test-avd', name: 'test-avd', state: 'shutdown' }] }).ok, true);
});
test('cancelling queued work requires its owner and never starts it', async () => {
  const session = setup();
  const job = await Q.submit(C, options(), session, noRunner);
  await assert.rejects(Q.cancel(C, job.id, 'somebody-else'), /only the submitting/);
  await Q.cancel(C, job.id, session.sessionId);
  assert.equal(Q.status(C, job.id).state, 'cancelled');
});
test('running job leases survive expired roster, deregister, and release', async () => {
  const session = setup();
  const job = await Q.submit(C, options('ios-test'), session, noRunner);
  job.state = 'running'; job.timings = {};
  Q.atomic(Q.file(C, job.id), job);
  C.tryLease({ ...device, jobId: job.id, sessionId: session.sessionId, acquiredAt: new Date(0).toISOString(), lastSeen: new Date(0).toISOString() });
  assert.equal(C.pruneLeases(Date.now(), deps, { shutdown: true }), 0);
  assert.equal(C.releaseSessionLeases(session.sessionId), 0);
  assert.equal(C.shutdownAndReleaseLeases(session.sessionId, deps).released.length, 0);
});
test('cleanup retains capacity after shutdown failure and recovers crashed workers', async () => {
  const session = setup();
  const job = await Q.submit(C, options('ios-test'), session, noRunner);
  Object.assign(job, { state: 'running', timings: {}, device });
  Q.atomic(Q.file(C, job.id), job);
  C.tryLease({ ...device, sessionId: session.sessionId, jobId: job.id, acquiredAt: new Date().toISOString() });
  assert.equal(Q.cleanup(C, job, { ...deps, shutdownDevice: () => false, listIos: () => [{ ...device, state: 'booted' }] }), false);
  assert.equal(Q.status(C, job.id).state, 'cleaning');
  assert.ok(C.readLease('ios', device.key));
  assert.equal(Q.cleanup(C, job, deps), true);
  assert.equal(Q.status(C, job.id).state, 'failed');
  assert.equal(C.readLease('ios', device.key), null);
});
test('orphan descendants hold capacity after their worker exits', async () => {
  const session = setup();
  const child = spawn(process.execPath, ['-e', 'require("child_process").spawn(process.execPath,["-e","setTimeout(()=>{},1500)"],{stdio:"ignore"});setTimeout(()=>process.exit(0),100)'], { detached: true, stdio: 'ignore' });
  const job = await Q.submit(C, options(), session, noRunner);
  Object.assign(job, { state: 'running', timings: {}, workerPid: child.pid, workerBirth: Q.identity(child.pid) });
  Q.atomic(Q.file(C, job.id), job);
  await waitFor(() => !Q.alive(child.pid, job.workerBirth));
  assert.equal(Q.groupAlive(child.pid), true);
  assert.equal(Q.cleanup(C, job, deps), false);
  await waitFor(() => !Q.groupAlive(child.pid));
  assert.equal(Q.cleanup(C, job, deps), true);
});
test('both harness command shapes deny implicit boots and permit queued submissions and read-only commands', () => {
  setup();
  for (const input of [{ command: 'xcodebuild -destination "platform=iOS Simulator,id=ABCD" test' }, { cmd: 'xcodebuild -project App.xcodeproj build-for-testing' }, { command: ['xcodebuild', 'test-without-building'] }, { command: 'xcodebuild -project App.xcodeproj' }, { command: 'xcrun simctl boot "iPhone 17"' }, { command: 'xcrun simctl erase "booted"' }, { command: 'xcodebuild -version && xcodebuild build' }]) {
    assert.equal(C.computeGuardDecision({ session_id: 'queue-owner', tool_input: input }, Date.now()).deny, true);
  }
  for (const command of ['xcodebuild -help', 'xcodebuild -version', 'xcodebuild -project App.xcodeproj -showBuildSettings', 'echo "xcodebuild test"', 'node "/tmp/coord.js" test submit --session queue-owner --kind build -- xcodebuild build']) {
    assert.equal(C.computeGuardDecision({ session_id: 'queue-owner', tool_input: { command } }, Date.now()).deny, false, command);
  }
});
test('detached dispatcher serializes actual commands and records outcomes', async () => {
  const session = setup();
  const marker = path.join(process.env.AIRCONTROL_DIR, 'marker');
  const first = await Q.submit(C, { ...options(), command: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'first');setTimeout(()=>{},500)`] }, session, noRunner);
  const second = await Q.submit(C, { ...options(), command: [process.execPath, '-e', `if(require('fs').readFileSync(${JSON.stringify(marker)},'utf8')!=='first')process.exit(2);require('fs').appendFileSync(${JSON.stringify(marker)},' second')`] }, session, noRunner);
  const runner = spawn(process.execPath, ['-e', 'require("./test-queue.js").dispatch(require("./coord.js"),{externalBuilds:()=>0})'], { cwd: __dirname, env: process.env, stdio: 'ignore' });
  try {
    await waitFor(() => Q.TERMINAL.has(Q.status(C, second.id).state));
    assert.equal(Q.status(C, first.id).state, 'succeeded');
    assert.equal(Q.status(C, second.id).state, 'succeeded');
    assert.equal(fs.readFileSync(marker, 'utf8'), 'first second');
    assert.ok(Q.status(C, second.id).startedAt >= Q.status(C, first.id).finishedAt);
  } finally { runner.kill(); }
});
test('lock ownership tracks process lifetime rather than age', () => {
  setup();
  const release = Q.lock(C, 'fixture');
  assert.equal(Q.lock(C, 'fixture'), null);
  release();
  Q.atomic(path.join(Q.root(C), 'fixture.lock-99999999-dead'), { pid: 99999999, birth: 'dead' });
  const recovered = Q.lock(C, 'fixture');
  assert.equal(typeof recovered, 'function'); recovered();
});

test('Xcode arguments cannot select another device or enable clones; build kind cannot run tests', () => {
  setup();
  const cfg = Q.config(C);
  const argv = Q.commandForJob(['xcodebuild', '-destination', 'platform=iOS Simulator,id=PROTECTED', '-jobs', '99', '-parallel-testing-enabled', 'YES', '-parallelize-tests-among-destinations', 'test'], { kind: 'ios-test', device }, cfg);
  assert.equal(argv.includes('PROTECTED'), false);
  assert.equal(argv.includes('YES'), false);
  assert.equal(argv[argv.indexOf('-destination') + 1], 'platform=iOS Simulator,id=' + device.key);
  assert.equal(argv[argv.indexOf('-jobs') + 1], '4');
  assert.throws(() => Q.validateCommand(['xcodebuild', 'test'], 'build', __dirname, cfg), /require --kind/);
  assert.throws(() => Q.validateCommand(['bash', 'unknown.sh'], 'ios-test', __dirname, cfg), /configured trusted/);
  assert.equal(C.computeGuardDecision({ session_id: 'queue-owner', tool_input: { code: 'text(await tools.exec_command({cmd:"xcodebuild -project App.xcodeproj"}));' } }, Date.now()).deny, true);
});
test('independent processes submit without lost updates or duplicate FIFO sequence', async () => {
  setup();
  const source = 'require("./test-queue.js").submit(require("./coord.js"),{kind:"build",command:[process.execPath,"-e","process.exit(0)"],cwd:process.cwd()},{sessionId:"queue-owner",repo:"r"},{allowCommand:true,ensureRunner(){}}).catch(e=>{console.error(e);process.exitCode=1})';
  await Promise.all(Array.from({ length: 12 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source], { cwd: __dirname, env: process.env, stdio: 'ignore' });
    child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('contender failed')));
  })));
  assert.deepEqual(Q.jobs(C).map((j) => j.sequence), Array.from({ length: 12 }, (_, i) => i + 1));
});
test('running cancellation stops only its process group and the next job proceeds', async () => {
  const session = setup();
  const first = await Q.submit(C, { ...options(), command: [process.execPath, '-e', 'require("child_process").spawn(process.execPath,["-e","setTimeout(()=>{},60000)"],{stdio:"ignore"});setTimeout(()=>{},60000)'] }, session, noRunner);
  const next = await Q.submit(C, options(), session, noRunner);
  const runner = spawn(process.execPath, ['-e', 'require("./test-queue.js").dispatch(require("./coord.js"),{externalBuilds:()=>0})'], { cwd: __dirname, env: process.env, stdio: 'ignore' });
  try {
    await waitFor(() => Q.status(C, first.id).state === 'running');
    const pid = Q.status(C, first.id).workerPid;
    await Q.cancel(C, first.id, session.sessionId);
    await waitFor(() => Q.TERMINAL.has(Q.status(C, next.id).state));
    assert.equal(Q.status(C, first.id).state, 'cancelled');
    assert.equal(Q.groupAlive(pid), false);
    assert.equal(Q.status(C, next.id).state, 'succeeded');
  } finally { runner.kill(); }
});
test('dispatcher restart preserves the running worker and its reserved capacity', async () => {
  const session = setup();
  const first = await Q.submit(C, { ...options(), command: [process.execPath, '-e', 'setTimeout(()=>{},3500)'] }, session, noRunner);
  const next = await Q.submit(C, options(), session, noRunner);
  const argv = ['-e', 'require("./test-queue.js").dispatch(require("./coord.js"),{externalBuilds:()=>0})'];
  const runner = spawn(process.execPath, argv, { cwd: __dirname, env: process.env, stdio: 'ignore' });
  await waitFor(() => Q.status(C, first.id).state === 'running');
  runner.kill('SIGKILL');
  await new Promise((resolve) => runner.on('exit', resolve));
  const replacement = spawn(process.execPath, argv, { cwd: __dirname, env: process.env, stdio: 'ignore' });
  try {
    await waitFor(() => Q.TERMINAL.has(Q.status(C, next.id).state));
    assert.equal(Q.status(C, first.id).state, 'succeeded');
    assert.ok(Q.status(C, next.id).startedAt >= Q.status(C, first.id).finishedAt);
  } finally { replacement.kill(); }
});

test('slow manual acquisition cannot strand the dispatcher', { timeout: 30000 }, async () => {
  const session = setup();
  const job = await Q.submit(C, options(), session, noRunner);
  const marker = path.join(process.env.AIRCONTROL_DIR, 'held');
  const holder = spawn(process.execPath, ['-e', `const C=require('./coord.js'),Q=require('./test-queue.js');const release=Q.lock(C,'queue');require('fs').writeFileSync(${JSON.stringify(marker)},'ready');setTimeout(()=>release(),11000)`], { cwd: __dirname, env: process.env, stdio: 'ignore' });
  await waitFor(() => fs.existsSync(marker));
  const runner = spawn(process.execPath, ['-e', 'require("./test-queue.js").dispatch(require("./coord.js"),{externalBuilds:()=>0})'], { cwd: __dirname, env: process.env, stdio: 'ignore' });
  try {
    await waitFor(() => Q.TERMINAL.has(Q.status(C, job.id).state), 25000);
    assert.equal(Q.status(C, job.id).state, 'succeeded');
  } finally { holder.kill(); runner.kill(); }
});
test('cleanup phase overrides a runner phase marker', async () => {
  const session = setup();
  const job = await Q.submit(C, options(), session, noRunner);
  Object.assign(job, { state: 'cleaning', phase: 'cleanup', timings: {} });
  Q.atomic(Q.file(C, job.id), job);
  Q.atomic(path.join(Q.root(C), job.id + '.phase.json'), { phase: 'test' });
  assert.equal(Q.status(C, job.id).phase, 'cleanup');
});

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'queue-progress.log'), 'utf8');
test('progress parser counts UI and unit results from a real job log and ignores CoreData noise', () => {
  const { progress, events } = Q.parseProgress(fixture);
  assert.deepEqual(progress.ui, { passed: 9, failed: 1 });
  assert.equal(progress.unit.total, 1183);
  assert.equal(progress.unit.result, 'passed');
  assert.equal(progress.result, 'failed');
  assert.equal(progress.error, 'BatchScanDraftFlowUITests.swift:214: XCTAssertTrue failed');
  assert.equal(events.filter((e) => e.type === 'error').length, 1, 'CoreData "error:" lines are not failures');
  assert.deepEqual(events.find((e) => e.type === 'test'), { type: 'test', label: 'BatchScanDraftFlowUITests.testBatchControlsAndDraftShortcut', outcome: 'passed', secs: 32.672 });
});
test('progress parser carries a line split across reads', () => {
  const cut = fixture.indexOf("Test Case '-[CardOpsUITests") + 20;
  const first = Q.parseProgress(fixture.slice(0, cut));
  const second = Q.parseProgress(fixture.slice(cut), first.progress);
  assert.deepEqual(second.progress.ui, Q.parseProgress(fixture).progress.ui);
});
test('fingerprint ignores per-worktree paths and estimate takes the median run', () => {
  const session = setup();
  const base = { kind: 'ios-test', repo: 'repo', cwd: '/a', command: ['xcodebuild', '-scheme', 'App', '-derivedDataPath', '/a/DD', 'test'] };
  assert.equal(Q.fingerprint(base), Q.fingerprint({ ...base, cwd: '/b', command: ['xcodebuild', '-scheme', 'App', '-derivedDataPath', '/b/DD', 'test'] }));
  assert.notEqual(Q.fingerprint(base), Q.fingerprint({ ...base, command: ['xcodebuild', '-scheme', 'Other', 'test'] }));
  assert.equal(Q.estimate(base, null), null);
  for (const ms of [300000, 900000, 600000]) Q.recordHistory(C, { ...base, timings: { commandMs: ms }, progress: { ui: { passed: 5, failed: 1 }, unit: { total: 1183 } } });
  const history = JSON.parse(fs.readFileSync(path.join(Q.root(C), 'history.json'), 'utf8'));
  assert.deepEqual(Q.estimate(base, history), { commandMs: 600000, ui: 6, unit: 1183 });
  void session;
});
test('tests line shows own jobs first with progress and ETA, and is empty when idle', () => {
  const now = 1_000_000;
  const job = (o) => ({ id: 'test_0123456789abcdef', sequence: 1, owner: 'me', ownerName: 'me', state: 'running', phase: 'command', ...o });
  assert.equal(Q.renderTestsLine([job({ state: 'succeeded' })], 'me', now), '');
  const line = Q.renderTestsLine([
    job({ id: 'test_aaaaaaaaaaaaaaaa', owner: 'peer', ownerName: 'peer-name', sequence: 1 }),
    job({ commandStartedAt: now - 120000, estimate: { commandMs: 300000, ui: 6, unit: null }, progress: { ui: { passed: 4, failed: 0 }, unit: { done: 0, failed: 0, total: 1183, result: 'passed' } }, sequence: 2 }),
    job({ id: 'test_bbbbbbbbbbbbbbbb', owner: 'peer', state: 'queued', queuePosition: 1, sequence: 3 }),
  ], 'me', now);
  assert.match(line, /^\[aircontrol\] tests: test_0123… \(you\) running · 4\/6 UI · 1183 unit ✓ · ~3m left \| test_aaaa… \(peer-name\) running \| 1 other job queued/);
});
test('watch replays a finished job and exits with its result', async () => {
  setup();
  const id = 'test_cccccccccccccccc';
  const log = path.join(Q.root(C), id + '.log');
  fs.mkdirSync(Q.root(C), { recursive: true });
  fs.writeFileSync(log, fixture);
  Q.atomic(Q.file(C, id), { id, sequence: 1, state: 'failed', phase: 'cleanup', kind: 'ios-test', command: ['x'], cwd: __dirname, owner: 'o', ownerName: 'o', log, startedAt: 1000, finishedAt: 126000, error: 'command exited 65' });
  const out = [];
  const code = await Q.watch(C, id, { write: (l) => out.push(l), intervalMs: 1 });
  assert.equal(code, 1);
  assert.ok(out.includes('✅ BatchScanDraftFlowUITests.testBatchControlsAndDraftShortcut (32.7s)'));
  assert.ok(out.includes('❌ BatchScanDraftFlowUITests.testClearAllDraftsRequiresExplicitConfirmation (16.1s)'));
  assert.ok(out.includes('✅ unit tests: 1183 passed'));
  assert.match(out[out.length - 1], /^done: failed in 2:05 · 10 UI \(1 failed\) · 1183 unit ✓ · command exited 65$/);
});

test('watch follows the log a runner names in its phase file', async () => {
  setup();
  const id = 'test_dddddddddddddddd';
  fs.mkdirSync(Q.root(C), { recursive: true });
  const log = path.join(Q.root(C), id + '.log');
  const side = path.join(Q.root(C), id + '-test.log');
  fs.writeFileSync(log, 'test: ' + path.basename(side) + '\n');
  fs.writeFileSync(side, fixture);
  Q.atomic(path.join(Q.root(C), id + '.phase.json'), { phase: 'test', log: side });
  Q.atomic(Q.file(C, id), { id, sequence: 1, state: 'succeeded', phase: 'cleanup', kind: 'ios-test', command: ['x'], cwd: __dirname, owner: 'o', ownerName: 'o', log, startedAt: 1000, finishedAt: 61000 });
  const out = [];
  assert.equal(await Q.watch(C, id, { write: (l) => out.push(l), intervalMs: 1 }), 0);
  assert.ok(out.includes('✅ unit tests: 1183 passed'));
  assert.match(out[out.length - 1], /^done: succeeded in 1:00 · 10 UI \(1 failed\) · 1183 unit ✓$/);
});

test('no ETA once the command has finished and the job is cleaning up', () => {
  const j = { id: 'test_0123456789abcdef', sequence: 1, owner: 'me', ownerName: 'me', state: 'cleaning', phase: 'cleanup', commandStartedAt: 0,
    timings: { commandMs: 160000 }, estimate: { commandMs: 160000, ui: 0, unit: 1185 }, progress: { ui: { passed: 0, failed: 0 }, unit: { done: 0, failed: 0, total: 1185, result: 'passed' } } };
  assert.equal(Q.formatProgress(j, 200000), '1185 unit ✓');
});
