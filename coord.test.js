'use strict';
require('./tmp-cleanup.js');
const test = require('node:test');
const assert = require('node:assert');

// AIRCONTROL_DIR must be set before requiring coord.js in fs tests (Task 2);
// pure-helper tests don't touch the fs but we set it defensively anyway.
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.AIRCONTROL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aircontrol-test-'));
process.env.AIRCONTROL_DISABLE_LISTENER = '1';

const C = require('./coord.js');

test('boundaryPrefix matches at / boundaries only', () => {
  assert.equal(C.boundaryPrefix('CardStock/App', 'CardStock/App'), true);
  assert.equal(C.boundaryPrefix('CardStock/App', 'CardStock/App/RootView.swift'), true);
  assert.equal(C.boundaryPrefix('CardStock/App', 'CardStock/AppStore.swift'), false);
  assert.equal(C.boundaryPrefix('CardStock/App/', 'CardStock/App/RootView.swift'), true);
});

test('pathsOverlap is symmetric', () => {
  assert.equal(C.pathsOverlap('CardStock/App', 'CardStock/App/RootView.swift'), true);
  assert.equal(C.pathsOverlap('CardStock/App/RootView.swift', 'CardStock/App'), true);
  assert.equal(C.pathsOverlap('worker/src', 'CardStock/App'), false);
});

test('boundaryPrefix and pathsOverlap fold case, matching macOS APFS default case-insensitivity', () => {
  assert.equal(C.boundaryPrefix('Store/', 'store/Foo.swift'), true);
  assert.equal(C.boundaryPrefix('store/', 'Store/Foo.swift'), true);
  assert.equal(C.pathsOverlap('Store/', 'STORE/Foo.swift'), true);
  assert.equal(C.pathsOverlap('Store', 'StoreX.swift'), false); // still boundary-safe, not a substring match
});

test('isStale uses the 30-minute threshold', () => {
  const now = Date.parse('2026-07-16T12:00:00Z');
  assert.equal(C.isStale({ lastSeen: '2026-07-16T11:45:00Z' }, now), false);
  assert.equal(C.isStale({ lastSeen: '2026-07-16T11:29:59Z' }, now), true);
});

test('mergeClaims appends and dedupes', () => {
  const merged = C.mergeClaims({ paths: ['a'], resources: ['sim:x'] }, ['a', 'b'], ['sim:x', 'stash']);
  assert.deepEqual(merged, { paths: ['a', 'b'], resources: ['sim:x', 'stash'] });
  assert.deepEqual(C.mergeClaims(undefined, ['p'], undefined), { paths: ['p'], resources: [] });
});

test('resolveIdPrefix: unique hit, none, ambiguous', () => {
  const ids = ['58da6e70-x', '7619f7ec-y'];
  assert.equal(C.resolveIdPrefix(ids, '58da'), '58da6e70-x');
  assert.throws(() => C.resolveIdPrefix(ids, 'zz'), /no session/);
  assert.throws(() => C.resolveIdPrefix(['abc1', 'abc2'], 'abc'), /ambiguous/);
});

test('resolveIdPrefix resolves by friendly name, case-insensitive', () => {
  const ids = ['58da6e70-x', '7619f7ec-y'];
  assert.notEqual(C.friendlyName(ids[0]), C.friendlyName(ids[1])); // fixtures must be distinct
  const name = C.friendlyName(ids[1]);
  assert.equal(C.resolveIdPrefix(ids, name), ids[1]);
  assert.equal(C.resolveIdPrefix(ids, name.toUpperCase()), ids[1]);
  assert.throws(() => C.resolveIdPrefix(ids, 'nobody-here'), /no session/);
});

test('hashId is deterministic; friendlyName is stable and style-aware', () => {
  assert.equal(C.hashId('abc'), C.hashId('abc'));
  assert.equal(C.friendlyName('session-alpha'), C.friendlyName('session-alpha'));
  for (const style of Object.keys(C.NAME_STYLES)) {
    assert.match(C.friendlyName('some-id', style), /^[a-z]+(-[a-z]+)?$/);
  }
  assert.match(C.friendlyName('some-id', 'goofy'), /-/);      // two-part
  assert.match(C.friendlyName('some-id', 'animal'), /-/);     // two-part
  assert.doesNotMatch(C.friendlyName('some-id', 'real'), /-/); // single word
});

test('nameStyle defaults to goofy; unknown style falls back; writeNameStyle persists', () => {
  freshDataDir(); // no config.json yet
  assert.equal(C.nameStyle(), 'goofy');
  assert.equal(C.friendlyName('x', 'bogus'), C.friendlyName('x', 'goofy'));
  C.writeNameStyle('animal');
  assert.equal(C.nameStyle(), 'animal');
  assert.match(C.friendlyName('x'), /-/); // animal is two-part
});

test('a new session is never named a word another live session is already using', () => {
  freshDataDir();
  // sess-0 and sess-2 both hash to "…-noodlebonk" under goofy. Sharing only the
  // second half is the dangerous case: two live sessions read as one another on
  // a roster, and a message addressed by the shared half goes somewhere silently.
  const repo = tmpGitRepo('names-a');
  const now = Date.now();
  C.cmdRegister({ session_id: 'sess-0', cwd: repo }, now);
  C.cmdRegister({ session_id: 'sess-2', cwd: repo }, now);

  const first = C.friendlyName('sess-0');
  const second = C.friendlyName('sess-2');
  assert.notEqual(first, second);
  const words = (n) => new Set(n.split('-'));
  for (const w of words(second)) assert.equal(words(first).has(w), false, `"${w}" is shared by ${first} and ${second}`);
});

test('deconfliction only considers sessions that are still live', () => {
  freshDataDir();
  const repo = tmpGitRepo('names-b');
  const now = Date.parse('2026-07-16T12:00:00Z');
  C.cmdRegister({ session_id: 'sess-0', cwd: repo }, now);
  // Long enough ago that sweep would drop it: a name freed by a dead session is
  // reusable, otherwise the vocabulary only ever shrinks.
  assert.equal(C.pickNameSalt('sess-2', now + C.STALE_MS * 10), 0);
});

test('a session that predates salts keeps the name it has been answering to', () => {
  freshDataDir();
  const repo = tmpGitRepo('names-c');
  const now = Date.now();
  C.cmdRegister({ session_id: 'sess-0', cwd: repo }, now);
  const before = C.friendlyName('sess-0');

  // Simulate an upgrade: the record exists, written by a version with no salts.
  const rec = C.readSession('sess-0');
  delete rec.nameSalt;
  C.writeSession(rec);

  C.cmdRegister({ session_id: 'sess-0', cwd: repo }, now + 1000);
  assert.equal(C.readSession('sess-0').nameSalt, 0);
  assert.equal(C.friendlyName('sess-0'), before);
});

test('a salt renders under whichever style is configured, not a frozen name', () => {
  freshDataDir();
  for (const style of ['goofy', 'animal', 'real']) {
    assert.equal(C.saltedName('an-id', 3, style), C.saltedName('an-id', 3, style));
    assert.match(C.saltedName('an-id', 3, style), /^[a-z]+(-[a-z]+)?$/);
  }
  // Salt 0 must be byte-identical to the pre-salt hash, or every existing
  // session renames itself the moment this ships.
  assert.equal(C.saltedName('an-id', 0, 'goofy'), C.friendlyName('an-id', 'goofy'));
  assert.notEqual(C.saltedName('an-id', 1, 'goofy'), C.saltedName('an-id', 0, 'goofy'));
});

test('messageFilename is unique per call and keeps the full sender id recoverable', () => {
  const a = C.messageFilename(1752600000000, 'abcd-ef');
  const b = C.messageFilename(1752600000000, 'abcd-ef');
  assert.notEqual(a, b); // same ms + same sender must not overwrite
  for (const f of [a, b]) {
    assert.match(f, /^1752600000000-/);
    assert.ok(f.endsWith('.md'));
    assert.equal(f.replace(/\.md$/, '').split('-').slice(2).join('-'), 'abcd-ef');
  }
});

test('parseArgs and splitList', () => {
  const a = C.parseArgs(['send', '--session', '76', '--to', '58', '--repair', 'hello world']);
  assert.equal(a.session, '76');
  assert.equal(a.to, '58');
  assert.equal(a.repair, true);
  assert.deepEqual(a._, ['send', 'hello world']);
  assert.deepEqual(C.splitList(' a, b ,,c '), ['a', 'b', 'c']);
});

test('gitEnv disables optional locks without dropping the environment', () => {
  const env = C.gitEnv();
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(env.PATH, process.env.PATH);
});

test('toolInputPaths reads Claude file fields and Codex apply_patch paths', () => {
  assert.deepEqual(C.toolInputPaths({ tool_input: { file_path: '/repo/a.js' } }), ['/repo/a.js']);
  assert.deepEqual(C.toolInputPaths({
    tool_name: 'apply_patch',
    tool_input: {
      command: [
        '*** Begin Patch',
        '*** Update File: src/a.js',
        '*** Move to: src/b.js',
        '*** Add File: test/a.test.js',
        '*** Delete File: old.js',
        '*** End Patch',
      ].join('\n'),
    },
  }), ['src/a.js', 'src/b.js', 'test/a.test.js', 'old.js']);
  assert.deepEqual(C.toolInputPaths({ tool_name: 'Bash', tool_input: { command: 'touch nope' } }), []);
});

function mkSession(over) {
  return Object.assign({
    sessionId: 'self-0000-0000', startedAt: '2026-07-16T11:00:00Z',
    lastSeen: '2026-07-16T11:59:00Z', repo: '/repo/a/.git',
    worktree: '/repo/a', branch: 'develop', intent: 'testing',
    claims: { paths: [], resources: [] }, recentPaths: [],
  }, over);
}

test('advisories: path conflicts only within same repo', () => {
  const self = mkSession({ recentPaths: ['CardStock/App/RootView.swift'] });
  const sameRepo = mkSession({ sessionId: 'peer-1111', claims: { paths: ['CardStock/App'], resources: [] } });
  const otherRepo = mkSession({ sessionId: 'peer-2222', repo: '/repo/b/.git', claims: { paths: ['CardStock/App'], resources: [] } });
  assert.equal(C.advisories(self, [sameRepo]).length, 1);
  assert.equal(C.advisories(self, [otherRepo]).length, 0);
});

test('advisories: sim resources global, stash repo-scoped', () => {
  const self = mkSession({ claims: { paths: [], resources: ['sim:CardStock-Agent', 'stash'] } });
  const otherRepoSim = mkSession({ sessionId: 'p1', repo: '/repo/b/.git', claims: { paths: [], resources: ['sim:CardStock-Agent'] } });
  const otherRepoStash = mkSession({ sessionId: 'p2', repo: '/repo/b/.git', claims: { paths: [], resources: ['stash'] } });
  const sameRepoStash = mkSession({ sessionId: 'p3', claims: { paths: [], resources: ['stash'] } });
  assert.equal(C.advisories(self, [otherRepoSim]).length, 1);
  assert.equal(C.advisories(self, [otherRepoStash]).length, 0);
  assert.equal(C.advisories(self, [sameRepoStash]).length, 1);
});

test('renderInjection: solo one-liner', () => {
  const now = Date.parse('2026-07-16T12:00:00Z');
  const self = mkSession({});
  const out = C.renderInjection(self, [], [], now);
  assert.match(out, new RegExp(`^\\[aircontrol\\] session ${C.friendlyName(self.sessionId)} `));
  assert.match(out, /no other sessions/);
});

test('renderInjection: groups same-repo vs elsewhere, lists messages, shows advisories', () => {
  const now = Date.parse('2026-07-16T12:00:00Z');
  const self = mkSession({ recentPaths: ['CardStock/App/RootView.swift'] });
  const same = mkSession({ sessionId: 'peer-1111', worktree: '/repo/a-wt2', branch: 'feature/x', intent: 'insights polish', claims: { paths: ['CardStock/App'], resources: ['sim:P3'] } });
  const other = mkSession({ sessionId: 'peer-2222', repo: '/repo/b/.git', worktree: '/repo/b', intent: 'otherapp work' });
  const msgs = [{ from: 'peer-1111', at: '2026-07-16T11:57:00Z', text: 'ping' }];
  const out = C.renderInjection(self, [same, other], msgs, now);
  assert.match(out, /Other sessions in THIS repo:/);
  assert.match(out, new RegExp(`${C.friendlyName('peer-1111')}.*feature\\/x.*insights polish`));
  assert.match(out, /Elsewhere on this machine:/);
  assert.match(out, new RegExp(C.friendlyName('peer-2222')));
  assert.match(out, /Messages for you:/);
  assert.match(out, new RegExp(`from ${C.friendlyName('peer-1111')}.*ping`));
  assert.match(out, /Advisories:/);
  assert.match(out, /coordinate/i);
});

test('renderInjection footer uses the given cli path (Claude default, Codex override)', () => {
  const now = Date.parse('2026-07-16T12:00:00Z');
  const self = mkSession({});
  const peer = mkSession({ sessionId: 'peer-1111' });
  assert.match(C.renderInjection(self, [peer], [], now), /Coordination CLI: node ~\/\.claude\/hooks\/coord\.js/);
  assert.match(C.renderInjection(self, [peer], [], now, '~/.codex/hooks/coord.js'), /Coordination CLI: node ~\/\.codex\/hooks\/coord\.js/);
});

test('renderInjection: stale others are ignored', () => {
  const now = Date.parse('2026-07-16T12:00:00Z');
  const stale = mkSession({ sessionId: 'peer-1111', lastSeen: '2026-07-16T11:00:00Z' });
  assert.match(C.renderInjection(mkSession({}), [stale], [], now), /no other sessions/);
});

const { execFileSync } = require('child_process');

function freshDataDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aircontrol-fs-'));
  process.env.AIRCONTROL_DIR = d;
  return d;
}

function tmpGitRepo(name) {
  // realpath immediately: on macOS, os.tmpdir() resolves under the /var symlink,
  // but `git rev-parse --show-toplevel` / `--git-common-dir` return the
  // canonicalized /private/var/... path. Canonicalize here so path equality
  // assertions against git's output match.
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `aircontrol-${name}-`)));
  const git = (args) => execFileSync('git', args, { cwd: d });
  git(['init', '-q', '-b', 'develop']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return d;
}

test('register + readSessions + gitInfo: repo key groups worktrees', () => {
  freshDataDir();
  const repoA = tmpGitRepo('a');
  const wt = repoA + '-wt';
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'feature/x', wt], { cwd: repoA });
  const now = Date.now();
  C.cmdRegister({ session_id: 'sess-main', cwd: repoA }, now);
  C.cmdRegister({ session_id: 'sess-wt', cwd: wt }, now);
  const all = C.readSessions();
  assert.equal(all.length, 2);
  const [m, w] = [all.find((s) => s.sessionId === 'sess-main'), all.find((s) => s.sessionId === 'sess-wt')];
  assert.equal(m.repo, w.repo); // worktrees share the git common dir
  assert.equal(m.branch, 'develop');
  assert.equal(w.branch, 'feature/x');
  assert.equal(m.intent, '(not yet declared)');
});

test('register outside a repo uses none:<cwd> and does not throw', () => {
  freshDataDir();
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'aircontrol-plain-'));
  C.cmdRegister({ session_id: 'sess-plain', cwd: plain }, Date.now());
  assert.equal(C.readSession('sess-plain').repo, `none:${plain}`);
});

test('re-register (resume/compact) preserves intent and claims', () => {
  freshDataDir();
  const repo = tmpGitRepo('b');
  const now = Date.now();
  C.cmdRegister({ session_id: 's1', cwd: repo }, now);
  const s = C.readSession('s1');
  s.intent = 'doing things'; s.claims = { paths: ['x'], resources: [] };
  C.writeSession(s);
  C.cmdRegister({ session_id: 's1', cwd: repo }, now + 1000);
  const again = C.readSession('s1');
  assert.equal(again.intent, 'doing things');
  assert.deepEqual(again.claims.paths, ['x']);
});

test('sweep removes stale sessions, expired messages/temp files, and empty inboxes', () => {
  const data = freshDataDir();
  const repo = tmpGitRepo('c');
  const now = Date.now();
  C.cmdRegister({ session_id: 'fresh', cwd: repo }, now);
  C.cmdRegister({ session_id: 'old', cwd: repo }, now);
  const old = C.readSession('old');
  old.lastSeen = new Date(now - 31 * 60 * 1000).toISOString();
  C.writeSession(old);
  const inbox = path.join(process.env.AIRCONTROL_DIR, 'messages', 'fresh');
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, `${now - 8 * 24 * 3600 * 1000}-x.md.read`), 'ancient');
  fs.writeFileSync(path.join(inbox, `${now}-y.md.read`), 'recent');
  const orphanInbox = path.join(data, 'messages', 'orphan');
  fs.mkdirSync(orphanInbox, { recursive: true });
  fs.writeFileSync(path.join(orphanInbox, `${now - 31 * 24 * 3600 * 1000}-x.md`), 'never delivered');
  const temp = path.join(data, 'sessions', 'orphan.json.tmp-123');
  fs.writeFileSync(temp, '{}');
  const oldTime = new Date(now - 25 * 60 * 60 * 1000);
  fs.utimesSync(temp, oldTime, oldTime);
  const removed = C.sweep(now);
  assert.equal(C.readSessions().length, 1);
  assert.deepEqual(fs.readdirSync(inbox), [`${now}-y.md.read`]);
  assert.equal(fs.existsSync(orphanInbox), false);
  assert.equal(fs.existsSync(temp), false);
  assert.deepEqual(removed, {
    sessions: 1, readMessages: 1, unreadMessages: 1, tempFiles: 1, emptyDirs: 1,
    leases: 0, ledgerEvents: 0,
  });
});

test('lock helpers distinguish writable lsof descriptors and unchanged identity', () => {
  assert.equal(C.parseLsofWritable('p123\nf5r\nna\np456\nf7u\nb'), true);
  assert.equal(C.parseLsofWritable('p123\nf5r\nna'), false);
  assert.equal(C.sameLock(
    { dev: 1, ino: 2, size: 0, mtimeMs: 3, regular: true },
    { dev: 1, ino: 2, size: 0, mtimeMs: 3, regular: true },
  ), true);
  assert.equal(C.sameLock(
    { dev: 1, ino: 2, size: 0, mtimeMs: 3, regular: true },
    { dev: 1, ino: 9, size: 0, mtimeMs: 3, regular: true },
  ), false);
});

test('discoverGitDirs finds main and linked-worktree gitdirs', () => {
  const repo = tmpGitRepo('doctor-discover');
  const wt = repo + '-wt';
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'doctor/wt', wt], { cwd: repo });
  const dirs = C.discoverGitDirs([repo]);
  assert.ok(dirs.includes(path.join(repo, '.git')));
  assert.ok(dirs.some((dir) => dir.includes(`${path.sep}.git${path.sep}worktrees${path.sep}`)));
  assert.ok(C.discoverGitDirs([wt]).some((dir) => dir.includes(`${path.sep}.git${path.sep}worktrees${path.sep}`)));
});

test('doctor is dry-run by default and repairs only a safely classified stale lock', () => {
  const data = freshDataDir();
  const repo = tmpGitRepo('doctor-repair');
  const lock = path.join(repo, '.git', 'index.lock');
  const now = Date.now();
  fs.writeFileSync(lock, '');
  const oldTime = new Date(now - 11 * 60 * 1000);
  fs.utimesSync(lock, oldTime, oldTime);
  const safeRuntime = {
    nowMs: now,
    processCheck: () => ({ active: false, unknown: false, detail: '' }),
    openState: () => ({ writable: false, unknown: false }),
    probeMs: 0,
  };

  const dry = C.doctorLocks([repo], safeRuntime);
  assert.equal(dry.results[0].action, 'repairable');
  assert.equal(fs.existsSync(lock), true);

  const repaired = C.doctorLocks([repo], { ...safeRuntime, repair: true });
  assert.equal(repaired.results[0].action, 'removed');
  assert.equal(fs.existsSync(lock), false);
  const audit = fs.readFileSync(path.join(data, 'doctor.log'), 'utf8');
  assert.match(audit, /removed-stale-index-lock/);
  assert.match(audit, /index\.lock/);
});

test('doctor refuses fresh, non-empty, operation-active, open, and changing locks', () => {
  const repo = tmpGitRepo('doctor-block');
  const lock = path.join(repo, '.git', 'index.lock');
  const now = Date.now();
  fs.writeFileSync(lock, 'data');
  let result = C.inspectLock(lock, {
    nowMs: now,
    processState: { active: false, unknown: false },
    openState: () => ({ writable: false, unknown: false }),
  });
  assert.match(result.reasons.join(' '), /non-empty/);
  assert.match(result.reasons.join(' '), /only/);

  fs.writeFileSync(lock, '');
  const oldTime = new Date(now - 11 * 60 * 1000);
  fs.utimesSync(lock, oldTime, oldTime);
  fs.writeFileSync(path.join(repo, '.git', 'MERGE_HEAD'), 'abc');
  result = C.inspectLock(lock, {
    nowMs: now,
    processState: { active: false, unknown: false },
    openState: () => ({ writable: true, unknown: false }),
  });
  assert.match(result.reasons.join(' '), /operation in progress/);
  assert.match(result.reasons.join(' '), /open for writing/);
  fs.unlinkSync(path.join(repo, '.git', 'MERGE_HEAD'));

  let checks = 0;
  const changed = C.doctorLocks([repo], {
    nowMs: now, repair: true, probeMs: 0,
    processCheck: () => ({ active: false, unknown: false, detail: '' }),
    openState: () => {
      checks++;
      if (checks === 1) fs.utimesSync(lock, new Date(), new Date());
      return { writable: false, unknown: false };
    },
  });
  assert.equal(changed.results[0].action, 'blocked');
  assert.equal(fs.existsSync(lock), true);
});

test('readSessions skips and removes corrupt files', () => {
  freshDataDir();
  C.ensureDirs();
  fs.writeFileSync(path.join(process.env.AIRCONTROL_DIR, 'sessions', 'bad.json'), '{nope');
  assert.deepEqual(C.readSessions(), []);
  assert.equal(fs.existsSync(path.join(process.env.AIRCONTROL_DIR, 'sessions', 'bad.json')), false);
});

test('beat: debounces plain heartbeats, always records new recentPaths repo-relative', () => {
  freshDataDir();
  const repo = tmpGitRepo('d');
  const t0 = Date.now() - 120000;
  C.cmdRegister({ session_id: 's1', cwd: repo }, t0);
  // fresh heartbeat < 60s later without a path: skipped
  C.cmdBeat({ session_id: 's1' }, t0 + 1000);
  assert.equal(Date.parse(C.readSession('s1').lastSeen), t0);
  // with a file path: recorded regardless of debounce, repo-relative
  C.cmdBeat({ session_id: 's1', tool_input: { file_path: path.join(repo, 'CardStock/App/RootView.swift') } }, t0 + 2000);
  const s = C.readSession('s1');
  assert.deepEqual(s.recentPaths, ['CardStock/App/RootView.swift']);
  assert.equal(Date.parse(s.lastSeen), t0 + 2000);
  // repeated path moves to end, no duplicate; cap at 20
  for (let i = 0; i < 25; i++) C.cmdBeat({ session_id: 's1', tool_input: { file_path: path.join(repo, `f${i}.txt`) } }, t0 + 3000 + i);
  const capped = C.readSession('s1');
  assert.equal(capped.recentPaths.length, 20);
  assert.equal(capped.recentPaths[19], 'f24.txt');
});

test('beat records every path from a Codex apply_patch call', () => {
  freshDataDir();
  const repo = tmpGitRepo('codex-patch');
  const now = Date.now();
  C.cmdRegister({ session_id: 'codex-1', cwd: repo }, now - 120000);
  C.cmdBeat({
    session_id: 'codex-1',
    tool_name: 'apply_patch',
    tool_input: {
      command: [
        '*** Begin Patch',
        '*** Update File: src/a.js',
        '*** Add File: test/a.test.js',
        '*** End Patch',
      ].join('\n'),
    },
  }, now);
  assert.deepEqual(C.readSession('codex-1').recentPaths, ['src/a.js', 'test/a.test.js']);
});

test('deregister removes the session file; hook cmds tolerate missing ids', () => {
  freshDataDir();
  const repo = tmpGitRepo('e');
  C.cmdRegister({ session_id: 's1', cwd: repo }, Date.now());
  C.cmdDeregister({ session_id: 's1' });
  assert.equal(C.readSession('s1'), null);
  C.cmdRegister({}, Date.now());   // no session_id → no-op, no throw
  C.cmdBeat({}, Date.now());
  C.cmdDeregister({});
});

test('a real Codex SessionEnd schedules an archive, but /clear and Claude do not', () => {
  freshDataDir();
  const repo = tmpGitRepo('archive');
  const launches = [];
  const deps = { spawn: (...args) => { launches.push(args); return { unref() {} }; } };
  C.cmdRegister({ session_id: 'codex-ending', cwd: repo }, Date.now(), 'codex');
  C.cmdDeregister({ session_id: 'codex-ending' }, Date.now(), deps);
  assert.equal(launches.length, 1);
  assert.deepEqual(launches[0][1].slice(-3), ['--archive', '--session', 'codex-ending']);

  C.cmdRegister({ session_id: 'codex-clear', cwd: repo }, Date.now(), 'codex');
  C.cmdDeregister({ session_id: 'codex-clear', reason: 'clear' }, Date.now(), deps);
  C.cmdRegister({ session_id: 'claude-ending', cwd: repo }, Date.now(), 'claude');
  C.cmdDeregister({ session_id: 'claude-ending' }, Date.now(), deps);
  assert.equal(launches.length, 1);
});

// cmdInject speaks the hook JSON envelope on both harnesses; tests care about the context
// inside it. Asserting against the raw stdout would pass by accident on single-line regexes
// and silently stop checking structure.
function injectContext(input, nowMs, format) {
  const raw = captureStdout(() => C.cmdInject(input, nowMs, format));
  if (!raw.trim()) return '';
  return JSON.parse(raw).hookSpecificOutput.additionalContext;
}

function captureStdout(fn) {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = '';
  process.stdout.write = (chunk) => { buf += chunk; return true; };
  try { fn(); } finally { process.stdout.write = orig; }
  return buf;
}

