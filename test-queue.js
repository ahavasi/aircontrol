'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ACTIVE = new Set(['starting', 'running', 'cleaning']);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const DEFAULTS = { enabled: false, maxXcode: 1, maxSimulators: 1, jobs: 4, runtime: 'iOS 26.5', allowedNames: ['Aircontrol-Agent'], protectedDevices: [], runnerScripts: ['scripts/verify.mjs'] };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const root = (C) => path.join(path.dirname(C.configFile()), 'test-jobs');
const file = (C, id) => {
  if (!/^test_[a-f0-9]{16}$/.test(id)) throw new Error('invalid test job id');
  return path.join(root(C), id + '.json');
};
function readJson(name) { try { return JSON.parse(fs.readFileSync(name, 'utf8')); } catch { return null; } }
function atomic(name, value) {
  fs.mkdirSync(path.dirname(name), { recursive: true });
  const tmp = name + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, name);
}
function config(C) {
  const result = { ...DEFAULTS, ...(readJson(C.configFile()) || {}).testing };
  for (const key of ['maxXcode', 'maxSimulators', 'jobs']) {
    if (!Number.isInteger(result[key]) || result[key] < 1) throw new Error('testing.' + key + ' must be a positive integer');
  }
  for (const key of ['allowedNames', 'protectedDevices', 'runnerScripts']) {
    if (!Array.isArray(result[key]) || !result[key].every((s) => typeof s === 'string' && s)) throw new Error('invalid testing.' + key);
  }
  return result;
}
function jobs(C) {
  fs.mkdirSync(root(C), { recursive: true });
  return fs.readdirSync(root(C)).filter((s) => /^test_[a-f0-9]{16}\.json$/.test(s))
    .map((s) => readJson(path.join(root(C), s))).filter(Boolean).sort((a, b) => a.sequence - b.sequence);
}
function identity(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 3000 }).trim() || null; } catch { return null; }
}
const processBirths = new Map();
function alive(pid, birth) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); } catch { return false; }
  if (!birth) return true;
  let cached = processBirths.get(pid);
  if (!cached || Date.now() - cached.at > 1000) {
    cached = { birth: identity(pid), at: Date.now() }; processBirths.set(pid, cached);
  }
  return cached.birth === birth;
}
let selfBirth;
function groupAlive(pid) {
  if (!pid) return false;
  try { process.kill(-pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
function lockEntries(C, name) {
  fs.mkdirSync(root(C), { recursive: true });
  return fs.readdirSync(root(C)).filter((s) => s.startsWith(name + '.lock-')).flatMap((s) => {
    const target = path.join(root(C), s);
    const owner = readJson(target);
    const pid = owner?.pid || Number(s.split('.lock-')[1].split('-')[0]);
    if (!alive(pid, owner?.birth)) { fs.rmSync(target, { force: true }); return []; }
    return [{ target, pid, ticket: owner?.ticket || 0 }];
  });
}
function lock(C, name) {
  const target = path.join(root(C), name + '.lock-' + process.pid + '-' + crypto.randomBytes(8).toString('hex'));
  fs.mkdirSync(root(C), { recursive: true });
  const owner = { pid: process.pid, birth: selfBirth ||= identity(process.pid), ticket: 0 };
  // Per-contender files prevent a stale-lock cleanup from unlinking a new owner's lock.
  fs.writeFileSync(target, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  owner.ticket = Math.max(0, ...lockEntries(C, name).map((entry) => entry.ticket)) + 1;
  atomic(target, owner);
  const blocked = lockEntries(C, name).some((entry) => entry.target !== target &&
    (!entry.ticket || entry.ticket < owner.ticket || (entry.ticket === owner.ticket && entry.target < target)));
  if (blocked) { fs.rmSync(target, { force: true }); return null; }
  return () => fs.rmSync(target, { force: true });
}
async function withLock(C, fn) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const release = lock(C, 'queue');
    if (release) { try { return fn(); } finally { release(); } }
    await delay(25 + Math.floor(Math.random() * 25));
  }
  const error = new Error('test queue busy; retry');
  error.code = 'AIRCONTROL_QUEUE_BUSY';
  throw error;
}
function deviceAllowed(device, cfg, opts = {}) {
  return device.platform === 'ios' && device.runtime === (opts.runtime || cfg.runtime) &&
    cfg.allowedNames.includes(device.name) && !cfg.protectedDevices.some((s) => s === device.key || s === device.name) &&
    (!opts.name || device.name === opts.name);
}
function activeLease(C, lease) {
  if (!lease.jobId) return false;
  const job = readJson(file(C, lease.jobId));
  return !!job && ACTIVE.has(job.state);
}
function manualCount(C) { return C.readLeases().filter((s) => s.platform === 'ios' && !s.jobId).length; }
function externalBuilds(existing = []) {
  try {
    const groups = new Set(existing.filter((j) => ACTIVE.has(j.state)).map((j) => j.workerPid));
    return execFileSync('ps', ['-axo', 'pgid=,comm='], { encoding: 'utf8', timeout: 3000 }).split('\n')
      .filter((s) => { const match = s.trim().match(/^(\d+)\s+(.*)$/); return match && !groups.has(Number(match[1])) && /(?:^|\/)xcodebuild$/.test(match[2]); }).length;
  } catch { return 1; }
}
function capacity(C, cfg, existing, kind, external = externalBuilds(existing)) {
  const active = existing.filter((j) => ACTIVE.has(j.state));
  if (active.length >= cfg.maxXcode || external > 0) return false;
  return kind !== 'ios-test' || manualCount(C) + active.filter((j) => j.kind === 'ios-test').length < cfg.maxSimulators;
}
function ensureRunner(C) {
  if (lockEntries(C, 'runner').length) return;
  const child = spawn(process.execPath, [path.join(__dirname, 'test-queue.js'), 'dispatch'], {
    detached: true, stdio: 'ignore', env: process.env,
  });
  child.unref();
}
async function submit(C, opts, session, deps = {}) {
  const cfg = config(C);
  if (!cfg.enabled) throw new Error('testing queue is disabled; configure testing.enabled first');
  if (!['ios-test', 'build'].includes(opts.kind)) throw new Error('--kind must be ios-test or build');
  if (!Array.isArray(opts.command) || !opts.command.length || !opts.command.every((s) => typeof s === 'string' && !s.includes('\0'))) throw new Error('provide an argv command after --');
  const cwd = fs.realpathSync(opts.cwd || process.cwd());
  if (!fs.statSync(cwd).isDirectory()) throw new Error('cwd must be a directory');
  if (!deps.allowCommand) validateCommand(opts.command, opts.kind, cwd, cfg);
  if (opts.kind === 'ios-test') {
    const devices = (deps.listDevices || (() => C.listDevices('ios')))();
    if (!devices.some((d) => deviceAllowed(d, cfg, opts))) throw new Error('no compatible allowed agent device; configure an exact device name and runtime');
  }
  const result = await withLock(C, () => {
    const id = 'test_' + crypto.randomBytes(8).toString('hex');
    const sequence = Math.max(0, ...jobs(C).map((j) => j.sequence)) + 1;
    const job = { id, sequence, state: 'queued', kind: opts.kind, command: opts.command, cwd,
      owner: session.sessionId, ownerName: C.friendlyName(session.sessionId), repo: session.repo,
      runtime: opts.runtime || cfg.runtime, name: opts.name || null, bundleId: opts.bundleId || null,
      submittedAt: Date.now(), log: path.join(root(C), id + '.log') };
    atomic(file(C, id), job);
    return job;
  });
  (deps.ensureRunner || (() => ensureRunner(C)))();
  return result;
}
function status(C, id) {
  const all = jobs(C);
  const waiting = all.filter((j) => j.state === 'queued');
  const result = all.filter((j) => !id || j.id === id).map((j) => ({ ...j,
    ...(j.state === 'running' && j.phase === 'command' ? { phase: readJson(path.join(root(C), j.id + '.phase.json'))?.phase || j.phase } : {}),
    queuePosition: j.state === 'queued' ? waiting.findIndex((w) => w.id === j.id) + 1 : null,
    elapsedMs: j.startedAt ? (j.finishedAt || Date.now()) - j.startedAt : 0,
    slow: ACTIVE.has(j.state) && Date.now() - j.startedAt > 15 * 60 * 1000,
  }));
  if (id && !result.length) throw new Error('test job not found');
  return id ? result[0] : result;
}
async function cancel(C, id, owner) {
  const result = await withLock(C, () => {
    const job = readJson(file(C, id));
    if (!job) throw new Error('test job not found');
    if (job.owner !== owner) throw new Error('only the submitting session can cancel this job');
    if (TERMINAL.has(job.state)) return job;
    atomic(path.join(root(C), id + '.cancel'), { requestedAt: Date.now() });
    if (job.state === 'queued') { job.state = 'cancelled'; job.finishedAt = Date.now(); atomic(file(C, id), job); }
    return job;
  });
  ensureRunner(C);
  return result;
}
function validateCommand(argv, kind, cwd, cfg) {
  if (path.basename(argv[0]) === 'xcodebuild') {
    if (kind === 'build' && argv.some((s) => ['test', 'test-without-building'].includes(s))) throw new Error('simulator tests require --kind ios-test');
    if (kind === 'build' && argv.some((s) => /platform=iOS Simulator/.test(s) && !/generic\//.test(s))) throw new Error('device destinations require --kind ios-test; use a generic destination for builds');
    return;
  }
  const registered = path.basename(argv[0]).startsWith('node') && argv[1] && cfg.runnerScripts.some((s) => path.resolve(cwd, s) === path.resolve(cwd, argv[1]));
  if (!registered) throw new Error('submit xcodebuild or a configured trusted runner script');
}
function commandForJob(argv, job, cfg) {
  if (path.basename(argv[0]) !== 'xcodebuild') return argv;
  const controlled = new Set(['-jobs', '-parallel-testing-enabled', '-parallel-testing-worker-count', '-maximum-parallel-testing-workers', '-maximum-concurrent-test-simulator-destinations', '-parallelize-tests-among-destinations']);
  if (job.kind === 'ios-test') controlled.add('-destination');
  const result = [argv[0]];
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i].split('=')[0];
    if (!controlled.has(flag)) { result.push(argv[i]); continue; }
    if (flag !== '-parallelize-tests-among-destinations' && !argv[i].includes('=')) i++;
  }
  result.push('-jobs', String(cfg.jobs), '-parallel-testing-enabled', 'NO', '-parallel-testing-worker-count', '1', '-maximum-concurrent-test-simulator-destinations', '1');
  if (job.kind === 'ios-test') result.push('-destination', 'platform=iOS Simulator,id=' + job.device.key);
  return result;
}
async function execute(argv, job, env, logFd) {
  await new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: job.cwd, env, stdio: ['ignore', logFd, logFd] });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error('command exited ' + (signal || code))));
  });
}
async function work(C, id) {
  let job;
  // The dispatcher writes the process identity before execution may begin.
  for (let i = 0; i < 100; i++) {
    job = readJson(file(C, id));
    if (job?.workerPid === process.pid) break;
    await delay(50);
  }
  if (job?.workerPid !== process.pid) return;
  job.state = 'running';
  job.phase = job.kind === 'ios-test' ? 'boot' : 'build';
  atomic(file(C, id), job);
  const logFd = fs.openSync(job.log, 'a', 0o600);
  const env = { ...process.env, AIRCONTROL_TEST_JOB_ID: id, AIRCONTROL_TEST_JOBS: String(config(C).jobs), AIRCONTROL_SIM_UDID: job.device?.key || '',
    AIRCONTROL_TEST_METRICS_PATH: path.join(root(C), id + '.metrics.json'), AIRCONTROL_TEST_PHASE_PATH: path.join(root(C), id + '.phase.json') };
  try {
    if (job.device) {
      const begin = Date.now();
      if (job.device.state !== 'booted') await execute(['xcrun', 'simctl', 'boot', job.device.key], job, env, logFd);
      await execute(['xcrun', 'simctl', 'bootstatus', job.device.key, '-b'], job, env, logFd);
      job.timings.bootMs = Date.now() - begin;
    }
    job.phase = 'command'; atomic(file(C, id), job);
    const begin = Date.now();
    await execute(commandForJob(job.command, job, config(C)), job, env, logFd);
    job.timings.commandMs = Date.now() - begin;
    job.result = 'succeeded';
  } catch (e) { job.result = 'failed'; job.error = e.message; }
  finally {
    fs.closeSync(logFd);
    const metrics = readJson(env.AIRCONTROL_TEST_METRICS_PATH);
    if (metrics) {
      for (const phase of ['buildMs', 'testMs']) if (Number.isFinite(metrics[phase])) job.timings[phase] = metrics[phase];
      job.reusedBuild = metrics.reusedBuild === true;
      job.tests = metrics.tests;
      job.resultBundle = metrics.result;
    }
    job.state = 'cleaning'; job.phase = 'cleanup';
    atomic(file(C, id), job);
  }
}
function signalJob(job, signal) {
  if (!job.workerPid || !groupAlive(job.workerPid)) return;
  const current = identity(job.workerPid);
  if (current && current !== job.workerBirth) throw new Error('worker identity changed; refusing to signal');
  process.kill(-job.workerPid, signal);
}
function cleanup(C, job, deps = {}) {
  if (groupAlive(job.workerPid)) return false;
  job.state = 'cleaning';
  job.phase = 'cleanup';
  const begin = Date.now();
  job.device ||= C.readLeases().find((l) => l.jobId === job.id);
  if (job.device) {
    const cfg = config(C);
    if (cfg.protectedDevices.some((s) => s === job.device.key || s === job.device.name)) {
      job.error = 'device became protected; operator cleanup required'; atomic(file(C, job.id), job); return false;
    }
    const lease = C.readLease('ios', job.device.key);
    if (lease && lease.jobId !== job.id) { job.error = 'device lease owner changed; cleanup blocked'; atomic(file(C, job.id), job); return false; }
    const result = C.shutdownLeaseDevice(job.device, deps);
    if (!result.ok) { job.error = 'cleanup pending: ' + result.error; atomic(file(C, job.id), job); return false; }
    if (lease) C.releaseLease('ios', job.device.key);
  }
  job.timings.cleanupMs = Date.now() - begin;
  job.finishedAt = Date.now();
  job.state = fs.existsSync(path.join(root(C), job.id + '.cancel')) ? 'cancelled' : job.result || 'failed';
  if (!job.result && job.state !== 'cancelled') job.error = 'test runner exited without a result';
  atomic(file(C, job.id), job);
  return true;
}
async function tick(C, deps = {}) {
  return withLock(C, () => {
    let all = jobs(C);
    for (const job of all.filter((j) => ACTIVE.has(j.state))) {
      const request = readJson(path.join(root(C), job.id + '.cancel'));
      if (request && groupAlive(job.workerPid)) {
        try { signalJob(job, Date.now() - request.requestedAt > 10000 ? 'SIGKILL' : 'SIGTERM'); } catch (e) { job.error = e.message; atomic(file(C, job.id), job); }
      }
      if (!groupAlive(job.workerPid)) cleanup(C, job, deps);
    }
    all = jobs(C);
    if (!config(C).enabled) return;
    const job = all.find((j) => j.state === 'queued');
    if (!job || !capacity(C, config(C), all, job.kind, deps.externalBuilds ? deps.externalBuilds() : externalBuilds(all))) return;
    job.state = 'starting'; job.phase = 'starting'; job.startedAt = Date.now();
    job.timings = { queueMs: job.startedAt - job.submittedAt };
    atomic(file(C, job.id), job);
    if (job.kind === 'ios-test') {
      const result = C.acquireDevice({ sessionId: job.owner, sessionName: job.ownerName, repo: job.repo, purpose: job.id,
        platform: 'ios', nowMs: Date.now(), bundleId: job.bundleId, prefer: job.name, runtime: job.runtime, queuedJob: job.id }, deps);
      if (!result.ok) {
        job.state = result.reason === 'no-devices' ? 'failed' : 'queued';
        if (job.state === 'failed') { job.finishedAt = Date.now(); job.error = 'no compatible allowed agent device'; }
        atomic(file(C, job.id), job); return;
      }
      job.device = result.device;
      const lease = { ...result.lease, jobId: job.id };
      atomic(C.leaseFile('ios', job.device.key), lease);
    }
    atomic(file(C, job.id), job);
    const child = (deps.spawn || spawn)(process.execPath, [path.join(__dirname, 'test-queue.js'), 'work', job.id], { detached: true, stdio: 'ignore', env: process.env });
    job.workerPid = child.pid; job.workerBirth = identity(child.pid);
    atomic(file(C, job.id), job);
    child.on('error', () => {}); child.unref();
  });
}
async function dispatch(C, deps = {}) {
  let release;
  for (let i = 0; i < 10 && !release; i++) { release = lock(C, 'runner'); if (!release) await delay(50); }
  if (!release) return;
  try {
    while (true) {
      try { await tick(C, deps); } catch (e) { if (e.code !== 'AIRCONTROL_QUEUE_BUSY') throw e; }
      const pending = jobs(C).some((j) => j.state === 'queued' || ACTIVE.has(j.state));
      if (!pending) {
        release();
        // A submit racing the idle transition must not leave a job without a runner.
        if (jobs(C).some((j) => j.state === 'queued')) ensureRunner(C);
        return;
      }
      await delay(2000);
    }
  } finally { release(); }
}
async function cli(C, argv) {
  const separator = argv.indexOf('--');
  const args = C.parseArgs(separator < 0 ? argv : argv.slice(0, separator));
  const sub = args._[1];
  let result;
  if (sub === 'configure') {
    const current = readJson(C.configFile()) || {};
    const testing = { ...config(C) };
    if (args.enabled !== undefined) {
      if (!['true', 'false'].includes(args.enabled)) throw new Error('--enabled must be true or false');
      testing.enabled = args.enabled === 'true';
    }
    for (const [flag, key] of [['max-xcode', 'maxXcode'], ['max-simulators', 'maxSimulators'], ['jobs', 'jobs']]) {
      if (args[flag] !== undefined) { const n = Number(args[flag]); if (!Number.isInteger(n) || n < 1) throw new Error('invalid --' + flag); testing[key] = n; }
    }
    if (args.runtime) testing.runtime = args.runtime;
    if (args.devices) testing.allowedNames = args.devices.split(',').map((s) => s.trim()).filter(Boolean);
    if (args.protected) testing.protectedDevices = args.protected.split(',').map((s) => s.trim()).filter(Boolean);
    atomic(C.configFile(), { ...current, testing });
    console.log(JSON.stringify(testing)); return;
  } else if (sub === 'status') {
    const id = args._[2];
    if (id) file(C, id);
    result = status(C, id); ensureRunner(C);
  } else {
    const session = C.requireLiveSession(args, Date.now());
    if (sub === 'submit') result = await submit(C, { kind: args.kind, cwd: args.cwd, name: args.name,
      runtime: args.runtime, bundleId: args['bundle-id'], command: separator < 0 ? [] : argv.slice(separator + 1) }, session);
    else if (sub === 'cancel') result = await cancel(C, args._[2], session.sessionId);
    else throw new Error('usage: test submit|status|cancel');
  }
  if (args.json) console.log(JSON.stringify(result));
  else for (const j of Array.isArray(result) ? result : [result]) console.log(`${j.id} ${j.state} owner=${j.ownerName} queue=${j.queuePosition || '-'} device=${j.device?.key || '-'} phase=${j.phase || '-'} log=${j.log}${j.error ? ' error=' + j.error : ''}`);
}
module.exports = { DEFAULTS, ACTIVE, TERMINAL, root, file, config, jobs, atomic, lock, identity, alive, groupAlive, deviceAllowed, activeLease, capacity, validateCommand, commandForJob, submit, status, cancel, cleanup, tick, cli, dispatch };
if (require.main === module) {
  const C = require('./coord.js');
  const run = process.argv[2] === 'work' ? work(C, process.argv[3]) : dispatch(C);
  run.catch((e) => { console.error(e.message); process.exitCode = 1; });
}
