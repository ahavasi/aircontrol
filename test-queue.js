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
  const history = readJson(historyFile(C));
  const waiting = all.filter((j) => j.state === 'queued');
  const result = all.filter((j) => !id || j.id === id).map((j) => ({ ...j,
    ...(j.state === 'running' && j.phase === 'command' ? { phase: readJson(path.join(root(C), j.id + '.phase.json'))?.phase || j.phase,
      progress: readJson(path.join(root(C), j.id + '.progress.json')) || j.progress || null } : {}),
    estimate: ACTIVE.has(j.state) || j.state === 'queued' ? estimate(j, history) : null,
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
// Progress is read from xcodebuild's own output. Every pattern is anchored: simulator apps
// log CoreData/CloudKit lines containing "error:" into the same stream, and a bare match on
// that word reports a failure that never happened.
function emptyProgress() {
  return { partial: '', ui: { passed: 0, failed: 0 }, unit: { done: 0, failed: 0, total: null, result: null }, build: null, result: null, last: null, error: null };
}
function parseProgress(text, prev = emptyProgress()) {
  const p = { ...prev, ui: { ...prev.ui }, unit: { ...prev.unit } };
  const events = [];
  const lines = (prev.partial + text).split('\n');
  p.partial = lines.pop();
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    let m;
    if ((m = /^Test Case '-\[([\w.]+) (\w+)\]' (passed|failed) \(([\d.]+) seconds\)/.exec(line))) {
      const [, cls, name, outcome, secs] = m;
      const label = cls.split('.').pop() + '.' + name;
      if (/UITests$/.test(cls.split('.')[0])) {
        p.ui[outcome]++; p.last = label;
        events.push({ type: 'test', label, outcome, secs: Number(secs) });
      } else {
        p.unit.done++; if (outcome === 'failed') p.unit.failed++;
      }
    } else if ((m = /^([✔✘]) Test run with (\d+) tests?/.exec(line))) {
      p.unit.total = Number(m[2]); p.unit.result = m[1] === '✔' ? 'passed' : 'failed';
      events.push({ type: 'unit', total: p.unit.total, outcome: p.unit.result });
    } else if ((m = /^([✔✘]) Test /.exec(line))) {
      p.unit.done++; if (m[1] === '✘') p.unit.failed++;
    } else if ((m = /^\*\* (TEST BUILD|BUILD) (SUCCEEDED|FAILED) \*\*/.exec(line))) {
      p.build = m[2].toLowerCase();
      events.push({ type: 'build', outcome: p.build });
    } else if ((m = /^\*\* TEST (EXECUTE )?(SUCCEEDED|FAILED) \*\*/.exec(line))) {
      p.result = m[2].toLowerCase();
    } else if (!p.error && (m = /^(\/\S+\.swift):(\d+):(?:\d+:)? error: (.*)$/.exec(line))) {
      p.error = (path.basename(m[1]) + ':' + m[2] + ': ' + m[3].replace(/^-\[[^\]]*\] : /, '')).slice(0, 200);
      events.push({ type: 'error', text: p.error });
    }
  }
  return { progress: p, events };
}
function progressSummary(p) {
  const { partial, ...rest } = p;
  return rest;
}
function readNew(name, offset) {
  let fd;
  try {
    fd = fs.openSync(name, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return { text: '', offset };
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    return { text: buf.toString('utf8'), offset: size };
  } catch { return { text: '', offset }; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
// Runners such as a project verify script send xcodebuild output to their own files and name
// the current one in the phase file (`{ phase, log }`), so every log seen is followed, each with
// its own offset and partial line.
function progressReader(primary, phaseFile, fromEnd) {
  const sources = new Map();
  const add = (name) => {
    if (!name || sources.has(name)) return;
    let offset = 0;
    if (fromEnd) try { offset = fs.statSync(name).size; } catch {}
    sources.set(name, { offset, partial: '' });
  };
  add(primary);
  let state = emptyProgress();
  return {
    read() {
      const named = readJson(phaseFile)?.log;
      if (typeof named === 'string' && path.isAbsolute(named)) add(named);
      const events = [];
      for (const [name, src] of sources) {
        const chunk = readNew(name, src.offset);
        if (!chunk.text) continue;
        src.offset = chunk.offset;
        const parsed = parseProgress(chunk.text, { ...state, partial: src.partial });
        src.partial = parsed.progress.partial;
        state = { ...parsed.progress, partial: '' };
        events.push(...parsed.events);
      }
      return { progress: state, events };
    },
  };
}
function trackProgress(logPath, out, phaseFile, intervalMs = 3000) {
  const reader = progressReader(logPath, phaseFile, true);
  let state = emptyProgress();
  const tick = () => {
    const { progress, events } = reader.read();
    state = progress;
    if (events.length || progress.ui.passed || progress.unit.done) try { atomic(out, progressSummary(state)); } catch {}
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop() { clearInterval(timer); tick(); return progressSummary(state); } };
}

// Durations are keyed on what the command does, not where it writes: derived data, result
// bundles, destinations and signing keys differ between worktrees running the same suite.
const VOLATILE = new Set(['-derivedDataPath', '-destination', '-resultBundlePath', '-authenticationKeyPath', '-authenticationKeyID', '-authenticationKeyIssuerID']);
function fingerprint(job) {
  const argv = [];
  for (let i = 0; i < (job.command || []).length; i++) {
    if (VOLATILE.has(job.command[i])) { i++; continue; }
    argv.push(job.command[i]);
  }
  return crypto.createHash('sha1').update([job.kind, job.repo || path.basename(job.cwd || ''), ...argv].join('\0')).digest('hex').slice(0, 16);
}
const historyFile = (C) => path.join(root(C), 'history.json');
function recordHistory(C, job) {
  if (!Number.isFinite(job.timings?.commandMs)) return;
  const all = readJson(historyFile(C)) || {};
  const key = fingerprint(job);
  const ui = job.progress ? job.progress.ui.passed + job.progress.ui.failed : null;
  all[key] = [...(all[key] || []), { commandMs: job.timings.commandMs, ui, unit: job.progress?.unit.total ?? null, at: Date.now() }].slice(-5);
  atomic(historyFile(C), all);
}
function estimate(job, history) {
  const runs = (history || {})[fingerprint(job)] || [];
  if (!runs.length) return null;
  const sorted = runs.map((r) => r.commandMs).sort((a, b) => a - b);
  const last = runs[runs.length - 1];
  return { commandMs: sorted[Math.floor(sorted.length / 2)], ui: last.ui, unit: last.unit };
}
function remainingMs(j, now = Date.now()) {
  if (!j.estimate) return null;
  if (j.state === 'queued') return j.estimate.commandMs;
  if (!j.commandStartedAt) return j.estimate.commandMs;
  return j.estimate.commandMs - (now - j.commandStartedAt);
}
function formatDuration(ms) {
  const m = Math.round(ms / 60000);
  return m < 1 ? '<1m' : m + 'm';
}
function formatProgress(j, now = Date.now()) {
  const parts = [];
  const p = j.progress;
  if (p) {
    const ui = p.ui.passed + p.ui.failed;
    if (ui || j.estimate?.ui) parts.push(`${ui}${j.estimate?.ui ? '/' + j.estimate.ui : ''} UI${p.ui.failed ? ` (${p.ui.failed} failed)` : ''}`);
    if (p.unit.total) parts.push(`${p.unit.total} unit ${p.unit.result === 'passed' ? '✓' : '✗'}`);
    else if (p.unit.done) parts.push(`${p.unit.done}${j.estimate?.unit ? '/' + j.estimate.unit : ''} unit`);
    if (!ui && !p.unit.done && !p.unit.total && p.build) parts.push(`build ${p.build}`);
  }
  if (ACTIVE.has(j.state) || j.state === 'queued') {
    const left = remainingMs(j, now);
    if (left !== null) parts.push(left > 0 ? `~${formatDuration(left)} left` : 'running over estimate');
  }
  return parts.join(' · ');
}
const PHASES = { starting: 'starting', boot: 'booting simulator', build: 'building', command: 'running', test: 'testing', cleanup: 'cleaning up' };
const phaseLabel = (phase) => PHASES[phase] || phase;
function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
function renderEvent(e) {
  if (e.type === 'test') return `${e.outcome === 'passed' ? '✅' : '❌'} ${e.label} (${e.secs.toFixed(1)}s)`;
  if (e.type === 'unit') return `${e.outcome === 'passed' ? '✅' : '❌'} unit tests: ${e.total} ${e.outcome}`;
  if (e.type === 'build') return `🔨 build ${e.outcome}`;
  if (e.type === 'error') return `   ↳ ${e.text}`;
  return null;
}
// Replays the log from the start, so attaching late still shows every finished test.
async function watch(C, id, opts = {}) {
  const write = opts.write || ((line) => console.log(line));
  const interval = opts.intervalMs ?? 2000;
  let last = null;
  const reader = progressReader(status(C, id).log, path.join(root(C), id + '.phase.json'), false);
  let state = emptyProgress();
  for (;;) {
    const j = status(C, id);
    const where = j.state === 'queued' ? `queued #${j.queuePosition}` : phaseLabel(j.phase || j.state);
    if (where !== last && !TERMINAL.has(j.state)) {
      const progress = formatProgress(j);
      write(`⏱ ${formatClock(j.elapsedMs)} ${where}${progress ? ' · ' + progress : ''}`);
      last = where;
    }
    const parsed = reader.read();
    state = parsed.progress;
    if (!opts.quiet) for (const e of parsed.events) { const line = renderEvent(e); if (line) write(line); }
    if (TERMINAL.has(j.state)) {
      const progress = formatProgress({ ...j, progress: j.progress || progressSummary(state) });
      write(`done: ${j.state} in ${formatClock(j.elapsedMs)}${progress ? ' · ' + progress : ''}${j.error ? ' · ' + j.error : ''}`);
      return j.state === 'succeeded' ? 0 : 1;
    }
    await delay(interval);
  }
}
function renderTestsLine(all, selfId, now = Date.now()) {
  const active = all.filter((j) => ACTIVE.has(j.state));
  const queued = all.filter((j) => j.state === 'queued');
  if (!active.length && !queued.length) return '';
  const mine = (j) => j.owner === selfId;
  const shown = [...active, ...queued.filter(mine)].sort((a, b) => Number(mine(b)) - Number(mine(a)) || a.sequence - b.sequence).slice(0, 3);
  const items = shown.map((j) => {
    const who = mine(j) ? 'you' : j.ownerName;
    const where = j.state === 'queued' ? `queued #${j.queuePosition}` : phaseLabel(j.phase || j.state);
    const progress = formatProgress(j, now);
    return `${j.id.slice(0, 9)}… (${who}) ${where}${progress ? ' · ' + progress : ''}`;
  });
  const others = queued.filter((j) => !mine(j)).length;
  if (others) items.push(`${others} other job${others === 1 ? '' : 's'} queued`);
  return `[aircontrol] tests: ${items.join(' | ')} — \`coord.js test watch <id>\` to follow`;
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
  let tracker = null;
  const env = { ...process.env, AIRCONTROL_TEST_JOB_ID: id, AIRCONTROL_TEST_JOBS: String(config(C).jobs), AIRCONTROL_SIM_UDID: job.device?.key || '',
    AIRCONTROL_TEST_METRICS_PATH: path.join(root(C), id + '.metrics.json'), AIRCONTROL_TEST_PHASE_PATH: path.join(root(C), id + '.phase.json') };
  try {
    if (job.device) {
      const begin = Date.now();
      if (job.device.state !== 'booted') await execute(['xcrun', 'simctl', 'boot', job.device.key], job, env, logFd);
      await execute(['xcrun', 'simctl', 'bootstatus', job.device.key, '-b'], job, env, logFd);
      job.timings.bootMs = Date.now() - begin;
    }
    const begin = Date.now();
    job.phase = 'command'; job.commandStartedAt = begin; atomic(file(C, id), job);
    tracker = trackProgress(job.log, path.join(root(C), id + '.progress.json'), env.AIRCONTROL_TEST_PHASE_PATH);
    await execute(commandForJob(job.command, job, config(C)), job, env, logFd);
    job.timings.commandMs = Date.now() - begin;
    job.result = 'succeeded';
  } catch (e) { job.result = 'failed'; job.error = e.message; }
  finally {
    fs.closeSync(logFd);
    if (tracker) {
      job.progress = tracker.stop();
      try { fs.unlinkSync(path.join(root(C), id + '.progress.json')); } catch {}
    }
    if (job.result === 'succeeded') try { recordHistory(C, job); } catch {}
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
  } else if (sub === 'watch') {
    const id = args._[2];
    if (!id) throw new Error('usage: test watch <job-id> [--quiet]');
    file(C, id); ensureRunner(C);
    process.exitCode = await watch(C, id, { quiet: Boolean(args.quiet) });
    return;
  } else {
    const session = C.requireLiveSession(args, Date.now());
    if (sub === 'submit') result = await submit(C, { kind: args.kind, cwd: args.cwd, name: args.name,
      runtime: args.runtime, bundleId: args['bundle-id'], command: separator < 0 ? [] : argv.slice(separator + 1) }, session);
    else if (sub === 'cancel') result = await cancel(C, args._[2], session.sessionId);
    else throw new Error('usage: test submit|status|watch|cancel');
  }
  if (args.json) console.log(JSON.stringify(result));
  else for (const j of Array.isArray(result) ? result : [result]) console.log(`${j.id} ${j.state} owner=${j.ownerName} queue=${j.queuePosition || '-'} device=${j.device?.key || '-'} phase=${j.phase || '-'}${formatProgress(j) ? ' progress="' + formatProgress(j) + '"' : ''} log=${j.log}${j.error ? ' error=' + j.error : ''}`);
}
module.exports = { emptyProgress, parseProgress, fingerprint, recordHistory, estimate, formatProgress, renderTestsLine, renderEvent, watch, DEFAULTS, ACTIVE, TERMINAL, root, file, config, jobs, atomic, lock, identity, alive, groupAlive, deviceAllowed, activeLease, capacity, validateCommand, commandForJob, submit, status, cancel, cleanup, tick, cli, dispatch };
if (require.main === module) {
  const C = require('./coord.js');
  const run = process.argv[2] === 'work' ? work(C, process.argv[3]) : dispatch(C);
  run.catch((e) => { console.error(e.message); process.exitCode = 1; });
}