test('inject: heartbeats, prints block, delivers and marks messages read', () => {
  freshDataDir();
  const repoA = tmpGitRepo('inj-a');
  const repoB = tmpGitRepo('inj-b');
  const now = Date.now();
  C.cmdRegister({ session_id: 'me-000000', cwd: repoA }, now - 120000);
  C.cmdRegister({ session_id: 'peer-1111', cwd: repoA }, now);
  C.cmdRegister({ session_id: 'far-22222', cwd: repoB }, now);
  C.cmdSend({ _: ['send', 'hello me'], session: 'peer', to: 'me-0' }, now);
  const out = injectContext({ session_id: 'me-000000', cwd: repoA }, now);
  assert.match(out, new RegExp(`You are session ${C.friendlyName('me-000000')}`));
  assert.match(out, new RegExp(`Other sessions in THIS repo:[\\s\\S]*${C.friendlyName('peer-1111')}`));
  assert.match(out, new RegExp(`Elsewhere on this machine:[\\s\\S]*${C.friendlyName('far-22222')}`));
  assert.match(out, new RegExp(`from ${C.friendlyName('peer-1111')}.*hello me`));
  assert.match(out, /Coordination CLI: node ~\/\.claude\/hooks\/coord\.js/); // Claude path
  assert.ok(Date.parse(C.readSession('me-000000').lastSeen) >= now);
  const inbox = path.join(process.env.AIRCONTROL_DIR, 'messages', 'me-000000');
  assert.deepEqual(fs.readdirSync(inbox).every((f) => f.endsWith('.read')), true);
  // second inject: message not delivered again
  const out2 = injectContext({ session_id: 'me-000000', cwd: repoA }, now + 1000);
  assert.doesNotMatch(out2, /hello me/);
});

test('inject with no registration re-registers first (post-sweep survival)', () => {
  freshDataDir();
  const repo = tmpGitRepo('inj-c');
  const out = injectContext({ session_id: 'lazarus-1', cwd: repo }, Date.now());
  assert.match(out, /no other sessions/);
  assert.ok(C.readSession('lazarus-1'));
});

// The roster is for the model, not the operator. Bare stdout on UserPromptSubmit is printed
// to the terminal *as well as* injected, which put a block of coordination state in front of
// the human on every prompt. The envelope injects without echoing.
test('Claude inject uses the quiet JSON envelope, never bare stdout', () => {
  freshDataDir();
  const repo = tmpGitRepo('inj-quiet');
  const now = Date.now();
  C.cmdRegister({ session_id: 'quiet-json', cwd: repo }, now);
  C.cmdRegister({ session_id: 'peer-1111', cwd: repo }, now);
  C.cmdSend({ _: ['send', 'roster noise'], session: 'peer', to: 'quiet' }, now);

  const raw = captureStdout(() => C.cmdInject({ session_id: 'quiet-json', cwd: repo }, now));
  const first = raw.trim().split('\n')[0];
  assert.doesNotMatch(first, /^\[aircontrol\]/, 'roster must not reach the terminal verbatim');
  const output = JSON.parse(raw);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(output.hookSpecificOutput.additionalContext, /roster noise/);
  assert.match(output.hookSpecificOutput.additionalContext, /Coordination CLI: node ~\/\.claude\/hooks\/coord\.js/);
});

test('Codex inject wraps roster context in the required JSON envelope', () => {
  freshDataDir();
  const repo = tmpGitRepo('inj-codex');
  const now = Date.now();
  C.cmdRegister({ session_id: 'codex-json', cwd: repo }, now);
  const raw = captureStdout(() => C.cmdInject({ session_id: 'codex-json', cwd: repo }, now, 'codex'));
  const output = JSON.parse(raw);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(output.hookSpecificOutput.additionalContext, new RegExp(`^\\[aircontrol\\] session ${C.friendlyName('codex-json')}`));
  assert.match(output.hookSpecificOutput.additionalContext, /no other sessions/);
});

// ---------- harness tagging ----------
//
// Codex exposes no session-id env var, so the harness is either declared by the installer
// (`--harness codex` on every Codex hook command) or inferred from the rollout path Codex
// puts in `transcript_path`. Once recorded it sticks: a later flagless register (an old
// hooks.json, a manual CLI call) must not downgrade a Codex session to Claude.

test('detectHarness: explicit flag wins, then the stored harness, then a .codex/sessions transcript_path, then claude', () => {
  const codexTranscript = path.join(os.homedir(), '.codex', 'sessions', '2026', '09', '06', 'rollout-2026-09-06T10-00-00-abc.jsonl');
  assert.equal(C.detectHarness({ transcript_path: codexTranscript }, 'claude', { harness: 'codex' }), 'claude');
  assert.equal(C.detectHarness({}, undefined, { harness: 'codex' }), 'codex');
  assert.equal(C.detectHarness({ transcript_path: codexTranscript }), 'codex');
  assert.equal(C.detectHarness({ transcript_path: '/Users/x/.claude/projects/-a/b.jsonl' }), 'claude');
  assert.equal(C.detectHarness({}), 'claude');
  assert.equal(C.detectHarness({}, 'bogus'), 'claude', 'unknown flag values fall through');
});

test('cliPathFor maps a harness to its installed hook copy', () => {
  assert.equal(C.cliPathFor('codex'), '~/.codex/hooks/coord.js');
  assert.equal(C.cliPathFor('claude'), '~/.claude/hooks/coord.js');
  assert.equal(C.cliPathFor(undefined), '~/.claude/hooks/coord.js');
});

test('register records the harness from the flag, infers codex from transcript_path, and keeps it on re-register', () => {
  freshDataDir();
  const repo = tmpGitRepo('harness-reg');
  const now = Date.now();
  C.cmdRegister({ session_id: 'flag-0001', cwd: repo }, now, 'codex');
  assert.equal(C.readSession('flag-0001').harness, 'codex');
  C.cmdRegister({ session_id: 'flag-0001', cwd: repo }, now + 1000);
  assert.equal(C.readSession('flag-0001').harness, 'codex', 'a later flagless register must not downgrade');
  C.cmdRegister({ session_id: 'infer-001', cwd: repo, transcript_path: '/Users/x/.codex/sessions/2026/09/06/rollout-x.jsonl' }, now);
  assert.equal(C.readSession('infer-001').harness, 'codex');
  C.cmdRegister({ session_id: 'plain-001', cwd: repo }, now);
  assert.equal(C.readSession('plain-001').harness, 'claude');
});

test('who tags non-Claude sessions with [codex] in text and exposes harness in --json', () => {
  freshDataDir();
  const repo = tmpGitRepo('harness-who');
  const now = Date.now();
  C.cmdRegister({ session_id: 'cx-00001', cwd: repo }, now, 'codex');
  C.cmdRegister({ session_id: 'cc-00001', cwd: repo }, now);
  const text = captureStdout(() => C.cmdWho(now));
  assert.match(text, new RegExp(`${C.friendlyName('cx-00001')} \\[codex\\] \\[`));
  assert.doesNotMatch(text, /\[claude\]/, 'Claude is the default and stays untagged');
  const rows = JSON.parse(captureStdout(() => C.cmdWho(now, { json: true })));
  assert.equal(rows.find((r) => r.sessionId === 'cx-00001').harness, 'codex');
  assert.equal(rows.find((r) => r.sessionId === 'cc-00001').harness, 'claude');
});

test('renderInjection tags codex peers on both roster lists', () => {
  const now = Date.now();
  const seen = new Date(now).toISOString();
  const noClaims = { paths: [], resources: [] };
  const self = { sessionId: 'me-0', repo: 'r1', worktree: '/w/r1', branch: 'main', claims: noClaims, recentPaths: [] };
  const same = { sessionId: 'p1-0', repo: 'r1', worktree: '/w/r1', branch: 'main', intent: 'x', harness: 'codex', lastSeen: seen, claims: noClaims, recentPaths: [] };
  const other = { sessionId: 'p2-0', repo: 'r2', worktree: '/w/r2', branch: 'main', intent: 'y', harness: 'codex', lastSeen: seen, claims: noClaims, recentPaths: [] };
  const claude = { sessionId: 'p3-0', repo: 'r2', worktree: '/w/r2', branch: 'main', intent: 'z', harness: 'claude', lastSeen: seen, claims: noClaims, recentPaths: [] };
  const out = C.renderInjection(self, [same, other, claude], [], now);
  assert.match(out, new RegExp(`- ${C.friendlyName('p1-0')} \\[codex\\] \\[main @ r1\\]`));
  assert.match(out, new RegExp(`- ${C.friendlyName('p2-0')} \\[codex\\] in r2`));
  assert.match(out, new RegExp(`- ${C.friendlyName('p3-0')} in r2`));
});

test('nudge: the reply hint names the Codex CLI path for a codex session', () => {
  freshDataDir();
  const repo = tmpGitRepo('nudge-codex');
  const now = Date.now();
  C.cmdRegister({ session_id: 'cx-nudge1', cwd: repo }, now, 'codex');
  C.cmdRegister({ session_id: 'peer-2222', cwd: repo }, now);
  C.cmdSend({ _: ['send', 'ping'], session: 'peer', to: 'cx-n' }, now);
  const out = JSON.parse(captureStdout(() => C.cmdStop({ session_id: 'cx-nudge1' }, now)));
  assert.match(out.reason, /node ~\/\.codex\/hooks\/coord\.js send/);
  assert.doesNotMatch(out.reason, /~\/\.claude\/hooks/);
});

test('hook dispatch honours --harness and keeps inject-codex as an alias', () => {
  const dir = freshDataDir();
  const repo = tmpGitRepo('harness-cli');
  const now = Date.now();
  C.cmdRegister({ session_id: 'cli-peer-0', cwd: repo }, now); // a peer, so the footer renders
  const env = { ...process.env, AIRCONTROL_DIR: dir };
  const run = (args, input) => execFileSync(process.execPath, [path.join(__dirname, 'coord.js'), ...args], { input: JSON.stringify(input), env, encoding: 'utf8' });
  run(['register', '--harness', 'codex'], { session_id: 'cli-cx-01', cwd: repo });
  assert.equal(C.readSession('cli-cx-01').harness, 'codex');
  const alias = JSON.parse(run(['inject-codex'], { session_id: 'cli-cx-02', cwd: repo }));
  assert.match(alias.hookSpecificOutput.additionalContext, /Coordination CLI: node ~\/\.codex\/hooks\/coord\.js/);
  assert.equal(C.readSession('cli-cx-02').harness, 'codex', 'the legacy alias still records the harness');
  const flagged = JSON.parse(run(['inject', '--harness', 'codex'], { session_id: 'cli-cx-03', cwd: repo }));
  assert.match(flagged.hookSpecificOutput.additionalContext, /Coordination CLI: node ~\/\.codex\/hooks\/coord\.js/);
  const plain = JSON.parse(run(['inject'], { session_id: 'cli-cc-04', cwd: repo }));
  assert.match(plain.hookSpecificOutput.additionalContext, /Coordination CLI: node ~\/\.claude\/hooks\/coord\.js/);
});

// ---------- skills bridge ----------
//
// Claude Code reads `.claude/skills`; Codex, Gemini CLI, opencode, Cursor, Kimi and Copilot
// read `.agents/skills`. Both follow symlinks, so one additive relative link per skill gives
// every harness the same catalog without moving anything. Nothing real is ever overwritten.

function tmpSkillsRoot(names = ['alpha', 'beta']) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-')));
  const src = path.join(root, '.claude', 'skills');
  for (const n of names) {
    fs.mkdirSync(path.join(src, n), { recursive: true });
    fs.writeFileSync(path.join(src, n, 'SKILL.md'), `---\nname: ${n}\ndescription: test\n---\n`);
  }
  return { root, src, dst: path.join(root, '.agents', 'skills') };
}

const byName = (plan) => Object.fromEntries(plan.map((r) => [r.name, r.action]));

test('skillLinkPlan: create when absent, ok when linked, conflict on a real dir or foreign symlink, relink on a dangling link into .claude/skills', () => {
  const { root, src, dst } = tmpSkillsRoot(['alpha', 'beta', 'gamma', 'delta', 'epsilon']);
  fs.mkdirSync(dst, { recursive: true });
  fs.symlinkSync(path.join('..', '..', '.claude', 'skills', 'alpha'), path.join(dst, 'alpha'), 'dir'); // already ours
  fs.mkdirSync(path.join(dst, 'beta'));                                                                 // a real directory
  fs.mkdirSync(path.join(root, 'elsewhere'));
  fs.symlinkSync(path.join(root, 'elsewhere'), path.join(dst, 'gamma'), 'dir');                        // someone else's link
  fs.symlinkSync(path.join('..', '..', '.claude', 'skills', 'delta-old'), path.join(dst, 'delta'), 'dir'); // ours, but the source moved
  const plan = C.skillLinkPlan(src, dst);
  assert.deepEqual(byName(plan), { alpha: 'ok', beta: 'conflict', gamma: 'conflict', delta: 'relink', epsilon: 'create' });
  const eps = plan.find((r) => r.name === 'epsilon');
  assert.equal(eps.target, path.join('..', '..', '.claude', 'skills', 'epsilon'), 'targets are relative, so the tree can move');
  assert.equal(eps.link, path.join(dst, 'epsilon'));
  assert.match(plan.find((r) => r.name === 'gamma').detail, /elsewhere/);
});

test('skillLinkPlan skips entries without SKILL.md and dangling sources', () => {
  const { root, src, dst } = tmpSkillsRoot(['alpha']);
  fs.mkdirSync(path.join(src, 'notaskill'));
  fs.writeFileSync(path.join(src, 'README.md'), 'not a skill dir');
  fs.symlinkSync(path.join(root, 'gone'), path.join(src, 'dangling'), 'dir');
  fs.mkdirSync(path.join(root, 'shared-skill'));
  fs.writeFileSync(path.join(root, 'shared-skill', 'SKILL.md'), '---\nname: shared\n---\n');
  fs.symlinkSync(path.join(root, 'shared-skill'), path.join(src, 'shared'), 'dir'); // a source that is itself a link still counts
  assert.deepEqual(byName(C.skillLinkPlan(src, dst)), { alpha: 'create', shared: 'create' });
  assert.deepEqual(C.skillLinkPlan(path.join(root, 'absent'), dst), [], 'no source dir, no plan');
});

test('skillUnlinkPlan removes only symlinks that resolve under the source root', () => {
  const { root, src, dst } = tmpSkillsRoot(['alpha']);
  fs.mkdirSync(dst, { recursive: true });
  fs.symlinkSync(path.join('..', '..', '.claude', 'skills', 'alpha'), path.join(dst, 'alpha'), 'dir');
  fs.mkdirSync(path.join(dst, 'beta'));
  fs.mkdirSync(path.join(root, 'elsewhere'));
  fs.symlinkSync(path.join(root, 'elsewhere'), path.join(dst, 'gamma'), 'dir');
  assert.deepEqual(byName(C.skillUnlinkPlan(src, dst)), { alpha: 'remove', beta: 'keep', gamma: 'keep' });
});

test('skills link --repo creates relative symlinks under .agents/skills and is idempotent', () => {
  freshDataDir();
  const repo = tmpGitRepo('skills-link');
  const src = path.join(repo, '.claude', 'skills');
  for (const n of ['one', 'two']) {
    fs.mkdirSync(path.join(src, n), { recursive: true });
    fs.writeFileSync(path.join(src, n, 'SKILL.md'), '---\nname: x\n---\n');
  }
  const first = JSON.parse(captureStdout(() => C.cmdSkills({ _: ['skills', 'link'], repo, json: true })));
  assert.deepEqual(byName(first.plans[0].rows), { one: 'create', two: 'create' });
  const link = path.join(repo, '.agents', 'skills', 'one');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readlinkSync(link), path.join('..', '..', '.claude', 'skills', 'one'));
  assert.ok(fs.existsSync(path.join(link, 'SKILL.md')), 'the link resolves to the skill');
  const second = JSON.parse(captureStdout(() => C.cmdSkills({ _: ['skills', 'link'], repo, json: true })));
  assert.deepEqual(byName(second.plans[0].rows), { one: 'ok', two: 'ok' });
  const text = captureStdout(() => C.cmdSkills({ _: ['skills', 'status'], repo }));
  assert.match(text, /\.agents\/skills.*2 ok/);
});

test('skills --dry-run and status write nothing', () => {
  freshDataDir();
  const repo = tmpGitRepo('skills-dry');
  fs.mkdirSync(path.join(repo, '.claude', 'skills', 'one'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'skills', 'one', 'SKILL.md'), '---\nname: x\n---\n');
  const dry = JSON.parse(captureStdout(() => C.cmdSkills({ _: ['skills', 'link'], repo, 'dry-run': true, json: true })));
  assert.deepEqual(byName(dry.plans[0].rows), { one: 'create' });
  assert.ok(!fs.existsSync(path.join(repo, '.agents')), 'dry-run must not touch the tree');
  captureStdout(() => C.cmdSkills({ _: ['skills', 'status'], repo }));
  assert.ok(!fs.existsSync(path.join(repo, '.agents')), 'status must not touch the tree');
});

test('skills status --global --json lists ~/.codex/skills duplicates of ~/.claude/skills', () => {
  freshDataDir();
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-home-')));
  for (const [dir, names] of [['.claude', ['a', 'b']], ['.codex', ['b', 'c']]]) {
    for (const n of names) {
      fs.mkdirSync(path.join(home, dir, 'skills', n), { recursive: true });
      fs.writeFileSync(path.join(home, dir, 'skills', n, 'SKILL.md'), '---\nname: x\n---\n');
    }
  }
  const out = JSON.parse(captureStdout(() => C.cmdSkills({ _: ['skills', 'status'], global: true, json: true }, { home })));
  assert.equal(out.plans[0].dir, path.join(home, '.agents', 'skills'));
  assert.deepEqual(byName(out.plans[0].rows), { a: 'create', b: 'create' });
  assert.deepEqual(out.legacyDuplicates, ['b']);
});

test('skills unlink --global removes only aircontrol links and grok is an opt-in target', () => {
  freshDataDir();
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-home-')));
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'a'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'a', 'SKILL.md'), '---\nname: a\n---\n');
  fs.mkdirSync(path.join(home, '.agents', 'skills', 'mine'), { recursive: true }); // a real dir, not ours
  captureStdout(() => C.cmdSkills({ _: ['skills', 'link'], global: true, targets: 'agents,grok' }, { home }));
  assert.ok(fs.lstatSync(path.join(home, '.agents', 'skills', 'a')).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(home, '.grok', 'skills', 'a')).isSymbolicLink());
  captureStdout(() => C.cmdSkills({ _: ['skills', 'unlink'], global: true, targets: 'agents,grok' }, { home }));
  assert.ok(!fs.existsSync(path.join(home, '.agents', 'skills', 'a')));
  assert.ok(!fs.existsSync(path.join(home, '.grok', 'skills', 'a')));
  assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', 'mine')), 'a real directory survives unlink');
});

test('skills rejects an unknown --targets value', () => {
  freshDataDir();
  const repo = tmpGitRepo('skills-bad');
  assert.throws(() => C.cmdSkills({ _: ['skills', 'link'], repo, targets: 'agents,cursor' }), /unknown skills target "cursor"/);
});

test('register auto-links <repo>/.claude/skills into .agents/skills, quietly', () => {
  freshDataDir();
  const repo = tmpGitRepo('skills-auto');
  fs.mkdirSync(path.join(repo, '.claude', 'skills', 'auto'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'skills', 'auto', 'SKILL.md'), '---\nname: auto\n---\n');
  const out = captureStdout(() => C.cmdRegister({ session_id: 'auto-0001', cwd: path.join(repo) }, Date.now()));
  assert.equal(out, '', 'a hook must stay silent');
  assert.ok(fs.lstatSync(path.join(repo, '.agents', 'skills', 'auto')).isSymbolicLink());
});

test('register skips auto-link outside a git repo, without .claude/skills, or when config skills.autoLink is false', () => {
  freshDataDir();
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-nogit-')));
  fs.mkdirSync(path.join(plain, '.claude', 'skills', 's'), { recursive: true });
  fs.writeFileSync(path.join(plain, '.claude', 'skills', 's', 'SKILL.md'), '---\nname: s\n---\n');
  C.cmdRegister({ session_id: 'nogit-001', cwd: plain }, Date.now());
  assert.ok(!fs.existsSync(path.join(plain, '.agents')), 'not a git repo: leave it alone');

  const bare = tmpGitRepo('skills-none');
  C.cmdRegister({ session_id: 'noskl-001', cwd: bare }, Date.now());
  assert.ok(!fs.existsSync(path.join(bare, '.agents')), 'no .claude/skills: nothing to link');

  const off = tmpGitRepo('skills-off');
  fs.mkdirSync(path.join(off, '.claude', 'skills', 's'), { recursive: true });
  fs.writeFileSync(path.join(off, '.claude', 'skills', 's', 'SKILL.md'), '---\nname: s\n---\n');
  fs.writeFileSync(C.configFile(), JSON.stringify({ skills: { autoLink: false } }));
  C.cmdRegister({ session_id: 'off-00001', cwd: off }, Date.now());
  assert.ok(!fs.existsSync(path.join(off, '.agents')), 'opted out in config.json');
});

// ---------- nudge (Stop hook push delivery) ----------

test('nudge: blocks with pending messages, marks them read, then lets the turn end', () => {
  freshDataDir();
  const repo = tmpGitRepo('nudge-a');
  const now = Date.now();
  C.cmdRegister({ session_id: 'me-000000', cwd: repo }, now);
  C.cmdRegister({ session_id: 'peer-1111', cwd: repo }, now);
  C.cmdSend({ _: ['send', 'ship it'], session: 'peer', to: 'me-0' }, now);

  const out = JSON.parse(captureStdout(() => C.cmdStop({ session_id: 'me-000000' }, now)));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /^\[aircontrol\] Messages for you:/);
  assert.match(out.reason, new RegExp(`from ${C.friendlyName('peer-1111')}.*ship it`));
  assert.match(out.reason, new RegExp(`--session ${C.friendlyName('me-000000')}`));

  const inbox = path.join(process.env.AIRCONTROL_DIR, 'messages', 'me-000000');
  assert.ok(fs.readdirSync(inbox).every((f) => f.endsWith('.read')));

  // The loop bound: delivered messages are read, so the next Stop says nothing and
  // the turn ends. This holds independent of the harness's 8-block cap.
  assert.equal(captureStdout(() => C.cmdStop({ session_id: 'me-000000' }, now + 1000)), '');
});

// ---------- next-steps offer (the other half of the Stop hook) ----------

function beat(id, repo, at, name) {
  C.cmdBeat({ session_id: id, tool_input: { file_path: path.join(repo, name || 'f.txt') } }, at);
}

test('next-steps: offers once after work, and not again until there is more', () => {
  freshDataDir();
  const repo = tmpGitRepo('ns-a');
  const now = Date.now();
  C.cmdRegister({ session_id: 'me-000000', cwd: repo }, now);

  // `idle` rather than nothing: cmdStop asks whether this session's own work
  // is still running, and left to look at the real machine these two measure
  // whoever happens to have a background shell alive while the suite runs.
  const idle = { procs: [] };
  beat('me-000000', repo, now + 1000);
  const out = JSON.parse(captureStdout(() => C.cmdStop({ session_id: 'me-000000' }, now + 2000, undefined, idle)));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /next-steps/);
  assert.match(out.reason, /Do not invoke it yourself/);

  // The loop bound. The continuation this blocks for must find nothing to say,
  // or the turn never ends.
  assert.equal(captureStdout(() => C.cmdStop({ session_id: 'me-000000' }, now + 3000, undefined, idle)), '');

  // More work re-arms it: a long session doing several things gets offered again.
  beat('me-000000', repo, now + 4000, 'g.txt');
  assert.match(captureStdout(() => C.cmdStop({ session_id: 'me-000000' }, now + 5000, undefined, idle)), /next-steps/);
});

test('next-steps: silent after pure conversation', () => {
  freshDataDir();
  const repo = tmpGitRepo('ns-b');
  const now = Date.now();
  C.cmdRegister({ session_id: 'me-000000', cwd: repo }, now);
  // No beat: nothing was edited, so there is no work to plan the sequel to.
  assert.equal(captureStdout(() => C.cmdStop({ session_id: 'me-000000' }, now + 1000)), '');
});

test('next-steps: messages win, and the offer keeps until the next quiet turn', () => {
  freshDataDir();
  const repo = tmpGitRepo('ns-c');
  const now = Date.now();
  C.cmdRegister({ session_id: 'me-000000', cwd: repo }, now);
  C.cmdRegister({ session_id: 'peer-1111', cwd: repo }, now);
  beat('me-000000', repo, now + 1000);
  C.cmdSend({ _: ['send', 'ship it'], session: 'peer', to: 'me-0' }, now);

  // An answer owed to another session comes before planning the next thing.
  const idle = { procs: [] };
  const first = JSON.parse(captureStdout(() => C.cmdStop({ session_id: 'me-000000' }, now + 2000, undefined, idle)));
  assert.match(first.reason, /Messages for you:/);
  assert.doesNotMatch(first.reason, /next-steps/);

  // Not lost, only deferred: the inbox is empty now and the work flag still stands.
  assert.match(captureStdout(() => C.cmdStop({ session_id: 'me-000000' }, now + 3000, undefined, idle)), /next-steps/);
});

test('next-steps: holds the offer while this session still has work running', () => {
  freshDataDir();
  const repo = tmpGitRepo('ns-busy');
  const now = Date.now();
  C.cmdRegister({ session_id: 'me-000000', cwd: repo }, now);
  beat('me-000000', repo, now + 1000);

  // A suite started with run_in_background is still going. The offer's one
  // claim is "nothing else is pending", and that is not true yet.
  const busy = { procs: tasksProcs(), claudePid: 63366, ancestors: new Set([88888]) };
  assert.equal(
    captureStdout(() => C.cmdStop({ session_id: 'me-000000' }, now + 2000, undefined, busy)), '');

  // Deferred, not lost: the work flag still stands, so the next quiet turn
  // offers. Same deferral the inbox gets.
  const quiet = { procs: C.parseProcTable('63366 58658 /opt/homebrew/bin/claude'), claudePid: 63366 };
  assert.match(
    captureStdout(() => C.cmdStop({ session_id: 'me-000000' }, now + 3000, undefined, quiet)),
    /next-steps/);
});

test("next-steps: another session's shells and orphans do not hold the offer", () => {
  freshDataDir();
  const repo = tmpGitRepo('ns-theirs');
  const now = Date.now();
  C.cmdRegister({ session_id: 'me-000000', cwd: repo }, now);
  beat('me-000000', repo, now + 1000);

  // This session's claude has no shell of its own. 77001 hangs off the other
  // claude and 99999 is an orphan: neither is work this session is waiting on,
  // and letting either mute the offer would mean a busy machine never gets one.
  const SNAPSHOT = '/bin/zsh -c source /Users/a/.claude/shell-snapshots/snapshot-zsh-1788.sh && eval';
  const theirs = {
    procs: C.parseProcTable([
      '63366 58658 /opt/homebrew/bin/claude',            // mine, and idle
      '77777 77000 /opt/homebrew/bin/claude',            // theirs
      `77001 77777 ${SNAPSHOT} 'their suite'`,
      `99999 1 ${SNAPSHOT} 'orphan from a dead session'`,
    ].join('\n')),
    claudePid: 63366,
  };
  assert.match(
    captureStdout(() => C.cmdStop({ session_id: 'me-000000' }, now + 2000, undefined, theirs)),
    /next-steps/);
});

test('ownTasksRunning: an unreadable process table is quiet, not silent forever', () => {
  // The offer disappearing for a whole session is harder to notice than one
  // that arrives a turn early, so every failure here reads as "not busy".
  assert.equal(C.ownTasksRunning({ run: () => { throw new Error('ps: no'); } }), false);
  assert.equal(C.ownTasksRunning({ procs: tasksProcs(), claudePid: null }), false,
               'no claude ancestor: nothing can be attributed, so nothing is held');
});

test('next-steps: silent inside its own continuation and for an unknown session', () => {
  freshDataDir();
  const repo = tmpGitRepo('ns-d');
  const now = Date.now();
  C.cmdRegister({ session_id: 'me-000000', cwd: repo }, now);
  beat('me-000000', repo, now + 1000);
  assert.equal(captureStdout(() => C.cmdStop({ session_id: 'me-000000', stop_hook_active: true }, now + 2000)), '');
  assert.equal(captureStdout(() => C.cmdStop({ session_id: 'nobody-0000' }, now + 2000)), '');
});

test('nudge: silent with an empty inbox, an unknown session, or inside its own continuation', () => {
  freshDataDir();
  const repo = tmpGitRepo('nudge-b');
  const now = Date.now();
  C.cmdRegister({ session_id: 'me-000000', cwd: repo }, now);
  C.cmdRegister({ session_id: 'peer-1111', cwd: repo }, now);
  assert.equal(captureStdout(() => C.cmdStop({ session_id: 'me-000000' }, now)), '');
  assert.equal(captureStdout(() => C.cmdStop({ session_id: 'ghost-999' }, now)), '');

  // stop_hook_active means we already blocked once and are inside the continuation.
  C.cmdSend({ _: ['send', 'later'], session: 'peer', to: 'me-0' }, now);
  assert.equal(captureStdout(() => C.cmdStop({ session_id: 'me-000000', stop_hook_active: true }, now)), '');
  // ...and the message is untouched, so the next prompt still delivers it.
  const out = injectContext({ session_id: 'me-000000', cwd: repo }, now + 1000);
  assert.match(out, /later/);
});

test('nudge: a Stop delivery is not repeated by the next prompt injection', () => {
  freshDataDir();
  const repo = tmpGitRepo('nudge-c');
  const now = Date.now();
  C.cmdRegister({ session_id: 'me-000000', cwd: repo }, now);
  C.cmdRegister({ session_id: 'peer-1111', cwd: repo }, now);
  C.cmdSend({ _: ['send', 'only once'], session: 'peer', to: 'me-0' }, now);
  assert.match(captureStdout(() => C.cmdStop({ session_id: 'me-000000' }, now)), /only once/);
  const out = injectContext({ session_id: 'me-000000', cwd: repo }, now + 1000);
  assert.doesNotMatch(out, /only once/);
});

test('nudge and inject render an identical message line', () => {
  freshDataDir();
  const repo = tmpGitRepo('nudge-d');
  const now = Date.now();
  C.cmdRegister({ session_id: 'me-000000', cwd: repo }, now);
  C.cmdRegister({ session_id: 'peer-1111', cwd: repo }, now);

  // Same text down each delivery path: the prompt block and the Stop nudge must
  // render the sender, age and body identically, or a reader could tell which hook
  // woke them and the two paths would drift.
  C.cmdSend({ _: ['send', 'same shape'], session: 'peer', to: 'me-0' }, now);
  const injected = injectContext({ session_id: 'me-000000', cwd: repo }, now);
  C.cmdSend({ _: ['send', 'same shape'], session: 'peer', to: 'me-0' }, now);
  const nudged = JSON.parse(captureStdout(() => C.cmdStop({ session_id: 'me-000000' }, now))).reason;

  const line = (text) => text.split('\n').find((l) => l.includes('same shape'));
  assert.ok(line(injected));
  assert.equal(line(nudged), line(injected));
});


// ---------- guard (PreToolUse hard block) ----------

function guardOut(input, now) {
  return captureStdout(() => C.cmdGuard(input, now));
}

function denyReason(out) {
  assert.notEqual(out.trim(), '', 'expected a deny, got silence');
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  return parsed.hookSpecificOutput.permissionDecisionReason;
}

test('guard denies an edit on a path another live session claims, and records it', () => {
  freshDataDir();
  const repo = tmpGitRepo('guard-a');
  const now = Date.now();
  C.cmdRegister({ session_id: 'aaaa-1', cwd: repo }, now);
  C.cmdRegister({ session_id: 'bbbb-1', cwd: repo }, now);
  captureStdout(() => C.cmdClaim({ session: 'bbbb', intent: 'store rework', paths: 'Store' }, now));
  const out = guardOut({ session_id: 'aaaa-1', tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'Store', 'Manager.swift') } }, now);
  const reason = denyReason(out);
  assert.match(reason, new RegExp(C.friendlyName('bbbb-1')));
  assert.match(reason, /Store/);
  assert.deepEqual(C.readSession('aaaa-1').blockedAttempts.map((b) => b.target), ['Store/Manager.swift']);
  const log = fs.readFileSync(path.join(process.env.AIRCONTROL_DIR, 'guard.log'), 'utf8').trim().split('\n');
  assert.equal(log.length, 1);
  assert.equal(JSON.parse(log[0]).sessionId, 'aaaa-1');
});

test('guard logs an internal error instead of failing silently', () => {
  freshDataDir();
  const repo = tmpGitRepo('guard-throw');
  const now = Date.now();
  C.cmdRegister({ session_id: 'aaaa-1', cwd: repo }, now);
  // Corrupt the session record so computeGuardDecision throws inside the path
  // check (path.relative requires a string worktree) — this must still exit
  // silently (hooks may never crash), but the failure has to leave a trace.
  const s = C.readSession('aaaa-1');
  delete s.worktree;
  C.writeSession(s);
  const out = guardOut({ session_id: 'aaaa-1', tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'X.swift') } }, now);
  assert.equal(out, ''); // still silent on stdout: never blocks the hook
  const log = fs.readFileSync(C.guardLogFile(), 'utf8').trim().split('\n');
  assert.equal(log.length, 1);
  const entry = JSON.parse(log[0]);
  assert.equal(entry.sessionId, 'aaaa-1');
  assert.ok(entry.err, 'expected the caught error message to be recorded');
});

test('guard stays silent for unclaimed paths, own claims, other repos, and stale claimants', () => {
  freshDataDir();
  const repoA = tmpGitRepo('guard-b1');
  const repoB = tmpGitRepo('guard-b2');
  const now = Date.now();
  C.cmdRegister({ session_id: 'aaaa-1', cwd: repoA }, now);
  C.cmdRegister({ session_id: 'bbbb-1', cwd: repoA }, now);
  C.cmdRegister({ session_id: 'cccc-1', cwd: repoB }, now);
  captureStdout(() => C.cmdClaim({ session: 'aaaa', paths: 'Mine' }, now));
  captureStdout(() => C.cmdClaim({ session: 'cccc', paths: 'Store' }, now));
  captureStdout(() => C.cmdClaim({ session: 'bbbb', paths: 'Theirs' }, now));
  assert.equal(guardOut({ session_id: 'aaaa-1', tool_name: 'Edit', tool_input: { file_path: path.join(repoA, 'Unclaimed.swift') } }, now), '');
  assert.equal(guardOut({ session_id: 'aaaa-1', tool_name: 'Write', tool_input: { file_path: path.join(repoA, 'Mine', 'File.swift') } }, now), '');
  assert.equal(guardOut({ session_id: 'aaaa-1', tool_name: 'Edit', tool_input: { file_path: path.join(repoA, 'Store', 'X.swift') } }, now), '');
  // A claimant quiet for 31 minutes is off the roster but NOT off its claim: going
  // quiet is not evidence of death, and unlocking the path here would let two live
  // sessions edit it. Enforcement holds until CLAIM_TTL_MS.
  const theirs = { session_id: 'aaaa-1', tool_name: 'Edit', tool_input: { file_path: path.join(repoA, 'Theirs', 'Y.swift') } };
  assert.match(denyReason(guardOut(theirs, now + 31 * 60 * 1000)), /Theirs/);
  assert.match(denyReason(guardOut(theirs, now + 31 * 60 * 1000)), /last seen 31m ago/);
  assert.equal(guardOut(theirs, now + C.CLAIM_TTL_MS), '');
});

test('a claim outlives roster staleness; an unclaimed session is still swept at 30 min', () => {
  freshDataDir();
  const repo = tmpGitRepo('claim-ttl');
  const now = Date.now();
  C.cmdRegister({ session_id: 'holder-01', cwd: repo }, now);
  C.cmdRegister({ session_id: 'quiet-001', cwd: repo }, now);
  captureStdout(() => C.cmdClaim({ session: 'holder', intent: 'long build', paths: 'Sources' }, now));

  const quietly = now + 31 * 60 * 1000;
  assert.equal(C.isStale(C.readSession('holder-01'), quietly), true, 'quiet by roster standards');
  assert.equal(C.isExpired(C.readSession('holder-01'), quietly), false, 'but its claim still stands');
  assert.equal(C.isExpired(C.readSession('quiet-001'), quietly), true, 'holding nothing, it is gone');

  // The sweep must agree with the guard, or it deletes the session out from under a
  // claim the guard is still enforcing — the holder would lose its claim silently.
  C.sweep(quietly);
  assert.ok(C.readSession('holder-01'), 'claim holder survives the sweep');
  assert.equal(C.readSession('quiet-001'), undefined, 'unclaimed session is reaped on the old schedule');

  // ...and the roster shows the survivor, so a denial never names an invisible session.
  const roster = captureStdout(() => C.cmdWho(quietly));
  assert.match(roster, new RegExp(C.friendlyName('holder-01')));

  // Past CLAIM_TTL_MS the backstop finally fires.
  C.sweep(now + C.CLAIM_TTL_MS);
  assert.equal(C.readSession('holder-01'), undefined);
});

test('guard blocks a simulator boot without a lease, allows the leaseholder, names a thief\'s victim', () => {
  freshDataDir();
  const repo = tmpGitRepo('guard-c');
  const now = Date.now();
  C.cmdRegister({ session_id: 'aaaa-1', cwd: repo }, now);
  C.cmdRegister({ session_id: 'bbbb-1', cwd: repo }, now);
  const boot = { tool_name: 'Bash', tool_input: { command: 'xcrun simctl boot 12AB-34CD' } };
  assert.match(denyReason(guardOut({ session_id: 'aaaa-1', ...boot }, now)), /sim acquire/);
  assert.ok(C.tryLease({ platform: 'ios', key: '12AB-34CD', sessionId: 'aaaa-1', lastSeen: new Date(now).toISOString() }));
  assert.equal(guardOut({ session_id: 'aaaa-1', ...boot }, now), '');
  assert.match(denyReason(guardOut({ session_id: 'bbbb-1', ...boot }, now)), new RegExp(C.friendlyName('aaaa-1')));
  // android spelling too
  const emu = { tool_name: 'Bash', tool_input: { command: 'emulator -avd Pixel_8 -no-window' } };
  assert.match(denyReason(guardOut({ session_id: 'aaaa-1', ...emu }, now)), /sim acquire/);
});

test('guard gates mutating git stash on the repo-scoped stash claim', () => {
  freshDataDir();
  const repo = tmpGitRepo('guard-d');
  const now = Date.now();
  C.cmdRegister({ session_id: 'aaaa-1', cwd: repo }, now);
  C.cmdRegister({ session_id: 'bbbb-1', cwd: repo }, now);
  const stash = (cmd) => ({ tool_name: 'Bash', tool_input: { command: cmd } });
  assert.equal(guardOut({ session_id: 'aaaa-1', ...stash('git stash list') }, now), ''); // read-only: fine
  assert.match(denyReason(guardOut({ session_id: 'aaaa-1', ...stash('git stash pop') }, now)), /stash/);
  captureStdout(() => C.cmdClaim({ session: 'aaaa', resources: 'stash' }, now));
  assert.equal(guardOut({ session_id: 'aaaa-1', ...stash('git stash pop') }, now), '');
  captureStdout(() => C.cmdClaim({ session: 'bbbb', resources: 'stash' }, now));
  assert.match(denyReason(guardOut({ session_id: 'aaaa-1', ...stash('git stash drop') }, now)), new RegExp(C.friendlyName('bbbb-1')));
});

test('guard gates deploy-shaped commands on the deploy claim, with config-taught patterns', () => {
  freshDataDir();
  const repo = tmpGitRepo('guard-e');
  const now = Date.now();
  C.cmdRegister({ session_id: 'aaaa-1', cwd: repo }, now);
  const bash = (cmd) => ({ session_id: 'aaaa-1', tool_name: 'Bash', tool_input: { command: cmd } });
  assert.match(denyReason(guardOut(bash('firebase deploy --only hosting'), now)), /deploy/);
  assert.equal(guardOut(bash('make ship'), now), ''); // unknown shape passes
  fs.writeFileSync(C.configFile(), JSON.stringify({ guardPatterns: { deploy: ['\\bmake\\s+ship\\b'] } }));
  assert.match(denyReason(guardOut(bash('make ship'), now)), /deploy/); // taught per install
  captureStdout(() => C.cmdClaim({ session: 'aaaa', resources: 'deploy' }, now));
  assert.equal(guardOut(bash('firebase deploy --only hosting'), now), '');
  assert.equal(guardOut(bash('make ship'), now), '');
});

test('deploy claims are scoped: different targets do not contend, bare deploy still covers all', () => {
  freshDataDir();
  const repo = tmpGitRepo('guard-scope');
  const now = Date.now();
  C.cmdRegister({ session_id: 'aaaa-1', cwd: repo }, now);
  const bash = (cmd) => ({ session_id: 'aaaa-1', tool_name: 'Bash', tool_input: { command: cmd } });

  captureStdout(() => C.cmdClaim({ session: 'aaaa', resources: 'deploy:asc' }, now));
  assert.equal(guardOut(bash('bundle exec fastlane pilot upload'), now), '');
  // the claim is for App Store Connect, so a Firebase deploy is still ungated
  assert.match(denyReason(guardOut(bash('firebase deploy --only hosting'), now)), /deploy:firebase/);
  // an unscoped lane passes on any deploy claim: the alternative is telling a
  // session to claim bare `deploy`, which puts it back in everyone's way
  assert.equal(guardOut(bash('npm run deploy'), now), '');

  // a second session deploying elsewhere is not contention
  const repoB = tmpGitRepo('guard-scope-b');
  C.cmdRegister({ session_id: 'bbbb-1', cwd: repoB }, now);
  captureStdout(() => C.cmdClaim({ session: 'bbbb', resources: 'deploy:firebase' }, now));
  assert.equal(guardOut(bash('bundle exec fastlane pilot upload'), now), '');
  // ...but an unscoped lane could be theirs, so it contends with every claim
  assert.match(denyReason(guardOut(bash('npm run deploy'), now)), new RegExp(C.friendlyName('bbbb-1')));

  // ...but a session still holding the undivided claim blocks everything
  captureStdout(() => C.cmdClaim({ session: 'bbbb', resources: 'deploy' }, now));
  assert.match(denyReason(guardOut(bash('bundle exec fastlane pilot upload'), now)), new RegExp(C.friendlyName('bbbb-1')));
});

test('deploy scopes: claim matching, target overlap, and per-command classification', () => {
  assert.deepEqual([...C.deployScopes(['deploy:asc', 'stash'])], ['asc']);
  assert.deepEqual([...C.deployScopes(['deploy'])], ['*']);
  assert.deepEqual([...C.deployScopes(['deploy:'])], []);
  assert.equal(C.deployScopesOverlap(C.deployScopes(['deploy:asc']), C.deployScopes(['deploy:firebase'])), false);
  assert.equal(C.deployScopesOverlap(C.deployScopes(['deploy:asc']), C.deployScopes(['deploy'])), true);
  assert.equal(C.deployScopesOverlap(C.deployScopes([]), C.deployScopes(['deploy'])), false);

  assert.deepEqual(C.commandDeployScopes('firebase deploy --only hosting'), ['firebase']);
  assert.deepEqual(C.commandDeployScopes('wrangler deploy'), ['cloudflare']);
  assert.deepEqual(C.commandDeployScopes('bundle exec fastlane deliver'), ['asc']);
  assert.deepEqual(C.commandDeployScopes('bundle exec fastlane supply'), ['play']);
  // the specific fastlane rule wins over the catch-all rather than both firing
  assert.deepEqual(C.commandDeployScopes('fastlane upload_to_app_store'), ['asc']);
  // a lane whose target is only knowable from its config stays machine-wide
  assert.deepEqual(C.commandDeployScopes('bundle exec fastlane beta'), [null]);
  assert.deepEqual(C.commandDeployScopes('npm run deploy'), [null]);
  // a chain naming two systems gates on both
  assert.deepEqual(C.commandDeployScopes('firebase deploy && fastlane deliver'), ['firebase', 'asc']);
  assert.deepEqual(C.classifyCommand('firebase deploy').map((m) => m.key), ['firebase']);
});

test('config-taught deploy patterns may name the target they ship to', () => {
  freshDataDir();
  const repo = tmpGitRepo('guard-taught');
  const now = Date.now();
  C.cmdRegister({ session_id: 'aaaa-1', cwd: repo }, now);
  const bash = (cmd) => ({ session_id: 'aaaa-1', tool_name: 'Bash', tool_input: { command: cmd } });
  fs.writeFileSync(C.configFile(), JSON.stringify({
    guardPatterns: { deploy: ['\\bmake\\s+ship\\b', { pattern: '\\bmake\\s+publish\\b', scope: 'firebase' }] },
  }));
  assert.deepEqual(C.commandDeployScopes('make ship'), [null]);
  assert.deepEqual(C.commandDeployScopes('make publish'), ['firebase']);
  captureStdout(() => C.cmdClaim({ session: 'aaaa', resources: 'deploy:firebase' }, now));
  assert.equal(guardOut(bash('make publish'), now), '');
  assert.equal(guardOut(bash('make ship'), now), '');
});

test('advisories: deploy targets contend only when they overlap', () => {
  const self = { sessionId: 'a-1', repo: '/r/one/.git', claims: { resources: ['deploy:asc'] } };
  const same = { sessionId: 'b-1', repo: '/r/two/.git', intent: 'ship ios', claims: { resources: ['deploy:asc'] } };
  const other = { sessionId: 'c-1', repo: '/r/two/.git', intent: 'ship web', claims: { resources: ['deploy:firebase'] } };
  const undivided = { sessionId: 'd-1', repo: '/r/two/.git', intent: 'ship something', claims: { resources: ['deploy'] } };
  assert.equal(C.advisories(self, [same]).length, 1);
  assert.equal(C.advisories(self, [other]).length, 0);
  assert.equal(C.advisories(self, [undivided]).length, 1);
  assert.match(C.advisories(self, [same])[0], /Resource "deploy:asc" is also claimed/);
});

test('guard ignores prose that mentions simctl boot without a device-shaped token', () => {
  freshDataDir();
  const now = Date.now();
  const bash = (cmd) => ({ session_id: 'aaaa-1', tool_name: 'Bash', tool_input: { command: cmd } });
  // found in the wild: guard denied its own author's echo of this very sentence
  assert.equal(guardOut(bash('echo "--- simctl boot without lease (expect deny):"'), now), '');
  assert.equal(guardOut(bash('grep "simctl boot" README.md'), now), '');
  // a real UDID-shaped target still triggers
  assert.match(denyReason(guardOut(bash('xcrun simctl boot 99999999-AAAA-BBBB-CCCC-DDDDEEEEFFFF'), now)), /sim acquire/);
  assert.match(denyReason(guardOut(bash('xcrun simctl bootstatus 0AF3C1D2'), now)), /sim acquire/);
});

test('guard ignores prose for every classifier, not just simctl', () => {
  // The UDID rule above fixed one pattern; deploy, stash and avd kept denying prose. Each of
  // these was denied in the wild, three of them while writing this fix: a heredoc whose code
  // comment named a lane verb, the ledger entry describing that denial, and the source comment
  // documenting the rule. The guard was obstructing work on itself.
  freshDataDir();
  const repo = tmpGitRepo('guard-prose');
  const now = Date.now();
  C.cmdRegister({ session_id: 'aaaa-1', cwd: repo }, now);
  const bash = (cmd) => ({ session_id: 'aaaa-1', tool_name: 'Bash', tool_input: { command: cmd } });

  assert.equal(guardOut(bash('git commit -m "docs: explain npm run deploy"'), now), '');
  assert.equal(guardOut(bash('grep -rn "firebase deploy" README.md'), now), '');
  assert.equal(guardOut(bash('node coord.js ledger add --title "eas submit needs a claim"'), now), '');
  assert.equal(guardOut(bash('echo "the git stash guard needs work"'), now), '');
  assert.equal(guardOut(bash('echo "run emulator -avd Pixel_7 to repro"'), now), '');
  // a heredoc body is input to whatever reads it, not a command the shell runs
  assert.equal(guardOut(bash("python3 - <<'PY'\n# mirrors fastlane deliver's own layout\nprint(1)\nPY"), now), '');
  // prose may quote a real device id and still be prose
  assert.equal(guardOut(bash('echo "simctl boot 99999999-AAAA-BBBB-CCCC-DDDDEEEEFFFF needs a lease"'), now), '');

  // ...and the real invocations still deny, including the shapes stripping could have broken:
  // a quoted single-token target, an env prefix with a wrapper, and sh -c where the quoted
  // string IS the command.
  assert.match(denyReason(guardOut(bash('xcrun simctl boot "0AF3C1D2-1111-2222-3333-444455556666"'), now)), /sim acquire/);
  assert.match(denyReason(guardOut(bash('HOME=$FAKE bundle exec fastlane deliver'), now)), /deploy/);
  assert.match(denyReason(guardOut(bash('bash -c "firebase deploy"'), now)), /deploy/);
  assert.match(denyReason(guardOut(bash('git -C /repo stash drop'), now)), /stash/);
});

test('guard never throws and stays silent on malformed input', () => {
  freshDataDir();
  const now = Date.now();
  assert.equal(guardOut({}, now), '');
  assert.equal(guardOut({ session_id: 'nobody-1', tool_name: 'Edit', tool_input: {} }, now), '');
  assert.equal(guardOut({ session_id: 'nobody-1', tool_name: 'Bash', tool_input: { command: 12345 } }, now), '');
  assert.equal(guardOut({ session_id: 'nobody-1', tool_name: 'Bash', tool_input: { command: 'xcrun simctl list' } }, now), '');
});

test('claim sets intent, appends claims; release clears', () => {
  freshDataDir();
  const repo = tmpGitRepo('cli-a');
  const now = Date.now();
  C.cmdRegister({ session_id: 'work-0001', cwd: repo }, now);
  C.cmdClaim({ _: ['claim'], session: 'work', intent: 'tab fix', paths: 'CardStock/App', resources: 'sim:X' }, now);
  let s = C.readSession('work-0001');
  assert.equal(s.intent, 'tab fix');
  assert.deepEqual(s.claims, { paths: ['CardStock/App'], resources: ['sim:X'] });
  C.cmdClaim({ _: ['claim'], session: 'work', paths: 'CardStock/App,worker/src' }, now);
  s = C.readSession('work-0001');
  assert.deepEqual(s.claims.paths, ['CardStock/App', 'worker/src']); // deduped append
  C.cmdRelease({ _: ['release'], session: 'work', paths: 'worker/src' }, now);
  assert.deepEqual(C.readSession('work-0001').claims.paths, ['CardStock/App']);
  C.cmdRelease({ _: ['release'], session: 'work' }, now);
  s = C.readSession('work-0001');
  assert.equal(s.intent, 'unassigned');
  assert.deepEqual(s.claims, { paths: [], resources: [] });
});

test('assignable means unclaimed, not "not currently working"', () => {
  freshDataDir();
  const repo = tmpGitRepo('assignable');
  const now = Date.now();
  C.cmdRegister({ session_id: 'busy-0001', cwd: repo }, now);
  // A session can be mid-turn — editing files, so plainly working — and still be
  // assignable, because it never declared intent or claimed anything. This is the
  // trap: it is NOT the same as Claude Code's "idle" (finished its turn).
  C.cmdBeat({ session_id: 'busy-0001', tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'a.js') } }, now);
  assert.ok(C.readSession('busy-0001').recentPaths.length, 'session is demonstrably working');
  assert.equal(C.isAssignable(C.readSession('busy-0001')), true);

  // Declaring intent is what makes it unassignable — claims are not required.
  captureStdout(() => C.cmdClaim({ session: 'busy', intent: 'refactoring the parser' }, now));
  assert.equal(C.isAssignable(C.readSession('busy-0001')), false);

  // A bare release hands it back to the pool without pretending it stopped working.
  captureStdout(() => C.cmdRelease({ _: ['release'], session: 'busy' }, now));
  assert.equal(C.readSession('busy-0001').intent, 'unassigned');
  assert.equal(C.isAssignable(C.readSession('busy-0001')), true);
});

test('send: broadcast reaches all live sessions except sender; prefix must be unambiguous', () => {
  freshDataDir();
  const repo = tmpGitRepo('cli-b');
  const now = Date.now();
  C.cmdRegister({ session_id: 'aaaa-1', cwd: repo }, now);
  C.cmdRegister({ session_id: 'bbbb-1', cwd: repo }, now);
  C.cmdRegister({ session_id: 'bbbb-2', cwd: repo }, now);
  C.cmdSend({ _: ['send', 'heads up'], session: 'aaaa', to: 'all' }, now);
  assert.equal(fs.readdirSync(path.join(process.env.AIRCONTROL_DIR, 'messages', 'bbbb-1')).length, 1);
  assert.equal(fs.readdirSync(path.join(process.env.AIRCONTROL_DIR, 'messages', 'bbbb-2')).length, 1);
  assert.equal(fs.existsSync(path.join(process.env.AIRCONTROL_DIR, 'messages', 'aaaa-1')), false);
  assert.throws(() => C.cmdSend({ _: ['send', 'x'], session: 'aaaa', to: 'bbbb' }, now), /ambiguous/);
  assert.throws(() => C.cmdSend({ _: ['send', ''], session: 'aaaa', to: 'bbbb-1' }, now), /no message text/);
});

test('readInbox still recovers the sender from a pre-nonce filename', () => {
  freshDataDir();
  const dir = path.join(process.env.AIRCONTROL_DIR, 'messages', 'cccc-1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '1752600000000-abcd-ef.md'), 'legacy\n');
  const inbox = C.readInbox('cccc-1');
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].from, 'abcd-ef');
  assert.equal(inbox[0].text, 'legacy');
});

test('two sends in the same millisecond both persist and round-trip', () => {
  freshDataDir();
  const repo = tmpGitRepo('cli-dup');
  const now = Date.now();
  C.cmdRegister({ session_id: 'aaaa-1', cwd: repo }, now);
  C.cmdRegister({ session_id: 'bbbb-1', cwd: repo }, now);
  C.cmdSend({ _: ['send', 'first'], session: 'aaaa', to: 'bbbb-1' }, now);
  C.cmdSend({ _: ['send', 'second'], session: 'aaaa', to: 'bbbb-1' }, now);
  const inbox = C.readInbox('bbbb-1');
  assert.equal(inbox.length, 2);
  assert.deepEqual(inbox.map((m) => m.text).sort(), ['first', 'second']);
  for (const m of inbox) assert.equal(m.from, 'aaaa-1');
});

test('updateSession replays its mutation instead of clobbering a concurrent write', () => {
  freshDataDir();
  const repo = tmpGitRepo('cas-a');
  const now = Date.now();
  C.cmdRegister({ session_id: 'cas-1', cwd: repo }, now);
  let first = true;
  C.updateSession('cas-1', (s) => {
    if (first) { // a rival write lands while our mutation is in flight
      first = false;
      const rival = C.readSession('cas-1');
      rival.intent = 'rival intent';
      rival.rev = (rival.rev || 0) + 1;
      C.writeSession(rival);
    }
    s.claims = C.mergeClaims(s.claims, ['MyDir'], []);
    return s;
  });
  const final = C.readSession('cas-1');
  assert.equal(final.intent, 'rival intent');      // the rival's write survived
  assert.deepEqual(final.claims.paths, ['MyDir']); // and ours applied on top of it
});

test('requireLiveSession reports a session that vanished between lookup and re-read, instead of crashing null', () => {
  freshDataDir();
  const repo = tmpGitRepo('vanish-a');
  const now = Date.now();
  C.cmdRegister({ session_id: 'vanish-1', cwd: repo }, now);
  const file = C.sessionFile('vanish-1');
  const orig = fs.readFileSync;
  let calls = 0;
  // Let the first read of this file through (readSessions()'s live-id scan,
  // which is how the id got resolved at all); fail only the SECOND read — the
  // follow-up readSession(id) that races a concurrent sweep in real use.
  fs.readFileSync = (p, ...rest) => {
    if (p === file && ++calls === 2) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    return orig(p, ...rest);
  };
  try {
    assert.throws(() => C.requireLiveSession({ session: 'vanish' }, now), /vanish-1|vanished/);
  } finally {
    fs.readFileSync = orig;
  }
});

test('trySessionLock is mutually exclusive and self-heals a stale holder', () => {
  freshDataDir();
  const repo = tmpGitRepo('cas-lock');
  const now = Date.now();
  C.cmdRegister({ session_id: 'lock-1', cwd: repo }, now);
  assert.equal(C.trySessionLock('lock-1', now), true);
  assert.equal(C.trySessionLock('lock-1', now), false); // already held
  assert.equal(C.trySessionLock('lock-1', now + 10 * 1000), true); // stale: swept and re-acquired
  fs.unlinkSync(C.sessionLockFile('lock-1'));
});

test('updateSession refuses to commit while another update holds the session lock', () => {
  freshDataDir();
  const repo = tmpGitRepo('cas-c');
  const now = Date.now();
  C.cmdRegister({ session_id: 'cas-3', cwd: repo }, now);
  fs.closeSync(fs.openSync(C.sessionLockFile('cas-3'), 'wx')); // simulate a concurrent holder
  const before = C.readSession('cas-3').intent;
  assert.throws(() => C.updateSession('cas-3', (s) => { s.intent = 'blocked'; return s; }),
    /conflicted/);
  assert.equal(C.readSession('cas-3').intent, before); // never wrote past the held lock
  fs.unlinkSync(C.sessionLockFile('cas-3'));
  const s = C.updateSession('cas-3', (s2) => { s2.intent = 'now free'; return s2; });
  assert.equal(s.intent, 'now free'); // succeeds once the lock is released
});

test('deregister bounces unread messages back to a live sender', () => {
  freshDataDir();
  const repo = tmpGitRepo('bounce-a');
  const now = Date.now();
  C.cmdRegister({ session_id: 'aaaa-1', cwd: repo }, now);
  C.cmdRegister({ session_id: 'bbbb-1', cwd: repo }, now);
  C.cmdSend({ _: ['send', 'are you there?'], session: 'aaaa', to: 'bbbb-1' }, now);
  C.cmdDeregister({ session_id: 'bbbb-1' }, now);
  const inbox = C.readInbox('aaaa-1');
  assert.equal(inbox.length, 1);
  assert.match(inbox[0].text, /never read|undelivered|before reading/);
  assert.match(inbox[0].text, /are you there\?/);
  assert.equal(inbox[0].from, 'bbbb-1');
});

test('a stale sweep bounces unread messages the same way', () => {
  freshDataDir();
  const repo = tmpGitRepo('bounce-b');
  const t0 = Date.now();
  C.cmdRegister({ session_id: 'aaaa-1', cwd: repo }, t0);
  C.cmdRegister({ session_id: 'bbbb-1', cwd: repo }, t0);
  C.cmdSend({ _: ['send', 'ping'], session: 'aaaa', to: 'bbbb-1' }, t0);
  const later = t0 + 31 * 60 * 1000;
  C.cmdBeat({ session_id: 'aaaa-1' }, later); // sender stays live
  C.sweep(later);                              // recipient goes stale
  const inbox = C.readInbox('aaaa-1');
  assert.equal(inbox.length, 1);
  assert.match(inbox[0].text, /ping/);
});

test('no bounce when the sender is gone too', () => {
  freshDataDir();
  const repo = tmpGitRepo('bounce-c');
  const t0 = Date.now();
  C.cmdRegister({ session_id: 'aaaa-1', cwd: repo }, t0);
  C.cmdRegister({ session_id: 'bbbb-1', cwd: repo }, t0);
  C.cmdSend({ _: ['send', 'ping'], session: 'aaaa', to: 'bbbb-1' }, t0);
  C.sweep(t0 + 31 * 60 * 1000); // both stale: nobody to notify, must not throw
  assert.equal(C.readInbox('aaaa-1').length, 0);
});

test('a bounce is never itself bounced back', () => {
  freshDataDir();
  const repo = tmpGitRepo('bounce-d');
  const now = Date.now();
  C.cmdRegister({ session_id: 'aaaa-1', cwd: repo }, now);
  C.cmdRegister({ session_id: 'bbbb-1', cwd: repo }, now);
  C.cmdSend({ _: ['send', 'ping'], session: 'aaaa', to: 'bbbb-1' }, now);
  C.cmdDeregister({ session_id: 'bbbb-1' }, now);          // bounce lands with aaaa
  C.cmdRegister({ session_id: 'bbbb-1', cwd: repo }, now); // original sender is back
  C.cmdDeregister({ session_id: 'aaaa-1' }, now);          // dies with the bounce unread
  assert.equal(C.readInbox('bbbb-1').length, 0);
});

test('who --json is parseable and --assignable filters, with --idle as an alias', () => {
  freshDataDir();
  const repo = tmpGitRepo('who-j');
  const now = Date.now();
  C.cmdRegister({ session_id: 'aaaa-1', cwd: repo }, now);
  C.cmdRegister({ session_id: 'bbbb-1', cwd: repo }, now);
  captureStdout(() => C.cmdClaim({ session: 'aaaa', intent: 'busy work', paths: 'Store' }, now));
  const rows = JSON.parse(captureStdout(() => C.cmdWho(now, { json: true })));
  assert.equal(rows.length, 2);
  const busy = rows.find((r) => r.sessionId === 'aaaa-1');
  assert.equal(busy.name, C.friendlyName('aaaa-1'));
  assert.equal(busy.intent, 'busy work');
  assert.deepEqual(busy.claims.paths, ['Store']);
  assert.equal(busy.assignable, false);
  assert.equal(busy.idle, false); // deprecated alias, kept for existing scripts
  assert.equal(rows.find((r) => r.sessionId === 'bbbb-1').assignable, true);
  const freeRows = JSON.parse(captureStdout(() => C.cmdWho(now, { assignable: true, json: true })));
  assert.deepEqual(freeRows.map((r) => r.sessionId), ['bbbb-1']);
  // --idle still filters identically, so older dispatcher scripts keep working
  assert.deepEqual(
    JSON.parse(captureStdout(() => C.cmdWho(now, { idle: true, json: true }))).map((r) => r.sessionId),
    ['bbbb-1']);
  const text = captureStdout(() => C.cmdWho(now, { assignable: true }));
  assert.match(text, new RegExp(C.friendlyName('bbbb-1')));
  assert.doesNotMatch(text, new RegExp(C.friendlyName('aaaa-1')));
});

test('ledger list --json emits the filtered items as machine-readable JSON', () => {
  freshDataDir();
  const repo = tmpGitRepo('led-json');
  const now = Date.now();
  C.cmdRegister({ session_id: 'worker-1', cwd: repo }, now);
  withCwd(repo, () => {
    captureStdout(() => C.cmdLedger({ _: ['ledger', 'add'], title: 'first', 'points-at': 'p', priority: 'high' }, now));
    captureStdout(() => C.cmdLedger({ _: ['ledger', 'add'], title: 'second', 'points-at': 'p' }, now + 1));
  });
  const items = JSON.parse(captureStdout(() => C.cmdLedger({ _: ['ledger', 'list'], repo: 'all', json: true }, now + 10)));
  assert.equal(items.length, 2);
  assert.equal(items.find((it) => it.title === 'first').priority, 'high');
  assert.ok(items.every((it) => it.id && it.state));
});

test('ledger list omits notes until asked, and show reads them all back', () => {
  // One `ledger list` was the costliest tool result of a whole session on
  // 2026-09-12 -- 14 KB re-sent on every later turn -- because it printed every
  // item's full note. The pointer stays; the paragraphs move behind a flag.
  freshDataDir();
  const repo = tmpGitRepo('led-notes');
  const now = Date.now();
  C.cmdRegister({ session_id: 'worker-1', cwd: repo }, now);
  let id;
  withCwd(repo, () => {
    const added = captureStdout(() => C.cmdLedger({ _: ['ledger', 'add'], title: 'noted item', 'points-at': 'spec.md' }, now));
    id = added.match(/lg_[a-f0-9]+/)[0];
    captureStdout(() => C.cmdLedger({ _: ['ledger', 'note', id, 'first', 'paragraph'] }, now + 1));
    captureStdout(() => C.cmdLedger({ _: ['ledger', 'note', id, 'second', 'paragraph'] }, now + 2));
  });

  const quiet = captureStdout(() => C.cmdLedger({ _: ['ledger', 'list'], repo: 'all' }, now + 10));
  assert.ok(quiet.includes('noted item'), 'the title still shows');
  assert.ok(quiet.includes('spec.md'), 'pointsAt stays -- it is how `take` finds the spec');
  assert.ok(!quiet.includes('second paragraph'), 'notes are not in the default listing');

  const loud = captureStdout(() => C.cmdLedger({ _: ['ledger', 'list'], repo: 'all', notes: true }, now + 10));
  assert.ok(loud.includes('second paragraph'), '--notes brings them back');

  const shown = captureStdout(() => C.cmdLedger({ _: ['ledger', 'show', id] }, now + 10));
  assert.ok(shown.includes('first paragraph') && shown.includes('second paragraph'),
    'show prints every note, not only the last');
});

test('ledger list --repo finds by absolute path what it finds by dot', () => {
  // An explicit path used to be compared raw against a canonical stored key, so
  // it matched nothing and printed "nothing open" -- an empty backlog that was
  // not empty.
  freshDataDir();
  const repo = tmpGitRepo('led-abspath');
  const now = Date.now();
  C.cmdRegister({ session_id: 'worker-1', cwd: repo }, now);
  withCwd(repo, () => {
    captureStdout(() => C.cmdLedger({ _: ['ledger', 'add'], title: 'findable', 'points-at': 'p' }, now));
  });

  const byDot = withCwd(repo, () => captureStdout(() => C.cmdLedger({ _: ['ledger', 'list'], repo: '.' }, now + 10)));
  const byPath = captureStdout(() => C.cmdLedger({ _: ['ledger', 'list'], repo }, now + 10));
  assert.ok(byDot.includes('findable'));
  assert.ok(byPath.includes('findable'), 'an absolute path must find what "." finds');
});

test('sim list --json emits devices and leases', () => {
  freshDataDir();
  const now = Date.now();
  assert.ok(C.tryLease({ platform: 'ios', key: 'UDID-B', sessionId: 'holder-1', purpose: 'qa', lastSeen: new Date(now).toISOString() }));
  const parsed = JSON.parse(captureStdout(() => C.cmdSim({ _: ['sim', 'list'], json: true }, now, stubDeps([IOS_A, IOS_B]))));
  assert.deepEqual(parsed.devices.map((d) => d.key).sort(), ['UDID-A', 'UDID-B']);
  assert.equal(parsed.leases.length, 1);
  assert.equal(parsed.leases[0].holder, C.friendlyName('holder-1'));
});

test('who prints sessions grouped by repo', () => {
  freshDataDir();
  const repoA = tmpGitRepo('who-a');
  const repoB = tmpGitRepo('who-b');
  const now = Date.now();
  C.cmdRegister({ session_id: 'wa-1', cwd: repoA }, now);
  C.cmdRegister({ session_id: 'wb-1', cwd: repoB }, now);
  const out = captureStdout(() => C.cmdWho(now));
  const idxA = out.indexOf('who-a');
  const idxB = out.indexOf('who-b');
  assert.ok(idxA >= 0 && idxB >= 0 && out.includes(C.friendlyName('wa-1')) && out.includes(C.friendlyName('wb-1')));
});

// ---------- simulator lease broker ----------

const IOS_JSON = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
      { udid: 'UDID-A', name: 'iPhone 17', state: 'Shutdown', isAvailable: true },
      { udid: 'UDID-B', name: 'iPhone 17 Pro', state: 'Booted', isAvailable: true },
      { udid: 'UDID-GONE', name: 'iPhone 12', state: 'Shutdown', isAvailable: false },
    ],
  },
});

function stubDeps(devices, installed) {
  return {
    listIos: () => devices.filter((d) => d.platform === 'ios'),
    listAndroid: () => devices.filter((d) => d.platform === 'android'),
    appInstalled: typeof installed === 'function' ? installed : () => installed,
  };
}

const IOS_A = { platform: 'ios', key: 'UDID-A', name: 'iPhone 17', runtime: 'iOS 26.5', state: 'shutdown' };
const IOS_B = { platform: 'ios', key: 'UDID-B', name: 'iPhone 17 Pro', runtime: 'iOS 26.5', state: 'booted' };

test('parseSimctlDevices keeps available devices and normalizes runtime + state', () => {
  const parsed = C.parseSimctlDevices(IOS_JSON);
  assert.deepEqual(parsed.map((d) => d.key), ['UDID-A', 'UDID-B']); // unavailable dropped
  assert.equal(parsed[0].runtime, 'iOS 26.5');
  assert.equal(parsed[1].state, 'booted');
  assert.deepEqual(C.parseSimctlDevices('not json'), []);
});

test('parseAdbSerials picks booted emulators only', () => {
  const out = 'List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\nR5CT\tdevice\n';
  assert.deepEqual(C.parseAdbSerials(out), ['emulator-5554']);
  assert.deepEqual(C.parseAdbSerials(''), []);
});

test('listDevices degrades to empty when the toolchain is missing', () => {
  freshDataDir();
  const run = () => null; // xcrun / emulator / adb all absent
  assert.deepEqual(C.listDevices(undefined, { run }), []);
});

test('acquire: two sessions cannot hold the same device; the loser gets the other one', () => {
  freshDataDir();
  const repo = tmpGitRepo('sim-a');
  const now = Date.now();
  C.cmdRegister({ session_id: 'sim-one', cwd: repo }, now);
  C.cmdRegister({ session_id: 'sim-two', cwd: repo }, now);
  const deps = stubDeps([IOS_A, IOS_B]);
  const first = C.acquireDevice({ sessionId: 'sim-one', repo: 'r', purpose: 'p', nowMs: now }, deps);
  const second = C.acquireDevice({ sessionId: 'sim-two', repo: 'r2', purpose: 'p', nowMs: now }, deps);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(first.device.key, second.device.key);
  assert.equal(first.device.key, 'UDID-B'); // booted preferred over shutdown
  assert.equal(C.readLeases().length, 2);
});

test('acquire is denied when every device is held, and names the holder', () => {
  freshDataDir();
  const repo = tmpGitRepo('sim-b');
  const now = Date.now();
  C.cmdRegister({ session_id: 'holder-1', cwd: repo }, now);
  C.cmdRegister({ session_id: 'seeker-1', cwd: repo }, now);
  const deps = stubDeps([IOS_A]);
  assert.equal(C.acquireDevice({ sessionId: 'holder-1', repo: 'r', nowMs: now }, deps).ok, true);
  const denied = C.acquireDevice({ sessionId: 'seeker-1', repo: 'r', nowMs: now }, deps);
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'all-held');
  assert.equal(denied.held[0].lease.sessionId, 'holder-1');
});

test('tryLease is O_EXCL: the second write to one device loses', () => {
  freshDataDir();
  const rec = { platform: 'ios', key: 'UDID-A', sessionId: 'a', acquiredAt: new Date().toISOString() };
  assert.equal(C.tryLease(rec), true);
  assert.equal(C.tryLease({ ...rec, sessionId: 'b' }), false);
  assert.equal(C.readLease('ios', 'UDID-A').sessionId, 'a'); // not overwritten
});

test('shutdownAndReleaseLeases shuts down only the caller\'s devices', () => {
  freshDataDir();
  const states = new Map([['UDID-A', 'booted'], ['UDID-B', 'booted']]);
  const shutDown = [];
  let quitCalls = 0;
  const deps = {
    listIos: () => [IOS_A, IOS_B].map((device) => ({ ...device, state: states.get(device.key) })),
    listAndroid: () => [],
    shutdownDevice: (lease) => { shutDown.push(lease.key); states.set(lease.key, 'shutdown'); },
    quitSimulator: () => { quitCalls++; },
  };
  assert.ok(C.tryLease({ platform: 'ios', key: 'UDID-A', name: 'mine', sessionId: 'owner' }));
  assert.ok(C.tryLease({ platform: 'ios', key: 'UDID-B', name: 'theirs', sessionId: 'peer' }));

  const result = C.shutdownAndReleaseLeases('owner', deps);

  assert.deepEqual(shutDown, ['UDID-A']);
  assert.deepEqual(result.released.map((lease) => lease.key), ['UDID-A']);
  assert.equal(C.readLease('ios', 'UDID-A'), null);
  assert.equal(C.readLease('ios', 'UDID-B').sessionId, 'peer');
  assert.equal(quitCalls, 0, 'another iOS lease keeps Simulator.app open');
});

test('explicit shutdown keeps a lease when the device fails to stop', () => {
  freshDataDir();
  assert.ok(C.tryLease({ platform: 'ios', key: 'UDID-B', name: 'mine', sessionId: 'owner' }));
  const result = C.shutdownAndReleaseLeases('owner', {
    ...stubDeps([IOS_B]), shutdownDevice: () => false,
  });
  assert.equal(result.failed.length, 1);
  assert.equal(result.released.length, 0);
  assert.equal(C.readLease('ios', 'UDID-B').sessionId, 'owner');
});

test('pruning an orphaned lease stops the device it was left booted on', () => {
  freshDataDir();
  const stale = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const states = new Map([['UDID-B', 'booted']]);
  const shutDown = [];
  let quitCalls = 0;
  const deps = {
    listIos: () => [{ ...IOS_B, state: states.get('UDID-B') }], listAndroid: () => [],
    shutdownDevice: (lease) => { shutDown.push(lease.key); states.set(lease.key, 'shutdown'); },
    quitSimulator: () => { quitCalls++; },
  };
  assert.ok(C.tryLease({ platform: 'ios', key: 'UDID-B', name: 'left behind', sessionId: 'gone', lastSeen: stale }));

  assert.equal(C.pruneLeases(Date.now(), deps, { shutdown: true }), 1);

  assert.deepEqual(shutDown, ['UDID-B'], 'a lease nobody holds leaves a simulator nobody stops');
  assert.equal(C.readLease('ios', 'UDID-B'), null);
  assert.equal(quitCalls, 1);
});

test('pruning without shutdown leaves the device running', () => {
  freshDataDir();
  const stale = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const shutDown = [];
  const deps = { ...stubDeps([IOS_B]), shutdownDevice: (lease) => { shutDown.push(lease.key); } };
  assert.ok(C.tryLease({ platform: 'ios', key: 'UDID-B', name: 'left behind', sessionId: 'gone', lastSeen: stale }));

  assert.equal(C.pruneLeases(Date.now(), deps), 1); // sweep() stays off the shutdown path

  assert.deepEqual(shutDown, []);
  assert.equal(C.readLease('ios', 'UDID-B'), null);
});

test('pruning never stops a live session\'s device, however old the lease', () => {
  const repo = tmpGitRepo('sim-prune-live');
  const now = Date.now();
  C.cmdRegister({ session_id: 'alive', cwd: repo }, now);
  const stale = new Date(now - 3 * 60 * 60 * 1000).toISOString();
  const shutDown = [];
  const deps = { ...stubDeps([IOS_B]), shutdownDevice: (lease) => { shutDown.push(lease.key); } };
  assert.ok(C.tryLease({ platform: 'ios', key: 'UDID-B', name: 'in use', sessionId: 'alive', lastSeen: stale }));

  assert.equal(C.pruneLeases(now, deps, { shutdown: true }), 0);

  assert.deepEqual(shutDown, []);
  assert.equal(C.readLease('ios', 'UDID-B').sessionId, 'alive');
});

test('owned shutdown quits Simulator.app after the final iOS device stops', () => {
  freshDataDir();
  let state = 'booted';
  let quitCalls = 0;
  assert.ok(C.tryLease({ platform: 'ios', key: 'UDID-B', name: 'mine', sessionId: 'owner' }));
  const result = C.shutdownAndReleaseLeases('owner', {
    listIos: () => [{ ...IOS_B, state }], listAndroid: () => [],
    shutdownDevice: () => { state = 'shutdown'; },
    quitSimulator: () => { quitCalls++; },
  });
  assert.equal(result.quitSimulator, true);
  assert.equal(quitCalls, 1);
});

// SessionEnd reaps this session's own browsers, resolved by `claude` ancestor. The cases that
// matter are all about NOT killing something: another live session's browser, an orphan whose
// owner is gone, and every browser on a /clear, where the session keeps running.
test('deregister reaps only this session\'s own browsers, by claude ancestor', () => {
  const all = C.parseProcTable([
    '100 1 /opt/homebrew/bin/claude --mine',
    '111 100 npm exec @playwright/mcp@latest',       // mine (playwright: no token, still resolved)
    '200 1 /opt/homebrew/bin/claude --theirs',
    '222 200 chrome-devtools-mcp',                    // a live peer's
    '333 1 npm exec @playwright/mcp@latest',          // orphan, reparented to launchd
  ].join('\n'));
  const killed = [];
  const got = C.reapOwnBrowsers({
    allProcs: all, myClaudePid: 100, liveClaudePids: new Set([100, 200]), kill: (pid) => killed.push(pid),
  });
  assert.deepEqual(got, [111]);
  assert.deepEqual(killed, [111], "another session's and orphaned browsers must survive a session-end reap");
});

test('deregister kills nothing when no claude ancestor resolves', () => {
  const all = C.parseProcTable('111 1 npm exec @playwright/mcp@latest');
  const killed = [];
  const got = C.reapOwnBrowsers({
    allProcs: all, myClaudePid: null, liveClaudePids: new Set(), kill: (pid) => killed.push(pid),
  });
  assert.deepEqual(got, [], 'with no claude ancestor nothing is identifiable, so nothing is killed');
  assert.deepEqual(killed, []);
});

test('a /clear does not reap browsers, because the session carries on', () => {
  freshDataDir();
  const repo = tmpGitRepo('sim-clear');
  const now = Date.now();
  C.cmdRegister({ session_id: 'still-going', cwd: repo }, now);
  const killed = [];
  // allProcs feeds the browser reaper; procs=[] keeps the task reaper off the real process table.
  const deps = {
    allProcs: C.parseProcTable('100 1 /opt/homebrew/bin/claude\n111 100 chrome-devtools-mcp'),
    procs: [], myClaudePid: 100, claudePid: 100, liveClaudePids: new Set([100]),
    kill: (pid) => killed.push(pid),
  };
  C.cmdDeregister({ session_id: 'still-going', reason: 'clear' }, now, deps);
  assert.deepEqual(killed, [], '/clear must leave the running session its browser');
  C.cmdDeregister({ session_id: 'still-going', reason: 'prompt_input_exit' }, now, deps);
  assert.deepEqual(killed, [111], 'a real ending reaps');
});

test('deregister frees a lease immediately', () => {
  freshDataDir();
  const repo = tmpGitRepo('sim-c');
  const now = Date.now();
  C.cmdRegister({ session_id: 'ends-cleanly', cwd: repo }, now);
  C.acquireDevice({ sessionId: 'ends-cleanly', repo: 'r', nowMs: now }, stubDeps([IOS_B]));
  assert.equal(C.readLeases().length, 1);
  C.cmdDeregister({ session_id: 'ends-cleanly' }); // SessionEnd — the normal path
  assert.deepEqual(C.readLeases(), []);
});

test('a real deregister shuts down owned devices; /clear only releases them', () => {
  freshDataDir();
  const repo = tmpGitRepo('sim-end-shutdown');
  const now = Date.now();
  const stopped = [];
  const deps = {
    ...stubDeps([{ ...IOS_B, state: 'booted' }]),
    shutdownDevice: (lease) => { stopped.push(lease.key); },
  };
  C.cmdRegister({ session_id: 'ending', cwd: repo }, now);
  assert.ok(C.tryLease({ platform: 'ios', key: 'UDID-B', name: 'phone', sessionId: 'ending' }));
  C.cmdDeregister({ session_id: 'ending', reason: 'prompt_input_exit' }, now, deps);
  assert.deepEqual(stopped, ['UDID-B']);
  assert.deepEqual(C.readLeases(), []);

  C.cmdRegister({ session_id: 'clearing', cwd: repo }, now);
  assert.ok(C.tryLease({ platform: 'ios', key: 'UDID-B', name: 'phone', sessionId: 'clearing' }));
  C.cmdDeregister({ session_id: 'clearing', reason: 'clear' }, now, deps);
  assert.deepEqual(stopped, ['UDID-B'], '/clear must not shut down a continuing session\'s device');
  assert.deepEqual(C.readLeases(), []);
});

// The bug this rule exists for: a 40-minute xcodebuild emits no heartbeat, the session reads as
// stale, and the old rule handed the device to someone else mid-build.
test('a quiet session keeps its device until the lease TTL, not the roster TTL', () => {
  freshDataDir();
  const repo = tmpGitRepo('sim-quiet');
  const now = Date.now();
  C.cmdRegister({ session_id: 'long-build', cwd: repo }, now - C.STALE_MS - 1000);
  C.acquireDevice({ sessionId: 'long-build', repo: 'r', nowMs: now }, stubDeps([IOS_A]));

  assert.equal(C.sweep(now).leases, 0); // stale roster entry, but the lease holds
  assert.equal(C.readLeases().length, 1);

  // ...and a holder that really is gone still gives the device back, just not for two hours.
  const later = now + C.LEASE_TTL_MS + 1000;
  assert.equal(C.sweep(later).leases, 1);
  assert.deepEqual(C.readLeases(), []);
});

test('a sim subcommand refreshes the holder\'s leases', () => {
  freshDataDir();
  const repo = tmpGitRepo('sim-touch');
  const now = Date.now();
  C.cmdRegister({ session_id: 'toucher', cwd: repo }, now);
  C.acquireDevice({ sessionId: 'toucher', repo: 'r', nowMs: now }, stubDeps([IOS_A]));
  const later = now + C.LEASE_TTL_MS - 1000;
  assert.equal(C.touchLeases('toucher', later), 1);
  // Touched inside the window, so the TTL restarts from the touch, not from acquire.
  assert.equal(C.sweep(later + 1000).leases, 0);
  assert.equal(C.readLeases().length, 1);
});

test('affinity: a verified seeded device wins over a booted one', () => {
  freshDataDir();
  const now = Date.now();
  C.writeAffinity({ repos: { 'repo-key': { platform: 'ios', key: 'UDID-A', name: 'iPhone 17', bundleId: 'com.example.myapp' } } });
  const res = C.acquireDevice({ sessionId: 's', repo: 'repo-key', nowMs: now }, stubDeps([IOS_A, IOS_B], true));
  assert.equal(res.device.key, 'UDID-A'); // affinity beats "booted first"
  assert.match(res.affinity, /^verified/);
});

test('affinity is verified, not trusted: a disproven mapping is dropped, not repointed on a guess', () => {
  freshDataDir();
  const now = Date.now();
  C.writeAffinity({ repos: { 'repo-key': { platform: 'ios', key: 'UDID-A', bundleId: 'com.example.myapp' } } });
  const res = C.acquireDevice({ sessionId: 's', repo: 'repo-key', nowMs: now }, stubDeps([IOS_A, IOS_B], false));
  assert.equal(res.device.key, 'UDID-B');
  assert.match(res.affinity, /^stale/);
  assert.equal(C.affinityFor('repo-key'), null); // proven wrong, and not replaced by a guess
});

test('with no affinity yet, a seeded device beats a booted one and becomes the affinity', () => {
  freshDataDir();
  const now = Date.now();
  // UDID-B is booted (normally preferred); only UDID-A actually has the app.
  const deps = stubDeps([IOS_A, IOS_B], (d) => d.key === 'UDID-A');
  const res = C.acquireDevice({ sessionId: 's', repo: 'rk', bundleId: 'com.example.myapp', nowMs: now }, deps);
  assert.equal(res.device.key, 'UDID-A');
  assert.equal(res.affinity, 'seeded');
  assert.equal(C.affinityFor('rk').key, 'UDID-A');
});

test('no seeded device: one is still leased, but nothing unverified is remembered', () => {
  freshDataDir();
  const now = Date.now();
  const res = C.acquireDevice({ sessionId: 's', repo: 'rk', bundleId: 'com.example.myapp', nowMs: now }, stubDeps([IOS_A, IOS_B], false));
  assert.equal(res.ok, true);
  assert.match(res.affinity, /fallback$/);
  assert.equal(C.affinityFor('rk'), null);
});

test('re-acquiring returns the device this session already holds, not a second one', () => {
  freshDataDir();
  const repo = tmpGitRepo('sim-retry');
  const now = Date.now();
  C.cmdRegister({ session_id: 'retry-me', cwd: repo }, now);
  const deps = stubDeps([IOS_A, IOS_B]);
  const first = C.acquireDevice({ sessionId: 'retry-me', repo: 'r', nowMs: now }, deps);
  const again = C.acquireDevice({ sessionId: 'retry-me', repo: 'r', nowMs: now }, deps);
  assert.equal(again.device.key, first.device.key);
  assert.equal(again.affinity, 'already-held');
  assert.equal(C.readLeases().length, 1);
  // --extra is the deliberate way to hold two
  const second = C.acquireDevice({ sessionId: 'retry-me', repo: 'r', extra: true, nowMs: now }, deps);
  assert.notEqual(second.device.key, first.device.key);
  assert.equal(C.readLeases().length, 2);
});

test('renderSimList shows holders and marks this repo\'s affinity', () => {
  freshDataDir();
  const now = Date.now();
  const lease = { platform: 'ios', key: 'UDID-B', name: 'iPhone 17 Pro', sessionId: 'holder-9', purpose: 'myapp-ios', acquiredAt: new Date(now - 120000).toISOString() };
  C.writeAffinity({ repos: { rk: { platform: 'ios', key: 'UDID-A' } } });
  const out = C.renderSimList([IOS_A, IOS_B], [lease], now, 'rk');
  assert.match(out, /UDID-A.*<- affinity/);
  assert.match(out, new RegExp(`UDID-B.*held by ${C.friendlyName('holder-9')} "myapp-ios" \\(2m ago\\)`));
});

// ---------- cross-repo ledger ----------

function withCwd(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try { return fn(); } finally { process.chdir(prev); }
}

test('ledger add refuses without a pointer, and caps the title', () => {
  freshDataDir();
  const repo = tmpGitRepo('led-a');
  const now = Date.now();
  withCwd(repo, () => {
    assert.throws(() => C.cmdLedger({ _: ['ledger', 'add'], title: 'no pointer' }, now), /--points-at/);
    assert.throws(() => C.cmdLedger({ _: ['ledger', 'add'], 'points-at': 'x' }, now), /--title/);
    assert.throws(
      () => C.cmdLedger({ _: ['ledger', 'add'], title: 'x'.repeat(81), 'points-at': 'x' }, now),
      /keep it under 80/,
    );
    assert.equal(C.readLedgerEvents().length, 0);
  });
});

test('an item filed before `git init` still surfaces once the dir becomes a repo', () => {
  freshDataDir();
  // A plain directory: gitInfo() keys it `none:<cwd>`, and the item is filed there.
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aircontrol-pregit-')));
  const now = Date.now();
  withCwd(plain, () => {
    captureStdout(() => C.cmdLedger(
      { _: ['ledger', 'add'], title: 'filed before git init', 'points-at': 'NOTES.md' }, now));
  });
  assert.equal(C.ledgerView(now)[0].repo, `none:${plain}`);

  // git init moves the key to <cwd>/.git. The item must not disappear.
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: plain });
  withCwd(plain, () => {
    const listed = JSON.parse(captureStdout(() => C.cmdLedger(
      { _: ['ledger', 'list'], repo: '.', json: true }, now + 1)));
    assert.equal(listed.length, 1, 'ledger list --repo . must still find the pre-git item');
    assert.equal(listed[0].title, 'filed before git init');

    // and the session-start ledger line must count it as "here", not "elsewhere"
    const counts = C.ledgerCounts(C.ledgerView(now + 1), C.gitInfo(plain).repo);
    assert.equal(counts.here, 1);
    assert.equal(counts.elsewhere, 0);
  });
});

test('ledger folds add -> take -> done, and derives in-progress from a live session', () => {
  freshDataDir();
  const repo = tmpGitRepo('led-b');
  const now = Date.now();
  C.cmdRegister({ session_id: 'worker-1', cwd: repo }, now);
  const id = withCwd(repo, () => {
    captureStdout(() => C.cmdLedger({ _: ['ledger', 'add'], title: 'Remote Config device QA', 'points-at': 'openspec/changes/x/tasks.md#6.1', status: 'blocked-on-human' }, now));
    return C.ledgerView(now)[0].id;
  });
  assert.equal(C.ledgerView(now)[0].state, 'blocked-on-human');

  captureStdout(() => C.cmdLedger({ _: ['ledger', 'take', id], session: 'worker-1' }, now));
  assert.equal(C.ledgerView(now)[0].state, 'in-progress');

  captureStdout(() => C.cmdLedger({ _: ['ledger', 'done', id], note: 'QA passed' }, now));
  const done = C.ledgerView(now)[0];
  assert.equal(done.state, 'done');
  assert.equal(done.notes.at(-1).text, 'QA passed');
});

test('an item owned by a dead session folds back to open, marked abandoned', () => {
  freshDataDir();
  const repo = tmpGitRepo('led-c');
  const now = Date.now();
  C.cmdRegister({ session_id: 'ghost-42', cwd: repo }, now);
  const id = withCwd(repo, () => {
    captureStdout(() => C.cmdLedger({ _: ['ledger', 'add'], title: 'half-done work', 'points-at': 'plans/x.md' }, now));
    return C.ledgerView(now)[0].id;
  });
  captureStdout(() => C.cmdLedger({ _: ['ledger', 'take', id], session: 'ghost-42' }, now));
  assert.equal(C.ledgerView(now)[0].state, 'in-progress');

  C.cmdDeregister({ session_id: 'ghost-42' }); // terminal closed, context ran out, whatever
  const orphan = C.ledgerView(now)[0];
  assert.equal(orphan.state, 'open');
  assert.equal(orphan.owner, null);
  assert.equal(orphan.abandonedBy, C.friendlyName('ghost-42'));
});

test('take refuses to steal an item another live session is working', () => {
  freshDataDir();
  const repo = tmpGitRepo('led-d');
  const now = Date.now();
  C.cmdRegister({ session_id: 'first-one', cwd: repo }, now);
  C.cmdRegister({ session_id: 'second-11', cwd: repo }, now);
  const id = withCwd(repo, () => {
    captureStdout(() => C.cmdLedger({ _: ['ledger', 'add'], title: 't', 'points-at': 'p' }, now));
    return C.ledgerView(now)[0].id;
  });
  captureStdout(() => C.cmdLedger({ _: ['ledger', 'take', id], session: 'first-one' }, now));
  assert.throws(() => C.cmdLedger({ _: ['ledger', 'take', id], session: 'second-11' }, now), /already being worked/);
});

test('a take that loses a photo-finish race is told so, and one owner settles', () => {
  freshDataDir();
  const repo = tmpGitRepo('led-race');
  const now = Date.now();
  C.cmdRegister({ session_id: 'aaaa-1', cwd: repo }, now);
  C.cmdRegister({ session_id: 'bbbb-1', cwd: repo }, now);
  const id = withCwd(repo, () => {
    captureStdout(() => C.cmdLedger({ _: ['ledger', 'add'], title: 'contested', 'points-at': 'x' }, now));
    return C.ledgerView(now)[0].id;
  });
  // Deterministic race: a competing take lands between our append and our verify.
  const hooks = {
    beforeTakeVerify: () =>
      C.appendLedgerEvent({ ts: new Date(now).toISOString(), event: 'take', id, sessionId: 'bbbb-1' }),
  };
  assert.throws(
    () => captureStdout(() => C.cmdLedger({ _: ['ledger', 'take', id], session: 'aaaa' }, now, hooks)),
    /they won/,
  );
  assert.equal(C.ledgerView(now)[0].owner, 'bbbb-1');
});

test('appends from interleaved writers all survive the fold', () => {
  freshDataDir();
  const now = Date.now();
  for (let i = 0; i < 20; i++) {
    C.appendLedgerEvent({ ts: new Date(now + i).toISOString(), event: 'add', id: `lg_${i}`, title: `t${i}`, pointsAt: 'p', repo: 'r' });
    C.appendLedgerEvent({ ts: new Date(now + i).toISOString(), event: 'note', id: `lg_${i}`, text: 'n' });
  }
  const items = C.ledgerView(now);
  assert.equal(items.length, 20);
  assert.ok(items.every((it) => it.notes.length === 1));
});

test('compaction drops only long-done items, and only once the log is long', () => {
  freshDataDir();
  const now = Date.now();
  const old = new Date(now - C.LEDGER_DONE_TTL_MS - 1000).toISOString();
  C.appendLedgerEvent({ ts: old, event: 'add', id: 'lg_stale', title: 'ancient', pointsAt: 'p', repo: 'r' });
  C.appendLedgerEvent({ ts: old, event: 'done', id: 'lg_stale' });
  C.appendLedgerEvent({ ts: new Date(now).toISOString(), event: 'add', id: 'lg_live', title: 'current', pointsAt: 'p', repo: 'r' });
  C.appendLedgerEvent({ ts: new Date(now).toISOString(), event: 'done', id: 'lg_recent' });
  assert.equal(C.compactLedger(now), 0); // short log: left alone

  for (let i = 0; i < C.LEDGER_MAX_LINES; i++) {
    C.appendLedgerEvent({ ts: new Date(now).toISOString(), event: 'note', id: 'lg_live', text: `n${i}` });
  }
  assert.equal(C.compactLedger(now), 2); // both lg_stale lines
  assert.deepEqual(C.ledgerView(now).map((it) => it.id), ['lg_live']);
});

function seedCompactableLedger(now) {
  const old = new Date(now - C.LEDGER_DONE_TTL_MS - 1000).toISOString();
  C.appendLedgerEvent({ ts: old, event: 'add', id: 'lg_stale', title: 'ancient', pointsAt: 'p', repo: 'r' });
  C.appendLedgerEvent({ ts: old, event: 'done', id: 'lg_stale' });
  C.appendLedgerEvent({ ts: new Date(now).toISOString(), event: 'add', id: 'lg_live', title: 'current', pointsAt: 'p', repo: 'r' });
  for (let i = 0; i < C.LEDGER_MAX_LINES; i++) {
    C.appendLedgerEvent({ ts: new Date(now).toISOString(), event: 'note', id: 'lg_live', text: `n${i}` });
  }
}

test('compaction aborts without writing when an append lands mid-compact', () => {
  freshDataDir();
  const now = Date.now();
  seedCompactableLedger(now);
  const hooks = {
    beforeCompactWrite: () =>
      C.appendLedgerEvent({ ts: new Date(now).toISOString(), event: 'add', id: 'lg_racer', title: 'landed mid-compact', pointsAt: 'p', repo: 'r' }),
  };
  assert.equal(C.compactLedger(now, hooks), 0); // aborted: no lines dropped
  const ids = C.ledgerView(now).map((it) => it.id).sort();
  assert.ok(ids.includes('lg_racer')); // the concurrent append survived
  assert.ok(ids.includes('lg_stale')); // nothing was dropped this round
  // The recheck now happens right before the rename (after the tmp file is
  // already written), so an abort must also clean up that tmp file itself.
  const leftover = fs.readdirSync(process.env.AIRCONTROL_DIR).filter((f) => f.startsWith('ledger.jsonl.tmp-'));
  assert.deepEqual(leftover, []);
  assert.equal(C.compactLedger(now), 2); // quiet retry succeeds
  assert.ok(!C.ledgerView(now).map((it) => it.id).includes('lg_stale'));
});

test('a fresh compaction lock makes this round skip; a stale one is swept and ignored', () => {
  freshDataDir();
  const now = Date.now();
  seedCompactableLedger(now);
  const lock = path.join(process.env.AIRCONTROL_DIR, 'ledger.compact.lock');
  fs.writeFileSync(lock, String(process.pid));
  assert.equal(C.compactLedger(now), 0); // someone else is compacting: skip
  assert.ok(fs.existsSync(lock)); // their lock is not ours to remove
  const old = now - 10 * 60 * 1000;
  fs.utimesSync(lock, old / 1000, old / 1000);
  assert.equal(C.compactLedger(now), 2); // stale lock: proceed
  assert.ok(!fs.existsSync(lock)); // and released afterwards
});

test('ledger priority is stored on add, defaults to normal, and drives the suggestion', () => {
  freshDataDir();
  const repo = tmpGitRepo('led-pri');
  const now = Date.now();
  C.cmdRegister({ session_id: 'worker-1', cwd: repo }, now);
  const repoKey = C.readSession('worker-1').repo;
  withCwd(repo, () => {
    captureStdout(() => C.cmdLedger({ _: ['ledger', 'add'], title: 'A normal', 'points-at': 'p' }, now));
    captureStdout(() => C.cmdLedger({ _: ['ledger', 'add'], title: 'B urgent', 'points-at': 'p', priority: 'urgent' }, now + 1));
    captureStdout(() => C.cmdLedger({ _: ['ledger', 'add'], title: 'C low', 'points-at': 'p', priority: 'low' }, now + 2));
    assert.throws(() => C.cmdLedger({ _: ['ledger', 'add'], title: 'D', 'points-at': 'p', priority: 'whenever' }, now + 3), /priority/);
  });
  const items = C.ledgerView(now + 10);
  const byTitle = Object.fromEntries(items.map((it) => [it.title, it]));
  assert.equal(byTitle['A normal'].priority, 'normal');
  assert.equal(byTitle['B urgent'].priority, 'urgent');
  assert.equal(byTitle['C low'].priority, 'low');
  assert.equal(C.suggestNextLedgerItem(items, repoKey).title, 'B urgent');
  assert.equal(C.suggestNextLedgerItem(items, 'some-other-repo'), null); // never suggests another repo's work
});

test('ledger dependencies hold an item back until the dep is done', () => {
  freshDataDir();
  const repo = tmpGitRepo('led-dep');
  const now = Date.now();
  C.cmdRegister({ session_id: 'worker-1', cwd: repo }, now);
  const repoKey = C.readSession('worker-1').repo;
  const [xId, yId] = withCwd(repo, () => {
    captureStdout(() => C.cmdLedger({ _: ['ledger', 'add'], title: 'X first', 'points-at': 'p' }, now));
    const x = C.ledgerView(now)[0].id;
    captureStdout(() => C.cmdLedger({ _: ['ledger', 'add'], title: 'Y second', 'points-at': 'p', 'depends-on': x, priority: 'urgent' }, now + 1));
    const y = C.ledgerView(now).find((it) => it.title === 'Y second').id;
    return [x, y];
  });
  let items = C.ledgerView(now + 10);
  assert.equal(items.find((it) => it.id === yId).state, 'blocked-on-deps');
  assert.equal(C.suggestNextLedgerItem(items, repoKey).id, xId); // urgent Y is blocked, X wins
  captureStdout(() => C.cmdLedger({ _: ['ledger', 'done', xId] }, now + 20));
  items = C.ledgerView(now + 30);
  assert.equal(items.find((it) => it.id === yId).state, 'open');
  assert.equal(C.suggestNextLedgerItem(items, repoKey).id, yId);
});

test('an untouched open item is flagged stale after the threshold', () => {
  freshDataDir();
  const repo = tmpGitRepo('led-stale');
  const now = Date.now();
  C.cmdRegister({ session_id: 'worker-1', cwd: repo }, now);
  withCwd(repo, () => captureStdout(() => C.cmdLedger({ _: ['ledger', 'add'], title: 'old thing', 'points-at': 'p' }, now)));
  const fresh = C.ledgerView(now + 1000)[0];
  assert.ok(!fresh.staleSince);
  const aged = C.ledgerView(now + C.LEDGER_STALE_MS + 1000)[0];
  assert.ok(aged.staleSince);
  assert.match(C.formatLedgerItem(aged, now + C.LEDGER_STALE_MS + 1000), /stale/);
});

test('handoff moves ownership, claims, and context, and nudges the recipient', () => {
  freshDataDir();
  const repo = tmpGitRepo('led-hand');
  const now = Date.now();
  C.cmdRegister({ session_id: 'aaaa-1', cwd: repo }, now);
  C.cmdRegister({ session_id: 'bbbb-1', cwd: repo }, now);
  captureStdout(() => C.cmdClaim({ session: 'aaaa', intent: 'store rework', paths: 'Store', resources: 'stash' }, now));
  const id = withCwd(repo, () => {
    captureStdout(() => C.cmdLedger({ _: ['ledger', 'add'], title: 'store rework', 'points-at': 'plans/store.md' }, now));
    return C.ledgerView(now)[0].id;
  });
  captureStdout(() => C.cmdLedger({ _: ['ledger', 'take', id], session: 'aaaa' }, now));
  captureStdout(() => C.cmdHandoff({ session: 'aaaa', to: 'bbbb', 'ledger-id': id, note: 'halfway; see plans/store.md §3' }, now + 1000));
  const item = C.ledgerView(now + 2000).find((it) => it.id === id);
  assert.equal(item.owner, 'bbbb-1');
  assert.equal(item.notes.at(-1).text, 'halfway; see plans/store.md §3');
  assert.deepEqual(C.readSession('bbbb-1').claims.paths, ['Store']);
  assert.deepEqual(C.readSession('bbbb-1').claims.resources, ['stash']);
  assert.deepEqual(C.readSession('aaaa-1').claims, { paths: [], resources: [] });
  const inbox = C.readInbox('bbbb-1');
  assert.equal(inbox.length, 1);
  assert.match(inbox[0].text, /handoff/i);
  assert.match(inbox[0].text, /halfway/);
  // only the owner may hand an item off
  assert.throws(
    () => captureStdout(() => C.cmdHandoff({ session: 'aaaa', to: 'bbbb', 'ledger-id': id }, now + 3000)),
    /owner/,
  );
});

test('the ledger notice appears once per session and returns after a re-register', () => {
  freshDataDir();
  const repo = tmpGitRepo('led-e');
  const now = Date.now();
  C.cmdRegister({ session_id: 'reader-1', cwd: repo }, now);
  withCwd(repo, () => captureStdout(() => C.cmdLedger({ _: ['ledger', 'add'], title: 'pick me up', 'points-at': 'plans/x.md' }, now)));

  const first = injectContext({ session_id: 'reader-1', cwd: repo }, now);
  assert.match(first, /\[aircontrol\] ledger: 1 open in aircontrol-led-e/);

  const second = injectContext({ session_id: 'reader-1', cwd: repo }, now + 1000);
  assert.doesNotMatch(second, /ledger:/); // not a per-prompt tax

  C.cmdRegister({ session_id: 'reader-1', cwd: repo }, now + 2000); // /clear or compact
  const third = injectContext({ session_id: 'reader-1', cwd: repo }, now + 3000);
  assert.match(third, /\[aircontrol\] ledger: 1 open/);
});

test('the ledger notice is omitted entirely when nothing is open', () => {
  freshDataDir();
  const repo = tmpGitRepo('led-f');
  const now = Date.now();
  C.cmdRegister({ session_id: 'quiet-1', cwd: repo }, now);
  const out = injectContext({ session_id: 'quiet-1', cwd: repo }, now);
  assert.doesNotMatch(out, /ledger:/);
});

test('renderLedgerLine separates here from elsewhere and flags abandoned work', () => {
  const line = C.renderLedgerLine({ here: 3, abandoned: 1, elsewhere: 5 }, 'myapp', '~/.claude/hooks/coord.js');
  assert.equal(line, '[aircontrol] ledger: 3 open in myapp (1 abandoned), 5 elsewhere — node ~/.claude/hooks/coord.js ledger list --repo .');
  assert.equal(C.renderLedgerLine({ here: 0, abandoned: 0, elsewhere: 0 }, 'x', 'y'), '');
});

test('a lease with no registered session survives until the TTL, then is reclaimed', () => {
  freshDataDir();
  const now = Date.now();
  const deps = stubDeps([IOS_A, IOS_B]);
  C.acquireDevice({ sessionId: 'never-registered', repo: 'r', nowMs: now }, deps);
  C.acquireDevice({ sessionId: 'also-unregistered', repo: 'r', nowMs: now }, deps);
  assert.equal(C.readLeases().length, 2); // no longer reclaimed on sight

  const later = now + C.LEASE_TTL_MS + 1000;
  C.acquireDevice({ sessionId: 'third', repo: 'r', nowMs: later }, deps);
  assert.deepEqual(C.readLeases().map((l) => l.sessionId), ['third']);
});

test('installedBundleIds reads apps off a shut-down simulator (simctl cannot)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aircontrol-simroot-'));
  process.env.AIRCONTROL_SIM_ROOT = root;
  const appDir = path.join(root, 'UDID-FS', 'data', 'Containers', 'Bundle', 'Application', 'C1', 'MyApp.app');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'Info.plist'),
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>' +
    '<key>CFBundleIdentifier</key><string>com.example.myapp</string></dict></plist>');

  assert.deepEqual([...C.installedBundleIds('UDID-FS')], ['com.example.myapp']);
  assert.equal(C.appInstalled({ platform: 'ios', key: 'UDID-FS' }, 'com.example.myapp'), true);
  assert.equal(C.appInstalled({ platform: 'ios', key: 'UDID-FS' }, 'com.havasi.cardstock'), false);
  assert.deepEqual([...C.installedBundleIds('UDID-NOT-THERE')], []);
  assert.equal(C.appInstalled({ platform: 'android', key: 'Medium_Phone' }, 'com.example.myapp'), null);
  delete process.env.AIRCONTROL_SIM_ROOT;
});

test('an explicit --name outranks a remembered affinity', () => {
  freshDataDir();
  const now = Date.now();
  C.writeAffinity({ repos: { rk: { platform: 'ios', key: 'UDID-A', name: 'iPhone 17', bundleId: 'b' } } });
  const deps = stubDeps([IOS_A, IOS_B], true);
  const res = C.acquireDevice({ sessionId: 's', repo: 'rk', prefer: 'Pro', nowMs: now }, deps);
  assert.equal(res.device.key, 'UDID-B'); // iPhone 17 Pro, not the affinity's plain iPhone 17
  assert.equal(C.affinityFor('rk').key, 'UDID-B'); // and the explicit choice becomes the new memory
});

test('block and unblock move an item in and out of blocked-on-human', () => {
  freshDataDir();
  const repo = tmpGitRepo('led-block');
  const now = Date.now();
  const id = withCwd(repo, () => {
    captureStdout(() => C.cmdLedger({ _: ['ledger', 'add'], title: 'awaiting a call', 'points-at': 'memory/x.md' }, now));
    return C.ledgerView(now)[0].id;
  });
  assert.equal(C.ledgerView(now)[0].state, 'open');
  captureStdout(() => C.cmdLedger({ _: ['ledger', 'block', id] }, now));
  assert.equal(C.ledgerView(now)[0].state, 'blocked-on-human');
  captureStdout(() => C.cmdLedger({ _: ['ledger', 'unblock', id], note: 'decision made' }, now));
  const back = C.ledgerView(now)[0];
  assert.equal(back.state, 'open');
  assert.equal(back.notes.at(-1).text, 'decision made');
});

// ---------- session-scoped cleanup ----------

const PS_SAMPLE = [
  '100 1 /opt/homebrew/bin/claude --session-id mine',          // this session's claude
  '19740 100 npm exec @playwright/mcp@latest',                 // playwright root (no token)
  '19742 19740 node .bin/playwright-mcp',
  '20541 19742 chrome --headless --type=renderer',             // browser binary grandchild
  '200 1 /opt/homebrew/bin/claude --session-id peer-live',     // a live peer's claude
  '28301 200 npm exec chrome-devtools-mcp@1.7.0',
  '28579 28301 chrome-devtools-mcp',
  '300 1 /opt/homebrew/bin/claude --session-id peer-dead',     // an exited peer: process lingers, no socket
  '31000 300 npm exec @playwright/mcp@latest',
  '31200 31000 node .bin/playwright-mcp',
  '40000 1 npm exec @playwright/mcp@latest',                   // reparented to launchd: no claude ancestor
  '99999 1 /usr/bin/some-unrelated-daemon --chrome-ish',       // not a browser MCP tree
].join('\n');

const SAMPLE_PROCS = C.parseProcTable(PS_SAMPLE);

test('selectBrowserProcs picks browser MCP procs and their descendants, ignoring unrelated ones', () => {
  const pids = C.selectBrowserProcs(SAMPLE_PROCS).map((p) => p.pid).sort((a, b) => a - b);
  assert.deepEqual(pids, [19740, 19742, 20541, 28301, 28579, 31000, 31200, 40000]);
});

test('classifyBrowserProcs splits trees by claude ancestor and socket liveness', () => {
  const { mine, others, orphaned } = C.classifyBrowserProcs(
    C.selectBrowserProcs(SAMPLE_PROCS), SAMPLE_PROCS, 100, new Set([100, 200]),
  );
  assert.deepEqual(mine.map((p) => p.pid), [19740, 19742, 20541]);   // playwright tree, no token, still mine
  assert.deepEqual(others.map((p) => p.pid), [28301, 28579]);        // live peer's, off-limits
  assert.deepEqual(orphaned.map((p) => p.pid).sort((a, b) => a - b), [31000, 31200, 40000]); // dead peer + launchd orphan
});

// The safety property: when socket liveness is unknown, a tree with a live-or-dead claude ancestor
// is NEVER orphaned on a guess — only a tree reparented to launchd (no claude ancestor at all) is.
test('unknown liveness orphans only launchd-reparented trees, never a resolvable ancestor', () => {
  const { mine, others, orphaned } = C.classifyBrowserProcs(
    C.selectBrowserProcs(SAMPLE_PROCS), SAMPLE_PROCS, 100, null,
  );
  assert.deepEqual(mine.map((p) => p.pid), [19740, 19742, 20541]);
  assert.deepEqual(orphaned.map((p) => p.pid), [40000]);
  assert.deepEqual(others.map((p) => p.pid).sort((a, b) => a - b), [28301, 28579, 31000, 31200]);
});

test('a playwright tree under a live non-Claude harness is an other, never an orphan', () => {
  const all = [
    { pid: 1, ppid: 0, command: '/sbin/launchd' },
    { pid: 13407, ppid: 1, command: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT' },
    { pid: 14788, ppid: 13407, command: '/Applications/ChatGPT.app/Contents/Resources/codex app-server' },
    { pid: 74083, ppid: 14788, command: 'npm exec @playwright/mcp@latest' },
    { pid: 74181, ppid: 74083, command: 'node /Users/x/.npm/_npx/abc/node_modules/.bin/playwright-mcp' },
  ];
  const procs = C.selectBrowserProcs(all);
  assert.ok(procs.length >= 1);
  for (const live of [new Set([100]), null]) {
    const { others, orphaned } = C.classifyBrowserProcs(procs, all, 100, live);
    assert.deepEqual(orphaned, []);
    assert.deepEqual(others.map((p) => p.pid).sort(), procs.map((p) => p.pid).sort());
  }
});

test('kill-mine refuses and exits non-zero when no claude ancestor resolves', () => {
  const prev = process.exitCode;
  const out = captureStdout(() => C.cmdBrowsers({ 'kill-mine': true }, {
    allProcs: SAMPLE_PROCS, myClaudePid: null, liveClaudePids: new Set([100, 200]), kill: () => {},
  }));
  assert.equal(process.exitCode, 1);
  assert.doesNotMatch(out, /killed/);
  process.exitCode = prev;
});

test('kill-orphaned refuses and exits non-zero when socket liveness is unknown', () => {
  const prev = process.exitCode;
  const out = captureStdout(() => C.cmdBrowsers({ 'kill-orphaned': true }, {
    allProcs: SAMPLE_PROCS, myClaudePid: 100, liveClaudePids: null, kill: () => {},
  }));
  assert.equal(process.exitCode, 1);
  assert.doesNotMatch(out, /reaped/);
  process.exitCode = prev;
});

test('kill-mine reaps this session\'s trees; kill-orphaned reaps only exited sessions\'', () => {
  const killedMine = [];
  captureStdout(() => C.cmdBrowsers({ 'kill-mine': true }, {
    allProcs: SAMPLE_PROCS, myClaudePid: 100, liveClaudePids: new Set([100, 200]), kill: (p) => killedMine.push(p),
  }));
  assert.deepEqual(killedMine.sort((a, b) => a - b), [19740, 19742, 20541]);
  const killedOrphan = [];
  captureStdout(() => C.cmdBrowsers({ 'kill-orphaned': true }, {
    allProcs: SAMPLE_PROCS, myClaudePid: 100, liveClaudePids: new Set([100, 200]), kill: (p) => killedOrphan.push(p),
  }));
  assert.deepEqual(killedOrphan.sort((a, b) => a - b), [31000, 31200, 40000]);
});

test('worktrees --others excludes your own session and lists everyone else', () => {
  freshDataDir();
  const now = Date.now();
  const a = tmpGitRepo('wt-a');
  const b = tmpGitRepo('wt-b');
  C.cmdRegister({ session_id: 'me-aaaaaa', cwd: a }, now);
  C.cmdRegister({ session_id: 'peer-bbbb', cwd: b }, now);
  C.cmdRegister({ session_id: 'dead-cccc', cwd: b }, now - C.STALE_MS - 1000);
  const out = captureStdout(() => C.cmdWorktrees({ _: ['worktrees'], others: true, session: 'me-a' }, now));
  assert.match(out, new RegExp(b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(out, new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(out, /dead/); // stale sessions do not block cleanup
});

// ---------- cross-machine mirror ----------

function writeSyncConfig(cfg) {
  fs.mkdirSync(process.env.AIRCONTROL_DIR, { recursive: true });
  fs.writeFileSync(C.configFile(), JSON.stringify(cfg));
}

test('repoUrlKey normalizes ssh and https origins to one identity', () => {
  assert.equal(C.repoUrlKey('git@github.com:me/myapp.git'), 'github.com/me/myapp');
  assert.equal(C.repoUrlKey('https://github.com/me/myapp.git'), 'github.com/me/myapp');
  assert.equal(C.repoUrlKey('https://user@github.com/me/myapp/'), 'github.com/me/myapp');
  assert.equal(C.repoUrlKey(''), null);
  assert.equal(C.repoUrlKey(null), null);
});

test('sync is a strict no-op without configured peers', () => {
  freshDataDir();
  const calls = [];
  C.cmdSync({ _: ['sync'] }, Date.now(), { rsync: (a) => calls.push(a), ssh: (h, c) => calls.push([h, c]) });
  assert.equal(calls.length, 0);
});

test('sync pushes local state to each peer and pulls theirs, failing open per peer', () => {
  freshDataDir();
  writeSyncConfig({ machine: 'macbook', peers: [{ name: 'devbox', host: 'me@devbox', dir: '~/.claude/agents' }] });
  C.appendLedgerEvent({ ts: new Date().toISOString(), event: 'add', id: 'lg_x', title: 't', pointsAt: 'p', repo: 'r' });
  const rsyncs = [];
  const sshs = [];
  C.cmdSync({ _: ['sync'] }, Date.now(), { rsync: (args) => rsyncs.push(args.join(' ')), ssh: (host, cmd) => sshs.push(`${host} ${cmd}`) });
  assert.ok(sshs.some((c) => c.includes('mkdir -p') && c.includes('remote/macbook')));
  // "~/…" must reach the remote shell as $HOME, never as a quoted literal tilde
  assert.ok(!sshs.some((c) => c.includes("'~")));
  assert.ok(sshs.some((c) => c.includes('$HOME/.claude/agents')));
  assert.ok(rsyncs.some((c) => c.includes('sessions/') && c.includes('me@devbox:') && c.includes('remote/macbook/sessions/')));
  assert.ok(rsyncs.some((c) => c.includes('ledger.jsonl') && c.includes('remote/macbook/')));
  assert.ok(rsyncs.some((c) => c.includes('me@devbox:') && c.includes('remote/devbox/sessions/')));
  // a dead peer never breaks the loop
  const boom = () => { throw new Error('unreachable'); };
  C.cmdSync({ _: ['sync'] }, Date.now(), { rsync: boom, ssh: boom });
  assert.match(fs.readFileSync(path.join(process.env.AIRCONTROL_DIR, 'sync.log'), 'utf8'), /unreachable/);
});

test('quoteForRemoteShell escapes embedded quotes instead of letting them close early', () => {
  // Plain (absolute) paths are single-quoted; an embedded "'" must become the
  // standard POSIX close-quote/escaped-quote/reopen-quote sequence, not a bare
  // "'" that would end the string early and hand the rest to the remote shell.
  assert.equal(C.quoteForRemoteShell('/plain/path'), "'/plain/path'");
  assert.equal(C.quoteForRemoteShell("/tmp/o'; touch pwned #"), "'/tmp/o'\\''; touch pwned #'");

  // "~/…" is rewritten to "$HOME/…" in double quotes so it expands remotely;
  // ", $, `, and \\ in the tail must be backslash-escaped, not passed through
  // raw, or they could close the string / trigger substitution.
  assert.equal(C.quoteForRemoteShell('~/sub/dir'), '"$HOME/sub/dir"');
  assert.equal(C.quoteForRemoteShell('~/o"; touch pwned; echo "'), '"$HOME/o\\"; touch pwned; echo \\""');
  assert.equal(C.quoteForRemoteShell('~/$(rm -rf /)'), '"$HOME/\\$(rm -rf /)"');
  assert.equal(C.quoteForRemoteShell('~/`whoami`'), '"$HOME/\\`whoami\\`"');
});

test('who folds pulled remote sessions in as display-only, tagged by machine', () => {
  freshDataDir();
  writeSyncConfig({ machine: 'macbook', peers: [{ name: 'devbox', host: 'x', dir: 'y' }] });
  const repo = tmpGitRepo('xm-who');
  const now = Date.now();
  C.cmdRegister({ session_id: 'aaaa-1', cwd: repo }, now);
  const rdir = path.join(process.env.AIRCONTROL_DIR, 'remote', 'devbox', 'sessions');
  fs.mkdirSync(rdir, { recursive: true });
  fs.writeFileSync(path.join(rdir, 'zzzz-9.json'), JSON.stringify({
    sessionId: 'zzzz-9', repo: '/home/me/side-project/.git', worktree: '/home/me/side-project',
    branch: 'main', intent: 'gallery work', claims: { paths: [], resources: [] },
    lastSeen: new Date(now).toISOString(),
  }));
  const text = captureStdout(() => C.cmdWho(now, {}));
  assert.match(text, new RegExp(`${C.friendlyName('zzzz-9')}@devbox`));
  const rows = JSON.parse(captureStdout(() => C.cmdWho(now, { json: true })));
  assert.equal(rows.find((r) => r.sessionId === 'zzzz-9').machine, 'devbox');
  assert.equal(rows.find((r) => r.sessionId === 'aaaa-1').machine, null);
  // guard and advisories see only local sessions: a remote claim never hard-blocks
  assert.equal(C.readSessions().some((s) => s.sessionId === 'zzzz-9'), false);
});

test('remote ledger events fold into the view, tagged by machine', () => {
  freshDataDir();
  writeSyncConfig({ machine: 'macbook', peers: [{ name: 'devbox', host: 'x', dir: 'y' }] });
  const now = Date.now();
  const rdir = path.join(process.env.AIRCONTROL_DIR, 'remote', 'devbox');
  fs.mkdirSync(rdir, { recursive: true });
  fs.writeFileSync(path.join(rdir, 'ledger.jsonl'),
    JSON.stringify({ ts: new Date(now).toISOString(), event: 'add', id: 'lg_far001', title: 'remote item', pointsAt: 'p', repo: '/home/me/side-project/.git', repoName: 'side-project' }) + '\n');
  C.appendLedgerEvent({ ts: new Date(now).toISOString(), event: 'add', id: 'lg_here01', title: 'local item', pointsAt: 'p', repo: '/tmp/x/.git' });
  const items = C.ledgerView(now + 10);
  const far = items.find((it) => it.id === 'lg_far001');
  assert.equal(far.machine, 'devbox');
  assert.equal(items.find((it) => it.id === 'lg_here01').machine, null);
  assert.match(C.formatLedgerItem(far, now + 10), /@devbox/);
});

test('messages to a remote session go to the outbox; pulled ones import exactly once', () => {
  freshDataDir();
  writeSyncConfig({ machine: 'macbook', peers: [{ name: 'devbox', host: 'x', dir: 'y' }] });
  const repo = tmpGitRepo('xm-msg');
  const now = Date.now();
  C.cmdRegister({ session_id: 'aaaa-1', cwd: repo }, now);
  const rdir = path.join(process.env.AIRCONTROL_DIR, 'remote', 'devbox', 'sessions');
  fs.mkdirSync(rdir, { recursive: true });
  fs.writeFileSync(path.join(rdir, 'zzzz-9.json'), JSON.stringify({
    sessionId: 'zzzz-9', repo: 'r', worktree: 'w', branch: 'main', intent: 'idle',
    claims: { paths: [], resources: [] }, lastSeen: new Date(now).toISOString(),
  }));
  captureStdout(() => C.cmdSend({ _: ['send', 'hello over there'], session: 'aaaa', to: C.friendlyName('zzzz-9') }, now));
  const outbox = path.join(process.env.AIRCONTROL_DIR, 'outbox', 'devbox', 'zzzz-9');
  assert.equal(fs.readdirSync(outbox).length, 1);
  // an inbound message mirrored from the peer imports into the real inbox once
  const inDir = path.join(process.env.AIRCONTROL_DIR, 'remote', 'devbox', 'outbox', 'macbook', 'aaaa-1');
  fs.mkdirSync(inDir, { recursive: true });
  fs.writeFileSync(path.join(inDir, `${now}-1.0-zzzz-9.md`), 'reply from devbox\n');
  // sweep imports too: a pull-only peer (no peers of its own, so it never runs
  // `sync`) must still deliver what the other side pushed into its mirror
  C.sweep(now);
  assert.equal(C.readInbox('aaaa-1').length, 1); // sweep alone delivered it
  C.importRemoteMessages(now); // idempotent: the mirror persists between syncs
  const inbox = C.readInbox('aaaa-1');
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].from, 'zzzz-9');
  assert.match(inbox[0].text, /reply from devbox/);
});

test('auto-sync fires only when opted in, and is throttled', () => {
  freshDataDir();
  const now = Date.now();
  const spawned = [];
  const spawn = (file, argv) => spawned.push(argv.join(' '));
  writeSyncConfig({ machine: 'mac', peers: [{ name: 'p', host: 'h', dir: 'd' }] }); // no autoSync flag
  assert.equal(C.maybeAutoSync(now, spawn), false);
  writeSyncConfig({ machine: 'mac', peers: [{ name: 'p', host: 'h', dir: 'd' }], autoSync: true });
  assert.equal(C.maybeAutoSync(now, spawn), true);
  assert.equal(C.maybeAutoSync(now + 1000, spawn), false); // throttled
  assert.equal(spawned.length, 1);
  assert.match(spawned[0], /sync$/);
});

test('path-hostile ids never escape the data dir', () => {
  freshDataDir();
  const now = Date.now();
  // a hook payload with a traversal id registers nothing, silently
  C.cmdRegister({ session_id: 'good-1', cwd: process.cwd() }, now);
  C.cmdRegister({ session_id: '../evil', cwd: process.cwd() }, now);
  C.cmdRegister({ session_id: 'a/b', cwd: process.cwd() }, now);
  assert.deepEqual(fs.readdirSync(path.join(process.env.AIRCONTROL_DIR, 'sessions')), ['good-1.json']);
  assert.equal(fs.existsSync(path.join(process.env.AIRCONTROL_DIR, 'evil.json')), false);
  // a pulled remote session file with a traversal id is dropped on read
  writeSyncConfig({ machine: 'macbook', peers: [{ name: 'devbox', host: 'x', dir: 'y' }] });
  const rdir = path.join(process.env.AIRCONTROL_DIR, 'remote', 'devbox', 'sessions');
  fs.mkdirSync(rdir, { recursive: true });
  fs.writeFileSync(path.join(rdir, 'evil.json'), JSON.stringify({
    sessionId: '../../outside', repo: 'r', worktree: 'w', branch: 'b', intent: 'idle',
    claims: { paths: [], resources: [] }, lastSeen: new Date(now).toISOString(),
  }));
  assert.equal(C.readRemoteSessions().length, 0);
});

test('rankToolResults weights by resends, not raw size', () => {
  // The big result lands last and is paid once; the smaller one lands early and is re-sent 90x.
  const ranked = C.rankToolResults([
    { turn: 99, bytes: 47_000, name: 'late-big' },
    { turn: 10, bytes: 8_000, name: 'early-small' },
  ], 100);
  assert.equal(ranked[0].name, 'early-small');
  assert.equal(ranked[0].cost, 8_000 * 90);
});

test('readTranscript totals usage and survives torn lines', () => {
  freshDataDir();
  const f = path.join(process.env.AIRCONTROL_DIR, 't.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify({ message: { usage: { output_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 9000 }, content: [{ type: 'tool_result', content: 'x'.repeat(2000) }] } }),
    '{ this is not json',
    JSON.stringify({ message: { usage: { output_tokens: 10 }, content: [] } }),
  ].join('\n'));
  const { rows, usage, turns } = C.readTranscript(f);
  assert.equal(usage.output, 110);
  assert.equal(usage.cacheCreation, 50);
  assert.equal(usage.cacheRead, 9000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bytes, 2000);
  assert.equal(turns, 2); // the torn line is skipped, not counted
});

// --- live context budget ---

// A transcript with a mix of sized results, so delta totals have something to disagree with.
function budgetFixture(n = 40) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(JSON.stringify({
      message: {
        usage: { output_tokens: 10 },
        content: [
          { type: 'tool_use', id: `call-${i}`, name: i % 3 === 0 ? 'Read' : 'Bash', input: { file_path: `shot-${i}.jpg` } },
        ],
      },
    }));
    lines.push(JSON.stringify({
      message: { content: [{ type: 'tool_result', tool_use_id: `call-${i}`, content: 'x'.repeat(100 + i * 37) }] },
    }));
  }
  return lines.join('\n') + '\n';
}

// The anti-drift test that matters most: if the incremental meter and retro ever disagree,
// the operator is shown one number and billed another.
test('readTranscriptDelta replayed in chunks equals a full readTranscript', () => {
  freshDataDir();
  const raw = Buffer.from(budgetFixture(), 'utf8');
  const src = path.join(process.env.AIRCONTROL_DIR, 'full.jsonl');
  fs.writeFileSync(src, raw);
  const full = C.readTranscript(src);
  const fullBytes = full.rows.reduce((n, r) => n + r.bytes, 0);

  // 1 byte at a time is the pathological case: every append lands mid-line, most mid-JSON.
  for (const step of [1, 13, 512, 1 << 20]) {
    const f = path.join(process.env.AIRCONTROL_DIR, `replay-${step}.jsonl`);
    fs.writeFileSync(f, '');
    let b = C.emptyBudget();
    for (let off = 0; off < raw.length; off += step) {
      fs.appendFileSync(f, raw.subarray(off, Math.min(off + step, raw.length)));
      b = C.readTranscriptDelta(f, b);
    }
    assert.equal(b.bytes, fullBytes, `bytes at step ${step}`);
    assert.equal(b.turns, full.turns, `turns at step ${step}`);
    assert.equal(b.results, full.rows.length, `results at step ${step}`);
    assert.deepEqual(
      C.budgetTop(b).slice(0, C.BUDGET_TOP_N).map((r) => `${r.name}:${r.bytes}`),
      C.rankToolResults(full.rows, full.turns).slice(0, C.BUDGET_TOP_N).map((r) => `${r.name}:${r.bytes}`),
      `top at step ${step}`,
    );
  }
});

test('readTranscriptDelta leaves a torn trailing line for the next turn', () => {
  freshDataDir();
  const f = path.join(process.env.AIRCONTROL_DIR, 'torn.jsonl');
  const whole = JSON.stringify({ message: { content: [{ type: 'tool_result', content: 'y'.repeat(500) }] } });
  fs.writeFileSync(f, whole + '\n' + whole.slice(0, 30)); // second record half-written
  let b = C.readTranscriptDelta(f, C.emptyBudget());
  assert.equal(b.results, 1);
  assert.equal(b.bytes, 500);
  fs.writeFileSync(f, whole + '\n' + whole + '\n'); // the writer finishes it
  b = C.readTranscriptDelta(f, b);
  assert.equal(b.results, 2, 'the completed line is counted exactly once');
  assert.equal(b.bytes, 1000);
});

// Compaction, rotation, or a fresh transcript on the same path all shrink the file. Adding
// the new tail to the old totals would silently inflate every number after it.
test('readTranscriptDelta restarts when the transcript shrinks', () => {
  freshDataDir();
  const f = path.join(process.env.AIRCONTROL_DIR, 'rotate.jsonl');
  fs.writeFileSync(f, budgetFixture(20));
  const before = C.readTranscriptDelta(f, C.emptyBudget());
  assert.ok(before.bytes > 0);
  const small = JSON.stringify({ message: { content: [{ type: 'tool_result', content: 'z'.repeat(70) }] } }) + '\n';
  fs.writeFileSync(f, small);
  const after = C.readTranscriptDelta(f, before);
  assert.equal(after.results, 1, 'counts only the new file');
  assert.equal(after.bytes, 70);
  assert.equal(after.offset, Buffer.byteLength(small, 'utf8'));
});

// The hint is the actionable half — "Read shot.jpg" is a rule you can change, "13k on turn
// 149" is not. It survives only if the tool_use is remembered across the chunk boundary.
test('readTranscriptDelta pairs a tool_use with a tool_result from a later chunk', () => {
  freshDataDir();
  const f = path.join(process.env.AIRCONTROL_DIR, 'span.jsonl');
  const use = JSON.stringify({ message: { content: [{ type: 'tool_use', id: 'c1', name: 'Read', input: { file_path: 'shot.jpg' } }] } });
  const res = JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'q'.repeat(900) }] } });
  fs.writeFileSync(f, use + '\n');
  let b = C.readTranscriptDelta(f, C.emptyBudget());
  assert.equal(b.results, 0);
  fs.appendFileSync(f, res + '\n');
  b = C.readTranscriptDelta(f, b);
  assert.equal(C.budgetTop(b)[0].name, 'Read');
  assert.equal(C.budgetTop(b)[0].hint, 'shot.jpg');
});

test('renderBudgetLine stays silent below the thresholds', () => {
  const th = { totalBytes: 400000, singleBytes: 60000 };
  assert.equal(C.renderBudgetLine(C.emptyBudget(), th), '');
  const quiet = { offset: 10, bytes: 5000, turns: 20, results: 3, pool: [{ name: 'Bash', hint: 'ls', bytes: 2000, turn: 2 }], pending: [] };
  assert.equal(C.renderBudgetLine(quiet, th), '');
});

test('renderBudgetLine fires on one oversized result and names it', () => {
  const th = { totalBytes: 400000, singleBytes: 60000 };
  const loud = { offset: 10, bytes: 90000, turns: 100, results: 4, pool: [{ name: 'Read', hint: 'shot.jpg', bytes: 61000, turn: 10 }], pending: [] };
  const line = C.renderBudgetLine(loud, th);
  assert.match(line, /^\[aircontrol\] context: 90k tool results/);
  assert.match(line, /costliest: Read shot\.jpg 61k x90/);
});

test('renderBudgetLine fires on cumulative bytes with no single offender', () => {
  const th = { totalBytes: 400000, singleBytes: 60000 };
  const loud = { offset: 10, bytes: 1_900_000, turns: 150, results: 80, pool: [{ name: 'Bash', hint: 'grep -rn x', bytes: 20000, turn: 5 }], pending: [] };
  assert.match(C.renderBudgetLine(loud, th), /^\[aircontrol\] context: 1\.9MB tool results \(~475k tok, 80 results\)/);
});

test('remediationHint keys the fix to the offender shape, not raw bytes', () => {
  assert.equal(C.remediationHint(null), '');
  assert.match(C.remediationHint({ name: 'Read', hint: 'shot.jpg' }), /downsize before reading/);
  assert.match(C.remediationHint({ name: 'Read', hint: 'notes.md' }), /re-read a slice/);
  assert.match(C.remediationHint({ name: 'Bash', hint: 'grep -rn x' }), /delegate this fan-out/);
});

test('renderBudgetLine appends a fix hint next to the offender it names', () => {
  const th = { totalBytes: 400000, singleBytes: 60000 };
  const loud = { offset: 10, bytes: 90000, turns: 100, results: 4, pool: [{ name: 'Read', hint: 'shot.jpg', bytes: 61000, turn: 10 }], pending: [] };
  assert.match(C.renderBudgetLine(loud, th), /fix: downsize before reading \(sips -Z 900\)$/);
});

test('renderBudgetLine stays silent below thresholds even though a fix hint would apply', () => {
  const th = { totalBytes: 400000, singleBytes: 60000 };
  const quiet = { offset: 10, bytes: 5000, turns: 20, results: 3, pool: [{ name: 'Read', hint: 'shot.jpg', bytes: 2000, turn: 2 }], pending: [] };
  assert.equal(C.renderBudgetLine(quiet, th), '');
});

test('cmdRetro prints a fix line keyed to the costliest offender', () => {
  freshDataDir();
  const f = path.join(process.env.AIRCONTROL_DIR, 'retro-fix.jsonl');
  const lines = [
    JSON.stringify({ message: { usage: { output_tokens: 5 }, content: [{ type: 'tool_use', id: 'c1', name: 'Read', input: { file_path: 'shot.jpg' } }] } }),
    JSON.stringify({ message: { usage: { output_tokens: 5 }, content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'x'.repeat(70000) }] } }),
    JSON.stringify({ message: { usage: { output_tokens: 5 }, content: [{ type: 'tool_use', id: 'c2', name: 'Bash', input: { command: 'ls' } }] } }),
    JSON.stringify({ message: { usage: { output_tokens: 5 }, content: [{ type: 'tool_result', tool_use_id: 'c2', content: 'x'.repeat(100) }] } }),
  ];
  fs.writeFileSync(f, lines.join('\n') + '\n');
  const out = captureStdout(() => C.cmdRetro({ file: f }));
  assert.match(out, /costliest results/);
  assert.match(out, /fix: downsize before reading \(sips -Z 900\)/);
});

// The solo path is the common case and the one the retro data came from; an early return
// that drops the line would hide it exactly where it matters most.
test('renderInjection: solo one-liner still carries the budget line', () => {
  const now = Date.parse('2026-07-16T12:00:00Z');
  const self = mkSession({});
  const out = C.renderInjection(self, [], [], now, '~/.claude/hooks/coord.js', '', '[aircontrol] context: 1.9MB tool results');
  assert.match(out, /no other sessions/);
  assert.match(out, /context: 1\.9MB tool results/);
});

test('renderInjection: budget line rides along with peers present', () => {
  const now = Date.parse('2026-07-16T12:00:00Z');
  const self = mkSession({});
  const peer = mkSession({ sessionId: 'peer-1111', worktree: '/repo/a-wt2', intent: 'other work' });
  const out = C.renderInjection(self, [peer], [], now, '~/.claude/hooks/coord.js', '', '[aircontrol] context: 900k tool results');
  assert.match(out, /context: 900k tool results/);
});

test('budgetThresholds honours config.json overrides and ignores junk', () => {
  freshDataDir();
  fs.writeFileSync(C.configFile(), JSON.stringify({ budget: { totalBytes: 12345, singleBytes: 'nope' } }));
  const th = C.budgetThresholds();
  assert.equal(th.totalBytes, 12345);
  assert.equal(th.singleBytes, C.BUDGET_DEFAULTS.singleBytes);
});

test('cmdInject meters the transcript and persists the budget on the session', () => {
  freshDataDir();
  const repo = tmpGitRepo('budget-inject');
  const now = Date.now();
  const tr = path.join(process.env.AIRCONTROL_DIR, 'inject.jsonl');
  const big = JSON.stringify({ message: { content: [
    { type: 'tool_use', id: 'b1', name: 'Read', input: { file_path: 'huge.jpg' } },
  ] } });
  const res = JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'x'.repeat(70000) }] } });
  fs.writeFileSync(tr, big + '\n' + res + '\n');
  C.cmdRegister({ session_id: 'bud-1', cwd: repo }, now);
  const out = injectContext({ session_id: 'bud-1', cwd: repo, transcript_path: tr }, now);
  assert.match(out, /context: 70k tool results/);
  assert.match(out, /costliest: Read huge\.jpg/);
  const saved = C.readSession('bud-1');
  assert.equal(saved.budget.bytes, 70000);
  assert.ok(saved.budget.offset > 0);

  // A second prompt with nothing appended must not re-count the same bytes.
  injectContext({ session_id: 'bud-1', cwd: repo, transcript_path: tr }, now + 1000);
  assert.equal(C.readSession('bud-1').budget.bytes, 70000);
});

test('cmdInject survives a missing transcript without losing the roster block', () => {
  freshDataDir();
  const repo = tmpGitRepo('budget-missing');
  const now = Date.now();
  C.cmdRegister({ session_id: 'bud-2', cwd: repo }, now);
  const out = injectContext({ session_id: 'bud-2', cwd: repo, transcript_path: '/nope/absent.jsonl' }, now);
  assert.match(out, /\[aircontrol\]/);
  assert.doesNotMatch(out, /context:/);
});

// --- Codex rollouts ---
//
// Codex writes a different transcript: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`,
// one `{type, payload}` record per line. Tool calls are `response_item`s paired by `call_id`,
// and `event_msg/token_count` carries the cumulative usage the harness itself computed.

function codexFixture(n = 30) {
  const lines = [JSON.stringify({ timestamp: 't0', type: 'session_meta', payload: { id: 'cx', cwd: '/w' } })];
  for (let i = 0; i < n; i++) {
    lines.push(JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'go' } }));
    if (i % 3 === 0) {
      lines.push(JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: `c-${i}`, arguments: JSON.stringify({ cmd: `cat shot-${i}.jpg` }) } }));
      lines.push(JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: `c-${i}`, output: 'x'.repeat(100 + i * 37) } }));
    } else {
      lines.push(JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: `c-${i}`, input: `ls shot-${i}` } }));
      lines.push(JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: `c-${i}`, output: [
        { type: 'input_text', text: 'x'.repeat(50 + i * 20) }, { type: 'input_text', text: 'y'.repeat(50 + i * 17) },
      ] } }));
    }
    if (i % 5 === 4) {
      lines.push(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: {
        input_tokens: 1000 * (i + 1), cached_input_tokens: 400 * (i + 1), output_tokens: 100 * (i + 1), total_tokens: 1100 * (i + 1),
      } } } }));
    }
  }
  return lines.join('\n') + '\n';
}

function codexFixtureBytes(n = 30) {
  let total = 0;
  for (let i = 0; i < n; i++) total += i % 3 === 0 ? 100 + i * 37 : (50 + i * 20) + (50 + i * 17);
  return total;
}

function withCodexHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  const prevHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try { return fn(home); } finally {
    if (prevHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevHome;
  }
}

test('readTranscript parses a Codex rollout: pairs call_id to output, sums array outputs, keeps the last token_count', () => {
  freshDataDir();
  const f = path.join(process.env.AIRCONTROL_DIR, 'rollout.jsonl');
  fs.writeFileSync(f, codexFixture(30));
  const { rows, usage, turns } = C.readTranscript(f);
  assert.equal(rows.length, 30);
  assert.equal(rows.reduce((n, r) => n + r.bytes, 0), codexFixtureBytes(30));
  assert.equal(turns, 60, 'every response_item is a model-visible turn');
  assert.deepEqual({ name: rows[0].name, hint: rows[0].hint }, { name: 'exec_command', hint: 'cat shot-0.jpg' });
  assert.deepEqual({ name: rows[1].name, hint: rows[1].hint }, { name: 'exec', hint: 'ls shot-1' });
  assert.deepEqual(usage.codex, { input: 30000, cached: 12000, output: 3000, total: 33000 });
  assert.equal(usage.messages, 0, 'no Claude-style usage blocks were counted');
});

test('readTranscriptDelta replayed in chunks equals a full readTranscript for a Codex rollout', () => {
  freshDataDir();
  const raw = Buffer.from(codexFixture(), 'utf8');
  const src = path.join(process.env.AIRCONTROL_DIR, 'cx-full.jsonl');
  fs.writeFileSync(src, raw);
  const full = C.readTranscript(src);
  const fullBytes = full.rows.reduce((n, r) => n + r.bytes, 0);
  assert.ok(fullBytes > 0, 'the fixture must parse, or every equality below is 0 == 0');
  const key = (r) => [r.name, r.hint, r.bytes, r.turn];
  for (const step of [1, 13, 512, 1 << 20]) {
    const f = path.join(process.env.AIRCONTROL_DIR, `cx-replay-${step}.jsonl`);
    fs.writeFileSync(f, '');
    let b = C.emptyBudget();
    for (let off = 0; off < raw.length; off += step) {
      fs.appendFileSync(f, raw.subarray(off, Math.min(off + step, raw.length)));
      b = C.readTranscriptDelta(f, b);
    }
    assert.equal(b.bytes, fullBytes, `bytes at step ${step}`);
    assert.equal(b.turns, full.turns, `turns at step ${step}`);
    assert.equal(b.results, full.rows.length, `results at step ${step}`);
    const top = C.budgetTop(b);
    assert.deepEqual(top.map(key), C.rankToolResults(full.rows, full.turns).slice(0, top.length).map(key), `ranking at step ${step}`);
  }
});

test('readTranscriptDelta pairs a Codex call with its output from a later chunk', () => {
  freshDataDir();
  const f = path.join(process.env.AIRCONTROL_DIR, 'cx-span.jsonl');
  const call = JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'k1', input: 'sips -Z 900 shot.jpg' } });
  const out = JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'k1', output: [{ type: 'input_text', text: 'q'.repeat(900) }] } });
  fs.writeFileSync(f, call + '\n');
  let b = C.readTranscriptDelta(f, C.emptyBudget());
  assert.equal(b.results, 0);
  fs.appendFileSync(f, out + '\n');
  b = C.readTranscriptDelta(f, b);
  assert.equal(C.budgetTop(b)[0].name, 'exec');
  assert.equal(C.budgetTop(b)[0].hint, 'sips -Z 900 shot.jpg');
  assert.equal(C.budgetTop(b)[0].bytes, 900);
});

test('cmdInject meters a Codex rollout passed as transcript_path', () => {
  freshDataDir();
  const repo = tmpGitRepo('budget-codex');
  const now = Date.now();
  const tr = path.join(process.env.AIRCONTROL_DIR, 'cx-inject.jsonl');
  const call = JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'b1', arguments: JSON.stringify({ cmd: 'cat huge.jpg' }) } });
  const out = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'b1', output: 'x'.repeat(70000) } });
  fs.writeFileSync(tr, call + '\n' + out + '\n');
  const ctx = injectContext({ session_id: 'cxb-1', cwd: repo, transcript_path: tr }, now, 'codex');
  assert.match(ctx, /context: 70k tool results/);
  assert.match(ctx, /costliest: exec_command cat huge\.jpg/);
  const saved = C.readSession('cxb-1');
  assert.equal(saved.harness, 'codex');
  assert.equal(saved.transcriptPath, tr);
  assert.equal(saved.budget.bytes, 70000);
});

test('register stores transcript_path and beat persists a newly seen one even inside the debounce window', () => {
  freshDataDir();
  const repo = tmpGitRepo('tp-persist');
  const now = Date.now();
  C.cmdRegister({ session_id: 'tp-00001', cwd: repo, transcript_path: null }, now);
  assert.equal(C.readSession('tp-00001').transcriptPath, null);
  C.cmdBeat({ session_id: 'tp-00001', cwd: repo, transcript_path: '/x/rollout-a.jsonl', tool_name: 'Read', tool_input: {} }, now + 10);
  assert.equal(C.readSession('tp-00001').transcriptPath, '/x/rollout-a.jsonl', 'a debounced beat still records the path');
  C.cmdRegister({ session_id: 'tp-00001', cwd: repo }, now + 20);
  assert.equal(C.readSession('tp-00001').transcriptPath, '/x/rollout-a.jsonl', 're-register without a path keeps the known one');
  C.cmdRegister({ session_id: 'tp-00001', cwd: repo, transcript_path: '/x/rollout-b.jsonl' }, now + 30);
  assert.equal(C.readSession('tp-00001').transcriptPath, '/x/rollout-b.jsonl', 'a fresh path from the payload wins');
});

test('sessionTranscript prefers the payload, then the stored path, then the Claude slug, and null for a pathless codex session', () => {
  const stored = { transcriptPath: '/stored/rollout.jsonl', harness: 'codex' };
  assert.equal(C.sessionTranscript({ transcript_path: '/live/t.jsonl' }, 'id', stored), '/live/t.jsonl');
  assert.equal(C.sessionTranscript({}, 'id', stored), '/stored/rollout.jsonl');
  assert.equal(C.sessionTranscript({ cwd: '/w' }, 'id', { harness: 'claude' }), path.join(C.transcriptDir('/w'), 'id.jsonl'));
  assert.equal(C.sessionTranscript({ cwd: '/w' }, 'id'), path.join(C.transcriptDir('/w'), 'id.jsonl'));
  assert.equal(C.sessionTranscript({ cwd: '/w' }, 'id', { harness: 'codex' }), null, 'the Claude slug is never a Codex transcript');
});

test('findCodexRollout walks CODEX_HOME/sessions/YYYY/MM/DD, matches an id prefix, newest wins, null when absent', () => {
  withCodexHome((home) => {
    const mk = (d, name, ageMs) => {
      const dir = path.join(home, 'sessions', ...d);
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, name);
      fs.writeFileSync(f, '');
      const t = (Date.now() - ageMs) / 1000;
      fs.utimesSync(f, t, t);
      return f;
    };
    const older = mk(['2026', '09', '05'], 'rollout-2026-09-05T10-00-00-abc-1111.jsonl', 60000);
    const newer = mk(['2026', '09', '06'], 'rollout-2026-09-06T10-00-00-abc-2222.jsonl', 1000);
    mk(['2026', '09', '06'], 'notes.txt', 0);
    assert.equal(C.findCodexRollout('abc-1111'), older);
    assert.equal(C.findCodexRollout('abc'), newer, 'prefix matches pick the newest');
    const archive = path.join(home, 'archived_sessions');
    fs.mkdirSync(archive, { recursive: true });
    const archived = path.join(archive, 'rollout-2026-09-04T10-00-00-archived-3333.jsonl');
    fs.writeFileSync(archived, '');
    assert.equal(C.findCodexRollout('archived-3333'), archived, 'archived rollouts remain discoverable');
    assert.equal(C.findCodexRollout('zzz'), null);
    process.env.CODEX_HOME = path.join(home, 'nope');
    assert.equal(C.findCodexRollout('abc'), null, 'a missing sessions dir is not an error');
  });
});

test('bare retro resolves the sole live session in the current worktree and rejects ambiguity', () => {
  freshDataDir();
  const repo = tmpGitRepo('retro-live-cwd');
  const now = Date.now();
  const first = path.join(process.env.AIRCONTROL_DIR, 'first.jsonl');
  const second = path.join(process.env.AIRCONTROL_DIR, 'second.jsonl');
  fs.writeFileSync(first, codexFixture(2));
  fs.writeFileSync(second, codexFixture(2));
  C.cmdRegister({ session_id: 'retro-stale', cwd: repo, transcript_path: second }, now - C.STALE_MS - 1, 'codex');
  C.cmdRegister({ session_id: 'retro-one', cwd: repo, transcript_path: first }, now, 'codex');
  assert.equal(C.resolveRetroTranscript({ cwd: repo }).file, first);
  C.cmdRegister({ session_id: 'retro-two', cwd: repo, transcript_path: second }, now, 'codex');
  const ambiguous = C.resolveRetroTranscript({ cwd: repo });
  assert.equal(ambiguous.file, null);
  assert.deepEqual(ambiguous.ambiguous.sort(), [C.friendlyName('retro-one'), C.friendlyName('retro-two')].sort());
});

test('cmdRetro --session resolves a live session name to its stored transcriptPath, else a Codex rollout by id', () => {
  freshDataDir();
  const repo = tmpGitRepo('retro-codex');
  const now = Date.now();
  withCodexHome((home) => {
    const stored = path.join(process.env.AIRCONTROL_DIR, 'stored-rollout.jsonl');
    fs.writeFileSync(stored, codexFixture(10));
    C.cmdRegister({ session_id: 'rt-live-1', cwd: repo, transcript_path: stored }, now, 'codex');
    const byName = captureStdout(() => C.cmdRetro({ session: C.friendlyName('rt-live-1') }));
    assert.match(byName, /transcript stored-rollout\.jsonl/);
    assert.match(byName, /tokens \(Codex, cumulative\): 11k total/);
    assert.doesNotMatch(byName, /billed-ish/);

    const dir = path.join(home, 'sessions', '2026', '09', '06');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'rollout-2026-09-06T10-00-00-019f-dead.jsonl'), codexFixture(5));
    const byId = captureStdout(() => C.cmdRetro({ session: '019f-dead' }));
    assert.match(byId, /transcript rollout-2026-09-06T10-00-00-019f-dead\.jsonl/);
  });
});

// Trees reparented to launchd share pid 1 as an "ancestor". Attribution must never resolve a
// `claude` owner through pid 1, or one dead session's launchd orphan would look like everyone's.
test('attribution never resolves an owner through pid 1', () => {
  const all = C.parseProcTable([
    '500 1 npm exec @playwright/mcp@latest',        // launchd orphan
    '501 500 node .bin/playwright-mcp',
    '100 1 /opt/homebrew/bin/claude --mine',
    '600 100 chrome-devtools-mcp',                  // genuinely mine
  ].join('\n'));
  const { mine, orphaned } = C.classifyBrowserProcs(C.selectBrowserProcs(all), all, 100, new Set([100]));
  assert.deepEqual(mine.map((p) => p.pid), [600]);              // resolves up to claude 100
  assert.deepEqual(orphaned.map((p) => p.pid).sort((a, b) => a - b), [500, 501]); // no claude ancestor
});

test('attribution follows both sibling MCP trees of one real session up to its claude', () => {
  const all = C.parseProcTable([
    '800 1 /opt/homebrew/bin/claude --mine',
    '900 800 npm exec @playwright/mcp@latest',      // playwright: carries no token, still resolves
    '901 900 node .bin/playwright-mcp',
    '910 800 npm exec chrome-devtools-mcp@1.7.0',
    '911 910 chrome-devtools-mcp',
  ].join('\n'));
  const { mine } = C.classifyBrowserProcs(C.selectBrowserProcs(all), all, 800, new Set([800]));
  assert.deepEqual(mine.map((p) => p.pid).sort((a, b) => a - b), [900, 901, 910, 911]);
});

// ---------- activity log ----------

function readActivityDay(nowMs) {
  const f = path.join(process.env.AIRCONTROL_DIR, 'activity', `${C.localDateStr(nowMs)}.jsonl`);
  try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
}

test('localDateStr renders the local calendar date, zero-padded', () => {
  const ms = new Date(2026, 0, 5, 9, 30).getTime(); // local Jan 5
  assert.equal(C.localDateStr(ms), '2026-01-05');
});

test('logActivity appends to the day file, creating the directory on demand', () => {
  freshDataDir();
  const now = Date.now();
  C.logActivity({ ev: 'session-start', sid: 'x' }, now);
  C.logActivity({ ev: 'files', sid: 'x', paths: ['a.js'] }, now);
  const events = readActivityDay(now);
  assert.equal(events.length, 2);
  assert.equal(events[0].ev, 'session-start');
  assert.deepEqual(events[1].paths, ['a.js']);
});

test('logActivity never throws, even when the activity dir is unwritable', () => {
  const d = freshDataDir();
  fs.writeFileSync(path.join(d, 'activity'), 'a file, not a dir');
  assert.doesNotThrow(() => C.logActivity({ ev: 'claim' }, Date.now()));
});

test('readActivityFiles: --date exact, --days window, junk filenames ignored', () => {
  const d = freshDataDir();
  const dir = path.join(d, 'activity');
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date(2026, 8, 3, 12, 0).getTime(); // local 2026-09-03
  for (const day of ['2026-08-30', '2026-09-01', '2026-09-02', '2026-09-03']) {
    fs.writeFileSync(path.join(dir, `${day}.jsonl`), '');
  }
  fs.writeFileSync(path.join(dir, 'notes.txt'), '');
  fs.writeFileSync(path.join(dir, '2026-09-03.jsonl.tmp'), '');
  assert.deepEqual(C.readActivityFiles(now, { date: '2026-09-01' }), ['2026-09-01.jsonl']);
  assert.deepEqual(C.readActivityFiles(now, {}), ['2026-09-03.jsonl']); // default: today
  assert.deepEqual(C.readActivityFiles(now, { days: 3 }), ['2026-09-01.jsonl', '2026-09-02.jsonl', '2026-09-03.jsonl']);
  assert.deepEqual(C.readActivityFiles(now, { days: 30 }), ['2026-08-30.jsonl', '2026-09-01.jsonl', '2026-09-02.jsonl', '2026-09-03.jsonl']);
});

test('readActivityEvents parses lines and silently skips torn ones', () => {
  const d = freshDataDir();
  const dir = path.join(d, 'activity');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2026-09-03.jsonl'), '{"ev":"claim"}\n{"ev":"rel\n{"ev":"files"}\n');
  const events = C.readActivityEvents(['2026-09-03.jsonl']);
  assert.deepEqual(events.map((e) => e.ev), ['claim', 'files']);
});

test('activityRetentionDays: null when unset or invalid, honors config value', () => {
  freshDataDir();
  assert.equal(C.activityRetentionDays(), null);
  fs.writeFileSync(path.join(process.env.AIRCONTROL_DIR, 'config.json'), JSON.stringify({ activityRetentionDays: 'soon' }));
  assert.equal(C.activityRetentionDays(), null);
  fs.writeFileSync(path.join(process.env.AIRCONTROL_DIR, 'config.json'), JSON.stringify({ activityRetentionDays: 45 }));
  assert.equal(C.activityRetentionDays(), 45);
});

test('pruneActivity removes only day files strictly older than the cutoff', () => {
  const d = freshDataDir();
  const dir = path.join(d, 'activity');
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date(2026, 8, 3, 12, 0).getTime(); // local 2026-09-03
  for (const day of ['2026-07-01', '2026-08-04', '2026-09-03']) {
    fs.writeFileSync(path.join(dir, `${day}.jsonl`), '');
  }
  fs.writeFileSync(path.join(dir, 'notes.txt'), '');
  const removed = C.pruneActivity(now, 30);
  assert.equal(removed, 1); // only 2026-07-01 is older than 30 days
  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-08-04.jsonl', '2026-09-03.jsonl', 'notes.txt']);
});

test('classifyCommand recognizes notable commands and returns every match', () => {
  assert.deepEqual(C.classifyCommand(''), []);
  assert.deepEqual(C.classifyCommand('ls -la && npm test'), []);
  assert.deepEqual(C.classifyCommand('xcrun simctl boot 0A1B2C3D-1111-2222-3333-444455556666'),
    [{ kind: 'sim-boot', key: '0A1B2C3D-1111-2222-3333-444455556666' }]);
  assert.deepEqual(C.classifyCommand('emulator -avd Pixel_7 -no-window'),
    [{ kind: 'avd-boot', key: 'Pixel_7' }]);
  assert.deepEqual(C.classifyCommand('git stash pop'), [{ kind: 'git-stash', key: 'pop' }]);
  assert.deepEqual(C.classifyCommand('git stash list'), []); // read-only stash is not notable
  assert.deepEqual(C.classifyCommand('npm run deploy'), [{ kind: 'deploy' }]);
  assert.deepEqual(C.classifyCommand('git push origin main'), [{ kind: 'git-push' }]);
  assert.deepEqual(C.classifyCommand('git push && npm run deploy').map((m) => m.kind),
    ['deploy', 'git-push']);
});

test('commandOnly keeps command words and drops the text a shell treats as data', () => {
  // The unit behind the prose guard test. Pure, so it pins the rule itself rather than one
  // classifier's reading of it.
  const has = (cmd, needle) => C.commandOnly(cmd).includes(needle);
  // quoted prose goes
  assert.equal(has('git commit -m "docs: explain npm run deploy"', 'npm run deploy'), false);
  assert.equal(has("echo 'the git stash guard needs work'", 'git stash'), false);
  // a heredoc body goes, quoted delimiter or not
  assert.equal(has("python3 - <<'PY'\nfastlane deliver\nPY", 'fastlane deliver'), false);
  assert.equal(has('cat > f <<EOF\nfirebase deploy\nEOF', 'firebase deploy'), false);
  // a quoted argument with no whitespace is an argument, not prose, so it stays
  assert.equal(has('xcrun simctl boot "0AF3C1D2"', '0AF3C1D2'), true);
  // sh -c is the exception: the quoted string is the command
  assert.equal(has('bash -c "firebase deploy"', 'firebase deploy'), true);
  // and plain commands are untouched
  assert.equal(C.commandOnly('npm run deploy'), 'npm run deploy');
  assert.equal(C.commandOnly(''), '');
});

test('register logs session-start once; a resume does not duplicate it', () => {
  freshDataDir();
  const repo = tmpGitRepo('act-reg');
  const now = Date.now();
  C.cmdRegister({ session_id: 'act-1', cwd: repo }, now);
  C.cmdRegister({ session_id: 'act-1', cwd: repo }, now + 1000);
  const starts = readActivityDay(now).filter((e) => e.ev === 'session-start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].sid, 'act-1');
  assert.equal(starts[0].name, C.friendlyName('act-1'));
  assert.equal(starts[0].branch, 'develop');
  assert.equal(starts[0].worktree, path.basename(repo));
  assert.ok(starts[0].repo);
});

test('beat logs each path once when first seen, batched per call', () => {
  freshDataDir();
  const repo = tmpGitRepo('act-beat');
  const t0 = Date.now();
  C.cmdRegister({ session_id: 'ab-1', cwd: repo }, t0);
  C.cmdBeat({ session_id: 'ab-1', tool_input: { file_path: path.join(repo, 'src/a.js') } }, t0 + 1000);
  C.cmdBeat({ session_id: 'ab-1', tool_input: { file_path: path.join(repo, 'src/a.js') } }, t0 + 2000);
  C.cmdBeat({ session_id: 'ab-1' }, t0 + 3000); // heartbeat, no paths
  let files = readActivityDay(t0).filter((e) => e.ev === 'files');
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].paths, ['src/a.js']);
  C.cmdBeat({
    session_id: 'ab-1',
    tool_name: 'apply_patch',
    tool_input: { command: ['*** Begin Patch', '*** Add File: src/b.js', '*** Update File: src/c.js', '*** End Patch'].join('\n') },
  }, t0 + 4000);
  files = readActivityDay(t0).filter((e) => e.ev === 'files');
  assert.equal(files.length, 2);
  assert.deepEqual(files[1].paths, ['src/b.js', 'src/c.js']);
});

test('beat logs notable commands, one event per match', () => {
  freshDataDir();
  const repo = tmpGitRepo('act-cmd');
  const t0 = Date.now();
  C.cmdRegister({ session_id: 'ac-1', cwd: repo }, t0);
  C.cmdBeat({ session_id: 'ac-1', tool_name: 'Bash', tool_input: { command: 'npm test' } }, t0 + 1000);
  C.cmdBeat({ session_id: 'ac-1', tool_name: 'Bash', tool_input: { command: 'git push origin main' } }, t0 + 2000);
  C.cmdBeat({ session_id: 'ac-1', tool_name: 'Bash', tool_input: { command: 'git push && npm run deploy' } }, t0 + 3000);
  const cmds = readActivityDay(t0).filter((e) => e.ev === 'cmd');
  assert.deepEqual(cmds.map((e) => e.kind), ['git-push', 'deploy', 'git-push']);
});

test('deregister logs a session-end summary before deleting the session', () => {
  freshDataDir();
  const repo = tmpGitRepo('act-dereg');
  const t0 = Date.now();
  C.cmdRegister({ session_id: 'ad-1', cwd: repo }, t0);
  captureStdout(() => C.cmdClaim({ session: 'ad-1', intent: 'polish', paths: 'src' }, t0));
  C.cmdBeat({ session_id: 'ad-1', tool_input: { file_path: path.join(repo, 'src/x.js') } }, t0 + 1000);
  C.cmdDeregister({ session_id: 'ad-1' }, t0 + 5 * 60000);
  assert.equal(C.readSession('ad-1'), null);
  const ends = readActivityDay(t0).filter((e) => e.ev === 'session-end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].intent, 'polish');
  assert.deepEqual(ends[0].paths, ['src/x.js']);
  assert.deepEqual(ends[0].claims.paths, ['src']);
  assert.equal(ends[0].durationMin, 5);
  assert.equal(ends[0].reason, null);
  assert.equal(ends[0].swept, undefined);
});

test('deregister on /clear still logs, tagged with the reason', () => {
  freshDataDir();
  const repo = tmpGitRepo('act-clear');
  const t0 = Date.now();
  C.cmdRegister({ session_id: 'acl-1', cwd: repo }, t0);
  C.cmdDeregister({ session_id: 'acl-1', reason: 'clear' }, t0 + 60000);
  const ends = readActivityDay(t0).filter((e) => e.ev === 'session-end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].reason, 'clear');
});

test('sweep logs a swept session-end for sessions it reaps', () => {
  freshDataDir();
  const repo = tmpGitRepo('act-sweep');
  const now = Date.now();
  C.cmdRegister({ session_id: 'gone-1', cwd: repo }, now - 31 * 60000);
  C.cmdRegister({ session_id: 'live-1', cwd: repo }, now); // triggers sweep
  const ends = readActivityDay(now).filter((e) => e.ev === 'session-end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].sid, 'gone-1');
  assert.equal(ends[0].swept, true);
});

test('claim and release log their deltas', () => {
  freshDataDir();
  const repo = tmpGitRepo('act-claim');
  const now = Date.now();
  C.cmdRegister({ session_id: 'acr-1', cwd: repo }, now);
  captureStdout(() => C.cmdClaim({ session: 'acr-1', intent: 'tab fix', paths: 'App,worker', resources: 'deploy' }, now));
  captureStdout(() => C.cmdClaim({ session: 'acr-1' }, now)); // no-op: nothing to log
  captureStdout(() => C.cmdRelease({ session: 'acr-1', paths: 'worker' }, now + 1000));
  captureStdout(() => C.cmdRelease({ session: 'acr-1' }, now + 2000)); // release everything left
  const events = readActivityDay(now);
  const claims = events.filter((e) => e.ev === 'claim');
  assert.equal(claims.length, 1);
  assert.equal(claims[0].intent, 'tab fix');
  assert.deepEqual(claims[0].paths, ['App', 'worker']);
  assert.deepEqual(claims[0].resources, ['deploy']);
  const rels = events.filter((e) => e.ev === 'release');
  assert.equal(rels.length, 2);
  assert.deepEqual(rels[0].paths, ['worker']);
  assert.equal(rels[0].all, false);
  assert.deepEqual(rels[1].paths, ['App']);
  assert.deepEqual(rels[1].resources, ['deploy']);
  assert.equal(rels[1].all, true);
});

test('sim acquire and explicit release log lease events', () => {
  freshDataDir();
  const repo = tmpGitRepo('act-sim');
  const now = Date.now();
  C.cmdRegister({ session_id: 'as-1', cwd: repo }, now);
  captureStdout(() => C.cmdSim({ _: ['sim', 'acquire'], session: 'as-1', for: 'ui tests' }, now, stubDeps([IOS_A])));
  captureStdout(() => C.cmdSim({ _: ['sim', 'acquire'], session: 'as-1', for: 'ui tests' }, now + 1000, stubDeps([IOS_A])));
  captureStdout(() => C.cmdSim({ _: ['sim', 'release'], session: 'as-1', key: 'UDID-A' }, now + 2000, stubDeps([IOS_A])));
  const events = readActivityDay(now);
  const acq = events.filter((e) => e.ev === 'sim-acquire');
  assert.equal(acq.length, 2);
  assert.equal(acq[0].platform, 'ios');
  assert.equal(acq[0].key, 'UDID-A');
  assert.equal(acq[0].device, 'iPhone 17');
  assert.equal(acq[0].purpose, 'ui tests');
  assert.equal(acq[0].reused, false);
  assert.equal(acq[1].reused, true);
  const rel = events.filter((e) => e.ev === 'sim-release');
  assert.equal(rel.length, 1);
  assert.equal(rel[0].key, 'UDID-A');
});

test('send logs recipients only, never the message text', () => {
  freshDataDir();
  const repo = tmpGitRepo('act-send');
  const now = Date.now();
  C.cmdRegister({ session_id: 'snd-1', cwd: repo }, now);
  C.cmdRegister({ session_id: 'rcv-1', cwd: repo }, now);
  captureStdout(() => C.cmdSend({ _: ['send', 'the secret payload'], session: 'snd-1', to: 'rcv-1' }, now));
  captureStdout(() => C.cmdSend({ _: ['send', 'broadcast body'], session: 'snd-1', to: 'all' }, now + 1000));
  const raw = fs.readFileSync(path.join(process.env.AIRCONTROL_DIR, 'activity', `${C.localDateStr(now)}.jsonl`), 'utf8');
  assert.ok(!raw.includes('secret payload'));
  assert.ok(!raw.includes('broadcast body'));
  const sends = readActivityDay(now).filter((e) => e.ev === 'send');
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[0].to, [C.friendlyName('rcv-1')]);
  assert.equal(sends[0].broadcast, false);
  assert.equal(sends[1].broadcast, true);
});

test('handoff logs metadata, never the note', () => {
  freshDataDir();
  const repo = tmpGitRepo('act-hand');
  const now = Date.now();
  C.cmdRegister({ session_id: 'ha-1', cwd: repo }, now);
  C.cmdRegister({ session_id: 'hb-1', cwd: repo }, now);
  captureStdout(() => C.cmdClaim({ session: 'ha-1', intent: 'store rework', paths: 'Store', resources: 'stash' }, now));
  captureStdout(() => C.cmdHandoff({ session: 'ha-1', to: 'hb-1', note: 'halfway through the refactor' }, now + 1000));
  const raw = fs.readFileSync(path.join(process.env.AIRCONTROL_DIR, 'activity', `${C.localDateStr(now)}.jsonl`), 'utf8');
  assert.ok(!raw.includes('halfway'));
  const hos = readActivityDay(now).filter((e) => e.ev === 'handoff');
  assert.equal(hos.length, 1);
  assert.equal(hos[0].to, C.friendlyName('hb-1'));
  assert.equal(hos[0].movedClaims, 2);
});

function seedActivityFixture(d) {
  const dir = path.join(d, 'activity');
  fs.mkdirSync(dir, { recursive: true });
  const w = (day, events) => fs.writeFileSync(path.join(dir, `${day}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  w('2026-09-02', [
    { ts: '2026-09-02T09:00:00.000Z', sid: 'aaaa-1', name: C.friendlyName('aaaa-1'), repo: '/r/one/.git', branch: 'main', ev: 'session-start', worktree: 'one' },
    { ts: '2026-09-02T09:05:00.000Z', sid: 'aaaa-1', name: C.friendlyName('aaaa-1'), repo: '/r/one/.git', branch: 'main', ev: 'files', paths: ['src/a.js', 'src/b.js'] },
  ]);
  w('2026-09-03', [
    { ts: '2026-09-03T10:00:00.000Z', sid: 'aaaa-1', name: C.friendlyName('aaaa-1'), repo: '/r/one/.git', branch: 'main', ev: 'cmd', kind: 'deploy' },
    { ts: '2026-09-03T09:00:00.000Z', sid: 'bbbb-1', name: C.friendlyName('bbbb-1'), repo: '/r/two/.git', branch: 'dev', ev: 'claim', intent: 'fix', paths: ['App'], resources: [] },
    { ts: '2026-09-03T11:00:00.000Z', sid: 'bbbb-1', name: C.friendlyName('bbbb-1'), repo: '/r/two/.git', branch: 'dev', ev: 'session-end', intent: 'fix', paths: ['App/x.js'], durationMin: 120, reason: null },
  ]);
}

test('cmdLog --json filters by days, session, and repo, sorted by time', () => {
  const d = freshDataDir();
  seedActivityFixture(d);
  const now = new Date(2026, 8, 3, 12, 0).getTime(); // local 2026-09-03
  const all = JSON.parse(captureStdout(() => C.cmdLog({ json: true, days: 5 }, now)));
  assert.equal(all.length, 5);
  assert.deepEqual(all.map((e) => e.ts), [...all.map((e) => e.ts)].sort());
  const today = JSON.parse(captureStdout(() => C.cmdLog({ json: true }, now)));
  assert.equal(today.length, 3);
  const byName = JSON.parse(captureStdout(() => C.cmdLog({ json: true, days: 5, session: C.friendlyName('bbbb-1') }, now)));
  assert.equal(byName.length, 2);
  const byPrefix = JSON.parse(captureStdout(() => C.cmdLog({ json: true, days: 5, session: 'aaaa' }, now)));
  assert.equal(byPrefix.length, 3);
  const byRepo = JSON.parse(captureStdout(() => C.cmdLog({ json: true, days: 5, repo: '/r/two/.git' }, now)));
  assert.equal(byRepo.length, 2);
  const byDate = JSON.parse(captureStdout(() => C.cmdLog({ json: true, date: '2026-09-02' }, now)));
  assert.equal(byDate.length, 2);
});

test('cmdLog renders days grouped by session, human-readable', () => {
  const d = freshDataDir();
  seedActivityFixture(d);
  const now = new Date(2026, 8, 3, 12, 0).getTime();
  const out = captureStdout(() => C.cmdLog({ days: 5 }, now));
  assert.match(out, /2026-09-02/);
  assert.match(out, /2026-09-03/);
  assert.match(out, new RegExp(`${C.friendlyName('aaaa-1')}\\s+one \\(main\\)`));
  assert.match(out, new RegExp(`${C.friendlyName('bbbb-1')}\\s+two \\(dev\\)`));
  assert.match(out, /touched 2 files: src\/a\.js, src\/b\.js/);
  assert.match(out, /ran deploy/);
  assert.match(out, /claimed .*intent="fix"/);
  assert.match(out, /ended/);
  assert.match(out, /2h0m|120m/);
});

test('cmdLog renders event times in local time, not the UTC slice of the ISO ts', () => {
  const d = freshDataDir();
  const dir = path.join(d, 'activity');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date(2026, 8, 3, 14, 7).toISOString(); // local 14:07, whatever the zone
  fs.writeFileSync(path.join(dir, '2026-09-03.jsonl'),
    JSON.stringify({ ts, sid: 'x-1', name: 'x', repo: '/r/.git', branch: 'main', ev: 'cmd', kind: 'deploy' }) + '\n');
  const out = captureStdout(() => C.cmdLog({ date: '2026-09-03' }, new Date(2026, 8, 3, 15, 0).getTime()));
  assert.match(out, /14:07 {2}ran deploy/);
  assert.match(out, new RegExp(`^${C.localDateStr(Date.parse(ts))}$`, 'm')); // day header is local too
});

test('cmdLog with nothing recorded says so', () => {
  freshDataDir();
  const out = captureStdout(() => C.cmdLog({}, Date.now()));
  assert.match(out, /nothing recorded/);
});

test('recordDenial mirrors a deny event into the activity log', () => {
  freshDataDir();
  const repo = tmpGitRepo('act-deny');
  const now = Date.now();
  C.cmdRegister({ session_id: 'dn-1', cwd: repo }, now);
  C.recordDenial('dn-1', { target: 'deploy', reason: 'not claimed' }, { tool_name: 'Bash' }, now);
  const denies = readActivityDay(now).filter((e) => e.ev === 'deny');
  assert.equal(denies.length, 1);
  assert.equal(denies[0].tool, 'Bash');
  assert.equal(denies[0].target, 'deploy');
  assert.equal(denies[0].reason, 'not claimed');
  assert.ok(denies[0].repo);
});

// ---------- background tasks (Bash-tool shells) ----------
//
// The bug these exist for: two background shells each running
//   until ! pgrep -f "xcodebuild test"; do sleep 20; done
// started while a real xcodebuild was running. Once it exited, that pattern was still in both
// their argvs, so each kept the other's condition true and neither ever exited. They survived a
// full session plus a compaction, after which their task ids were gone and TaskStop could not
// reach them. Everything below is about killing exactly those and nothing adjacent.

const SNAP = '/bin/zsh -c source /Users/a/.claude/shell-snapshots/snapshot-zsh-1788.sh && eval';
const TASKS_PS = [
  '63366 58658 /opt/homebrew/bin/claude',                       // my session
  `36851 63366 ${SNAP} 'until ! pgrep -f "xcodebuild test"; do sleep 20; done'`,
  `61322 63366 ${SNAP} 'sleep 999'`,
  '64001 36851 /usr/bin/ruby watcher.rb',                       // grandchild of a stuck shell
  '64002 64001 /usr/bin/xcodebuild test -scheme Marquee',       // great-grandchild
  '70000 63366 /opt/homebrew/bin/node mcp-server.js',           // MCP server: same parent, not a shell
  `88888 63366 ${SNAP} 'coord.js tasks'`,                       // the shell running this command
  '77777 77000 /opt/homebrew/bin/claude',                       // another session
  `77001 77777 ${SNAP} 'their work'`,
  `99999 1 ${SNAP} 'orphan from a dead session'`,
].join('\n');

const tasksProcs = () => C.parseProcTable(TASKS_PS);

test('claudeAncestor finds the session process and collects the shells on the way up', () => {
  const { claudePid, ancestors } = C.claudeAncestor(88888, tasksProcs());
  assert.equal(claudePid, 63366);
  assert.ok(ancestors.has(88888), 'the invoking shell must be on the ancestor chain, never a target');
});

test('claudeAncestor gives up rather than guessing when no claude ancestor exists', () => {
  const { claudePid } = C.claudeAncestor(99999, tasksProcs());
  assert.equal(claudePid, null);
});

test('classifyTaskProcs takes only this session\'s shells, and never the MCP server', () => {
  const { mine, others, orphaned } = C.classifyTaskProcs(tasksProcs(), 63366, new Set([88888]));
  assert.deepEqual(mine.map((p) => p.pid), [36851, 61322]);
  assert.deepEqual(others.map((p) => p.pid), [77001], "another session's shells are off limits");
  assert.deepEqual(orphaned.map((p) => p.pid), [99999]);
  const all = [...mine, ...others, ...orphaned].map((p) => p.pid);
  assert.ok(!all.includes(70000), 'an MCP server shares the parent but is not a Bash-tool shell');
  assert.ok(!all.includes(88888), 'the invoking shell is excluded via ancestors');
});

test('reapOwnTasks kills a shell\'s descendants before the shell itself', () => {
  const killed = [];
  const got = C.reapOwnTasks({
    procs: tasksProcs(), claudePid: 63366, ancestors: new Set([88888]),
    kill: (pid) => killed.push(pid),
  });
  assert.deepEqual(killed, got);
  assert.deepEqual(killed, [64002, 64001, 36851, 61322],
    'deepest first: an xcodebuild left behind would be reparented to launchd and unattributable');
});

test('reapOwnTasks kills nothing when no claude ancestor resolves', () => {
  const killed = [];
  const got = C.reapOwnTasks({
    procs: tasksProcs(), claudePid: null, kill: (pid) => killed.push(pid),
  });
  assert.deepEqual(got, [], 'guessing is how a cleanup takes out live work');
  assert.deepEqual(killed, []);
});

test('deregister reaps this session\'s background shells on a real ending', () => {
  freshDataDir();
  const repo = tmpGitRepo('tasks-end');
  const now = Date.now();
  C.cmdRegister({ session_id: 'ending', cwd: repo }, now);
  const killed = [];
  C.cmdDeregister({ session_id: 'ending' }, now, {
    browserProcs: [], // ancestor-based browser reaper reads real ps by default; isolate it
    procs: tasksProcs(), claudePid: 63366, ancestors: new Set([88888]),
    kill: (pid) => killed.push(pid),
  });
  assert.deepEqual(killed, [64002, 64001, 36851, 61322]);
});

test('a /clear does not reap background shells, because the session carries on', () => {
  freshDataDir();
  const repo = tmpGitRepo('tasks-clear');
  const now = Date.now();
  C.cmdRegister({ session_id: 'still-going-tasks', cwd: repo }, now);
  const killed = [];
  C.cmdDeregister({ session_id: 'still-going-tasks', reason: 'clear' }, now, {
    browserProcs: [], // ancestor-based browser reaper reads real ps by default; isolate it
    procs: tasksProcs(), claudePid: 63366, ancestors: new Set([88888]),
    kill: (pid) => killed.push(pid),
  });
  assert.deepEqual(killed, [], 'a /clear keeps the session, so its shells keep running');
});

test('deregister with no injected kill reaps nothing, so the suite cannot signal real processes', () => {
  freshDataDir();
  const repo = tmpGitRepo('tasks-ungated');
  const now = Date.now();
  C.cmdRegister({ session_id: 'ungated', cwd: repo }, now);
  // No `live`, no `kill`. An ungated reap here resolves the real claude ancestor and SIGTERMs
  // the developer's own background shells — which is exactly what happened before this gate.
  const killed = [];
  const realKill = process.kill;
  process.kill = (pid, sig) => { killed.push(pid); };
  try {
    C.cmdDeregister({ session_id: 'ungated' }, now);
  } finally {
    process.kill = realKill;
  }
  assert.deepEqual(killed, [], 'a direct cmdDeregister call must never signal anything');
});

// ---------- printing a credential file ----------

test('guard refuses a command that would print a credential file', () => {
  freshDataDir();
  const repo = tmpGitRepo('guard-secrets');
  const now = Date.now();
  C.cmdRegister({ session_id: 'ssss-1', cwd: repo }, now);
  const bash = (cmd) => ({ session_id: 'ssss-1', tool_name: 'Bash', tool_input: { command: cmd } });

  // The one that actually happened: a grep for a key name, with enough
  // context lines to carry the token two entries below it.
  const reason = denyReason(guardOut(bash(`grep -n '"env"' -A 10 ~/.claude/settings.json`), now));
  assert.match(reason, /coord\.js peek/);

  for (const cmd of ['cat $HOME/.config/side-project/secrets.env',
                     'head -40 .env.production',
                     'jq . ~/.claude/settings.local.json',
                     'security find-generic-password -a "$USER" -s ASC_KEY_P8 -w']) {
    assert.notEqual(guardOut(bash(cmd), now).trim(), '', cmd);
  }
});

test('guard leaves alone every way of USING a secret', () => {
  freshDataDir();
  const repo = tmpGitRepo('guard-secrets-ok');
  const now = Date.now();
  C.cmdRegister({ session_id: 'tttt-1', cwd: repo }, now);
  const bash = (cmd) => ({ session_id: 'tttt-1', tool_name: 'Bash', tool_input: { command: cmd } });

  // Sourcing emits nothing; a capture puts the value in a variable; a
  // redirect puts it in a file. None of them reach the transcript, and all
  // three are how CLAUDE.md says to do this.
  for (const cmd of ['set -a; . "$HOME/.config/side-project/secrets.env"; set +a',
                     'TOKEN=$(security find-generic-password -a "$USER" -s NAME -w) curl -s x',
                     'security find-generic-password -a "$USER" -s ASC_KEY_P8 -w | xxd -r -p > /tmp/k.p8',
                     'xcodebuild archive -authenticationKeyPath ~/.appstoreconnect/private_keys/AuthKey_FAKEKEYID2.p8',
                     'grep -rn "nextReply" Relay/',
                     'git commit -m "read secrets.env at boot"',
                     'python3 - <<PY\nopen("settings.json")\nPY']) {
    assert.equal(guardOut(bash(cmd), now), '', cmd);
  }
});

test('peek prints the structure and never the value', () => {
  const sample = [
    '{',
    '  "ASC_KEY_ID": "FAKEKEYID1",',
    '  "JAVA_HOME": "/opt/homebrew/opt/openjdk@21",',
    '  "SENTRY_AUTH_TOKEN": "sntryu_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE",',
    '  "PLAIN": "hello world"',
    '}',
  ].join('\n');
  const out = C.redactText(sample);
  // Keys survive, because the question is almost always which keys exist.
  assert.match(out, /ASC_KEY_ID": "FAKEKEYID1"/);
  assert.match(out, /JAVA_HOME": "\/opt\/homebrew/);
  assert.match(out, /PLAIN": "hello world"/);
  assert.doesNotMatch(out, /sntryu_[A-Za-z0-9]/);
  assert.match(out, /SENTRY_AUTH_TOKEN": "<redacted \d+ chars>"/);

  // A PEM body is redacted whole rather than line by line.
  const pem = C.redactText('-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49\nAgEG\n-----END PRIVATE KEY-----');
  assert.doesNotMatch(pem, /MIGTAgEA/);
});

// --- disk ---

function fakeDerivedData(root, name, workspace) {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  if (workspace !== undefined) {
    fs.writeFileSync(path.join(d, 'info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>WorkspacePath</key>\n\t<string>${workspace}</string>\n</dict>\n</plist>\n`);
  }
  fs.writeFileSync(path.join(d, 'blob'), 'x');
  return d;
}

test('renderDiskLine stays silent with room to spare', () => {
  const th = { minFreeBytes: 20e9, minFreeRatio: 0.10 };
  assert.equal(C.renderDiskLine({ free: 85e9, total: 494e9 }, undefined, th), '');
  assert.equal(C.renderDiskLine(null, undefined, th), '');
});

test('renderDiskLine fires below either threshold and names the prune command', () => {
  const th = { minFreeBytes: 20e9, minFreeRatio: 0.10 };
  const byRatio = C.renderDiskLine({ free: 40e9, total: 494e9 }, '~/.claude/hooks/coord.js', th);
  assert.match(byRatio, /^\[aircontrol\] disk: 40\.0 GB free \(8%\)/);
  assert.match(byRatio, /`node ~\/\.claude\/hooks\/coord\.js disk` lists stale build output, `disk --prune` removes it$/);
  assert.match(C.renderDiskLine({ free: 15e9, total: 100e9 }, undefined, th), /15\.0 GB free/);
});

test('renderInjection carries the disk line on the solo path', () => {
  const out = C.renderInjection(mkSession({}), [], [], Date.parse('2026-07-16T12:00:00Z'), undefined, '', '', '[aircontrol] disk: 1.0 GB free (0%)');
  assert.match(out, /no other sessions/);
  assert.match(out, /\[aircontrol\] disk: 1\.0 GB free/);
});

test('staleDerivedData picks only folders whose project is gone and unclaimed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aircontrol-dd-'));
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'aircontrol-ddlive-'));
  fakeDerivedData(root, 'App-live', path.join(live, 'App.xcodeproj'));
  fs.mkdirSync(path.join(live, 'App.xcodeproj'));
  fakeDerivedData(root, 'App-gone', '/nonexistent/wt-gone/App.xcodeproj');
  fakeDerivedData(root, 'App-claimed', '/nonexistent/wt-claimed/App.xcodeproj');
  fakeDerivedData(root, 'App-escaped', '/nonexistent/a&amp;b/App.xcodeproj');
  fakeDerivedData(root, 'ModuleCache.noindex');
  const stale = C.staleDerivedData(root, ['/nonexistent/wt-claimed']);
  assert.deepEqual(stale.map((s) => path.basename(s.dir)).sort(), ['App-escaped', 'App-gone']);
  assert.equal(stale.find((s) => s.dir.endsWith('App-escaped')).workspace, '/nonexistent/a&b/App.xcodeproj');
});

test('disk --prune removes stale folders and leaves live ones', () => {
  freshDataDir();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aircontrol-ddprune-'));
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'aircontrol-ddlive-'));
  fs.mkdirSync(path.join(live, 'App.xcodeproj'));
  fakeDerivedData(root, 'App-live', path.join(live, 'App.xcodeproj'));
  fakeDerivedData(root, 'App-gone', '/nonexistent/wt-gone/App.xcodeproj');
  const run = () => '2048\t/x\n';
  const listed = captureStdout(() => C.cmdDisk({}, Date.now(), { root, run }));
  assert.match(listed, /stale\t0\.0 GB\tApp-gone/);
  assert.ok(fs.existsSync(path.join(root, 'App-gone')), 'listing alone must not delete');
  const pruned = captureStdout(() => C.cmdDisk({ prune: true }, Date.now(), { root, run }));
  assert.match(pruned, /removed\t.*App-gone/);
  assert.ok(!fs.existsSync(path.join(root, 'App-gone')));
  assert.ok(fs.existsSync(path.join(root, 'App-live')));
});

test('disk --prune skips a folder under a live session claim', () => {
  freshDataDir();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aircontrol-ddclaim-'));
  fakeDerivedData(root, 'App-claimed', '/nonexistent/wt-claimed/App.xcodeproj');
  const now = Date.now();
  C.writeSession(mkSession({ sessionId: 'peer-dd01', lastSeen: new Date(now).toISOString(), claims: { paths: ['/nonexistent/wt-claimed'], resources: [] } }));
  const out = captureStdout(() => C.cmdDisk({ prune: true }, now, { root, run: () => '0' }));
  assert.match(out, /stale DerivedData: none/);
  assert.ok(fs.existsSync(path.join(root, 'App-claimed')));
});
