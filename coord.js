#!/usr/bin/env node
// aircontrol — coordination for parallel coding-agent sessions on this machine.
// Hook subcommands (register/inject/beat/deregister) must NEVER fail a session:
// they swallow every error and exit 0. CLI subcommands (claim/release/send/who)
// report errors normally. State: one JSON file per session + one inbox dir per
// session under AIRCONTROL_DIR (default ~/.claude/agents).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const STALE_MS = 30 * 60 * 1000;
const READ_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UNREAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TEMP_TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_PROBE_MS = 250;
const BEAT_MS = 60 * 1000;
// Leases deliberately do NOT use STALE_MS. A 40-minute `xcodebuild` produces no heartbeat by
// nature, so tying a lease to roster liveness frees the device out from under the very sessions
// most likely to hold one. SessionEnd and `sim release` remain the fast paths; this is only the
// backstop for a session that died without either.
const LEASE_TTL_MS = 2 * 60 * 60 * 1000;
// Claims need the same exemption for the same reason. A session goes quiet without
// dying — its operator steps away, a build runs long, one tool call eats 40 minutes —
// and STALE_MS is far too short to expire a claim on that evidence. Reaping one only
// because nobody typed for half an hour silently unlocks a path whose holder is still
// alive and still editing it, and the holder is never told it lost the claim. So a
// session holding nothing is still swept at STALE_MS, but one holding claims survives
// until CLAIM_TTL_MS. SessionEnd and `release` remain the fast paths; this is only the
// backstop for a session that died without either.
const CLAIM_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_RECENT = 20;
const GIT_OPERATION_MARKERS = [
  'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG',
  'rebase-merge', 'rebase-apply', 'sequencer',
];
const SCAN_PRUNE_DIRS = new Set([
  'node_modules', 'DerivedData', 'Pods', '.build', 'build', 'dist',
  '.next', '.cache', 'vendor',
]);
const BOOLEAN_ARGS = new Set(['repair', 'extra', 'mine', 'json', 'idle', 'assignable', 'others', 'global', 'dry-run', 'no-mirror-global', 'shutdown', 'keep-booted', 'notes', 'prune']);
// Resources compared only within one repo; everything else (sim:*, deploy:*, …)
// is machine-global contention.
const REPO_SCOPED_RESOURCES = new Set(['stash']);

function dataDir() { return process.env.AIRCONTROL_DIR || path.join(os.homedir(), '.claude', 'agents'); }

// Every id that becomes a path component — session ids from hook stdin, ids
// parsed out of PULLED remote mirrors, peer/machine names — must be a single
// safe segment. Anything separator-shaped is rejected at the boundary so no
// join can escape the data dir.
function isSafeComponent(s) {
  return typeof s === 'string' && s.length > 0 && s !== '.' && s !== '..' &&
    !s.includes('/') && !s.includes('\\') && !s.includes('\0');
}
function sessionsDir() { return path.join(dataDir(), 'sessions'); }
function messagesDir(id) { return id ? path.join(dataDir(), 'messages', id) : path.join(dataDir(), 'messages'); }
function configFile() { return path.join(dataDir(), 'config.json'); }

// ---------- pure helpers ----------

// Case-folded: this tool targets macOS, where APFS is case-insensitive by
// default, so "Store/" and "store/Foo.swift" are the same file on disk. A
// case-sensitive compare would let a differently-cased path silently bypass
// a claim.
function boundaryPrefix(prefix, p) {
  const clean = (prefix.endsWith('/') ? prefix.slice(0, -1) : prefix).toLowerCase();
  const pl = p.toLowerCase();
  return pl === clean || pl.startsWith(clean + '/');
}

function pathsOverlap(a, b) { return boundaryPrefix(a, b) || boundaryPrefix(b, a); }

function isStale(session, nowMs) { return nowMs - Date.parse(session.lastSeen) >= STALE_MS; }
function holdsClaims(session) {
  const c = session.claims || {};
  return !!((c.paths || []).length || (c.resources || []).length);
}
// "Gone", as opposed to merely quiet: the test every caller wants when asking whether a
// session still counts. Roster, guard and sweep must agree on it, or the guard denies on
// a session the roster does not show.
function isExpired(session, nowMs) {
  return holdsClaims(session)
    ? nowMs - Date.parse(session.lastSeen) >= CLAIM_TTL_MS
    : isStale(session, nowMs);
}

function mergeClaims(claims, paths, resources) {
  const c = { paths: [...((claims && claims.paths) || [])], resources: [...((claims && claims.resources) || [])] };
  for (const p of paths || []) if (!c.paths.includes(p)) c.paths.push(p);
  for (const r of resources || []) if (!c.resources.includes(r)) c.resources.push(r);
  return c;
}

// Resolve a session reference to a full id. Accepts a UUID prefix (as before) or a
// friendly name (case-insensitive). Prefix wins to stay backward-compatible; names are
// tried only when no prefix matches. Collisions raise an error that lists
// "name (shortId)" pairs so the short UUID is always an unambiguous fallback handle.
function resolveIdPrefix(ids, ref) {
  if (!ref) throw new Error('no session id/prefix given (--session … / --to …)');
  const byPrefix = ids.filter((i) => i.startsWith(ref));
  if (byPrefix.length === 1) return byPrefix[0];
  const label = (i) => `${friendlyName(i)} (${shortId(i)})`;
  if (byPrefix.length > 1) throw new Error(`ambiguous prefix "${ref}" (${byPrefix.map(label).join(', ')})`);
  const lower = ref.toLowerCase();
  const byName = ids.filter((i) => friendlyName(i).toLowerCase() === lower);
  if (byName.length === 1) return byName[0];
  if (byName.length === 0) throw new Error(`no session matches "${ref}"`);
  throw new Error(`ambiguous name "${ref}" (${byName.map(label).join(', ')})`);
}

// The nonce sits BETWEEN timestamp and sender (never after: sender ids contain
// hyphens) and is hyphen-free itself, so readers can split on '-' and take
// everything from the third segment as the sender id.
let messageSeq = 0;
function messageFilename(nowMs, fromId) {
  const nonce = `${process.pid}.${(messageSeq++).toString(36)}`;
  return `${nowMs}-${nonce}-${fromId}.md`;
}
function shortId(id) { return String(id).slice(0, 8); }

// ---------- friendly names ----------
// A session's id is assigned by the harness and never changes, so we derive a stable,
// memorable display name from it deterministically: same id → same name, on every
// machine, with no shared registry. Two-part styles multiply their word lists for a
// large space (low collision odds among a handful of live sessions).
const GOOFY_TITLES = ['captain', 'sir', 'lady', 'baron', 'professor', 'doctor', 'chief', 'major',
  'duke', 'count', 'madame', 'master', 'general', 'admiral', 'wizard', 'sergeant', 'colonel',
  'squire', 'king', 'queen', 'prince', 'earl', 'cardinal', 'bishop', 'sultan', 'emperor',
  'governor', 'mayor', 'warden', 'abbot', 'friar', 'jester', 'herald', 'commodore', 'viscount',
  'chancellor', 'marshal', 'regent', 'deacon', 'provost'];
const GOOFY_CRITTERS = ['snugglepants', 'wigglesworth', 'bumblesnout', 'noodlefoot', 'picklebottom',
  'fuzzwhisker', 'gigglesnort', 'waddlebonk', 'snickerdoodle', 'flufftail', 'grumbletoes',
  'doodlebug', 'wobbleknees', 'sniffleton', 'boopsnoot', 'tumblewhisk', 'jibberjaw', 'quibblenose',
  'snoozlebeak', 'crumplehorn', 'wafflestomp', 'bimblebop', 'curdlewick', 'dinglehop', 'fripperton',
  'gloopmuffin', 'huffleplop', 'kerfluffle', 'lollygag', 'mopplewhump', 'plumptart', 'squigglebop',
  'thistledown', 'whipplesnap', 'bopplenook', 'flapdoodle', 'gubblewick', 'noodlebonk', 'pumpernickel',
  'zibblefritz'];
const ANIMAL_ADJECTIVES = ['sneaky', 'brave', 'sleepy', 'grumpy', 'jolly', 'clever', 'fuzzy', 'mighty',
  'tiny', 'dapper', 'cranky', 'zippy', 'wobbly', 'cheeky', 'spunky', 'breezy', 'quirky', 'plucky',
  'snappy', 'drowsy', 'feisty', 'giddy', 'nimble', 'perky', 'rowdy', 'sassy', 'silly', 'spry',
  'sturdy', 'witty', 'bouncy', 'crafty', 'dizzy', 'eager', 'frisky', 'gentle', 'husky', 'jumpy',
  'lucky', 'nifty'];
const ANIMALS = ['otter', 'walrus', 'badger', 'weasel', 'ferret', 'gecko', 'moose', 'narwhal', 'panda',
  'quokka', 'raccoon', 'sloth', 'toucan', 'wombat', 'yak', 'alpaca', 'beaver', 'chinchilla', 'dingo',
  'echidna', 'falcon', 'gopher', 'hedgehog', 'iguana', 'jackal', 'koala', 'lemur', 'mongoose', 'newt',
  'ocelot', 'pangolin', 'quail', 'salamander', 'tapir', 'urchin', 'vole', 'wolverine', 'xerus', 'zebra',
  'meerkat'];
const REAL_NAMES = ['wilma', 'bartholomew', 'greta', 'harold', 'mabel', 'oscar', 'dorothy', 'edgar',
  'fern', 'gus', 'hazel', 'ivan', 'june', 'karl', 'lena', 'milo', 'nora', 'otis', 'pearl', 'quinn',
  'rufus', 'stella', 'theo', 'ursula', 'vera', 'walt', 'xena', 'yolanda', 'zeke', 'agnes', 'bruno',
  'cleo', 'dexter', 'elsie', 'floyd', 'gwen', 'hank', 'iris', 'jasper', 'klara', 'leon', 'myrtle',
  'ned', 'opal', 'percy', 'rosa', 'sid', 'tessa'];
// Object {a,b} → two-part "a-b"; plain array → single word.
const NAME_STYLES = {
  goofy: { a: GOOFY_TITLES, b: GOOFY_CRITTERS },
  animal: { a: ANIMAL_ADJECTIVES, b: ANIMALS },
  real: REAL_NAMES,
};
const DEFAULT_NAME_STYLE = 'goofy';

// FNV-1a (32-bit) — deterministic string hash, no Math.random.
function hashId(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// The style configured at install time (config.json). Fail-safe: any missing/corrupt/
// unknown value falls back to the default so display never throws.
function nameStyle() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    const s = cfg && cfg.nameStyle;
    if (s && Object.prototype.hasOwnProperty.call(NAME_STYLES, s)) return s;
  } catch {}
  return DEFAULT_NAME_STYLE;
}

// The name for a given salt. Salt 0 is the plain hash of the id, which is what
// every session got before names were deconflicted, so an unsalted session keeps
// exactly the name it has always had.
function saltedName(id, salt, style) {
  const words = NAME_STYLES[style || nameStyle()] || NAME_STYLES[DEFAULT_NAME_STYLE];
  const h = hashId(salt ? `${id}#${salt}` : id);
  if (Array.isArray(words)) return words[h % words.length];
  return `${words.a[h % words.a.length]}-${words.b[Math.floor(h / words.a.length) % words.b.length]}`;
}

// Salts are read per id and cached for the life of the process. A CLI invocation
// is short and renders the roster in one pass, so a stale entry cannot outlive
// the command that read it.
const saltCache = new Map();
function nameSaltFor(id) {
  if (saltCache.has(id)) return saltCache.get(id);
  const s = readSession(id);
  const salt = (s && Number.isInteger(s.nameSalt)) ? s.nameSalt : 0;
  saltCache.set(id, salt);
  return salt;
}

function friendlyName(id, style) {
  return saltedName(id, nameSaltFor(id), style);
}

// Two sessions alive at the same time must not share a word. Sharing the whole
// name makes `--to <name>` ambiguous, which resolveIdPrefix already reports; the
// worse case is sharing only one half, because "squire-grumbletoes" and
// "professor-grumbletoes" read as the same session to a human skimming a roster
// and mail gets routed to the wrong one with no error at all.
//
// The salt is chosen once, at registration, and stored. It is not a rendered
// name: `coord.js names <style>` re-renders every session under the new style
// and the deconfliction survives it.
const MAX_NAME_SALT = 64;
function pickNameSalt(id, nowMs) {
  let live;
  try { live = readSessions().filter((s) => s.sessionId !== id && !isExpired(s, nowMs)); }
  catch { return 0; }
  const taken = new Set();
  for (const s of live) {
    for (const word of saltedName(s.sessionId, Number.isInteger(s.nameSalt) ? s.nameSalt : 0).split('-')) {
      taken.add(word);
    }
  }
  for (let salt = 0; salt < MAX_NAME_SALT; salt++) {
    if (!saltedName(id, salt).split('-').some((w) => taken.has(w))) return salt;
  }
  // Every probe collided: the room is bigger than the vocabulary. Keep the plain
  // name rather than looping — `who` still disambiguates by short id.
  return 0;
}

function writeNameStyle(style) {
  ensureDirs();
  const file = configFile();
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
  cfg.nameStyle = style;
  const tmp = file + `.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 1));
  fs.renameSync(tmp, file);
}

function agoLabel(iso, nowMs) {
  const m = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60000));
  return m < 1 ? 'just now' : `${m}m ago`;
}

function splitList(v) { return v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []; }

function gitEnv() { return { ...process.env, GIT_OPTIONAL_LOCKS: '0' }; }

function toolInputPaths(input) {
  const toolInput = (input && input.tool_input) || {};
  const direct = [toolInput.file_path, toolInput.notebook_path].filter((p) => typeof p === 'string' && p.trim());
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';
  const patchPaths = [];
  if (input && input.tool_name === 'apply_patch' && command) {
    const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;
    let match;
    while ((match = re.exec(command)) !== null) patchPaths.push((match[1] || match[2]).trim());
  }
  return [...new Set([...direct, ...patchPaths])];
}

// ---------- harness identity ----------
//
// Both harnesses speak the same hook JSON, so almost nothing here branches on which one is
// running. What does differ is *where its coord.js copy lives* (the footer the model is told
// to run) and where its transcript is. Codex exposes no session-id or harness env var, so
// the installer declares it (`--harness codex` on every Codex hook command) and, for older
// hooks.json files that predate the flag, the rollout path in `transcript_path` gives it away.
const HARNESSES = new Set(['claude', 'codex']);

function codexHome() { return process.env.CODEX_HOME || path.join(os.homedir(), '.codex'); }

function detectHarness(input, explicit, prev) {
  if (explicit && HARNESSES.has(explicit)) return explicit;
  if (prev && prev.harness && HARNESSES.has(prev.harness)) return prev.harness;
  const tp = input && typeof input.transcript_path === 'string' ? input.transcript_path : '';
  if (tp && (tp.startsWith(path.join(codexHome(), 'sessions') + path.sep) || /[\\/]\.codex[\\/]sessions[\\/]/.test(tp))) return 'codex';
  return 'claude';
}

function cliPathFor(harness) { return harness === 'codex' ? '~/.codex/hooks/coord.js' : '~/.claude/hooks/coord.js'; }

// Claude is the default and stays untagged; only the odd one out earns a label.
function harnessTag(s) { return s && s.harness && s.harness !== 'claude' ? ` [${s.harness}]` : ''; }

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (BOOLEAN_ARGS.has(key)) { out[key] = true; continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function isDeployResource(r) { return r === 'deploy' || (typeof r === 'string' && r.startsWith(DEPLOY_PREFIX)); }

function claimSummary(s) {
  return [...((s.claims && s.claims.paths) || []), ...((s.claims && s.claims.resources) || [])].join(', ') || 'none';
}

function advisories(self, others) {
  const out = [];
  const minePaths = [...((self.claims && self.claims.paths) || []), ...(self.recentPaths || [])];
  const myRes = (self.claims && self.claims.resources) || [];
  for (const o of others) {
    if (o.repo === self.repo) {
      for (const theirs of (o.claims && o.claims.paths) || []) {
        for (const mine of minePaths) {
          if (pathsOverlap(theirs, mine)) {
            out.push(`Your path ${mine} overlaps ${friendlyName(o.sessionId)}'s claim "${theirs}" ("${o.intent}") — coordinate before continuing.`);
          }
        }
      }
    }
    const theirRes = (o.claims && o.claims.resources) || [];
    for (const r of theirRes) {
      if (isDeployResource(r)) continue;
      if (!myRes.includes(r)) continue;
      if (REPO_SCOPED_RESOURCES.has(r) && o.repo !== self.repo) continue;
      out.push(`Resource "${r}" is also claimed by ${friendlyName(o.sessionId)} ("${o.intent}").`);
    }
    // Two deploy claims are a conflict only when their targets overlap, so
    // `deploy:asc` against `deploy:firebase` is silence, not an advisory.
    const theirDeploy = deployScopes(theirRes);
    for (const r of myRes) {
      if (!isDeployResource(r)) continue;
      if (!deployScopesOverlap(deployScopes([r]), theirDeploy)) continue;
      out.push(`Resource "${r}" is also claimed by ${friendlyName(o.sessionId)} ("${o.intent}").`);
    }
  }
  return [...new Set(out)];
}

// Both delivery paths render messages identically — the UserPromptSubmit roster
// block and the Stop-hook nudge — so a reader can't tell which hook woke them.
function renderMessageLines(messages, nowMs) {
  const lines = ['Messages for you:'];
  for (const m of messages) lines.push(`- from ${friendlyName(m.from)} (${agoLabel(m.at, nowMs)}): ${m.text}`);
  return lines;
}

function renderInjection(self, others, messages, nowMs, cliPath = '~/.claude/hooks/coord.js', ledgerLine = '', budgetLine = '', diskLine = '') {
  const live = others.filter((o) => !isExpired(o, nowMs));
  if (live.length === 0 && messages.length === 0) {
    const solo = `[aircontrol] session ${friendlyName(self.sessionId)} — no other sessions active on this machine.`;
    // The solo path is the common case, and the case the retro data came from. The budget
    // line has to survive this early return or it never fires where it matters most.
    return [solo, ledgerLine, budgetLine, diskLine].filter(Boolean).join('\n');
  }
  const lines = [`[aircontrol] You are session ${friendlyName(self.sessionId)}.`];
  const same = live.filter((o) => o.repo === self.repo);
  const elsewhere = live.filter((o) => o.repo !== self.repo);
  if (same.length) {
    lines.push('Other sessions in THIS repo:');
    for (const o of same) {
      lines.push(`- ${friendlyName(o.sessionId)}${harnessTag(o)} [${o.branch || '?'} @ ${path.basename(o.worktree)}] "${o.intent}" — claims: ${claimSummary(o)} (seen ${agoLabel(o.lastSeen, nowMs)})`);
    }
  }
  if (elsewhere.length) {
    lines.push('Elsewhere on this machine:');
    for (const o of elsewhere) {
      lines.push(`- ${friendlyName(o.sessionId)}${harnessTag(o)} in ${path.basename(o.worktree)} [${o.branch || '?'}] "${o.intent}" (seen ${agoLabel(o.lastSeen, nowMs)})`);
    }
  }
  if (messages.length) lines.push(...renderMessageLines(messages, nowMs));
  const adv = advisories(self, live);
  if (adv.length) {
    lines.push('⚠️ Advisories:');
    for (const a of adv) lines.push(`- ${a}`);
  }
  if (ledgerLine) lines.push(ledgerLine);
  if (budgetLine) lines.push(budgetLine);
  if (diskLine) lines.push(diskLine);
  lines.push(`Coordination CLI: node ${cliPath} claim|release|send|who --session ${friendlyName(self.sessionId)} …`);
  return lines.join('\n');
}

// ---------- fs + git layer ----------

function ensureDirs() {
  fs.mkdirSync(sessionsDir(), { recursive: true });
  fs.mkdirSync(messagesDir(), { recursive: true });
}

function sessionFile(id) { return path.join(sessionsDir(), `${id}.json`); }

function writeSession(s) {
  ensureDirs();
  const tmp = sessionFile(s.sessionId) + `.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1));
  fs.renameSync(tmp, sessionFile(s.sessionId));
}

function readSession(id) {
  try { return JSON.parse(fs.readFileSync(sessionFile(id), 'utf8')); } catch { return null; }
}

// A stale lock only happens if a process died between acquiring it and the
// unlink in the finally block below — a few filesystem calls — so 5s is
// generous headroom without leaving a crashed holder blocking real updates.
const SESSION_LOCK_STALE_MS = 5000;

function sessionLockFile(id) { return sessionFile(id) + '.lock'; }

function trySessionLock(id, nowMs) {
  const file = sessionLockFile(id);
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.closeSync(fs.openSync(file, 'wx')); return true; } catch {}
    try {
      if (nowMs - fs.statSync(file).mtimeMs < SESSION_LOCK_STALE_MS) return false;
      fs.unlinkSync(file); // crash-abandoned: sweep it and retry the O_EXCL create
    } catch { return false; }
  }
  return false;
}

// Optimistic read-modify-write, gated by a short-held O_EXCL lock around the
// recheck-and-write so two updaters can't both pass the rev check against the
// same base and clobber one another: writeSession's tmp+rename is an atomic
// replace, not a compare-and-swap, and re-reading the rev without a lock is
// only advisory — a second updater re-reading in the gap before the first one
// writes would see the same "unchanged" rev and race in anyway. Express the
// change as mutate(session) and it is replayed against fresh state whenever
// the on-disk rev moved or the lock was already held. mutate may return null
// to skip the write (used by beat's debounce).
function updateSession(id, mutate, maxAttempts = 5) {
  for (let i = 0; i < maxAttempts; i++) {
    const current = readSession(id);
    if (!current) return null;
    const expectedRev = current.rev || 0;
    const next = mutate({ ...current });
    if (!next) return current;
    next.rev = expectedRev + 1;
    if (!trySessionLock(id, Date.now())) continue; // someone else is mid-update: retry fresh
    try {
      const onDisk = readSession(id);
      if (((onDisk && onDisk.rev) || 0) !== expectedRev) continue;
      writeSession(next);
      return next;
    } finally {
      try { fs.unlinkSync(sessionLockFile(id)); } catch {}
    }
  }
  throw new Error(`session ${shortId(id)} update conflicted ${maxAttempts} times`);
}

function readSessions() {
  ensureDirs();
  const out = [];
  for (const f of fs.readdirSync(sessionsDir())) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(sessionsDir(), f);
    try {
      const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
      // Seed the salt cache from the read we already did: friendlyName is called
      // once per session when rendering a roster, and would otherwise re-open
      // every one of these files to find a single integer.
      if (parsed && parsed.sessionId) saltCache.set(parsed.sessionId, Number.isInteger(parsed.nameSalt) ? parsed.nameSalt : 0);
      out.push(parsed);
    } catch { try { fs.unlinkSync(full); } catch {} }
  }
  return out;
}

function gitInfo(cwd) {
  const git = (args) => execFileSync('git', args, {
    cwd, env: gitEnv(), stdio: ['ignore', 'pipe', 'ignore'],
  }).toString().trim();
  try {
    const common = path.resolve(cwd, git(['rev-parse', '--git-common-dir']));
    let worktree = cwd;
    let branch = '';
    try { worktree = git(['rev-parse', '--show-toplevel']); } catch {}
    try { branch = git(['rev-parse', '--abbrev-ref', 'HEAD']); } catch {}
    return { repo: common, worktree, branch };
  } catch {
    return { repo: `none:${cwd}`, worktree: cwd, branch: '' };
  }
}

function sweep(nowMs) {
  const removed = { sessions: 0, readMessages: 0, unreadMessages: 0, tempFiles: 0, emptyDirs: 0, leases: 0, ledgerEvents: 0 };
  for (const s of readSessions()) {
    if (isExpired(s, nowMs)) {
      try { logActivity({ ...sessionEndEvent(s, nowMs), swept: true }, nowMs); } catch {}
      try { bounceUndelivered(s.sessionId, nowMs); } catch {}
      try { fs.unlinkSync(sessionFile(s.sessionId)); removed.sessions++; } catch {}
    }
  }
  // Stale sessions are gone by now, so any lease without a live holder is orphaned.
  try { removed.leases = pruneLeases(nowMs); } catch {}
  try { removed.ledgerEvents = compactLedger(nowMs); } catch {}
  const keepDays = activityRetentionDays(); // null = keep forever (the default)
  if (keepDays) { try { removed.activityFiles = pruneActivity(nowMs, keepDays); } catch {} }
  try { maybeAutoSync(nowMs); } catch {}
  // A pull-only peer (no peers of its own, so it never runs `sync` itself)
  // still receives pushes into its mirror — deliver them on every sweep.
  try { importRemoteMessages(); } catch {}
  // Staged cross-machine messages: delivered copies dedupe by filename, so the
  // originals only need to outlive a few sync cycles, not the unread TTL.
  try {
    for (const m of fs.readdirSync(path.join(dataDir(), 'outbox'))) {
      const mdir = path.join(dataDir(), 'outbox', m);
      for (const sid of fs.readdirSync(mdir)) {
        const sdir = path.join(mdir, sid);
        for (const f of fs.readdirSync(sdir)) {
          const ts = parseInt(f, 10);
          if (Number.isFinite(ts) && nowMs - ts > READ_TTL_MS) { try { fs.unlinkSync(path.join(sdir, f)); } catch {} }
        }
        try { if (!fs.readdirSync(sdir).length) fs.rmdirSync(sdir); } catch {}
      }
    }
  } catch {}
  let sessionFiles = [];
  try { sessionFiles = fs.readdirSync(sessionsDir()); } catch {}
  for (const f of sessionFiles) {
    if (!f.includes('.json.tmp-')) continue;
    const full = path.join(sessionsDir(), f);
    try {
      if (nowMs - fs.statSync(full).mtimeMs > TEMP_TTL_MS) {
        fs.unlinkSync(full);
        removed.tempFiles++;
      }
    } catch {}
  }
  let dirs = [];
  try { dirs = fs.readdirSync(messagesDir()); } catch { return removed; }
  for (const dir of dirs) {
    const d = path.join(messagesDir(), dir);
    let files = [];
    try { files = fs.readdirSync(d); } catch { continue; }
    for (const f of files) {
      const ts = parseInt(f, 10);
      if (!Number.isFinite(ts)) continue;
      const isRead = f.endsWith('.read');
      const isUnread = f.endsWith('.md');
      const expired = (isRead && nowMs - ts > READ_TTL_MS) ||
        (isUnread && nowMs - ts > UNREAD_TTL_MS);
      if (expired) {
        try {
          fs.unlinkSync(path.join(d, f));
          if (isRead) removed.readMessages++;
          else removed.unreadMessages++;
        } catch {}
      }
    }
    try {
      if (fs.readdirSync(d).length === 0) {
        fs.rmdirSync(d);
        removed.emptyDirs++;
      }
    } catch {}
  }
  return removed;
}

// ---------- conservative Git lock doctor ----------

function expandUser(p) {
  if (p === '~') return os.homedir();
  if (p && p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function addGitDir(found, gitDir) {
  const resolved = path.resolve(gitDir);
  let stat;
  try { stat = fs.statSync(resolved); } catch { return; }
  if (!stat.isDirectory()) return;
  found.add(resolved);
  const worktrees = path.join(resolved, 'worktrees');
  let entries = [];
  try { entries = fs.readdirSync(worktrees, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory()) found.add(path.join(worktrees, entry.name));
  }
}

function gitDirFromFile(file) {
  try {
    const match = /^gitdir:\s*(.+)\s*$/im.exec(fs.readFileSync(file, 'utf8'));
    if (!match) return null;
    return path.resolve(path.dirname(file), match[1]);
  } catch { return null; }
}

function discoverGitDirs(roots) {
  const found = new Set();
  const visited = new Set();
  function visit(candidate, isRoot) {
    const full = path.resolve(expandUser(candidate));
    let stat;
    try { stat = fs.lstatSync(full); } catch { return; }
    const key = `${stat.dev}:${stat.ino}`;
    if (visited.has(key)) return;
    visited.add(key);

    if (path.basename(full) === '.git') {
      if (stat.isDirectory()) addGitDir(found, full);
      else if (stat.isFile()) {
        const gitDir = gitDirFromFile(full);
        if (gitDir) addGitDir(found, gitDir);
      }
      return;
    }
    if (!stat.isDirectory() || (!isRoot && SCAN_PRUNE_DIRS.has(path.basename(full)))) return;

    // A common/worktree gitdir may be supplied directly by a session record.
    if (fs.existsSync(path.join(full, 'HEAD')) &&
        (fs.existsSync(path.join(full, 'config')) || fs.existsSync(path.join(full, 'commondir')))) {
      addGitDir(found, full);
      return;
    }
    let entries = [];
    try { entries = fs.readdirSync(full, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === '.git') {
        const dotGit = path.join(full, entry.name);
        if (entry.isDirectory()) addGitDir(found, dotGit);
        else if (entry.isFile()) {
          const gitDir = gitDirFromFile(dotGit);
          if (gitDir) addGitDir(found, gitDir);
        }
        continue;
      }
      if (entry.isDirectory() && !SCAN_PRUNE_DIRS.has(entry.name)) visit(path.join(full, entry.name), false);
    }
  }
  for (const root of roots) visit(root, true);
  return [...found].sort();
}

function lockSnapshot(file) {
  try {
    const s = fs.lstatSync(file);
    return {
      dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs,
      regular: s.isFile(),
    };
  } catch { return null; }
}

function sameLock(a, b) {
  return Boolean(a && b && a.dev === b.dev && a.ino === b.ino &&
    a.size === b.size && a.mtimeMs === b.mtimeMs && a.regular === b.regular);
}

function parseLsofWritable(output) {
  return String(output || '').split(/\r?\n/).some((line) => /^f\d+[wu]$/.test(line));
}

function writableOpenState(file) {
  try {
    const output = execFileSync('lsof', ['-F', 'fn', file], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { writable: parseLsofWritable(output), unknown: false };
  } catch (e) {
    if (e && e.status === 1) return { writable: false, unknown: false };
    return { writable: false, unknown: true };
  }
}

function gitProcessState() {
  try {
    const output = execFileSync('pgrep', ['-fl', '(^|/)(git|git-[^ ]+)( |$)'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return { active: Boolean(output), unknown: false, detail: output };
  } catch (e) {
    if (e && e.status === 1) return { active: false, unknown: false, detail: '' };
    return { active: false, unknown: true, detail: '' };
  }
}

function operationMarkers(gitDir) {
  return GIT_OPERATION_MARKERS.filter((marker) => fs.existsSync(path.join(gitDir, marker)));
}

function inspectLock(file, options = {}) {
  const nowMs = options.nowMs === undefined ? Date.now() : options.nowMs;
  const minAgeMs = options.minAgeMs === undefined ? LOCK_STALE_MS : options.minAgeMs;
  const snapshot = lockSnapshot(file);
  const reasons = [];
  if (!snapshot) return { file, snapshot: null, safe: false, reasons: ['lock disappeared'] };
  if (!snapshot.regular) reasons.push('not a regular file');
  if (snapshot.size !== 0) reasons.push(`non-empty (${snapshot.size} bytes)`);
  const ageMs = Math.max(0, nowMs - snapshot.mtimeMs);
  if (ageMs < minAgeMs) reasons.push(`only ${Math.floor(ageMs / 1000)}s old`);
  const markers = operationMarkers(path.dirname(file));
  if (markers.length) reasons.push(`Git operation in progress (${markers.join(', ')})`);
  const openState = (options.openState || writableOpenState)(file);
  if (openState.unknown) reasons.push('could not verify open file handles');
  else if (openState.writable) reasons.push('open for writing by a process');
  const processState = options.processState || gitProcessState();
  if (processState.unknown) reasons.push('could not verify running Git processes');
  else if (processState.active) reasons.push('a Git process is currently running');
  return { file, snapshot, ageMs, safe: reasons.length === 0, reasons };
}

function waitMs(ms) {
  if (ms <= 0) return;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

function doctorLogFile() { return path.join(dataDir(), 'doctor.log'); }

function auditRepair(result, nowMs) {
  ensureDirs();
  const entry = {
    at: new Date(nowMs).toISOString(), action: 'removed-stale-index-lock',
    path: result.file, dev: result.snapshot.dev, ino: result.snapshot.ino,
    ageSeconds: Math.floor(result.ageMs / 1000),
  };
  fs.appendFileSync(doctorLogFile(), JSON.stringify(entry) + '\n');
}

function doctorLocks(roots, options = {}) {
  const nowMs = options.nowMs === undefined ? Date.now() : options.nowMs;
  const minAgeMs = options.minAgeMs === undefined ? LOCK_STALE_MS : options.minAgeMs;
  const probeMs = options.probeMs === undefined ? LOCK_PROBE_MS : options.probeMs;
  const gitDirs = discoverGitDirs(roots);
  const lockFiles = gitDirs.map((dir) => path.join(dir, 'index.lock')).filter((file) => fs.existsSync(file));
  const processCheck = options.processCheck || gitProcessState;
  const openState = options.openState || writableOpenState;
  const results = [];

  for (const file of lockFiles) {
    let processState = processCheck();
    let result = inspectLock(file, { nowMs, minAgeMs, processState, openState });
    if (result.safe) {
      waitMs(probeMs);
      const second = lockSnapshot(file);
      processState = processCheck();
      const secondNow = options.nowMs === undefined ? Date.now() : nowMs + probeMs;
      const secondCheck = inspectLock(file, { nowMs: secondNow, minAgeMs, processState, openState });
      if (!sameLock(result.snapshot, second) || !secondCheck.safe) {
        const changed = !sameLock(result.snapshot, second) ? ['lock changed during safety probe'] : [];
        result.reasons = [...changed, ...secondCheck.reasons];
        result.safe = false;
      } else if (options.repair) {
        // One final identity check narrows the stat/unlink race as far as portable Node allows.
        const finalSnapshot = lockSnapshot(file);
        if (!sameLock(second, finalSnapshot)) {
          result.reasons = ['lock changed immediately before removal'];
          result.safe = false;
        } else {
          fs.unlinkSync(file);
          result.action = 'removed';
          auditRepair(result, Date.now());
        }
      }
    }
    if (!result.action) result.action = result.safe && !options.repair ? 'repairable' : 'blocked';
    results.push(result);
  }
  return { roots: roots.map((root) => path.resolve(expandUser(root))), gitDirs, results };
}

function formatAge(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function cmdDoctor(args, nowMs) {
  let roots = splitList(args.roots || args.paths);
  if (!roots.length) {
    roots = [process.cwd()];
    for (const session of readSessions()) roots.push(session.worktree, session.repo);
  }
  roots = [...new Set(roots.filter((root) => root && !String(root).startsWith('none:')))];
  const minutes = args['min-age-minutes'] === undefined ? LOCK_STALE_MS / 60000 : Number(args['min-age-minutes']);
  if (!Number.isFinite(minutes) || minutes < 1) throw new Error('--min-age-minutes must be at least 1');
  const report = doctorLocks(roots, {
    nowMs, minAgeMs: minutes * 60000, repair: args.repair === true,
  });
  console.log(`aircontrol doctor: scanned ${report.gitDirs.length} Git directories under ${report.roots.length} root(s)`);
  if (!report.results.length) {
    console.log('no index.lock files found');
    return report;
  }
  for (const result of report.results) {
    const age = result.ageMs === undefined ? '?' : formatAge(result.ageMs);
    const detail = result.reasons.length ? ` — ${result.reasons.join('; ')}` : ` — zero-byte, unchanged, ${age} old`;
    console.log(`[${result.action}] ${result.file}${detail}`);
  }
  const repairable = report.results.filter((result) => result.action === 'repairable').length;
  const removed = report.results.filter((result) => result.action === 'removed').length;
  if (!args.repair && repairable) console.log(`dry run: rerun with --repair to remove ${repairable} safely classified stale lock(s)`);
  if (args.repair) console.log(`removed ${removed} stale lock(s); audit: ${doctorLogFile()}`);
  return report;
}

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function readInbox(id) {
  const dir = messagesDir(id);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { return []; }
  files.sort();
  return files.map((f) => {
    const ts = parseInt(f, 10);
    const parts = f.replace(/\.md$/, '').split('-');
    // Nonce segments contain a '.'; pre-nonce files (ts-sender only) don't.
    const from = parts.slice(parts[1] && parts[1].includes('.') ? 2 : 1).join('-');
    let text = '';
    try { text = fs.readFileSync(path.join(dir, f), 'utf8').trim(); } catch {}
    return { file: path.join(dir, f), at: new Date(Number.isFinite(ts) ? ts : 0).toISOString(), from, text };
  });
}

// ---------- activity log ----------
//
// Per-day history of what every session did: one compact JSON line per event
// under activity/YYYY-MM-DD.jsonl. Deliberately lightweight — enough to look
// back and see who touched what, not a transcript. Appends need no lock for
// the same reason ledger appends don't (nothing rewrites a line in place).
// Kept forever unless config.json sets activityRetentionDays.

function activityDir() { return path.join(dataDir(), 'activity'); }

// Local calendar date, not UTC — a session's day should match the operator's.
function localDateStr(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function activityFile(nowMs) { return path.join(activityDir(), `${localDateStr(nowMs)}.jsonl`); }

// Never throws: called from hooks, and a logging failure must not break a session.
function logActivity(event, nowMs) {
  try {
    fs.mkdirSync(activityDir(), { recursive: true });
    fs.appendFileSync(activityFile(nowMs), JSON.stringify(event) + '\n');
  } catch {}
}

// Common head of every event; `name` is rendered at write time so the log
// stays human-readable after the session (and its id→name context) is gone.
function activityBase(s, nowMs) {
  return { ts: new Date(nowMs).toISOString(), sid: s.sessionId, name: friendlyName(s.sessionId), repo: s.repo, branch: s.branch };
}

// The summary that outlives the session file: deregister and sweep both delete
// sessions/<id>.json, and this event is the only durable record of what the
// session was doing when it went.
function sessionEndEvent(s, nowMs) {
  const ev = { ...activityBase(s, nowMs), ev: 'session-end', intent: s.intent, paths: s.recentPaths || [] };
  const claims = s.claims || {};
  if ((claims.paths || []).length || (claims.resources || []).length) ev.claims = claims;
  const started = Date.parse(s.startedAt);
  if (Number.isFinite(started)) ev.durationMin = Math.round((nowMs - started) / 60000);
  return ev;
}

const ACTIVITY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

// Day files in range, sorted ascending. `date` selects exactly one day;
// otherwise the last `days` calendar days ending today (default: today only).
function readActivityFiles(nowMs, { date, days } = {}) {
  let names;
  try { names = fs.readdirSync(activityDir()); } catch { return []; }
  const files = names.filter((f) => ACTIVITY_FILE_RE.test(f)).sort();
  if (date) return files.filter((f) => f === `${date}.jsonl`);
  const n = Math.max(1, Number(days) || 1);
  const from = localDateStr(nowMs - (n - 1) * 86400000);
  const to = localDateStr(nowMs);
  return files.filter((f) => f.slice(0, 10) >= from && f.slice(0, 10) <= to);
}

function readActivityEvents(files) {
  const out = [];
  for (const f of files) {
    let raw;
    try { raw = fs.readFileSync(path.join(activityDir(), f), 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch {} // a torn line loses itself, not the file
    }
  }
  return out;
}

// null = keep forever (the default); pruning is opt-in via config.json.
function activityRetentionDays() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    const n = Number(cfg && cfg.activityRetentionDays);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  } catch {}
  return null;
}

function pruneActivity(nowMs, keepDays) {
  let names;
  try { names = fs.readdirSync(activityDir()); } catch { return 0; }
  const cutoff = localDateStr(nowMs - keepDays * 86400000);
  let removed = 0;
  for (const f of names) {
    const m = f.match(ACTIVITY_FILE_RE);
    if (m && m[1] < cutoff) {
      try { fs.unlinkSync(path.join(activityDir(), f)); removed++; } catch {}
    }
  }
  return removed;
}

// ---------- hook subcommands ----------

function cmdRegister(input, nowMs, harness) {
  const id = input.session_id;
  if (!isSafeComponent(id)) return;
  const g = gitInfo(input.cwd || process.cwd());
  const prev = readSession(id);
  writeSession({
    sessionId: id,
    harness: detectHarness(input, harness, prev),
    // Codex sends null on SessionStart and the real path later; keep whatever is known.
    transcriptPath: payloadTranscript(input) || (prev && prev.transcriptPath) || null,
    startedAt: (prev && prev.startedAt) || new Date(nowMs).toISOString(),
    lastSeen: new Date(nowMs).toISOString(),
    repo: g.repo,
    worktree: g.worktree,
    branch: g.branch,
    // Assigned once, on the first register, and kept: a session that renamed
    // itself mid-life would strand every message and ledger row already
    // addressed to the old name. A session that predates salts reads as salt 0,
    // which is the name it has been answering to all along.
    nameSalt: prev ? (Number.isInteger(prev.nameSalt) ? prev.nameSalt : 0) : pickNameSalt(id, nowMs),
    intent: (prev && prev.intent) || '(not yet declared)',
    claims: (prev && prev.claims) || { paths: [], resources: [] },
    recentPaths: (prev && prev.recentPaths) || [],
    ledgerPending: true,
    budget: (prev && prev.budget) || emptyBudget(),
    rev: (prev && prev.rev) || 0,
  });
  saltCache.delete(id);
  if (!prev) {
    logActivity({ ...activityBase({ sessionId: id, repo: g.repo, branch: g.branch }, nowMs), ev: 'session-start', worktree: path.basename(g.worktree) }, nowMs);
  }
  try { autoLinkSkills(g.worktree, g.repo); } catch {}
  sweep(nowMs);
}

function cmdBeat(input, nowMs, harness) {
  const id = input.session_id;
  if (!isSafeComponent(id)) return;
  const before = readSession(id);
  if (!before) { cmdRegister(input, nowMs, harness); return; }
  const paths = toolInputPaths(input);
  // The activity diff comes from a pre-update snapshot: independent of the
  // debounce below (which may skip the session write entirely) and immune to
  // updateSession's optimistic retry re-running its mutate callback.
  const newlySeen = [];
  for (const fp of paths) {
    let rel = path.isAbsolute(fp) ? path.relative(before.worktree, fp) : fp;
    if (rel.startsWith('..')) rel = fp;
    if (!(before.recentPaths || []).includes(rel) && !newlySeen.includes(rel)) newlySeen.push(rel);
  }
  const tp = payloadTranscript(input);
  updateSession(id, (s) => {
    for (const fp of paths) {
      let rel = path.isAbsolute(fp) ? path.relative(s.worktree, fp) : fp;
      if (rel.startsWith('..')) rel = fp; // outside the worktree: keep it absolute, still informative
      s.recentPaths = (s.recentPaths || []).filter((p) => p !== rel);
      s.recentPaths.push(rel);
    }
    if ((s.recentPaths || []).length > MAX_RECENT) s.recentPaths = s.recentPaths.slice(-MAX_RECENT);
    // A transcript path that just became known is worth a write on its own: the budget
    // line and retro are blind until it lands, debounce or not.
    const tpChanged = !!tp && s.transcriptPath !== tp;
    if (tpChanged) s.transcriptPath = tp;
    if (!paths.length && !tpChanged && nowMs - Date.parse(s.lastSeen) < BEAT_MS) return null; // debounce: skip the write
    // "Work happened since the last next-steps offer" -- what separates a turn
    // worth offering to plan from pure conversation, which touches no tool at all.
    // Set after the debounce, never before: forcing a write here to persist a
    // boolean would defeat the debounce this session deliberately has, and a beat
    // skipped now is followed by one that writes.
    s.workSinceOffer = true;
    s.lastSeen = new Date(nowMs).toISOString();
    return s;
  });
  if (newlySeen.length) logActivity({ ...activityBase(before, nowMs), ev: 'files', paths: newlySeen }, nowMs);
  for (const m of classifyCommand(commandText(input))) {
    logActivity({ ...activityBase(before, nowMs), ev: 'cmd', kind: m.kind, ...(m.key ? { key: m.key } : {}) }, nowMs);
  }
}

// Tell live senders their message died unread, at the moment the recipient dies
// (a sender 30 days later is long gone). Bounces carry BOUNCE_PREFIX so a bounce
// left unread never generates a bounce of its own.
const BOUNCE_PREFIX = '[aircontrol bounce]';

function bounceUndelivered(deadId, nowMs) {
  let inbox = [];
  try { inbox = readInbox(deadId); } catch { return; }
  if (!inbox.length) return;
  const live = new Set(readSessions()
    .filter((s) => s.sessionId !== deadId && !isExpired(s, nowMs))
    .map((s) => s.sessionId));
  for (const m of inbox) {
    if (!m.from || !live.has(m.from)) continue;
    if (m.text.startsWith(BOUNCE_PREFIX)) continue;
    const quoted = m.text.length > 200 ? m.text.slice(0, 200) + '…' : m.text;
    const note = `${BOUNCE_PREFIX} ${friendlyName(deadId)} ended before reading your message from ${m.at}: "${quoted}"`;
    try {
      fs.mkdirSync(messagesDir(m.from), { recursive: true });
      fs.writeFileSync(path.join(messagesDir(m.from), messageFilename(nowMs, deadId)), note + '\n');
      // The sender was just told "never read" — a resume of the dead session
      // must not deliver it after all. Only an unbounced message stays unread.
      fs.renameSync(m.file, m.file + '.read');
    } catch {}
  }
}

/// Reap the browsers this session started, and only those.
///
/// Ancestor-based, like the `tasks` reaper: a browser tree is ours when it walks up to THIS
/// session's `claude` process. This is stronger than the old token match — playwright's tree
/// carries no CLAUDE_CODE_MESSAGING_TOKEN, so token attribution silently dropped every
/// playwright-only session's browsers, including our own, into "unattributed" and never reaped
/// them. Returns the pids signalled, for the test to assert on.
function reapOwnBrowsers(deps = {}) {
  const { allProcs, browserProcs, myClaudePid, live } = browserContext(deps);
  if (!myClaudePid) return [];
  const { mine } = classifyBrowserProcs(browserProcs, allProcs, myClaudePid, live);
  const kill = deps.kill || ((pid) => process.kill(pid, 'SIGTERM'));
  const killed = [];
  for (const p of mine) { try { kill(p.pid); killed.push(p.pid); } catch {} }
  return killed;
}

function scheduleCodexArchive(id, session, deps = {}) {
  if (session.harness !== 'codex') return;
  try {
    const child = (deps.spawn || spawn)(process.execPath,
      [path.join(__dirname, 'codex-listener.js'), '--archive', '--session', id],
      { detached: true, stdio: 'ignore', cwd: session.worktree || process.cwd() });
    if (child && typeof child.unref === 'function') child.unref();
  } catch {}
}

function cmdDeregister(input, nowMs = Date.now(), deps = {}) {
  const id = input.session_id;
  if (!isSafeComponent(id)) return;
  const s = readSession(id);
  // Archiving is intentionally deferred to a detached child: the SessionEnd hook itself must
  // remain fast and must not prevent local cleanup when Codex's daemon is restarting.
  if (s && input.reason !== 'clear') scheduleCodexArchive(id, s, deps);
  if (s) logActivity({ ...sessionEndEvent(s, nowMs), reason: input.reason || null }, nowMs);
  try { bounceUndelivered(id, nowMs); } catch {}
  // A real ending owns its leased devices until they are shut down. `/clear` carries on in
  // the same harness process, so it keeps the historical release-only behavior and must not
  // pull a simulator out from under the continuing session.
  const mayOperateDevices = deps.live === true || typeof deps.shutdownDevice === 'function';
  try {
    if (input.reason !== 'clear' && mayOperateDevices) shutdownAndReleaseLeases(id, deps, { keepFailed: false });
    else releaseSessionLeases(id);
  } catch { try { releaseSessionLeases(id); } catch {} }
  try { fs.unlinkSync(sessionFile(id)); } catch {}
  // SessionEnd also fires for /clear, where the session carries straight on — killing its
  // browsers there would pull the page out from under work still in progress. Only a real
  // ending reaps.
  // `live` is set only by the hook dispatch, and a test that wants the reap injects its own
  // `kill`. Without one of the two, reaping is skipped: `cmdDeregister` is a plain exported
  // function, so `node --test` calls it for real, and an ungated reap resolves the REAL claude
  // ancestor and signals the developer's actual background shells. That is not hypothetical —
  // it killed two live shells the first time this ran.
  const mayReap = deps.live === true || typeof deps.kill === 'function';
  if (input.reason !== 'clear' && mayReap) {
    try { reapOwnBrowsers(deps); } catch {}
    try { reapOwnTasks(deps); } catch {}
  }
}

// ---------- guard (PreToolUse hook) ----------
//
// The hard-block counterpart to advisories. Runs before every Edit/Write/Bash;
// a deny is printed as the documented PreToolUse JSON, anything else is
// SILENCE — never an explicit "allow", which could override a stricter
// decision from another hook or the user's own permission rules. Guard is on
// the critical path of every tool call: reads only, never sweep(), and any
// internal error means silence (fail-open), matching the hook philosophy.

// The target must be UDID-shaped (≥8 hex chars, dashes allowed) — plain words
// after "boot" are usually prose quoting the command ("simctl boot without a
// lease…"), and a false deny on an echo is worse than missing a name-based
// boot, which the README already steers away from (names silently run zero
// tests via OS:latest).
const SIMCTL_BOOT_RE = /\bsimctl\s+(?:boot|bootstatus)\s+["']?([0-9A-Fa-f-]{8,})\b/;
const EMULATOR_AVD_RE = /\bemulator\b[^\n;|&]*?-avd[= ]+["']?([\w.-]+)/;
const GIT_STASH_RE = /\bgit\b[^\n;|&]*?\bstash\b(?:\s+(\w+))?/;
const STASH_READONLY_SUBS = new Set(['list', 'show', 'branch']);
// Deploys contend only when they target the same system: an App Store Connect
// upload and a Firebase deploy share nothing but the verb, yet a single `deploy`
// resource made every pair of them wait on each other. Each pattern names a
// scope and the guard gates on `deploy:<scope>`. A pattern with no scope keeps
// the old machine-wide meaning, which is the safe answer when the target cannot
// be read off the command: an ambiguous lane ships to whichever store its
// config names.
//
// `family` is how a specific rule beats the catch-all without the catch-all
// also claiming the command -- only the first match per family counts, so the
// rules within one family are ordered specific first.
const DEPLOY_PATTERNS = [
  { family: 'firebase', re: /\bfirebase\s+deploy\b/, scope: 'firebase' },
  { family: 'wrangler', re: /\bwrangler\s+(?:deploy|publish)\b/, scope: 'cloudflare' },
  { family: 'fastlane', re: /\bfastlane\s+\w*(?:deliver|pilot|testflight|app_store)\w*/, scope: 'asc' },
  { family: 'fastlane', re: /\bfastlane\s+\w*(?:supply|play_store)\w*/, scope: 'play' },
  { family: 'fastlane', re: /\bfastlane\s+\w*(?:upload|release|deploy|beta)\w*/, scope: null },
  { family: 'eas', re: /\beas\s+submit\b/, scope: null },
  { family: 'npm', re: /\bnpm\s+run\s+deploy\b/, scope: null },
];
const DEPLOY_ANY = '*';
const DEPLOY_PREFIX = 'deploy:';
const MAX_BLOCKED = 20;
// Log-only kind: pushes are never denied, but they matter when looking back.
const GIT_PUSH_RE = /\bgit\b[^\n;|&]*?\bpush\b/;

function commandText(input) {
  const c = input && input.tool_input && input.tool_input.command;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.every((x) => typeof x === 'string')) return c.join(' ');
  return '';
}

// Per-install extra deploy regexes (config.json guardPatterns.deploy) — deploys
// have no fixed command shape, so each machine can teach guard its own. They
// extend the built-ins; a bad pattern is skipped, never fatal.
function deployPatterns() {
  const out = [...DEPLOY_PATTERNS];
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    const taught = (cfg && cfg.guardPatterns && cfg.guardPatterns.deploy) || [];
    taught.forEach((p, i) => {
      // A bare string is a pattern with no scope, which is what every existing
      // config holds; `{ pattern, scope }` names the target it ships to.
      const src = typeof p === 'string' ? p : p && p.pattern;
      const scope = typeof p === 'string' ? null : (p && p.scope) || null;
      if (!src) return;
      try { out.push({ family: `config:${i}`, re: new RegExp(src), scope }); } catch {}
    });
  } catch {}
  return out;
}

// A claim of bare `deploy` covers every target; `deploy:<scope>` covers one.
function deployScopes(resources) {
  const out = new Set();
  for (const r of resources || []) {
    if (r === 'deploy') out.add(DEPLOY_ANY);
    else if (r.startsWith(DEPLOY_PREFIX) && r.length > DEPLOY_PREFIX.length) out.add(r.slice(DEPLOY_PREFIX.length));
  }
  return out;
}

function deployScopesOverlap(a, b) {
  if (!a.size || !b.size) return false;
  if (a.has(DEPLOY_ANY) || b.has(DEPLOY_ANY)) return true;
  for (const s of a) if (b.has(s)) return true;
  return false;
}

// Every scope a command deploys to, first match per family.
function commandDeployScopes(text) {
  const seen = new Set();
  const scopes = [];
  for (const { family, re, scope } of deployPatterns()) {
    if (seen.has(family) || !re.test(text)) continue;
    seen.add(family);
    const s = scope || null;
    if (!scopes.includes(s)) scopes.push(s);
  }
  return scopes;
}

// A guard pattern describes a COMMAND, but it is matched against the raw tool
// input, so it fires on prose too — a commit message, a `--title`, a comment
// inside a file being written. That is the same call SIMCTL_BOOT_RE makes
// above, for the same reason: a false deny on an echo is worse than a missed
// match. Found in the wild repeatedly, three times while fixing it — guard
// denied a heredoc whose code comment named a lane verb, then the ledger entry
// describing that denial, then the comment below that documents the rule.
//
// So strip what a shell treats as DATA before classifying. Heredoc bodies are
// input to whatever reads them (`python3 -`, `cat > file`), not commands the
// outer shell runs. A quoted span CONTAINING WHITESPACE is prose; one without
// is an ordinary argument, so a quoted device id is kept and the UDID rule
// above still sees its target.
const HEREDOC_BODY = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1[\s\S]*?^\s*\2\s*$/gm;
const QUOTED_PROSE = /'[^'\n]*\s[^'\n]*'|"(?:[^"\\\n]|\\.)*\s(?:[^"\\\n]|\\.)*"/g;
// The exception: under `sh -c` the quoted string IS the command, so keep it.
const SHELL_DASH_C = /\b(?:ba|z|k|da)?sh\s+(?:-\w+\s+)*-c\b/;

// Printing a credential file is the one mistake no amount of care prevents,
// because it is never the goal: the file is opened for a key name, a port, a
// hook path, and the secret two lines further down comes with it. `grep -A`
// and `cat` do not know which line was wanted, and once the value is in the
// transcript it is burnt whether or not anybody read it.
//
// The rule is about the VERB, not the path. Sourcing an env file, editing a
// settings.json, passing a .p8 to a signer — none of those emit anything, and
// all of them are how this machine actually works. Only a command that writes
// the contents to stdout is refused, and it is refused in favour of a reader
// that prints the same file with the values masked.
const SECRET_FILE_RE = /(?:^|[\s"'=/])(?:[\w.-]*(?:secret|credential)[\w.-]*|\.?env(?:\.[\w-]+)?|settings(?:\.local)?\.json|\.netrc|\.npmrc|\.pypirc|hosts\.yml|[\w.-]+\.(?:p8|pem|jks|keystore|p12)|id_(?:rsa|ed25519|ecdsa))(?=$|[\s"';|&)])/i;
const DUMPING_RE = /\b(?:cat|bat|nl|head|tail|less|more|xxd|strings|base64|grep|egrep|fgrep|rg|ag|ack|sed|awk|jq|yq)\b/;
// A dump is only a leak if it reaches stdout. Written to a file or captured
// into a variable, the value never enters the conversation, and CLAUDE.md
// already tells the machine to read secrets exactly that way.
const CAPTURED_RE = /=\s*[$`]\(|=\s*`|>\s*\S|\|\s*(?:xxd|base64|openssl|tee\b[^|]*>)/;
// `security find-generic-password -w` prints the secret itself. The Keychain
// is where every key on this machine lives, so this is the shortest path from
// "stored safely" to "in the transcript, rotate it".
const KEYCHAIN_READ_RE = /\bsecurity\s+find-(?:generic|internet)-password\b[^\n;|&]*?\s-w\b/;

function secretDumps(text) {
  const out = [];
  for (const segment of text.split(/[;\n]|&&|\|\|/)) {
    if (!segment.trim()) continue;
    if (CAPTURED_RE.test(segment)) continue;
    if (KEYCHAIN_READ_RE.test(segment)) { out.push({ kind: 'secret-echo', key: 'keychain' }); continue; }
    const hit = segment.match(SECRET_FILE_RE);
    if (DUMPING_RE.test(segment) && hit) {
      // The pattern matches a filename, but what is worth handing back is the
      // whole path as it was written, so the suggested reader can be run as
      // printed rather than retyped from a fragment.
      const head = segment.slice(0, hit.index + hit[0].length);
      const word = (head.match(/\S+$/) || [hit[0]])[0];
      const tail = (segment.slice(hit.index + hit[0].length).match(/^\S*/) || [''])[0];
      out.push({ kind: 'secret-dump', key: (word + tail).replace(/^["']+|["',]+$/g, '') });
    }
  }
  return out;
}

function commandOnly(cmd) {
  if (!cmd) return '';
  const text = cmd.replace(HEREDOC_BODY, ' ');
  return SHELL_DASH_C.test(text) ? text : text.replace(QUOTED_PROSE, ' ');
}

// Shared by guard (denies) and the activity log (records). Returns every match,
// not just the first — a chained `git push && npm run deploy` is two notable
// things — while guard keeps its own early-return precedence over the result.
function classifyCommand(cmd) {
  if (!cmd) return [];
  const text = commandOnly(cmd);
  if (!text.trim()) return [];
  const out = [];
  const sim = text.match(SIMCTL_BOOT_RE);
  if (sim) out.push({ kind: 'sim-boot', key: sim[1] });
  const avd = text.match(EMULATOR_AVD_RE);
  if (avd) out.push({ kind: 'avd-boot', key: avd[1] });
  const stash = text.match(GIT_STASH_RE);
  if (stash && !STASH_READONLY_SUBS.has(stash[1] || '')) out.push({ kind: 'git-stash', key: stash[1] || 'push' });
  // Config-taught patterns go through the same stripping as the built-ins: a
  // machine teaching guard `make ship` should not also teach it to deny an echo.
  for (const scope of commandDeployScopes(text)) out.push(scope ? { kind: 'deploy', key: scope } : { kind: 'deploy' });
  for (const leak of secretDumps(text)) out.push(leak);
  if (GIT_PUSH_RE.test(text)) out.push({ kind: 'git-push' });
  return out;
}

function guardLeaseCheck(platform, key, sessionId) {
  const lease = readLease(platform, key);
  if (lease && lease.sessionId === sessionId) return null;
  if (lease && lease.sessionId) {
    return `${platform === 'ios' ? 'Simulator' : 'Emulator'} ${key} is leased to ${friendlyName(lease.sessionId)} ("${lease.purpose || '?'}"). Message them (coord.js send) or acquire another device with \`coord.js sim acquire\`.`;
  }
  return `No lease held for ${platform === 'ios' ? 'simulator' : 'emulator'} ${key}. Run \`coord.js sim acquire --session <you> --for "<purpose>"\` first — it also picks the device that already has your app installed.`;
}

function guardResourceCheck(resource, self, others) {
  const mine = ((self.claims && self.claims.resources) || []).includes(resource);
  if (!mine) {
    return `Resource "${resource}" is not claimed by this session. Claim it first: \`coord.js claim --session <you> --resources ${resource}\` — then check \`coord.js who\` for contention.`;
  }
  for (const o of others) {
    if (REPO_SCOPED_RESOURCES.has(resource) && o.repo !== self.repo) continue;
    if (((o.claims && o.claims.resources) || []).includes(resource)) {
      return `Resource "${resource}" is also claimed by ${friendlyName(o.sessionId)} ("${o.intent}") — coordinate with them (coord.js send) before touching it.`;
    }
  }
  return null;
}

// Deploys get their own check because two of them only collide when their
// targets do. A bare claim on either side is machine-wide and still collides
// with everything, which keeps an un-migrated session safe rather than silently
// narrowing what it reserved.
function guardDeployCheck(scope, self, others) {
  const name = scope ? `${DEPLOY_PREFIX}${scope}` : 'deploy';
  const need = new Set([scope || DEPLOY_ANY]);
  const mine = deployScopes((self.claims && self.claims.resources) || []);
  if (!deployScopesOverlap(mine, need)) {
    return `Resource "${name}" is not claimed by this session. Claim it first: \`coord.js claim --session <you> --resources ${name}\` — then check \`coord.js who\` for contention. Bare \`deploy\` covers every target; \`${name}\` contends only with other ${scope || 'deploy'} work.`;
  }
  for (const o of others) {
    const theirs = (o.claims && o.claims.resources) || [];
    if (!deployScopesOverlap(deployScopes(theirs), need)) continue;
    const held = theirs.filter((r) => r === 'deploy' || r.startsWith(DEPLOY_PREFIX)).join(', ');
    return `Resource "${name}" contends with ${friendlyName(o.sessionId)}'s "${held}" ("${o.intent}") — coordinate with them (coord.js send) before touching it. Deploys to different targets do not contend, so claiming \`deploy:<target>\` rather than bare \`deploy\` keeps you out of each other's way.`;
  }
  return null;
}

function computeGuardDecision(input, nowMs) {
  const id = input && input.session_id;
  if (!isSafeComponent(id)) return { deny: false };
  const self = readSession(id);
  const others = readSessions().filter((o) => o.sessionId !== id && !isExpired(o, nowMs));

  // Paths: deny only on overlap with another LIVE same-repo session's explicit
  // claim. recentPaths stay advisory — touching a file is not claiming it.
  if (self) {
    for (const fp of toolInputPaths(input)) {
      let rel = path.isAbsolute(fp) ? path.relative(self.worktree, fp) : fp;
      if (rel.startsWith('..')) rel = fp;
      for (const o of others) {
        if (o.repo !== self.repo) continue;
        for (const claim of (o.claims && o.claims.paths) || []) {
          if (pathsOverlap(claim, rel)) {
            return {
              deny: true,
              target: rel,
              reason: `Path "${rel}" overlaps "${claim}", claimed by ${friendlyName(o.sessionId)} ("${o.intent}", last seen ${agoLabel(o.lastSeen, nowMs)}). Message them (\`coord.js send --to ${friendlyName(o.sessionId)}\`) or wait for their release; \`coord.js who\` shows the room. If they are plainly gone, \`coord.js release --session ${friendlyName(o.sessionId)}\` frees the claim.`,
            };
          }
        }
      }
    }
  }

  const cmd = commandText(input);
  if (!cmd) return { deny: false };

  for (const m of classifyCommand(cmd)) {
    if (m.kind === 'sim-boot') {
      const reason = guardLeaseCheck('ios', m.key, id);
      if (reason) return { deny: true, target: `sim:${m.key}`, reason };
    } else if (m.kind === 'avd-boot') {
      const reason = guardLeaseCheck('android', m.key, id);
      if (reason) return { deny: true, target: `avd:${m.key}`, reason };
    } else if (m.kind === 'git-stash' && self) {
      const reason = guardResourceCheck('stash', self, others);
      if (reason) return { deny: true, target: 'stash', reason };
    } else if (m.kind === 'deploy' && self) {
      const reason = guardDeployCheck(m.key || null, self, others);
      if (reason) return { deny: true, target: m.key ? `${DEPLOY_PREFIX}${m.key}` : 'deploy', reason };
    } else if (m.kind === 'secret-dump') {
      return {
        deny: true, target: `secret:${m.key}`,
        reason: `This would print ${m.key} to the transcript, where any credential in it is permanent and has to be rotated. Read it masked instead: \`coord.js peek ${m.key}\` (add \`--keys\` for names only, \`--grep <pattern>\` to narrow). To USE a value, capture it — \`KEY=$(...) cmd\` — or redirect to a file; neither is blocked. Editing the file is not blocked either.`,
      };
    } else if (m.kind === 'secret-echo') {
      return {
        deny: true, target: 'secret:keychain',
        reason: 'This prints a Keychain secret to stdout, which burns it: anything in the transcript is permanent and must be rotated. Pass it inline instead, so the value is never rendered: `KEY=$(security find-generic-password -a "$USER" -s NAME -w) cmd`. Check the exit code, never the value.',
      };
    } // git-push: log-only, never denied
  }
  return { deny: false };
}

function guardLogFile() { return path.join(dataDir(), 'guard.log'); }

function recordDenial(id, result, input, nowMs) {
  try {
    updateSession(id, (s) => {
      s.blockedAttempts = [...(s.blockedAttempts || []), { ts: new Date(nowMs).toISOString(), tool: (input && input.tool_name) || '', target: result.target || '' }].slice(-MAX_BLOCKED);
      return s;
    });
  } catch {}
  try {
    fs.appendFileSync(guardLogFile(), JSON.stringify({
      ts: new Date(nowMs).toISOString(), sessionId: id, tool: (input && input.tool_name) || '', target: result.target || '', reason: result.reason,
    }) + '\n');
  } catch {}
  try {
    const self = readSession(id);
    logActivity({
      ts: new Date(nowMs).toISOString(), sid: id, name: friendlyName(id),
      repo: (self && self.repo) || null, branch: (self && self.branch) || null,
      ev: 'deny', tool: (input && input.tool_name) || '', target: result.target || '', reason: result.reason,
    }, nowMs);
  } catch {}
}

function cmdGuard(input, nowMs) {
  let result;
  try {
    result = computeGuardDecision(input, nowMs);
  } catch (e) {
    // Guard must never crash the hook, but a decision that threw is enforcement
    // silently turning itself off — that has to leave a trace somewhere, or a
    // regression here is invisible until someone notices claims stopped working.
    try {
      fs.appendFileSync(guardLogFile(), JSON.stringify({
        ts: new Date(nowMs).toISOString(), sessionId: input && input.session_id, err: String((e && e.message) || e),
      }) + '\n');
    } catch {}
    return;
  }
  if (!result || !result.deny) return;
  recordDenial(input.session_id, result, input, nowMs);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: result.reason,
    },
  }) + '\n');
}

// ---------- inject (hook) ----------

function cmdInject(input, nowMs, harness) {
  const id = input.session_id;
  if (!isSafeComponent(id)) return;
  if (harness && !HARNESSES.has(harness)) harness = undefined; // legacy 'plain' and typos: infer instead
  let existing = readSession(id);
  if (!existing) {
    cmdRegister(input, nowMs, harness);
    existing = readSession(id);
    if (!existing) return;
  }
  let ledgerPending = false;
  let budgetLine = '';
  const tp = payloadTranscript(input);
  const transcript = sessionTranscript(input, id, existing);
  const s = updateSession(id, (cur) => {
    cur.lastSeen = new Date(nowMs).toISOString();
    if (harness) cur.harness = harness; // the installer's flag outranks whatever an older register inferred
    if (tp) cur.transcriptPath = tp; // only what the payload said — never the slug fallback
    ledgerPending = cur.ledgerPending !== false;
    cur.ledgerPending = false;
    // Metered inside the mutator so a rev conflict recomputes the delta from the winning
    // record's offset rather than counting the same bytes twice. Fails open, like guard:
    // a broken meter must never cost the session its roster block.
    try {
      cur.budget = readTranscriptDelta(transcript, cur.budget);
      budgetLine = renderBudgetLine(cur.budget);
    } catch { budgetLine = ''; }
    return cur;
  });
  if (!s) return;
  const others = readSessions().filter((o) => o.sessionId !== id && !isExpired(o, nowMs));
  const inbox = readInbox(id);
  const cliPath = cliPathFor(detectHarness(input, harness, s));
  let ledgerLine = '';
  if (ledgerPending) {
    try {
      const items = ledgerView(nowMs);
      ledgerLine = renderLedgerLine(ledgerCounts(items, s.repo), path.basename(s.worktree), cliPath);
      const pick = suggestNextLedgerItem(items, s.repo, gitOriginKey(s.worktree));
      if (ledgerLine && pick) {
        ledgerLine += `\n[aircontrol] suggested next: ${pick.id} "${pick.title}"${pick.priority !== 'normal' ? ` (${pick.priority})` : ''} — \`${cliPath.replace(/^~/, 'node ~')} ledger take ${pick.id}\` before working it`;
      }
    } catch { ledgerLine = ''; }
  }
  let diskLine = '';
  try { diskLine = renderDiskLine(diskUsage(s.worktree || os.homedir()), cliPath); } catch { diskLine = ''; }
  const context = renderInjection(s, others, inbox, nowMs, cliPath, ledgerLine, budgetLine, diskLine);
  // Both harnesses take the same shape, and it is the quiet one. `additionalContext`
  // reaches the model without echoing the roster into the operator's terminal; bare stdout
  // is *printed as well as* injected, which put a block of coordination state in front of
  // the human on every single prompt. The harness only picks the CLI path in the footer.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context,
    },
  }) + '\n');
  for (const m of inbox) { try { fs.renameSync(m.file, m.file + '.read'); } catch {} }
}

// Push delivery. `inject` only fires when a human submits a prompt, so a message
// to a busy session sat unread until its operator typed something — the human was
// the transport. Stop fires when the model finishes its turn, so the nudge lands
// there instead and the recipient answers before yielding.
//
// This cannot loop: the delivered messages are marked `.read`, so the next Stop
// finds an empty inbox and lets the turn end. `stop_hook_active` is belt-and-braces
// on top of that. Marking read *after* the write matches cmdInject and keeps the
// safer failure mode — a rename that fails re-delivers, it does not lose.
// The moment the operator currently types "let's come up with a plan for next
// steps" by hand: a turn that did some work and ended with nothing else pending.
// Offered here rather than as a line in the prompt block because an always-on
// nudge becomes wallpaper, and because Stop is the only surface that can say
// anything without the human typing first.
//
// It OFFERS. The reason text is read by the model, which will do what it says,
// so it has to be explicit that the skill is not to be invoked here — a nudge
// that auto-runs a planning session is the opposite of being prompted.
//
// Silent after pure conversation, because `workSinceOffer` is only ever set by
// cmdBeat, which fires on the file-touching tools. Silent while messages are
// waiting, because those take the same channel and an answer owed to another
// session comes first; the offer keeps until the next quiet turn.
//
// Silent while this session's own background shells are still running, because
// "nothing else is pending" is the one claim the offer makes and a running
// build, test run or deploy is exactly something pending. The flag is left
// standing, so the offer arrives on the next quiet turn — the same deferral the
// inbox gets. Unknown counts as quiet: if the process table cannot be read or
// no `claude` ancestor resolves, the offer goes out rather than disappearing
// for the rest of the session.
//
// Cannot loop: the flag is cleared in the same call that emits the offer, so
// the continuation this blocks for finds it false and lets the turn end.
function offerNextSteps(id, s, deps = {}) {
  if (s.workSinceOffer !== true) return;
  if (ownTasksRunning(deps)) return;
  updateSession(id, (x) => { x.workSinceOffer = false; return x; });
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: [
      '[aircontrol] This turn did some work and nothing else is pending.',
      'Offer the `next-steps` skill to the user in ONE short line — it gathers what is',
      'still open, asks which thread to take, and plans it. Do not invoke it yourself,',
      'do not start planning, and do not expand on this: print the offer, then finish.',
      'Say nothing at all if you have already offered it this turn.',
    ].join('\n'),
  }) + '\n');
}


function cmdStop(input, nowMs, harness, deps = {}) {
  if (input && input.stop_hook_active) return; // already inside our own continuation
  const id = input && input.session_id;
  if (!isSafeComponent(id)) return;
  const s = readSession(id);
  if (!s) return; // unregistered: nothing addressed us, nothing to deliver
  const inbox = readInbox(id);
  if (!inbox.length) return offerNextSteps(id, s, deps); // no messages: maybe offer to plan what's next
  const msg = renderMessageLines(inbox, nowMs);
  const lines = ['[aircontrol] ' + msg[0], ...msg.slice(1)];
  lines.push(`Answer any that need an answer (\`node ${cliPathFor(detectHarness(input, harness, s))} send --session ${friendlyName(id)} --to <them> "…"\`), then finish.`);
  process.stdout.write(JSON.stringify({ decision: 'block', reason: lines.join('\n') }) + '\n');
  for (const m of inbox) { try { fs.renameSync(m.file, m.file + '.read'); } catch {} }
}


// ---------- CLI subcommands ----------

function requireLiveSession(args, nowMs) {
  const ids = readSessions().filter((s) => !isExpired(s, nowMs)).map((s) => s.sessionId);
  const id = resolveIdPrefix(ids, args.session);
  const session = readSession(id);
  // The id just came from a live-session snapshot, but sweep() runs on every
  // register call — on a busy machine the file can be gone by the time we
  // re-read it. Without this check every caller dereferences null and the
  // failure surfaces as a raw TypeError instead of a fixable message.
  if (!session) throw new Error(`session ${shortId(id)} vanished between lookup and read — try again`);
  return session;
}

function cmdClaim(args, nowMs) {
  const s0 = requireLiveSession(args, nowMs);
  const s = updateSession(s0.sessionId, (cur) => {
    if (args.intent) cur.intent = args.intent;
    cur.claims = mergeClaims(cur.claims, splitList(args.paths), splitList(args.resources));
    cur.lastSeen = new Date(nowMs).toISOString();
    return cur;
  });
  console.log(`claimed for ${friendlyName(s.sessionId)}: intent="${s.intent}" paths=[${s.claims.paths}] resources=[${s.claims.resources}]`);
  const paths = splitList(args.paths);
  const resources = splitList(args.resources);
  if (args.intent || paths.length || resources.length) {
    logActivity({ ...activityBase(s, nowMs), ev: 'claim', ...(args.intent ? { intent: args.intent } : {}), paths, resources }, nowMs);
  }
}

function cmdRelease(args, nowMs) {
  const s0 = requireLiveSession(args, nowMs);
  const paths = splitList(args.paths);
  const res = splitList(args.resources);
  const s = updateSession(s0.sessionId, (cur) => {
    if (!paths.length && !res.length) {
      cur.claims = { paths: [], resources: [] };
      cur.intent = 'unassigned';
    } else {
      cur.claims = {
        paths: ((cur.claims && cur.claims.paths) || []).filter((p) => !paths.includes(p)),
        resources: ((cur.claims && cur.claims.resources) || []).filter((r) => !res.includes(r)),
      };
    }
    cur.lastSeen = new Date(nowMs).toISOString();
    return cur;
  });
  console.log(`released; ${friendlyName(s.sessionId)} now: intent="${s.intent}" paths=[${s.claims.paths}] resources=[${s.claims.resources}]`);
  // What was actually let go, from the pre-update snapshot — a bare release
  // logs everything that was held, not the (empty) arguments.
  const held = s0.claims || { paths: [], resources: [] };
  logActivity({
    ...activityBase(s, nowMs), ev: 'release',
    paths: paths.length || res.length ? (held.paths || []).filter((p) => paths.includes(p)) : held.paths || [],
    resources: paths.length || res.length ? (held.resources || []).filter((r) => res.includes(r)) : held.resources || [],
    all: !paths.length && !res.length,
  }, nowMs);
}

function cmdSend(args, nowMs) {
  const text = args._.slice(1).join(' ').trim();
  if (!text) throw new Error('no message text');
  const from = requireLiveSession(args, nowMs);
  const live = readSessions().filter((s) => !isExpired(s, nowMs) && s.sessionId !== from.sessionId);
  const remote = readRemoteSessions().filter((s) => !isExpired(s, nowMs));
  let targets;
  if (args.to === 'all') {
    targets = live; // broadcast stays machine-local on purpose
  } else {
    const all = [...live, ...remote];
    const id = resolveIdPrefix(all.map((s) => s.sessionId), args.to);
    targets = [all.find((s) => s.sessionId === id)];
  }
  if (!targets.length) throw new Error('no recipients (no other live sessions)');
  for (const t of targets) {
    // A remote recipient's inbox lives on its own machine: stage the message in
    // the outbox for that machine and let `sync` carry it over.
    const dir = t.machine ? outboxDir(t.machine, t.sessionId) : messagesDir(t.sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, messageFilename(nowMs, from.sessionId)), text + '\n');
  }
  console.log(`sent to ${targets.map((t) => friendlyName(t.sessionId) + (t.machine ? `@${t.machine}` : '')).join(', ')}`);
  logActivity({
    ...activityBase(from, nowMs), ev: 'send',
    to: targets.map((t) => friendlyName(t.sessionId) + (t.machine ? `@${t.machine}` : '')),
    broadcast: args.to === 'all',
  }, nowMs); // recipients only — message text never enters the log
}

function cmdNames(args) {
  const style = args._[1];
  if (!style) {
    console.log(`current name style: ${nameStyle()} (options: ${Object.keys(NAME_STYLES).join(', ')})`);
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(NAME_STYLES, style)) {
    throw new Error(`unknown name style "${style}" (options: ${Object.keys(NAME_STYLES).join(', ')})`);
  }
  writeNameStyle(style);
  console.log(`name style set to ${style}`);
}

// "Assignable" means the session declared no intent and holds no claims, so a
// dispatcher may hand it work. It does NOT mean the session is doing nothing right
// now: a session can be mid-turn — reading, searching, running a build — and still
// look assignable, because it never claimed anything. Claude Code's own cross-session
// roster uses "idle" for the other sense (finished its turn, nothing queued); do not
// read one as the other. 'idle' stays accepted here for sessions written by older
// builds, which set it as the intent on release.
function isAssignable(s) {
  const intent = s.intent || '';
  const unclaimed = !((s.claims && s.claims.paths) || []).length &&
    !((s.claims && s.claims.resources) || []).length;
  return unclaimed &&
    (intent === 'unassigned' || intent === 'idle' || intent === '(not yet declared)' || intent === '');
}

function cmdWho(nowMs, args = {}) {
  // Remote sessions (pulled by `sync`) fold in display-only, tagged @machine.
  let live = [
    ...readSessions().filter((s) => !isExpired(s, nowMs)),
    ...readRemoteSessions().filter((s) => !isExpired(s, nowMs)),
  ];
  const wantAssignable = args.assignable || args.idle; // --idle kept as a back-compat alias
  if (wantAssignable) live = live.filter(isAssignable);
  if (args.json) {
    console.log(JSON.stringify(live.map((s) => ({
      sessionId: s.sessionId,
      name: friendlyName(s.sessionId),
      harness: s.harness || 'claude',
      machine: s.machine || null,
      repo: s.repo,
      worktree: s.worktree,
      branch: s.branch,
      intent: s.intent,
      claims: s.claims || { paths: [], resources: [] },
      recentPaths: s.recentPaths || [],
      lastSeen: s.lastSeen,
      assignable: isAssignable(s),
      idle: isAssignable(s), // deprecated alias for `assignable`; scripts reading it keep working
    })), null, 1));
    return;
  }
  if (!live.length) { console.log(wantAssignable ? 'no assignable sessions' : 'no live sessions'); return; }
  const byRepo = new Map();
  for (const s of live) {
    if (!byRepo.has(s.repo)) byRepo.set(s.repo, []);
    byRepo.get(s.repo).push(s);
  }
  for (const [repo, ss] of byRepo) {
    console.log(repo);
    for (const s of ss) {
      const label = `${friendlyName(s.sessionId)}${s.machine ? `@${s.machine}` : ''}${harnessTag(s)}`;
      console.log(`  ${label} [${s.branch || '?'} @ ${path.basename(s.worktree)}] "${s.intent}" — claims: ${claimSummary(s)} (seen ${agoLabel(s.lastSeen, nowMs)})`);
    }
  }
}

// ---------- simulator lease broker ----------
//
// Claims (above) are advisory. Leases are not: one O_EXCL lockfile per device, so
// two concurrent acquires cannot both win. Device enumeration shells out to
// simctl/adb and therefore runs ONLY inside `sim` subcommands — never in a hook.

function leasesDir() { return path.join(dataDir(), 'leases'); }
function affinityFile() { return path.join(dataDir(), 'sim-affinity.json'); }
function leaseSlug(key) { return String(key).replace(/[^A-Za-z0-9._-]/g, '_'); }
function leaseFile(platform, key) { return path.join(leasesDir(), `${platform}-${leaseSlug(key)}.json`); }

function runQuiet(file, args) {
  try { return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
}

// --- device truth ---

function prettyRuntime(id) {
  const m = /iOS-(\d+)-(\d+)/.exec(String(id));
  if (m) return `iOS ${m[1]}.${m[2]}`;
  return String(id).replace('com.apple.CoreSimulator.SimRuntime.', '');
}

function parseSimctlDevices(json) {
  let parsed;
  try { parsed = JSON.parse(json); } catch { return []; }
  const out = [];
  for (const [runtime, list] of Object.entries((parsed && parsed.devices) || {})) {
    if (!Array.isArray(list)) continue;
    for (const d of list) {
      if (!d || !d.udid || d.isAvailable === false) continue;
      out.push({
        platform: 'ios',
        key: d.udid,
        name: d.name || d.udid,
        runtime: prettyRuntime(runtime),
        state: String(d.state || '').toLowerCase() === 'booted' ? 'booted' : 'shutdown',
      });
    }
  }
  return out;
}

function listIosDevices(run = runQuiet) {
  const json = run('xcrun', ['simctl', 'list', 'devices', 'available', '--json']);
  return json ? parseSimctlDevices(json) : [];
}

function parseAdbSerials(output) {
  return String(output || '').split(/\r?\n/).slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && p[1] === 'device' && p[0].startsWith('emulator-'))
    .map((p) => p[0]);
}

function androidEmulatorBin() {
  const home = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (home) {
    const p = path.join(home, 'emulator', 'emulator');
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return 'emulator';
}

function listAndroidDevices(run = runQuiet) {
  const avds = String(run(androidEmulatorBin(), ['-list-avds']) || '')
    .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const booted = new Map();
  for (const serial of parseAdbSerials(run('adb', ['devices']))) {
    const name = String(run('adb', ['-s', serial, 'emu', 'avd', 'name']) || '')
      .split(/\r?\n/).map((s) => s.trim()).filter((s) => s && s !== 'OK')[0];
    if (name) booted.set(name, serial);
  }
  const out = avds.map((name) => ({
    platform: 'android', key: name, name, runtime: 'avd',
    state: booted.has(name) ? 'booted' : 'shutdown', serial: booted.get(name) || null,
  }));
  for (const [name, serial] of booted) {
    if (!out.some((d) => d.key === name)) {
      out.push({ platform: 'android', key: name, name, runtime: 'avd', state: 'booted', serial });
    }
  }
  return out;
}

function listDevices(platform, deps = {}) {
  const run = deps.run || runQuiet;
  const ios = deps.listIos || listIosDevices;
  const android = deps.listAndroid || listAndroidDevices;
  const out = [];
  if (platform !== 'android') out.push(...ios(run));
  if (platform !== 'ios') out.push(...android(run));
  return out;
}

// --- lease store ---

function readLeases() {
  let files = [];
  try { files = fs.readdirSync(leasesDir()); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const full = path.join(leasesDir(), f);
    try { out.push(JSON.parse(fs.readFileSync(full, 'utf8'))); }
    catch { try { fs.unlinkSync(full); } catch {} }
  }
  return out;
}

function readLease(platform, key) {
  try { return JSON.parse(fs.readFileSync(leaseFile(platform, key), 'utf8')); } catch { return null; }
}

// O_EXCL: the whole point. Losing the race returns false rather than overwriting,
// which is why this cannot use writeSession's tmp+rename (last write wins).
function tryLease(record) {
  fs.mkdirSync(leasesDir(), { recursive: true });
  let fd;
  try { fd = fs.openSync(leaseFile(record.platform, record.key), 'wx'); } catch { return false; }
  try { fs.writeFileSync(fd, JSON.stringify(record, null, 1)); } finally { try { fs.closeSync(fd); } catch {} }
  return true;
}

function releaseLease(platform, key) {
  try { fs.unlinkSync(leaseFile(platform, key)); return true; } catch { return false; }
}

function releaseSessionLeases(sessionId) {
  let n = 0;
  for (const l of readLeases()) {
    if (l.sessionId === sessionId && releaseLease(l.platform, l.key)) n++;
  }
  return n;
}

function shutdownLeaseDevice(lease, deps = {}) {
  const devices = listDevices(lease.platform, deps);
  const device = devices.find((d) => d.platform === lease.platform && d.key === lease.key);
  if (device && device.state !== 'booted') return { ok: true, alreadyShutdown: true };
  try {
    if (typeof deps.shutdownDevice === 'function') {
      const ok = deps.shutdownDevice(lease, device);
      if (ok === false) throw new Error('shutdown command failed');
    } else if (lease.platform === 'ios') {
      execFileSync('xcrun', ['simctl', 'shutdown', lease.key], { stdio: 'ignore' });
    } else {
      const serial = (device && device.serial) || lease.serial;
      if (!serial) throw new Error('booted emulator serial unavailable');
      execFileSync('adb', ['-s', serial, 'emu', 'kill'], { stdio: 'ignore' });
    }
    return { ok: true, alreadyShutdown: false };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}

function quitSimulatorIfIdle(deps = {}) {
  if (readLeases().some((lease) => lease.platform === 'ios')) return false;
  if (listDevices('ios', deps).some((device) => device.state === 'booted')) return false;
  try {
    if (typeof deps.quitSimulator === 'function') {
      if (deps.quitSimulator() === false) return false;
    } else {
      execFileSync('osascript', ['-e', 'tell application "Simulator" to quit'], { stdio: 'ignore' });
    }
    return true;
  } catch { return false; }
}

function shutdownAndReleaseLeases(sessionId, deps = {}, { key, keepFailed = true } = {}) {
  const targets = readLeases().filter((lease) => lease.sessionId === sessionId && (!key || lease.key === key));
  const released = [];
  const failed = [];
  let touchedIos = false;
  for (const lease of targets) {
    if (lease.platform === 'ios') touchedIos = true;
    const result = shutdownLeaseDevice(lease, deps);
    if (!result.ok) {
      failed.push({ lease, error: result.error });
      if (keepFailed) continue;
    }
    if (releaseLease(lease.platform, lease.key)) released.push(lease);
  }
  const quitSimulator = touchedIos && failed.length === 0 ? quitSimulatorIfIdle(deps) : false;
  return { targets, released, failed, quitSimulator };
}

/// Refresh a session's leases so a long, quiet task keeps its device.
function touchLeases(sessionId, nowMs) {
  let n = 0;
  for (const l of readLeases()) {
    if (l.sessionId !== sessionId) continue;
    l.lastSeen = new Date(nowMs).toISOString();
    try {
      fs.writeFileSync(leaseFile(l.platform, l.key), JSON.stringify(l, null, 1));
      n++;
    } catch {}
  }
  return n;
}

// Reclaims a lease whose holder is gone AND which has not been touched inside LEASE_TTL_MS.
// Both conditions are required: a live-but-quiet session (a long build) keeps its device, and a
// session that died without deregistering still gives it back, just not for two hours.
function pruneLeases(nowMs, deps = {}, { shutdown = false } = {}) {
  const live = new Set(readSessions().filter((s) => !isExpired(s, nowMs)).map((s) => s.sessionId));
  let n = 0;
  let stopped = 0;
  for (const l of readLeases()) {
    if (l.sessionId && live.has(l.sessionId)) continue;
    const seen = Date.parse(l.lastSeen || l.acquiredAt || 0);
    const expired = !Number.isFinite(seen) || nowMs - seen > LEASE_TTL_MS;
    if (!expired) continue;
    // An orphan is a device some agent leased and never stopped: the holder is gone and the
    // lease outlived its TTL. Freeing the name alone leaves the simulator running with nobody
    // who knows to stop it, which is how the machine fills up with them. A live holder is
    // skipped above, so this never pulls a device out from under work in progress.
    if (shutdown) { try { if (shutdownLeaseDevice(l, deps).ok) stopped++; } catch {} }
    if (releaseLease(l.platform, l.key)) n++;
  }
  if (shutdown && stopped) { try { quitSimulatorIfIdle(deps); } catch {} }
  return n;
}

// --- affinity: reuse the simulator that already has the app's data ---

function readAffinity() {
  try { return JSON.parse(fs.readFileSync(affinityFile(), 'utf8')) || {}; } catch { return {}; }
}

function writeAffinity(obj) {
  ensureDirs();
  const tmp = affinityFile() + `.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, affinityFile());
}

// A mapping proven wrong is worse than none: it sends the next session to a
// simulator that has never had this app on it.
function clearAffinity(repo) {
  if (!repo) return false;
  const a = readAffinity();
  if (!a.repos || !a.repos[repo]) return false;
  delete a.repos[repo];
  writeAffinity(a);
  return true;
}

function affinityFor(repo) {
  const a = readAffinity();
  return (a.repos && a.repos[repo]) || null;
}

function recordAffinity(repo, device, bundleId, nowMs) {
  if (!repo) return;
  const a = readAffinity();
  a.repos = a.repos || {};
  const prev = a.repos[repo] || {};
  a.repos[repo] = {
    platform: device.platform,
    key: device.key,
    name: device.name,
    bundleId: bundleId || prev.bundleId || null,
    updated: new Date(nowMs).toISOString(),
  };
  writeAffinity(a);
}

// Verified, not trusted — but NOT via simctl. `simctl get_app_container` (and
// `listapps`) answer "Unable to lookup in current state: Shutdown" for every
// shut-down device, installed or not, so they cannot tell the two apart and would
// mark every sim unseeded forever. Read the installed bundles off disk instead:
// it works shut down, needs no boot, and is what the installs actually are.
function simDeviceRoot() {
  return process.env.AIRCONTROL_SIM_ROOT ||
    path.join(os.homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices');
}

function installedBundleIds(udid, run = runQuiet) {
  const root = path.join(simDeviceRoot(), udid, 'data', 'Containers', 'Bundle', 'Application');
  let containers = [];
  try { containers = fs.readdirSync(root); } catch { return new Set(); }
  const ids = new Set();
  for (const c of containers) {
    let apps = [];
    try { apps = fs.readdirSync(path.join(root, c)).filter((f) => f.endsWith('.app')); } catch { continue; }
    for (const app of apps) {
      const plist = path.join(root, c, app, 'Info.plist');
      // Info.plist is a binary plist; plutil is the only precise reader, so use the
      // raw byte scan as a cheap reject and pay for a subprocess only on a hit.
      let buf;
      try { buf = fs.readFileSync(plist); } catch { continue; }
      const id = run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist]);
      if (id) { ids.add(String(id).trim()); continue; }
      const text = buf.toString('latin1');
      const m = /com\.[A-Za-z0-9_.-]+/.exec(text);
      if (m) ids.add(m[0]);
    }
  }
  return ids;
}

function appInstalled(device, bundleId, run = runQuiet) {
  if (!bundleId || device.platform !== 'ios') return null;
  return installedBundleIds(device.key, run).has(bundleId);
}

const SEED_PROBE_LIMIT = 12;

function acquireDevice(opts, deps = {}) {
  const { sessionId, sessionName, repo, purpose, platform, bundleId, prefer, nowMs, extra } = opts;
  pruneLeases(nowMs, deps, { shutdown: true });
  const devices = listDevices(platform, deps);
  if (!devices.length) return { ok: false, reason: 'no-devices', free: [], held: [] };

  const heldKeys = new Map(readLeases().map((l) => [`${l.platform}-${l.key}`, l]));

  // Re-running acquire (a retry, a second script in the same task) must not quietly
  // grab a second device. Hand back the one this session already holds unless it
  // explicitly asked for another.
  if (!extra) {
    const mine = readLeases().find((l) => l.sessionId === sessionId && (!platform || l.platform === platform));
    if (mine) {
      const device = devices.find((d) => d.platform === mine.platform && d.key === mine.key) || mine;
      return { ok: true, device, lease: mine, affinity: 'already-held', reused: true };
    }
  }
  const free = devices.filter((d) => !heldKeys.has(`${d.platform}-${d.key}`));
  const held = devices.filter((d) => heldKeys.has(`${d.platform}-${d.key}`))
    .map((d) => ({ device: d, lease: heldKeys.get(`${d.platform}-${d.key}`) }));
  if (!free.length) return { ok: false, reason: 'all-held', free, held };

  const installed = deps.appInstalled || appInstalled;
  const aff = affinityFor(repo);
  const wantBundle = bundleId || (aff && aff.bundleId) || null;

  const matchesPrefer = (d) => !prefer || d.name.toLowerCase().includes(String(prefer).toLowerCase());

  let affinityState = 'none';
  let head = [];
  // An explicit --name is the caller stating intent right now; it outranks a
  // remembered affinity, which is only ever a guess about what they'd want.
  if (aff && !matchesPrefer({ name: aff.name || '' })) affinityState = 'overridden';
  else if (aff) {
    const hit = free.find((d) => d.platform === aff.platform && d.key === aff.key);
    if (hit) {
      const verdict = installed(hit, wantBundle, deps.run || runQuiet);
      if (verdict === false) { affinityState = 'stale'; }
      else { affinityState = verdict === true ? 'verified' : 'unverified'; head = [hit]; }
    } else {
      affinityState = 'unavailable';
    }
  }

  const byReadiness = (a, b) => (a.state === b.state ? a.name.localeCompare(b.name) : a.state === 'booted' ? -1 : 1);
  const rest = free.filter((d) => !head.includes(d)).filter(matchesPrefer).sort(byReadiness);

  // With no affinity yet, a bundle id still tells us which devices are already seeded.
  // Probing beats picking alphabetically and then recording that guess as affinity.
  const seeded = new Set();
  if (wantBundle && !head.length) {
    for (const d of rest.slice(0, SEED_PROBE_LIMIT)) {
      if (installed(d, wantBundle, deps.run || runQuiet) === true) seeded.add(d);
    }
  }
  const ordered = [...head, ...rest.filter((d) => seeded.has(d)), ...rest.filter((d) => !seeded.has(d))];
  const fallback = free.filter((d) => !head.includes(d) && !rest.includes(d)).sort(byReadiness);

  for (const device of [...ordered, ...fallback]) {
    const record = {
      platform: device.platform,
      key: device.key,
      name: device.name,
      runtime: device.runtime,
      state: device.state,
      serial: device.serial || null,
      sessionId,
      sessionName: sessionName || friendlyName(sessionId),
      repo: repo || null,
      purpose: purpose || null,
      acquiredAt: new Date(nowMs).toISOString(),
      lastSeen: new Date(nowMs).toISOString(),
    };
    if (!tryLease(record)) continue; // lost the race to another session; try the next device
    const confirmed = head.includes(device) ? affinityState === 'verified' : seeded.has(device);
    // Never record an unverified guess: a wrong mapping would send the next session
    // to a simulator that has never had this app on it.
    if (confirmed || !wantBundle) recordAffinity(repo, device, wantBundle, nowMs);
    else if (affinityState === 'stale') clearAffinity(repo);
    const state = head.includes(device) ? affinityState : seeded.has(device) ? 'seeded' : `${affinityState}:fallback`;
    return { ok: true, device, lease: record, affinity: state };
  }
  return { ok: false, reason: 'race-lost', free, held };
}

// --- CLI ---

function describeLease(lease, nowMs) {
  const who = lease.sessionName || friendlyName(lease.sessionId);
  const why = lease.purpose ? ` "${lease.purpose}"` : '';
  return `${who}${why} (${agoLabel(lease.acquiredAt, nowMs)})`;
}

function renderSimList(devices, leases, nowMs, affinityKey) {
  const held = new Map(leases.map((l) => [`${l.platform}-${l.key}`, l]));
  const aff = affinityKey ? affinityFor(affinityKey) : null;
  const lines = [];
  for (const platform of ['ios', 'android']) {
    const group = devices.filter((d) => d.platform === platform);
    if (!group.length) continue;
    lines.push(platform === 'ios' ? 'iOS' : 'Android');
    for (const d of group) {
      const lease = held.get(`${d.platform}-${d.key}`);
      const status = lease ? `held by ${describeLease(lease, nowMs)}` : 'free';
      const mark = aff && aff.platform === d.platform && aff.key === d.key ? '  <- affinity' : '';
      lines.push(`  ${d.key}  ${d.name}  ${d.runtime}  ${d.state}  ${status}${mark}`);
    }
  }
  return lines.length ? lines.join('\n') : 'no simulators or emulators found';
}

function cmdSim(args, nowMs, deps = {}) {
  const sub = args._[1];
  if (args.session) {
    try { touchLeases(requireLiveSession(args, nowMs).sessionId, nowMs); } catch {}
  }
  const platform = args.platform;
  if (platform && platform !== 'ios' && platform !== 'android') {
    throw new Error(`unknown --platform "${platform}" (ios|android)`);
  }

  if (sub === 'list') {
    pruneLeases(nowMs, deps, { shutdown: true });
    const devices = listDevices(platform, deps);
    const repo = gitInfo(process.cwd()).repo;
    if (args.json) {
      const leases = readLeases().map((l) => ({ ...l, holder: friendlyName(l.sessionId) }));
      console.log(JSON.stringify({ devices, leases }, null, 1));
      return;
    }
    console.log(renderSimList(devices, readLeases(), nowMs, repo));
    return;
  }

  if (sub === 'acquire') {
    const s = requireLiveSession(args, nowMs);
    const result = acquireDevice({
      sessionId: s.sessionId,
      sessionName: friendlyName(s.sessionId),
      repo: s.repo,
      purpose: args.for || args.purpose || s.intent,
      platform,
      bundleId: args['bundle-id'] || args.bundleId,
      prefer: args.name,
      extra: args.extra === true || args.extra === 'true',
      nowMs,
    }, deps);

    if (!result.ok) {
      const holders = (result.held || [])
        .map(({ device, lease }) => `  ${device.name} (${device.key}) — ${describeLease(lease, nowMs)}`);
      const freeList = (result.free || []).map((d) => `  ${d.name} (${d.key})`);
      console.error(`DENIED: no free ${platform || 'device'} to lease.`);
      if (holders.length) console.error(`Held:\n${holders.join('\n')}`);
      if (freeList.length) console.error(`Free but unclaimable (lost the race, retry):\n${freeList.join('\n')}`);
      if (result.reason === 'no-devices') console.error('No simulators or emulators are installed for that platform.');
      process.exitCode = 1;
      return;
    }

    const d = result.device;
    const note = result.affinity === 'already-held' ? ' — already yours, reusing it (--extra for a second device)'
      : result.affinity.startsWith('verified') ? ' — affinity hit, app already installed'
        : result.affinity === 'seeded' ? ' — app already installed here'
          : result.affinity.startsWith('unverified') ? ' — affinity hit (unverified, no bundle id)'
            : result.affinity.startsWith('stale') ? ' — affinity dropped, app not installed there'
              : args['bundle-id'] || args.bundleId ? ' — no seeded device free, this one is clean' : '';
    logActivity({
      ...activityBase(s, nowMs), ev: 'sim-acquire', platform: d.platform, key: d.key, device: d.name,
      purpose: args.for || args.purpose || s.intent, reused: result.affinity === 'already-held',
    }, nowMs);
    console.log(`leased ${d.key} (${d.name}, ${d.runtime}, ${d.state})${note}`);
    console.log(`export AIRCONTROL_SIM_UDID=${d.key}`);
    if (d.platform === 'ios') {
      console.log(`# xcodebuild -destination "platform=iOS Simulator,id=${d.key}"   # never by name: a name runs zero tests`);
    }
    return;
  }

  if (sub === 'release') {
    const s = requireLiveSession(args, nowMs);
    // Releasing stops the device. A lease handed back while the simulator keeps running is an
    // orphan: nothing downstream knows to stop it, because SessionEnd only reaps devices the
    // session still holds. --keep-booted opts out for a deliberate handoff.
    if (!args['keep-booted']) {
      if (args.key) {
        const lease = ['ios', 'android'].map((p) => readLease(p, args.key)).find(Boolean);
        if (!lease) throw new Error(`no lease found for "${args.key}"`);
        if (lease.sessionId !== s.sessionId) {
          throw new Error(`lease on ${lease.key} is held by ${describeLease(lease, nowMs)}, not you`);
        }
      }
      const result = shutdownAndReleaseLeases(s.sessionId, deps, { key: args.key, keepFailed: true });
      for (const lease of result.released) {
        logActivity({ ...activityBase(s, nowMs), ev: 'sim-release', platform: lease.platform, key: lease.key, device: lease.name, shutdown: true }, nowMs);
      }
      if (result.failed.length) {
        for (const item of result.failed) console.error(`failed to shut down ${item.lease.key} (${item.lease.name}): ${item.error}`);
        process.exitCode = 1;
      }
      const suffix = result.quitSimulator ? '; Simulator.app quit' : '';
      console.log(`shut down and released ${result.released.length} lease${result.released.length === 1 ? '' : 's'} held by ${friendlyName(s.sessionId)}${suffix}`);
      return;
    }
    if (args.key) {
      const lease = ['ios', 'android'].map((p) => readLease(p, args.key)).find(Boolean);
      if (!lease) throw new Error(`no lease found for "${args.key}"`);
      if (lease.sessionId !== s.sessionId) {
        throw new Error(`lease on ${lease.key} is held by ${describeLease(lease, nowMs)}, not you`);
      }
      releaseLease(lease.platform, lease.key);
      logActivity({ ...activityBase(s, nowMs), ev: 'sim-release', platform: lease.platform, key: lease.key, device: lease.name }, nowMs);
      console.log(`released ${lease.key} (${lease.name})`);
      return;
    }
    const n = releaseSessionLeases(s.sessionId);
    if (n) logActivity({ ...activityBase(s, nowMs), ev: 'sim-release', all: true, count: n }, nowMs);
    console.log(`released ${n} lease${n === 1 ? '' : 's'} held by ${friendlyName(s.sessionId)}`);
    return;
  }

  throw new Error('usage: coord.js sim <list|acquire|release> [--session id] [--for purpose] [--platform ios|android] [--bundle-id id] [--name pref] [--key udid|avd] [--keep-booted]');
}

// ---------- cross-repo work ledger ----------
//
// Append-only event log. Every mutation is one JSON line; readers fold the log
// into current state. Nothing ever rewrites a line in place, so appenders need
// no lock. The one exception is compaction, which rewrites the file whole and
// therefore takes an O_EXCL lock and aborts if the file moved under it.
//
// An entry INDEXES work, it never restates it: `pointsAt` is mandatory so the
// ledger stays a pointer list rather than a third copy of everyone's tasks.

const LEDGER_MAX_LINES = 500;
const LEDGER_DONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LEDGER_STALE_MS = 14 * 24 * 60 * 60 * 1000;
const LEDGER_TITLE_MAX = 80;
const LEDGER_STATUSES = new Set(['open', 'blocked-on-human', 'done']);
const LEDGER_PRIORITY_RANK = { urgent: 3, high: 2, normal: 1, low: 0 };

function ledgerFile() { return path.join(dataDir(), 'ledger.jsonl'); }

function readLedgerEvents() {
  let raw;
  try { raw = fs.readFileSync(ledgerFile(), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a torn line, keep the rest */ }
  }
  return out;
}

function appendLedgerEvent(ev) {
  ensureDirs();
  fs.appendFileSync(ledgerFile(), JSON.stringify(ev) + '\n');
  return ev;
}

function ledgerId(seed, taken) {
  let base = 'lg_' + hashId(String(seed)).toString(16).slice(0, 6).padStart(6, '0');
  let id = base;
  let n = 1;
  while (taken.has(id)) id = `${base}${n++}`;
  return id;
}

function foldLedger(events) {
  const items = new Map();
  for (const e of events) {
    if (!e || !e.id) continue;
    if (e.event === 'add') {
      items.set(e.id, {
        id: e.id,
        repo: e.repo || null,
        repoName: e.repoName || null,
        title: e.title || '',
        pointsAt: e.pointsAt || '',
        status: LEDGER_STATUSES.has(e.status) ? e.status : 'open',
        priority: Object.prototype.hasOwnProperty.call(LEDGER_PRIORITY_RANK, e.priority) ? e.priority : 'normal',
        dependsOn: Array.isArray(e.dependsOn) ? e.dependsOn : [],
        repoUrl: e.repoUrl || null,
        machine: e._machine || null,
        owner: null,
        opened: e.ts,
        updated: e.ts,
        notes: [],
      });
      continue;
    }
    const it = items.get(e.id);
    if (!it) continue;
    it.updated = e.ts || it.updated;
    if (e.event === 'take') it.owner = e.sessionId || null;
    else if (e.event === 'handoff') it.owner = e.to || null;
    else if (e.event === 'drop') it.owner = null;
    else if (e.event === 'note') it.notes.push({ ts: e.ts, text: e.text || '' });
    else if (e.event === 'status') { if (LEDGER_STATUSES.has(e.status)) it.status = e.status; }
    else if (e.event === 'done') {
      it.status = 'done';
      it.owner = null;
      if (e.note) it.notes.push({ ts: e.ts, text: e.note });
    }
  }
  return items;
}

// `in-progress` is derived, never stored: an owner whose session died means the
// item is available again. That derivation is the pick-up-abandoned-work path.
// Local events plus any peer mirrors, in timestamp order (NTP-synced clocks
// assumed; the README says so). Writes stay strictly local — mirrors are read-only.
function readAllLedgerEvents() {
  const local = readLedgerEvents();
  const remote = readRemoteLedgerEvents();
  if (!remote.length) return local;
  return [...local, ...remote].sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
}

function ledgerView(nowMs) {
  const live = new Set([...readSessions(), ...readRemoteSessions()]
    .filter((s) => !isExpired(s, nowMs)).map((s) => s.sessionId));
  const folded = foldLedger(readAllLedgerEvents());
  const items = [...folded.values()];
  for (const it of items) {
    it.abandonedBy = null;
    if (it.owner && !live.has(it.owner)) {
      it.abandonedBy = friendlyName(it.owner);
      it.owner = null;
    }
    // A dep that no longer exists (compacted away) counts as met, not blocking.
    const blockedByDeps = (it.dependsOn || []).some((d) => {
      const dep = folded.get(d);
      return dep && dep.status !== 'done';
    });
    it.state = it.status === 'done' ? 'done'
      : it.owner ? 'in-progress'
        : it.status === 'blocked-on-human' ? 'blocked-on-human'
          : blockedByDeps ? 'blocked-on-deps' : 'open';
    it.staleSince = it.state !== 'done' && nowMs - Date.parse(it.updated || 0) > LEDGER_STALE_MS
      ? it.updated : null;
  }
  return items.sort((a, b) => String(a.opened).localeCompare(String(b.opened)));
}

// The once-per-session nudge: highest-priority open item in THIS repo with its
// deps met and nobody working it. Never another repo's work — a suggestion the
// session can't act on here is noise. "This repo" matches by local key or, for
// items logged on another machine, by the normalized origin URL.
function suggestNextLedgerItem(items, repo, repoUrl = null) {
  const candidates = items.filter((it) => it.state === 'open' &&
    (it.repo === repo || (repoUrl && it.repoUrl === repoUrl)));
  if (!candidates.length) return null;
  candidates.sort((a, b) =>
    (LEDGER_PRIORITY_RANK[b.priority] || 0) - (LEDGER_PRIORITY_RANK[a.priority] || 0) ||
    String(a.opened).localeCompare(String(b.opened)));
  return candidates[0];
}

// Compaction is the one place that rewrites the ledger file whole, so it is
// also the one place that can lose a concurrent append. Two defenses: an
// O_EXCL lock so two compactions never interleave, and a stat recheck right
// before the rename — if the file changed since we read it, abort without
// writing and let the next sweep retry against fresh state.
const LEDGER_COMPACT_LOCK_STALE_MS = 60 * 1000;

function ledgerCompactLockFile() { return path.join(dataDir(), 'ledger.compact.lock'); }

function tryCompactLock(nowMs) {
  const file = ledgerCompactLockFile();
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.closeSync(fs.openSync(file, 'wx')); return true; } catch {}
    try {
      if (nowMs - fs.statSync(file).mtimeMs < LEDGER_COMPACT_LOCK_STALE_MS) return false;
      fs.unlinkSync(file); // crash-abandoned: sweep it and retry the O_EXCL create
    } catch { return false; }
  }
  return false;
}

function compactLedger(nowMs, hooks = {}) {
  let stat0;
  try { stat0 = fs.statSync(ledgerFile()); } catch { return 0; }
  let raw;
  try { raw = fs.readFileSync(ledgerFile(), 'utf8'); } catch { return 0; }
  const lines = raw.split('\n').filter((l) => l.trim());
  if (lines.length <= LEDGER_MAX_LINES) return 0;
  if (!tryCompactLock(nowMs)) return 0;
  try {
    const items = foldLedger(readLedgerEvents());
    const drop = new Set();
    for (const [id, it] of items) {
      if (it.status !== 'done') continue;
      if (nowMs - Date.parse(it.updated || 0) > LEDGER_DONE_TTL_MS) drop.add(id);
    }
    if (!drop.size) return 0;
    const kept = [];
    for (const line of lines) {
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev && drop.has(ev.id)) continue;
      kept.push(line);
    }
    if (hooks.beforeCompactWrite) hooks.beforeCompactWrite();
    // Recheck as late as possible — right before the rename, not before writing
    // the tmp file — so the window in which a concurrent append could land
    // undetected is the gap between one stat and one rename, not the time it
    // takes to serialize up to LEDGER_MAX_LINES lines to disk.
    const tmp = ledgerFile() + `.tmp-${process.pid}`;
    fs.writeFileSync(tmp, kept.join('\n') + (kept.length ? '\n' : ''));
    let stat1;
    try { stat1 = fs.statSync(ledgerFile()); } catch { try { fs.unlinkSync(tmp); } catch {} return 0; }
    if (stat1.size !== stat0.size || stat1.mtimeMs !== stat0.mtimeMs) {
      try { fs.unlinkSync(tmp); } catch {}
      return 0; // grew under us: abort, let the next sweep retry against fresh state
    }
    fs.renameSync(tmp, ledgerFile());
    return lines.length - kept.length;
  } finally {
    try { fs.unlinkSync(ledgerCompactLockFile()); } catch {}
  }
}

// A directory that gains git changes ledger identity: gitInfo() keys it
// `none:<cwd>` before `git init` and `<cwd>/.git` after, so items filed under the
// old key silently stop matching `--repo .` and vanish from the session-start
// ledger line. Normalising on read heals every already-stored item, and any repo
// that gains git later, without rewriting the log. No existence check: nothing
// ever files an item under `<path>/.git` unless that path really is a repo.
function sameRepo(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const asGitDir = (v) => (String(v).startsWith('none:')
    ? path.join(String(v).slice('none:'.length), '.git')
    : String(v));
  return asGitDir(a) === asGitDir(b);
}

function ledgerCounts(items, repo) {
  const open = items.filter((it) => it.state !== 'done');
  const here = repo ? open.filter((it) => sameRepo(it.repo, repo)) : [];
  return {
    here: here.length,
    abandoned: here.filter((it) => it.abandonedBy).length,
    elsewhere: open.length - here.length,
  };
}

function renderLedgerLine(counts, repoName, cliPath) {
  if (!counts.here && !counts.elsewhere) return '';
  const parts = [];
  if (counts.here) {
    parts.push(`${counts.here} open in ${repoName || 'this repo'}` +
      (counts.abandoned ? ` (${counts.abandoned} abandoned)` : ''));
  }
  if (counts.elsewhere) parts.push(`${counts.elsewhere} elsewhere`);
  return `[aircontrol] ledger: ${parts.join(', ')} — node ${cliPath} ledger list${counts.here ? ' --repo .' : ' --repo all'}`;
}

function ledgerRepoFilter(args) {
  const raw = args.repo;
  if (!raw || raw === 'all') return null;
  if (raw === '.' || raw === true) return gitInfo(process.cwd()).repo;
  // An explicit path has to be canonicalised the same way "." is, or it is
  // compared raw against a stored key and matches nothing -- and a miss prints
  // "nothing open", which reads as an empty backlog rather than a bad argument.
  const resolved = gitInfo(path.resolve(String(raw))).repo;
  return resolved || raw;
}

function formatLedgerItem(it, nowMs, { notes = false } = {}) {
  const badge = it.state === 'in-progress' ? `in-progress (${friendlyName(it.owner)})`
    : it.abandonedBy ? `open — abandoned by ${it.abandonedBy}`
      : it.state;
  const pri = it.priority && it.priority !== 'normal' ? ` [${it.priority}]` : '';
  const stale = it.staleSince ? ` · ⚠ stale (untouched ${agoLabel(it.staleSince, nowMs)})` : '';
  const at = it.machine ? `@${it.machine}` : '';
  const where = it.repoName ? `[${it.repoName}${at}] ` : at ? `[${at}] ` : '';
  // Notes run to paragraphs and there are dozens of open items, so the default
  // listing leaves them out: on 2026-09-12 one `ledger list` was the costliest
  // tool result of an entire session, re-sent on every later turn. pointsAt
  // stays on line 2 -- it is how `ledger take` finds the spec, and dropping it
  // would only trade one round trip for another. `ledger show <id>` reads them.
  const last = notes && it.notes.length
    ? it.notes.map((n) => `\n      note: ${n.text}`).join('')
    : '';
  return `  ${it.id}  ${where}${it.title}${pri}\n      ${badge} · ${it.pointsAt} · opened ${agoLabel(it.opened, nowMs)}${stale}${last}`;
}

function cmdLedger(args, nowMs, hooks = {}) {
  const sub = args._[1];

  if (sub === 'add') {
    const title = String(args.title || '').trim();
    const pointsAt = String(args['points-at'] || args.pointsAt || '').trim();
    if (!title) throw new Error('ledger add needs --title');
    if (!pointsAt) {
      throw new Error('ledger add needs --points-at (an OpenSpec change, plan file, PR url, questions.md item, or memory file). The ledger indexes work; it does not restate it.');
    }
    if (title.length > LEDGER_TITLE_MAX) {
      throw new Error(`--title is ${title.length} chars; keep it under ${LEDGER_TITLE_MAX}. The detail belongs behind --points-at.`);
    }
    const status = args.status || 'open';
    if (!LEDGER_STATUSES.has(status)) {
      throw new Error(`unknown --status "${status}" (${[...LEDGER_STATUSES].join('|')})`);
    }
    const priority = args.priority || 'normal';
    if (!Object.prototype.hasOwnProperty.call(LEDGER_PRIORITY_RANK, priority)) {
      throw new Error(`unknown --priority "${priority}" (${Object.keys(LEDGER_PRIORITY_RANK).join('|')})`);
    }
    const dependsOn = splitList(args['depends-on'] || args.dependsOn);
    const g = gitInfo(process.cwd());
    const ts = new Date(nowMs).toISOString();
    const id = ledgerId(`${ts}${title}${g.repo}`, foldLedger(readLedgerEvents()));
    appendLedgerEvent({
      ts, event: 'add', id, repo: g.repo, repoName: path.basename(g.worktree), title, pointsAt, status, priority, dependsOn,
      repoUrl: gitOriginKey(process.cwd()),
    });
    console.log(`added ${id}: ${title} → ${pointsAt} (${status}${priority !== 'normal' ? `, ${priority}` : ''}${dependsOn.length ? `, after ${dependsOn.join(',')}` : ''})`);
    return;
  }

  if (sub === 'list') {
    const repo = ledgerRepoFilter(args);
    let items = ledgerView(nowMs).filter((it) => it.state !== 'done');
    if (args.status) items = items.filter((it) => it.state === args.status);
    if (repo) {
      // URL fallback only for "--repo ." — an explicit path filter means that path.
      const localUrl = (args.repo === '.' || args.repo === true) ? gitOriginKey(process.cwd()) : null;
      items = items.filter((it) => sameRepo(it.repo, repo) || (localUrl && it.repoUrl === localUrl));
    }
    if (args.mine) {
      const s = requireLiveSession(args, nowMs);
      items = items.filter((it) => it.owner === s.sessionId);
    }
    if (args.json) { console.log(JSON.stringify(items, null, 1)); return; }
    if (!items.length) { console.log('ledger: nothing open'); return; }
    console.log(items.map((it) => formatLedgerItem(it, nowMs, { notes: !!args.notes })).join('\n'));
    return;
  }

  const id = args._[2];
  if (!id) throw new Error(`ledger ${sub} needs an item id`);
  const item = ledgerView(nowMs).find((it) => it.id === id);
  if (!item) throw new Error(`no ledger item "${id}"`);
  if (sub === 'show') {
    console.log(formatLedgerItem(item, nowMs, { notes: true }));
    return;
  }

  const ts = new Date(nowMs).toISOString();

  if (sub === 'take') {
    const s = requireLiveSession(args, nowMs);
    if (item.owner && item.owner !== s.sessionId) {
      throw new Error(`${id} is already being worked by ${friendlyName(item.owner)} — message them or pick another`);
    }
    // Append-then-verify: the pre-check above reads a stale fold, so two racing
    // takes can both pass it. The fold resolves ownership to the later event —
    // re-read after our append and report a loss honestly instead of lying.
    appendLedgerEvent({ ts, event: 'take', id, sessionId: s.sessionId });
    if (hooks.beforeTakeVerify) hooks.beforeTakeVerify();
    const settled = foldLedger(readLedgerEvents()).get(id);
    if (!settled || settled.owner !== s.sessionId) {
      const winner = settled && settled.owner ? friendlyName(settled.owner) : 'another session';
      throw new Error(`${id}: raced with ${winner} — they won. Pick another item or coordinate.`);
    }
    console.log(`${id} taken by ${friendlyName(s.sessionId)}: ${item.title}`);
    return;
  }

  if (sub === 'drop') {
    appendLedgerEvent({ ts, event: 'drop', id });
    console.log(`${id} handed back (still open): ${item.title}`);
    return;
  }

  if (sub === 'note') {
    const text = args._.slice(3).join(' ').trim();
    if (!text) throw new Error('ledger note needs text');
    appendLedgerEvent({ ts, event: 'note', id, text });
    console.log(`noted on ${id}`);
    return;
  }

  if (sub === 'block') {
    appendLedgerEvent({ ts, event: 'status', id, status: 'blocked-on-human' });
    console.log(`${id} marked blocked-on-human: ${item.title}`);
    return;
  }

  if (sub === 'unblock') {
    appendLedgerEvent({ ts, event: 'status', id, status: 'open' });
    if (args.note) appendLedgerEvent({ ts, event: 'note', id, text: args.note });
    console.log(`${id} unblocked, back to open: ${item.title}`);
    return;
  }

  if (sub === 'done') {
    appendLedgerEvent({ ts, event: 'done', id, note: args.note || '' });
    console.log(`${id} done: ${item.title}`);
    return;
  }

  throw new Error('usage: coord.js ledger <add|list|show|take|drop|note|block|unblock|done> …');
}

// ---------- session-scoped cleanup ----------
//
// The facts a cleanup step cannot safely work out on its own: which worktrees other live
// sessions are sitting in, and which browser processes belong to whom. Getting either wrong
// destroys another agent's work, so both answer conservatively.

const BROWSER_PROC_PATTERNS = [
  'chrome-devtools-mcp',
  'playwright-mcp',
  '@playwright/mcp',
];

// ---------- cross-machine mirror (opt-in) ----------
//
// Strictly opt-in: with no peers in config.json this entire section is inert
// and the machine-local story stays literally true. With peers, `sync` mirrors
// each machine's canonical state (sessions/, ledger.jsonl, outbox/) into the
// other's `remote/<machine>/…` namespace over rsync+ssh (existing ssh config
// does auth; nothing is stored here). Remote sessions are display-only —
// guard and advisories act only on local state — and leases never sync: a
// lease means exclusive use of a physically local device.

const SYNC_THROTTLE_MS = 60 * 1000;

function syncConfig() {
  const fallback = { machine: os.hostname().split('.')[0], peers: [], autoSync: false };
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile(), 'utf8')) || {};
    return {
      machine: (cfg.machine && String(cfg.machine)) || fallback.machine,
      peers: Array.isArray(cfg.peers) ? cfg.peers.filter((p) => p && isSafeComponent(p.name) && p.host && p.dir) : [],
      autoSync: cfg.autoSync === true,
    };
  } catch { return fallback; }
}

function remoteDir(name) { return name ? path.join(dataDir(), 'remote', name) : path.join(dataDir(), 'remote'); }
function outboxDir(machine, sessionId) {
  if (!isSafeComponent(machine) || (sessionId !== undefined && !isSafeComponent(sessionId))) {
    throw new Error('unsafe outbox path component');
  }
  const base = path.join(dataDir(), 'outbox', machine);
  return sessionId ? path.join(base, sessionId) : base;
}
function syncLogFile() { return path.join(dataDir(), 'sync.log'); }

// One identity for "the same repo" across machines, where local .git paths
// diverge: the normalized origin URL. git@host:a/b.git and https://host/a/b
// both become host/a/b.
function repoUrlKey(url) {
  if (!url || typeof url !== 'string') return null;
  let u = url.trim();
  if (!u) return null;
  u = u.replace(/^[a-z+]+:\/\//i, '');
  u = u.replace(/^[^/]*?@/, '');
  u = u.replace(':', '/');
  u = u.replace(/\.git$/i, '').replace(/\/+$/, '');
  return u.toLowerCase() || null;
}

function gitOriginKey(cwd) {
  try {
    return repoUrlKey(execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd, env: gitEnv(), stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim());
  } catch { return null; }
}

function remoteMachines() {
  try { return fs.readdirSync(remoteDir()).filter((n) => !n.startsWith('.')); } catch { return []; }
}

function readRemoteSessions() {
  const out = [];
  for (const m of remoteMachines()) {
    let files = [];
    try { files = fs.readdirSync(path.join(remoteDir(m), 'sessions')); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(remoteDir(m), 'sessions', f), 'utf8'));
        // Mirror content is remote-authored: an id that isn't a single safe
        // path segment could traverse out of the data dir downstream (outbox
        // writes key on it). Drop the session, not just the character.
        if (!isSafeComponent(s.sessionId)) continue;
        s.machine = m;
        // A salt is chosen on the machine that owns the session, so a mirrored
        // record is the only place this machine can learn it. Without seeding,
        // a remote session would render under salt 0 and appear here as a
        // different name than it answers to at home.
        saltCache.set(s.sessionId, Number.isInteger(s.nameSalt) ? s.nameSalt : 0);
        out.push(s);
      } catch {}
    }
  }
  return out;
}

function readRemoteLedgerEvents() {
  const out = [];
  for (const m of remoteMachines()) {
    let raw;
    try { raw = fs.readFileSync(path.join(remoteDir(m), 'ledger.jsonl'), 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push({ ...JSON.parse(line), _machine: m }); } catch {}
    }
  }
  return out;
}

// Messages mirrored from a peer's outbox for this machine are COPIED into the
// real inbox, deduped by filename — the mirror survives between syncs, so the
// copy must be idempotent. The local .read rename never touches the mirror.
function importRemoteMessages() {
  const { machine } = syncConfig();
  let imported = 0;
  for (const m of remoteMachines()) {
    const inRoot = path.join(remoteDir(m), 'outbox', machine);
    let sessions = [];
    try { sessions = fs.readdirSync(inRoot); } catch { continue; }
    for (const sessionId of sessions) {
      let files = [];
      try { files = fs.readdirSync(path.join(inRoot, sessionId)); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.md')) continue;
        const dest = path.join(messagesDir(sessionId), f);
        if (fs.existsSync(dest) || fs.existsSync(dest + '.read')) continue;
        try {
          fs.mkdirSync(messagesDir(sessionId), { recursive: true });
          fs.copyFileSync(path.join(inRoot, sessionId, f), dest);
          imported++;
        } catch {}
      }
    }
  }
  return imported;
}

function defaultSyncDeps() {
  return {
    rsync: (rargs) => execFileSync('rsync', rargs, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000 }),
    ssh: (host, cmd) => execFileSync('ssh', [host, cmd], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 30000 }),
  };
}

// "~/…" must expand on the REMOTE shell: single-quoting it makes mkdir create
// a literal "~" directory. Rewrite to "$HOME/…" in double quotes; absolute
// paths stay single-quoted. Either way, the path crosses into a REMOTE shell
// string built by hand, so a stray quote in it (peer.dir comes from the
// user's own config.json, not attacker input, but should still not be able
// to break out of the quoting and inject an extra command) must be escaped
// for whichever quoting style applies, not passed through raw.
function quoteForRemoteShell(p) {
  return p.startsWith('~/')
    ? `"$HOME/${String(p.slice(2)).replace(/([\\"$`])/g, '\\$1')}"`
    : `'${String(p).replace(/'/g, "'\\''")}'`;
}

function cmdSync(args, nowMs, deps = {}) {
  const { machine, peers } = syncConfig();
  if (!peers.length) return;
  const d = { ...defaultSyncDeps(), ...deps };
  ensureDirs();
  fs.mkdirSync(path.join(dataDir(), 'outbox'), { recursive: true });
  let ok = 0;
  for (const peer of peers) {
    try {
      const base = String(peer.dir).replace(/\/+$/, '');
      const mine = `${base}/remote/${machine}`;
      const q = quoteForRemoteShell;
      d.ssh(peer.host, `mkdir -p ${q(`${mine}/sessions`)} ${q(`${mine}/outbox`)} ${q(`${base}/sessions`)}`);
      // push my canonical state into their remote/<machine>/ namespace
      d.rsync(['-az', '--delete', sessionsDir() + '/', `${peer.host}:${mine}/sessions/`]);
      try { fs.accessSync(ledgerFile()); d.rsync(['-az', ledgerFile(), `${peer.host}:${mine}/ledger.jsonl`]); } catch {}
      d.rsync(['-az', '--delete', path.join(dataDir(), 'outbox') + '/', `${peer.host}:${mine}/outbox/`]);
      // pull their canonical state into my remote/<peer>/ namespace
      fs.mkdirSync(path.join(remoteDir(peer.name), 'sessions'), { recursive: true });
      d.rsync(['-az', '--delete', `${peer.host}:${base}/sessions/`, path.join(remoteDir(peer.name), 'sessions') + '/']);
      try { d.rsync(['-az', `${peer.host}:${base}/ledger.jsonl`, path.join(remoteDir(peer.name), 'ledger.jsonl')]); } catch {}
      try {
        fs.mkdirSync(path.join(remoteDir(peer.name), 'outbox', machine), { recursive: true });
        d.rsync(['-az', '--delete', `${peer.host}:${base}/outbox/${machine}/`, path.join(remoteDir(peer.name), 'outbox', machine) + '/']);
      } catch {}
      ok++;
    } catch (e) {
      // A dead peer never breaks the loop or the local-only behavior.
      try {
        fs.appendFileSync(syncLogFile(), JSON.stringify({
          ts: new Date(nowMs).toISOString(), peer: peer.name, error: String((e && e.message) || e),
        }) + '\n');
      } catch {}
    }
  }
  try { importRemoteMessages(); } catch {}
  console.log(`sync: ${ok}/${peers.length} peers`);
}

// Register-time auto-sync, throttled and detached so hooks stay fast. Gated on
// config `autoSync: true` — mirroring on a schedule is a deliberate choice.
function maybeAutoSync(nowMs, spawnFn) {
  const { peers, autoSync } = syncConfig();
  if (!autoSync || !peers.length) return false;
  const marker = path.join(dataDir(), 'sync.last');
  try { if (nowMs - fs.statSync(marker).mtimeMs < SYNC_THROTTLE_MS) return false; } catch {}
  try { fs.writeFileSync(marker, String(nowMs)); } catch { return false; }
  const spawn = spawnFn || ((file, argv) => {
    const cp = require('child_process').spawn(file, argv, { detached: true, stdio: 'ignore' });
    cp.unref();
  });
  spawn(process.execPath, [__filename, 'sync']);
  return true;
}

// ---------- handoff ----------
//
// Transfer in-progress work to another live session: ledger ownership first
// (the durable truth — a crash mid-handoff reconciles from this event), then
// claims as best-effort derived state, then a message nudge with the context
// note. There is no cross-file atomicity to be had without new machinery, so
// the sequencing IS the crash-safety story.
function cmdHandoff(args, nowMs) {
  const from = requireLiveSession(args, nowMs);
  const live = readSessions().filter((s) => !isExpired(s, nowMs) && s.sessionId !== from.sessionId);
  const to = readSession(resolveIdPrefix(live.map((s) => s.sessionId), args.to));
  const note = String(args.note || '').trim();
  const ledgerRef = args['ledger-id'] || args.ledgerId;
  const ts = new Date(nowMs).toISOString();
  if (ledgerRef) {
    const item = ledgerView(nowMs).find((it) => it.id === ledgerRef);
    if (!item) throw new Error(`no ledger item "${ledgerRef}"`);
    if (item.owner && item.owner !== from.sessionId) {
      throw new Error(`${ledgerRef} is owned by ${friendlyName(item.owner)} — only the owner hands off`);
    }
    appendLedgerEvent({ ts, event: 'handoff', id: ledgerRef, from: from.sessionId, to: to.sessionId });
    if (note) appendLedgerEvent({ ts, event: 'note', id: ledgerRef, text: note });
  }
  const claims = from.claims || { paths: [], resources: [] };
  updateSession(to.sessionId, (s) => {
    s.claims = mergeClaims(s.claims, claims.paths, claims.resources);
    return s;
  });
  updateSession(from.sessionId, (s) => {
    s.claims = { paths: [], resources: [] };
    s.intent = `handed off to ${friendlyName(to.sessionId)}`;
    return s;
  });
  const parts = [`[handoff] ${friendlyName(from.sessionId)} hands you their work${ledgerRef ? ` (ledger ${ledgerRef})` : ''}.`];
  const moved = [...(claims.paths || []), ...(claims.resources || [])];
  if (moved.length) parts.push(`Claims transferred to you: ${moved.join(', ')}.`);
  if (note) parts.push(`Context: ${note}`);
  fs.mkdirSync(messagesDir(to.sessionId), { recursive: true });
  fs.writeFileSync(path.join(messagesDir(to.sessionId), messageFilename(nowMs, from.sessionId)), parts.join(' ') + '\n');
  console.log(`handed off to ${friendlyName(to.sessionId)}${ledgerRef ? `: ${ledgerRef}` : ''}${moved.length ? ` (claims: ${moved.join(', ')})` : ''}`);
  logActivity({
    ...activityBase(from, nowMs), ev: 'handoff', to: friendlyName(to.sessionId),
    ...(ledgerRef ? { ledgerId: ledgerRef } : {}), movedClaims: moved.length,
  }, nowMs); // recipient and counts only — the note never enters the log
}

function cmdWorktrees(args, nowMs) {
  const live = readSessions().filter((s) => !isExpired(s, nowMs));
  const mine = args.session ? resolveIdPrefix(live.map((s) => s.sessionId), args.session) : null;
  const rows = live
    .filter((s) => (args.others ? s.sessionId !== mine : true))
    .filter((s) => s.worktree);
  if (!rows.length) { console.log(args.others ? 'no other live sessions hold a worktree' : 'no live sessions'); return; }
  for (const s of rows) {
    console.log(`${s.worktree}\t${friendlyName(s.sessionId)}\t${s.branch || '?'}\t"${s.intent}"`);
  }
}

// --- disk ---

// Xcode keys DerivedData by project path, so every throwaway worktree a session builds in
// leaves its own multi-GB folder behind after the worktree is deleted, and Xcode never
// collects it. With several sessions cutting worktrees these fill a disk within a day, and
// a full disk takes every session down at once: no tool can even create its temp dir.
const DISK_DEFAULTS = { minFreeBytes: 20e9, minFreeRatio: 0.10, sessionIdleMs: 60 * 60 * 1000, buildIdleMs: 24 * 60 * 60 * 1000, looseFileIdleMs: 7 * 24 * 60 * 60 * 1000, worktreeIdleMs: 7 * 24 * 60 * 60 * 1000 };

function diskThresholds() {
  const out = { ...DISK_DEFAULTS };
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    const d = (cfg && cfg.disk) || {};
    if (Number.isFinite(d.minFreeBytes) && d.minFreeBytes >= 0) out.minFreeBytes = d.minFreeBytes;
    if (Number.isFinite(d.minFreeRatio) && d.minFreeRatio >= 0) out.minFreeRatio = d.minFreeRatio;
    if (Number.isFinite(d.sessionIdleMs) && d.sessionIdleMs >= 0) out.sessionIdleMs = d.sessionIdleMs;
    if (Number.isFinite(d.buildIdleMs) && d.buildIdleMs >= 0) out.buildIdleMs = d.buildIdleMs;
    if (Number.isFinite(d.looseFileIdleMs) && d.looseFileIdleMs >= 0) out.looseFileIdleMs = d.looseFileIdleMs;
    if (Number.isFinite(d.worktreeIdleMs) && d.worktreeIdleMs >= 0) out.worktreeIdleMs = d.worktreeIdleMs;
  } catch {}
  return out;
}

function derivedDataRoot() {
  return process.env.AIRCONTROL_DERIVED_DATA ||
    path.join(os.homedir(), 'Library', 'Developer', 'Xcode', 'DerivedData');
}

/// Free and total bytes on the volume holding `dir`, or null when it cannot be read.
function diskUsage(dir = os.homedir()) {
  try {
    const s = fs.statfsSync(dir);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch { return null; }
}

function humanGB(n) { return `${(n / 1e9).toFixed(1)} GB`; }

/// One line, or nothing. It has to fire while there is still room to act: at 0 bytes free
/// the session cannot run the command it names.
function renderDiskLine(usage, cliPath = '~/.claude/hooks/coord.js', thresholds = diskThresholds()) {
  if (!usage || !usage.total) return '';
  const low = usage.free < thresholds.minFreeBytes || usage.free / usage.total < thresholds.minFreeRatio;
  if (!low) return '';
  const pct = Math.round((usage.free / usage.total) * 100);
  return `[aircontrol] disk: ${humanGB(usage.free)} free (${pct}%) — \`node ${cliPath} disk\` lists stale build output, \`disk --prune\` removes it`;
}

function derivedDataWorkspace(dir) {
  try {
    const xml = fs.readFileSync(path.join(dir, 'info.plist'), 'utf8');
    const m = /<key>WorkspacePath<\/key>\s*<string>([^<]*)<\/string>/.exec(xml);
    if (!m) return null;
    return m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  } catch { return null; }
}

/// DerivedData folders whose project no longer exists. A folder with no WorkspacePath is
/// Xcode's shared module cache or one still being created mid-build, so it is never a
/// candidate; neither is anything under a path a live session has claimed.
function staleDerivedData(root, claimedPaths = []) {
  let names;
  try { names = fs.readdirSync(root); } catch { return []; }
  const out = [];
  for (const name of names) {
    const dir = path.join(root, name);
    const workspace = derivedDataWorkspace(dir);
    if (!workspace || fs.existsSync(workspace)) continue;
    if (claimedPaths.some((p) => pathsOverlap(workspace, p))) continue;
    out.push({ dir, workspace });
  }
  return out;
}

function dirBytes(dir, run = runQuiet) {
  const kb = parseInt(run('du', ['-sk', dir]) || '', 10);
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

// Claude Code gives every session a tmp dir (task output, scratchpad) under /tmp/claude-<uid>,
// and builds pointed there with -derivedDataPath put multi-GB DerivedData in it. macOS clears
// /tmp only on reboot, so on a machine that stays up these outlive their sessions by weeks.
function sessionTmpRoot() {
  return process.env.AIRCONTROL_SESSION_TMP ||
    path.join('/tmp', `claude-${typeof process.getuid === 'function' ? process.getuid() : 0}`);
}

function buildTmpRoots() {
  const env = process.env.AIRCONTROL_BUILD_TMP_ROOTS;
  return env ? env.split(',').filter(Boolean) : [...new Set(['/tmp', sessionTmpRoot(), os.tmpdir()])];
}

/// True when anything under `dir` (including `dir`) was modified after `sinceMs`. Stops at
/// the first hit; never follows symlinks, so a link out of the tree cannot mark it busy.
function touchedSince(dir, sinceMs) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try { st = fs.lstatSync(cur); } catch { continue; }
    if (st.mtimeMs > sinceMs) return true;
    if (!st.isDirectory()) continue;
    let names;
    try { names = fs.readdirSync(cur); } catch { continue; }
    for (const n of names) stack.push(path.join(cur, n));
  }
  return false;
}

/// Per-session tmp dirs (`<root>/<project-slug>/<session-id>`) whose session has ended.
/// "Ended" means no session record: SessionEnd deletes it. Expiry is not enough, because
/// a session idle past the roster TTL is still running and still owns its scratchpad.
function staleSessionTmp(root, recordIds, nowMs, idleMs = DISK_DEFAULTS.sessionIdleMs) {
  const out = [];
  let slugs;
  try { slugs = fs.readdirSync(root).filter((n) => n.startsWith('-')); } catch { return []; }
  for (const slug of slugs) {
    let ids;
    try { ids = fs.readdirSync(path.join(root, slug)); } catch { continue; }
    for (const id of ids) {
      const dir = path.join(root, slug, id);
      if (recordIds.has(id)) continue;
      try { if (!fs.lstatSync(dir).isDirectory()) continue; } catch { continue; }
      if (touchedSince(dir, nowMs - idleMs)) continue;
      out.push({ dir, why: 'session ended' });
    }
  }
  return out;
}

// An Xcode -derivedDataPath root, or a SwiftPM --scratch-path / cloned-packages dir. Pairs,
// not single names: macOS volumes are case-insensitive, so a lone `Build` check also matches
// every unrelated tmp dir with a lowercase `build/` in it.
const BUILD_ROOT_SHAPES = [
  ['Build', 'ModuleCache.noindex'],
  ['Build', 'SourcePackages'],
  ['workspace-state.json', 'checkouts'],
];

function looksLikeBuildRoot(dir) {
  if (!BUILD_ROOT_SHAPES.some(([first]) => fs.existsSync(path.join(dir, first)))) return false;
  let names;
  try { names = new Set(fs.readdirSync(dir)); } catch { return false; }
  return BUILD_ROOT_SHAPES.some((shape) => shape.every((n) => names.has(n)));
}

/// Ad-hoc -derivedDataPath roots left directly in a tmp root. No session owns these, so
/// they wait out a longer idle window, and a claimed path is never touched.
function staleBuildRoots(roots, claimedPaths, nowMs, idleMs = DISK_DEFAULTS.buildIdleMs) {
  const out = [];
  for (const root of roots) {
    let names;
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const name of names) {
      const dir = path.join(root, name);
      if (!looksLikeBuildRoot(dir)) continue;
      const real = (() => { try { return fs.realpathSync(dir); } catch { return dir; } })();
      if (claimedPaths.some((p) => pathsOverlap(dir, p) || pathsOverlap(real, p))) continue;
      if (touchedSince(dir, nowMs - idleMs)) continue;
      out.push({ dir, why: 'build output, idle' });
    }
  }
  return out;
}

// Build and test logs, screenshots and dumps written straight into a tmp root are never inside
// a session dir, so nothing else ever reclaims them. Grouped per root: there can be hundreds.
function staleLooseFiles(roots, claimedPaths, nowMs, idleMs = DISK_DEFAULTS.looseFileIdleMs) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const out = [];
  for (const root of roots) {
    let names;
    try { names = fs.readdirSync(root); } catch { continue; }
    const files = [];
    let bytes = 0;
    for (const name of names) {
      if (/\.(lock|pid)$/.test(name)) continue;
      const file = path.join(root, name);
      let st;
      try { st = fs.lstatSync(file); } catch { continue; }
      if (!st.isFile()) continue;
      if (uid !== null && st.uid !== uid) continue;
      if (nowMs - st.mtimeMs < idleMs) continue;
      if (claimedPaths.some((p) => pathsOverlap(file, p))) continue;
      files.push(file);
      bytes += st.size;
    }
    if (files.length) out.push({ dir: root, files, bytes, why: `${files.length} loose files, idle` });
  }
  return out;
}

/// Every repo a session has ever worked in, from the activity log plus current records.
function knownRepos(sessions) {
  const repos = new Set(sessions.map((s) => s.repo).filter(Boolean));
  for (const e of readActivityEvents(readActivityFiles(Date.now(), { days: 100000 }))) if (e.repo) repos.add(e.repo);
  return [...repos];
}

/// Linked worktrees nobody is using: no live session in them, nothing uncommitted, nothing
/// that exists on no remote, and no git activity for a week. Reported, never removed: a
/// worktree is somebody's work, not a cache. Build output left inside one (an agent's
/// `-derivedDataPath build`) is how a forgotten worktree grows to 10 GB.
function idleWorktrees(repos, busyPaths, nowMs, idleMs = DISK_DEFAULTS.worktreeIdleMs, run = runQuiet) {
  const out = [];
  const seen = new Set();
  for (const repo of repos) {
    const top = path.basename(repo) === '.git' ? path.dirname(repo) : repo;
    const listing = run('git', ['-C', top, 'worktree', 'list', '--porcelain']);
    if (!listing) continue;
    const trees = listing.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
    for (const wt of trees.slice(1)) {
      if (seen.has(wt) || !fs.existsSync(wt)) continue;
      seen.add(wt);
      if (busyPaths.some((p) => pathsOverlap(wt, p))) continue;
      if ((run('git', ['-C', wt, 'status', '--porcelain']) ?? 'x').trim()) continue;
      const unpushed = run('git', ['-C', wt, 'rev-list', '--count', 'HEAD', '--not', '--remotes']);
      if (unpushed === null || Number(unpushed.trim()) > 0) continue;
      const gitDir = (run('git', ['-C', wt, 'rev-parse', '--absolute-git-dir']) || '').trim();
      const lastMs = Math.max(0, ...['index', 'HEAD', 'logs/HEAD'].map((f) => {
        try { return fs.statSync(path.join(gitDir, f)).mtimeMs; } catch { return 0; }
      }));
      if (!gitDir || nowMs - lastMs < idleMs) continue;
      const branch = (run('git', ['-C', wt, 'branch', '--show-current']) || '').trim() || 'detached';
      out.push({ dir: wt, top, branch, idleDays: Math.floor((nowMs - lastMs) / 86400000) });
    }
  }
  return out;
}

function cmdDisk(args, nowMs, deps = {}) {
  const usage = diskUsage(deps.volume);
  if (usage) console.log(`free: ${humanGB(usage.free)} of ${humanGB(usage.total)} (${Math.round((usage.free / usage.total) * 100)}%)`);
  const sessions = readSessions();
  const claimed = sessions
    .filter((s) => !isExpired(s, nowMs))
    .flatMap((s) => ((s.claims && s.claims.paths) || []).map(expandUser));
  const th = diskThresholds();
  const stale = [
    ...staleDerivedData(deps.root || derivedDataRoot(), claimed)
      .map((s) => ({ dir: s.dir, label: path.basename(s.dir), why: `${s.workspace} is gone` })),
    ...staleSessionTmp(deps.sessionTmp || sessionTmpRoot(), new Set(sessions.map((s) => s.sessionId)), nowMs, th.sessionIdleMs)
      .map((s) => ({ ...s, label: s.dir })),
    ...staleBuildRoots(deps.buildRoots || buildTmpRoots(), claimed, nowMs, th.buildIdleMs)
      .map((s) => ({ ...s, label: s.dir })),
    ...staleLooseFiles(deps.buildRoots || buildTmpRoots(), claimed, nowMs, th.looseFileIdleMs)
      .map((s) => ({ ...s, label: `${s.dir}/*` })),
  ];
  const busy = [...claimed, ...sessions.map((s) => s.worktree).filter(Boolean)];
  const idle = idleWorktrees(deps.repos || knownRepos(sessions), busy, nowMs, th.worktreeIdleMs, deps.run);
  for (const w of idle) {
    console.log(`idle worktree\t${humanGB(dirBytes(w.dir, deps.run))}\t${w.dir}\t(${w.branch}, clean and pushed, idle ${w.idleDays}d; remove with \`git -C ${w.top} worktree remove ${w.dir}\`)`);
  }
  if (!stale.length) { console.log('nothing stale'); return; }
  let total = 0;
  for (const s of stale) {
    const bytes = s.files ? s.bytes : dirBytes(s.dir, deps.run);
    if (args.prune) {
      try {
        if (s.files) for (const f of s.files) fs.rmSync(f, { force: true });
        else fs.rmSync(s.dir, { recursive: true, force: true });
      } catch (e) { console.log(`failed\t${s.label}\t${e.message}`); continue; }
    }
    total += bytes;
    console.log(`${args.prune ? 'removed' : 'stale'}\t${humanGB(bytes)}\t${s.label}\t(${s.why})`);
  }
  console.log(`${args.prune ? 'reclaimed' : 'reclaimable with --prune'}: ${humanGB(total)}`);
}

// --- browsers ---

// Claude Code names each session's Unix messaging socket <claudePid>.sock under this dir, so its
// presence is a per-PID liveness signal keyed exactly the way browser trees resolve to a `claude`
// ancestor. Overridable for tests and for a machine that puts the sockets elsewhere.
const CLAUDE_SOCK_DIR = process.env.CLAUDE_CODE_SOCK_DIR || '/tmp/cc-socks';

/// The set of `claude` PIDs that still have a live messaging socket.
///
/// Returns null when the socket dir cannot be read at all. Callers MUST treat null as "liveness
/// unknown" and decline to orphan-reap on that basis — a wrong path must never escalate into
/// killing every session's browsers. A live socket means the owning session is still running, so
/// its browser tree is off-limits however it was started.
function liveClaudePids(deps = {}) {
  const dir = deps.sockDir || CLAUDE_SOCK_DIR;
  try {
    const set = new Set();
    for (const f of fs.readdirSync(dir)) {
      const m = /^(\d+)\.sock$/.exec(f);
      if (m) set.add(Number(m[1]));
    }
    return set;
  } catch { return null; }
}

/// Select the browser-MCP process trees: every command matching a browser pattern, plus all
/// descendants. The actual browser binary is a grandchild of the MCP server and matches no
/// pattern of its own, so pattern-matching alone would leave it running.
function selectBrowserProcs(allProcs) {
  const picked = new Map(
    allProcs.filter((p) => BROWSER_PROC_PATTERNS.some((x) => p.command.includes(x))).map((p) => [p.pid, p]),
  );
  for (let pass = 0; pass < 8; pass++) {
    let grew = false;
    for (const p of allProcs) {
      if (picked.has(p.pid)) continue;
      if (picked.has(p.ppid)) { picked.set(p.pid, p); grew = true; }
    }
    if (!grew) break;
  }
  return [...picked.values()];
}

/// Split browser processes into mine / others / orphaned by their `claude` ancestor.
///
///   mine     — the tree walks up to THIS session's `claude` (myClaudePid)
///   others   — it walks up to another `claude` that still has a live socket (a running session)
///   orphaned — it walks up to a `claude` with no live socket (an exited session whose process
///              lingers), or the tree hangs off launchd with no `claude` ancestor
///
/// A tree with no `claude` ancestor whose top still has a living parent belongs to some other
/// harness (a Codex app-server runs its own Playwright MCP), so it is an "other", not an orphan.
/// `live` is the liveClaudePids() set, or null when unknown. When null, every resolved ancestor
/// is treated as a live "other", so the only thing orphaned on a guess is a launchd-parented tree.
function classifyBrowserProcs(browserProcs, allProcs, myClaudePid, live) {
  const mine = [];
  const others = [];
  const orphaned = [];
  const byPid = new Map(allProcs.map((p) => [p.pid, p]));
  const browserPids = new Set(browserProcs.map((p) => p.pid));
  const hangsOffLaunchd = (p) => {
    let cur = p;
    for (let hop = 0; hop < 12 && cur && browserPids.has(cur.pid); hop++) cur = byPid.get(cur.ppid) || (cur.ppid <= 1 ? null : { pid: cur.ppid });
    return !cur || cur.pid <= 1;
  };
  for (const p of browserProcs) {
    const { claudePid } = claudeAncestor(p.pid, allProcs);
    if (myClaudePid && claudePid === myClaudePid) mine.push(p);
    else if (claudePid && (live === null || live.has(claudePid))) others.push(p);
    else if (claudePid || hangsOffLaunchd(p)) orphaned.push(p);
    else others.push(p);
  }
  return { mine, others, orphaned };
}

function readAllProcs(run = runQuiet) {
  return parseProcTable(run('ps', ['-Ao', 'pid=,ppid=,command=']) || '');
}

/// Resolve (allProcs, browserProcs, myClaudePid, live) once, honouring injected deps so tests and
/// the SessionEnd reaper need no real `ps` or socket dir. `deps.live` is intentionally NOT read
/// here — `cmdDeregister` already uses that name as a boolean reap gate; the socket set is
/// `deps.liveClaudePids`.
function browserContext(deps = {}) {
  const allProcs = deps.allProcs || readAllProcs(deps.run || runQuiet);
  const browserProcs = deps.browserProcs || selectBrowserProcs(allProcs);
  const self = deps.selfPid || process.pid;
  const myClaudePid = deps.myClaudePid !== undefined
    ? deps.myClaudePid
    : claudeAncestor(self, allProcs).claudePid;
  const live = deps.liveClaudePids !== undefined ? deps.liveClaudePids : liveClaudePids(deps);
  return { allProcs, browserProcs, myClaudePid, live };
}

/// Reap browser trees whose owning `claude` session has exited (no live socket) or was reparented
/// to launchd. Never touches a live session's browsers — mine or another's. Returns null when
/// liveness is unknown (refuse rather than guess); otherwise the pids signalled.
function reapOrphanBrowsers(deps = {}) {
  const { allProcs, browserProcs, myClaudePid, live } = browserContext(deps);
  if (live === null) return null;
  const { orphaned } = classifyBrowserProcs(browserProcs, allProcs, myClaudePid, live);
  const kill = deps.kill || ((pid) => process.kill(pid, 'SIGTERM'));
  const killed = [];
  for (const p of orphaned) { try { kill(p.pid); killed.push(p.pid); } catch {} }
  return killed;
}

function cmdBrowsers(args, deps = {}) {
  const { allProcs, browserProcs, myClaudePid, live } = browserContext(deps);
  if (!browserProcs.length) { console.log('no browser MCP processes running'); return; }
  const { mine, others, orphaned } = classifyBrowserProcs(browserProcs, allProcs, myClaudePid, live);
  const kill = deps.kill || ((pid) => process.kill(pid, 'SIGTERM'));

  if (args['kill-mine']) {
    if (!myClaudePid) {
      console.error('refusing to kill: no `claude` ancestor resolved, so this session\'s own');
      console.error('browsers cannot be identified. Listing instead.');
      process.exitCode = 1;
    } else {
      for (const p of mine) { try { kill(p.pid); } catch {} }
      console.log(`killed ${mine.length} browser process${mine.length === 1 ? '' : 'es'} for this session${mine.length ? `: ${mine.map((p) => p.pid).join(', ')}` : ''}`);
    }
  } else if (mine.length) {
    console.log(`this session (${mine.length}): ${mine.map((p) => p.pid).join(', ')}`);
  }

  if (args['kill-orphaned']) {
    if (live === null) {
      console.error(`refusing to reap orphans: cannot read ${deps.sockDir || CLAUDE_SOCK_DIR}, so session`);
      console.error('liveness is unknown and a live session\'s browser could be killed. Listing instead.');
      process.exitCode = 1;
    } else {
      for (const p of orphaned) { try { kill(p.pid); } catch {} }
      console.log(`reaped ${orphaned.length} orphaned browser process${orphaned.length === 1 ? '' : 'es'}${orphaned.length ? `: ${orphaned.map((p) => p.pid).join(', ')}` : ''}`);
    }
  } else if (orphaned.length) {
    console.log(`orphaned / exited sessions (${orphaned.length})${live === null ? ' [liveness unknown]' : ''}, NOT touched:`);
    for (const p of orphaned) console.log(`  ${p.pid}  ${p.command.split(/\s+/).slice(0, 4).join(' ')}`);
    console.log(`  → coord.js browsers --kill-orphaned   to reap them`);
  }

  if (others.length) {
    console.log(`other live sessions (${others.length}), NOT touched: ${others.map((p) => p.pid).join(', ')}`);
  }
}

// ---------- background tasks (Bash-tool shells) ----------
//
// A background shell outlives the turn that started it, and nothing else notices. The shape that
// bit here, reproduced deliberately before this was written: two shells each waiting with
// `until ! pgrep -f "xcodebuild test"` while a real xcodebuild ran. When it exited, the pattern
// was still in BOTH their argvs, so each kept the other's condition true and neither could ever
// exit. They held a simulator for ten hours. (One alone is fine — pgrep does not match the shell
// that invoked it — and so is two started together, which race before either is visible. It
// takes a third process to hold the pattern true while both come up.)
//
// Attribution here is deliberately NOT the browser mechanism. CLAUDE_CODE_MESSAGING_TOKEN is
// inherited by everything a session spawns, MCP servers included, and `tasks` must be safe to
// run mid-session: killing this session's own MCP servers is not a cleanup. Background shells
// have a sharper signature that needs no environment at all — a direct child of THIS session's
// `claude` process whose argv sources the Bash tool's shell snapshot.
//
// Cross-session safety is structural rather than a rule: another session's shells hang off its
// own `claude` pid, which is not ours, so `--kill-mine` cannot reach them however hard it tries.

const TASK_SHELL_RE = /\/\.claude\/shell-snapshots\/snapshot-/;
const CLAUDE_PROC_RE = /(^|\/)claude$/;

function parseProcTable(psOutput) {
  const all = [];
  for (const line of String(psOutput || '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pid, ppid, rest] = m;
    all.push({ pid: Number(pid), ppid: Number(ppid), command: rest });
  }
  return all;
}

/// Walk up from `pid` to the nearest `claude` ancestor, collecting every pid on the way.
///
/// The ancestors are the point of the return value, not a by-product: coord.js is invoked FROM a
/// Bash-tool shell, so that shell has the same signature as the things being reaped and is on
/// this chain. Killing it would kill the command doing the killing.
function claudeAncestor(pid, procs) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const ancestors = new Set([pid]);
  let cur = byPid.get(pid);
  for (let hop = 0; hop < 12 && cur; hop++) {
    const parent = byPid.get(cur.ppid);
    if (!parent) break;
    if (CLAUDE_PROC_RE.test(parent.command.split(/\s+/)[0])) {
      return { claudePid: parent.pid, ancestors };
    }
    ancestors.add(parent.pid);
    cur = parent;
  }
  return { claudePid: null, ancestors };
}

/// Split Bash-tool shells into mine / others / orphaned.
///
/// Orphaned means the parent is gone and launchd adopted it — a session that already exited.
/// Those are reported and never killed, the same posture `cmdBrowsers` takes for unattributed
/// processes: at that point nothing on the machine can prove whose they were.
function classifyTaskProcs(procs, claudePid, ancestors = new Set()) {
  const claudePids = new Set(
    procs.filter((p) => CLAUDE_PROC_RE.test(p.command.split(/\s+/)[0])).map((p) => p.pid),
  );
  const mine = [];
  const others = [];
  const orphaned = [];
  for (const p of procs) {
    if (!TASK_SHELL_RE.test(p.command)) continue;
    if (ancestors.has(p.pid)) continue;
    if (claudePid && p.ppid === claudePid) mine.push(p);
    else if (claudePids.has(p.ppid)) others.push(p);
    else if (p.ppid <= 1) orphaned.push(p);
  }
  return { mine, others, orphaned };
}

function descendantsOf(pid, procs) {
  const out = [];
  let frontier = [pid];
  for (let pass = 0; pass < 8 && frontier.length; pass++) {
    const next = procs.filter((p) => frontier.includes(p.ppid)).map((p) => p.pid);
    out.push(...next);
    frontier = next;
  }
  return out;
}

function readTaskProcs(run = runQuiet) {
  return parseProcTable(run('ps', ['-Ao', 'pid=,ppid=,command=']) || '');
}

/// Has this session got a background shell still running?
///
/// The Stop hook's next-steps offer says "nothing else is pending", and a build,
/// test run or deploy started with run_in_background makes that false — the turn
/// ends while the work continues, and the offer lands on top of it.
///
/// Same ancestry rule as the reaper, so it sees exactly what `--kill-mine` would
/// take: direct children of THIS session's `claude` carrying the Bash tool's
/// shell-snapshot signature. Another session's shells hang off its own `claude`
/// and an orphan has no parent to walk to, so neither can hold this offer back.
///
/// False on any failure. An unreadable process table must not silence the offer
/// for the rest of the session — a nudge that goes missing is harder to notice
/// than one that arrives early.
function ownTasksRunning(deps = {}) {
  try {
    const procs = deps.procs || readTaskProcs(deps.run || runQuiet);
    const self = deps.selfPid || process.pid;
    const resolved = deps.claudePid !== undefined
      ? { claudePid: deps.claudePid, ancestors: deps.ancestors || new Set([self]) }
      : claudeAncestor(self, procs);
    if (!resolved.claudePid) return false;
    return classifyTaskProcs(procs, resolved.claudePid, resolved.ancestors).mine.length > 0;
  } catch {
    return false;
  }
}

/// Reap the background shells this session started, and only those.
///
/// Descendants go first, deepest last-found first: a `ruby` or `xcodebuild` under the shell
/// would otherwise be reparented to launchd by its parent dying, which turns one stuck process
/// into an unattributable one. Returns the pids signalled, for the test to assert on.
function reapOwnTasks(deps = {}) {
  const procs = deps.procs || readTaskProcs(deps.run || runQuiet);
  const self = deps.selfPid || process.pid;
  const resolved = deps.claudePid !== undefined
    ? { claudePid: deps.claudePid, ancestors: deps.ancestors || new Set([self]) }
    : claudeAncestor(self, procs);
  if (!resolved.claudePid) return [];
  const { mine } = classifyTaskProcs(procs, resolved.claudePid, resolved.ancestors);
  const kill = deps.kill || ((pid) => process.kill(pid, 'SIGTERM'));
  const killed = [];
  for (const p of mine) {
    for (const child of descendantsOf(p.pid, procs).reverse()) {
      try { kill(child); killed.push(child); } catch {}
    }
    try { kill(p.pid); killed.push(p.pid); } catch {}
  }
  return killed;
}

function cmdTasks(args, deps = {}) {
  const run = deps.run || runQuiet;
  const procs = deps.procs || readTaskProcs(run);
  const self = deps.selfPid || process.pid;
  const resolved = deps.claudePid !== undefined
    ? { claudePid: deps.claudePid, ancestors: deps.ancestors || new Set([self]) }
    : claudeAncestor(self, procs);
  const { mine, others, orphaned } = classifyTaskProcs(procs, resolved.claudePid, resolved.ancestors);

  if (!mine.length && !others.length && !orphaned.length) {
    console.log('no background shells running');
    return;
  }

  if (args['kill-mine']) {
    if (!resolved.claudePid) {
      console.error('refusing to kill: no `claude` ancestor resolved, so this session\'s own');
      console.error('background shells cannot be identified. Listing instead.');
      process.exitCode = 1;
    } else {
      const killed = reapOwnTasks({ ...deps, procs, claudePid: resolved.claudePid, ancestors: resolved.ancestors });
      console.log(`killed ${killed.length} process${killed.length === 1 ? '' : 'es'} for this session${killed.length ? `: ${killed.join(', ')}` : ''}`);
    }
  } else if (mine.length) {
    console.log(`this session (${mine.length}): ${mine.map((p) => p.pid).join(', ')}`);
  }

  if (others.length) {
    console.log(`other sessions (${others.length}), NOT touched: ${others.map((p) => p.pid).join(', ')}`);
  }
  if (orphaned.length) {
    console.log(`orphaned (${orphaned.length}), NOT touched:`);
    for (const p of orphaned) console.log(`  ${p.pid}  ${p.command.slice(0, 120)}`);
    console.log(`  → kill ${orphaned.map((p) => p.pid).join(' ')}   to reap them`);
  }
}

// --- retro ---

/// Rank tool results by what they actually cost: a result is re-sent on every SUBSEQUENT turn,
/// so cost ≈ bytes × turns remaining. Ranking by raw bytes points at the wrong ones — a 47 KB
/// result on the last turn is paid once; the same result on turn 3 is paid hundreds of times.
function rankToolResults(rows, totalTurns) {
  return rows
    .map((r) => ({ ...r, cost: r.bytes * Math.max(1, totalTurns - r.turn) }))
    .sort((a, b) => b.cost - a.cost);
}

/// A short, non-sensitive label for a tool call — enough to recognise the offender in a
/// ranking without reproducing its arguments.
function describeToolCall(block) {
  const i = block.input || {};
  const raw = i.command || i.cmd || i.file_path || i.pattern || i.path || i.url || '';
  return String(raw).replace(/\s+/g, ' ').slice(0, 60);
}

/// A general, offender-keyed fix for the costliest tool result — not a diagnosis of what
/// happened this session, just which of three remediations applies to this shape of result.
function remediationHint(top) {
  if (!top) return '';
  const label = `${top.name} ${top.hint || ''}`;
  if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(label)) return 'downsize before reading (sips -Z 900)';
  if (/^Read\b/.test(top.name)) return 're-read a slice (offset/limit) or delegate';
  return 'delegate this fan-out to a subagent';
}

// --- Codex rollouts ---
//
// Codex's transcript is a different file with a different schema: one `{type, payload}`
// record per line under `~/.codex/sessions/YYYY/MM/DD/`. Tool calls are `response_item`s
// (`function_call` with JSON `arguments`, or `custom_tool_call` with a raw `input` string)
// paired to their `*_output` by `call_id`; `event_msg/token_count` carries the cumulative
// usage the harness computed itself. Both readers fold Codex records into the same `state`
// so retro and the live meter agree on Codex exactly as they do on Claude.

function isCodexRecord(d) {
  return !!d && typeof d.type === 'string' && !!d.payload && typeof d.payload === 'object' && !d.message;
}

function describeCodexCall(p) {
  if (p.type === 'function_call') {
    let args = {};
    try { args = JSON.parse(p.arguments || '{}'); } catch {}
    return describeToolCall({ input: args && typeof args === 'object' ? args : {} });
  }
  return String(p.input == null ? '' : p.input).replace(/\s+/g, ' ').slice(0, 60);
}

/// Output bytes as the model sees them: a string, or a list of text parts.
function codexOutputBytes(output) {
  if (typeof output === 'string') return output.length;
  if (Array.isArray(output)) {
    return output.reduce((n, part) => n + (part && typeof part.text === 'string' ? part.text.length : JSON.stringify(part || '').length), 0);
  }
  return JSON.stringify(output == null ? '' : output).length;
}

function accumulateCodexRecord(d, state) {
  const p = d.payload;
  if (d.type === 'event_msg') {
    if (p.type === 'token_count' && p.info && p.info.total_token_usage) {
      const u = p.info.total_token_usage;
      // Cumulative, so the last one wins; summing would count every turn many times over.
      state.usage.codex = {
        input: u.input_tokens || 0,
        cached: u.cached_input_tokens || 0,
        output: u.output_tokens || 0,
        total: u.total_tokens || 0,
      };
    }
    return;
  }
  if (d.type !== 'response_item') return;
  state.turns++;
  if ((p.type === 'function_call' || p.type === 'custom_tool_call') && p.call_id) {
    state.calls.set(p.call_id, { name: p.name || 'tool', hint: describeCodexCall(p) });
    return;
  }
  if (p.type !== 'function_call_output' && p.type !== 'custom_tool_call_output') return;
  const call = state.calls.get(p.call_id) || {};
  state.rows.push({ turn: state.turns, bytes: codexOutputBytes(p.output), name: call.name || 'tool_result', hint: call.hint || '' });
}

/// One pass over a single transcript line, folded into `state`. Shared by the full reader
/// (retro) and the incremental meter (the live budget line) so the two can never drift
/// apart in what they count — a divergence there would show the operator one number and
/// bill them another.
///
/// `state` is `{ rows, calls: Map, usage, turns }`, mutated in place. Blank and
/// unparseable lines advance nothing, matching the original single-pass reader.
function accumulateTranscriptLine(line, state) {
  if (!line.trim()) return;
  let d;
  try { d = JSON.parse(line); } catch { return; }
  if (isCodexRecord(d)) return accumulateCodexRecord(d, state);
  const msg = d.message || {};
  const usage = state.usage;
  if (msg.usage) {
    usage.messages++;
    usage.output += msg.usage.output_tokens || 0;
    usage.cacheCreation += msg.usage.cache_creation_input_tokens || 0;
    usage.cacheRead += msg.usage.cache_read_input_tokens || 0;
    usage.input += msg.usage.input_tokens || 0;
  }
  state.turns++;
  const content = msg.content;
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (!b) continue;
    // Remember what each call WAS, so the ranking can name it. A tool_use_id alone is
    // unactionable — "13k bytes on turn 149" tells you nothing you can change.
    if (b.type === 'tool_use' && b.id) {
      state.calls.set(b.id, { name: b.name || 'tool', hint: describeToolCall(b) });
      continue;
    }
    if (b.type !== 'tool_result') continue;
    const c = b.content;
    const bytes = (typeof c === 'string' ? c : JSON.stringify(c || '')).length;
    const call = state.calls.get(b.tool_use_id) || {};
    state.rows.push({ turn: state.turns, bytes, name: call.name || 'tool_result', hint: call.hint || '' });
  }
}

function newTranscriptState() {
  return {
    rows: [],
    calls: new Map(),
    usage: { output: 0, cacheCreation: 0, cacheRead: 0, input: 0, messages: 0 },
    turns: 0,
  };
}

function readTranscript(file) {
  const state = newTranscriptState();
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { rows: state.rows, usage: state.usage, turns: 0 }; }
  for (const line of raw.split('\n')) accumulateTranscriptLine(line, state);
  return { rows: state.rows, usage: state.usage, turns: state.turns };
}

// --- live context budget ---
//
// `retro` answers "where did the tokens go?" only once the session is over, which is too
// late to act on: the 84%-of-bytes screenshot has already been re-sent 140 times by then.
// The meter below folds the same accounting into the per-turn UserPromptSubmit hook, so
// the number is in front of the session while it can still change course. It measures and
// reports; it never denies.

const BUDGET_TOP_N = 3;
// Candidate pool for "costliest result". Large enough that the lossless stage of pruning
// (see mergePool) almost always settles under it, so the ranking stays exact.
const BUDGET_POOL = 64;
// Enough tail to pair a tool_use with its tool_result across a chunk boundary without
// letting the session record grow unbounded.
const BUDGET_PENDING_MAX = 50;
// ~400 KB of tool results is ~100k tokens at first send. Below that the line is noise.
// The 60 KB single-result floor is the screenshot threshold already in the operator's
// CLAUDE.md, which prose alone twice failed to enforce.
const BUDGET_DEFAULTS = { totalBytes: 400000, singleBytes: 60000 };

function emptyBudget() {
  return { offset: 0, bytes: 0, turns: 0, results: 0, pool: [], pending: [] };
}

/// Per-install overrides (config.json `budget.totalBytes` / `budget.singleBytes`), the same
/// file guardPatterns.deploy uses. A missing or broken config keeps the defaults.
function budgetThresholds() {
  const out = { ...BUDGET_DEFAULTS };
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    const b = (cfg && cfg.budget) || {};
    if (Number.isFinite(b.totalBytes) && b.totalBytes >= 0) out.totalBytes = b.totalBytes;
    if (Number.isFinite(b.singleBytes) && b.singleBytes >= 0) out.singleBytes = b.singleBytes;
  } catch {}
  return out;
}

/// Narrow the candidates for "costliest result" without pruning away a future winner.
///
/// The trap: cost is `bytes x turns-remaining`, so it GROWS as the transcript does, and the
/// ordering between two results can swap while it grows. Keeping a running top-N therefore
/// keeps the wrong N — early in a session every result looks cheap, so the first few seen
/// get locked in and the genuinely costly middle of the session never displaces them.
///
/// Two stages instead:
///   1. Lossless — drop a row only once BUDGET_TOP_N other rows *dominate* it. Row j
///      dominates row i when it is at least as big and at least as early
///      (`bytes_j >= bytes_i` and `turn_j <= turn_i`), which makes `cost_j >= cost_i` at
///      every possible turn count. Once N rows each outrank it forever, it can never enter
///      a top-N, so discarding it costs nothing. Counting dominators among the *retained*
///      rows is enough: domination is transitive, so anything a dropped row dominates is
///      dominated by that row's own dominators too.
///   2. Lossy, and only if the survivors still exceed BUDGET_POOL — drop the cheapest at
///      the current turn count. The ranking is exact below that cap.
///
/// Note the K in stage 1 must match the K actually rendered. Pruning on single domination
/// is correct only for a top-1 list: a dominated row can still legitimately hold rank 2.
function mergePool(existing, rows, totalTurns) {
  const all = existing.concat(rows.map((r) => ({ name: r.name, hint: r.hint, bytes: r.bytes, turn: r.turn })));
  all.sort((a, b) => a.turn - b.turn || b.bytes - a.bytes);
  const kept = [];
  for (const r of all) {
    let dominators = 0;
    for (const k of kept) {
      // kept is in turn order, so every entry already satisfies turn <= r.turn.
      if (k.bytes >= r.bytes && ++dominators >= BUDGET_TOP_N) break;
    }
    if (dominators < BUDGET_TOP_N) kept.push(r);
  }
  if (kept.length <= BUDGET_POOL) return kept;
  return rankToolResults(kept, totalTurns)
    .slice(0, BUDGET_POOL)
    .map((r) => ({ name: r.name, hint: r.hint, bytes: r.bytes, turn: r.turn }));
}

/// The pool ranked as retro would rank it, most expensive first.
function budgetTop(budget) {
  if (!budget || !Array.isArray(budget.pool)) return [];
  return rankToolResults(budget.pool, Number(budget.turns) || 0);
}

/// Incremental sibling of readTranscript: parses only the bytes appended since
/// `prev.offset`. A turn appends kilobytes while the file grows to megabytes, so this is
/// what keeps a per-prompt hook off the critical path. Returns the next budget record;
/// never throws.
function readTranscriptDelta(file, prev) {
  const base = (prev && typeof prev === 'object') ? prev : emptyBudget();
  let budget = {
    offset: Number(base.offset) || 0,
    bytes: Number(base.bytes) || 0,
    turns: Number(base.turns) || 0,
    results: Number(base.results) || 0,
    pool: Array.isArray(base.pool) ? base.pool.slice(0, BUDGET_POOL) : [],
    pending: Array.isArray(base.pending) ? base.pending.slice(-BUDGET_PENDING_MAX) : [],
  };
  if (!file) return budget; // a Codex session whose rollout path has not arrived yet
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return budget; }
  try {
    const size = fs.fstatSync(fd).size;
    // A file that shrank is a different file: compaction, rotation, or a fresh transcript
    // reusing the path. Adding its tail to the old totals would double-count, so restart
    // rather than guess which it was.
    if (size < budget.offset) budget = emptyBudget();
    if (size <= budget.offset) return budget;
    const len = size - budget.offset;
    const buf = Buffer.allocUnsafe(len);
    const read = fs.readSync(fd, buf, 0, len, budget.offset);
    if (read <= 0) return budget;
    const chunk = buf.toString('utf8', 0, read);
    // Only whole lines are safe to parse — the tail may be a half-written record. Rewind
    // to the last newline and leave the remainder for next turn, so no line is ever
    // parsed twice or parsed in halves.
    const cut = chunk.lastIndexOf('\n');
    if (cut < 0) return budget;
    const complete = chunk.slice(0, cut);
    const consumed = Buffer.byteLength(complete, 'utf8') + 1;

    const state = newTranscriptState();
    state.turns = budget.turns;
    for (const [id, meta] of budget.pending) state.calls.set(id, meta);
    for (const line of complete.split('\n')) accumulateTranscriptLine(line, state);

    budget.turns = state.turns;
    budget.results += state.rows.length;
    for (const r of state.rows) budget.bytes += r.bytes;
    budget.pool = mergePool(budget.pool, state.rows, state.turns);
    budget.pending = [...state.calls].slice(-BUDGET_PENDING_MAX);
    budget.offset += consumed;
    return budget;
  } catch {
    return budget;
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

function payloadTranscript(input) {
  return input && typeof input.transcript_path === 'string' && input.transcript_path ? input.transcript_path : '';
}

/// Where this session's transcript lives. The hook payload carries it directly; the path
/// a previous hook stored on the session is next; the cwd-derived Claude slug is the
/// fallback `retro` already relies on — and is meaningless for a Codex session, whose
/// rollout only ever arrives by payload.
function sessionTranscript(input, id, prev) {
  const fromPayload = payloadTranscript(input);
  if (fromPayload) return fromPayload;
  if (prev && typeof prev.transcriptPath === 'string' && prev.transcriptPath) return prev.transcriptPath;
  if (prev && prev.harness === 'codex') return null;
  return path.join(transcriptDir((input && input.cwd) || process.cwd()), `${id}.jsonl`);
}

function humanBytes(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}MB` : `${Math.round(n / 1000)}k`;
}

/// One line, or nothing. Silence below the thresholds is the point: a number printed every
/// turn regardless of value is wallpaper, and wallpaper is what the prose rule already was.
function renderBudgetLine(budget, thresholds = budgetThresholds()) {
  if (!budget || !budget.bytes) return '';
  const top = budgetTop(budget)[0];
  const loud = budget.bytes >= thresholds.totalBytes
    || (top && top.bytes >= thresholds.singleBytes);
  if (!loud) return '';
  const parts = [`[aircontrol] context: ${humanBytes(budget.bytes)} tool results`
    + ` (~${Math.round(budget.bytes / 4000)}k tok, ${budget.results} results)`];
  if (top) {
    const label = top.hint ? `${top.name} ${top.hint}` : top.name;
    const resent = Math.max(1, budget.turns - top.turn);
    parts.push(`costliest: ${label} ${humanBytes(top.bytes)} x${resent}`);
    parts.push(`fix: ${remediationHint(top)}`);
  }
  return parts.join(' — ');
}

function transcriptDir(cwd) {
  const slug = path.resolve(cwd).replace(/[/.]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', slug);
}

function newestTranscript(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return null; }
  let best = null;
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      const m = fs.statSync(full).mtimeMs;
      if (!best || m > best.m) best = { full, m };
    } catch {}
  }
  return best ? best.full : null;
}

function codexSessionsDir() { return path.join(codexHome(), 'sessions'); }

/// Codex files rollouts by date, `sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`, so finding
/// one by id is a three-level walk (no globbing on Node 18). `ref` may be a prefix; among
/// several matches the newest wins, like `newestTranscript`.
function findCodexRollout(ref) {
  if (!ref) return null;
  const root = codexSessionsDir();
  const numeric = (d) => { try { return fs.readdirSync(d).filter((n) => /^\d+$/.test(n)); } catch { return []; } };
  const re = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/;
  let best = null;
  const consider = (dir, file) => {
    const match = re.exec(file);
    if (!match) return;
    const id = match[1];
    if (id !== ref && !id.startsWith(ref)) return;
    const full = path.join(dir, file);
    try {
      const mt = fs.statSync(full).mtimeMs;
      if (!best || mt > best.mt) best = { full, mt };
    } catch {}
  };
  for (const y of numeric(root)) {
    for (const m of numeric(path.join(root, y))) {
      for (const day of numeric(path.join(root, y, m))) {
        const dir = path.join(root, y, m, day);
        let files = [];
        try { files = fs.readdirSync(dir); } catch { continue; }
        for (const f of files) consider(dir, f);
      }
    }
  }
  const archive = path.join(codexHome(), 'archived_sessions');
  let archived = [];
  try { archived = fs.readdirSync(archive); } catch {}
  for (const f of archived) consider(archive, f);
  return best ? best.full : null;
}

/// Which transcript `retro` should read. `--file` is explicit. `--session` is a live
/// session's name or id prefix first (its stored transcript path works for either
/// harness), then a Claude transcript by id in this cwd's slug, then a Codex rollout by
/// id. With no `--session`, a sole live session in this worktree wins; multiple matches
/// are ambiguous, and no matches retain the legacy newest-Claude-transcript fallback.
function resolveRetroTranscript(args) {
  const dir = transcriptDir(args.cwd || process.cwd());
  if (args.file) return { file: args.file, dir };
  if (!args.session) {
    const cwd = path.resolve(args.cwd || process.cwd());
    const nowMs = Date.now();
    const matches = readSessions().filter((session) => {
      if (isExpired(session, nowMs)) return false;
      if (!session.worktree || path.resolve(session.worktree) !== cwd) return false;
      return !!(session.transcriptPath && fs.existsSync(session.transcriptPath));
    });
    if (matches.length === 1) return { file: matches[0].transcriptPath, dir };
    if (matches.length > 1) return { file: null, dir, ambiguous: matches.map((session) => friendlyName(session.sessionId)) };
    return { file: newestTranscript(dir), dir };
  }
  let live = null;
  try {
    const sessions = readSessions();
    const id = resolveIdPrefix(sessions.map((s) => s.sessionId), args.session);
    live = sessions.find((s) => s.sessionId === id) || null;
  } catch {} // no live match is the normal case for a finished session
  if (live && live.transcriptPath && fs.existsSync(live.transcriptPath)) return { file: live.transcriptPath, dir };
  const claude = path.join(dir, `${args.session}.jsonl`);
  if (fs.existsSync(claude)) return { file: claude, dir };
  return { file: findCodexRollout(args.session), dir };
}

function cmdRetro(args) {
  const { file, dir, ambiguous } = resolveRetroTranscript(args);
  if (!file || !fs.existsSync(file)) {
    if (ambiguous && ambiguous.length) {
      console.error(`multiple live sessions match this worktree (${ambiguous.join(', ')}). Pass --session <aircontrol-name>.`);
    } else {
      console.error(`no transcript found (looked in ${dir}, ${codexSessionsDir()}, and ${path.join(codexHome(), 'archived_sessions')}). Pass --session <aircontrol-name> or --file <path>.`);
    }
    process.exitCode = 1;
    return;
  }
  const { rows, usage, turns } = readTranscript(file);
  const mb = (fs.statSync(file).size / 1e6).toFixed(1);
  const totalBytes = rows.reduce((n, r) => n + r.bytes, 0);

  console.log(`transcript ${path.basename(file)} — ${mb} MB, ${turns} messages, ${rows.length} tool results`);
  if (usage.codex) {
    // Codex reports its own cumulative usage; the last token_count is the whole session.
    const c = usage.codex;
    console.log(`tokens (Codex, cumulative): ${Math.round(c.total / 1000)}k total — input ${Math.round(c.input / 1000)}k (cached ${Math.round(c.cached / 1000)}k), output ${Math.round(c.output / 1000)}k`);
  } else {
    // output + cache_creation is the honest figure: cache_read is heavily discounted, and
    // reporting it raw makes every long session look catastrophic.
    console.log(`billed-ish tokens: ~${Math.round((usage.output + usage.cacheCreation) / 1000)}k (output ${Math.round(usage.output / 1000)}k + cache-creation ${Math.round(usage.cacheCreation / 1000)}k)`);
    console.log(`cache reads: ${Math.round(usage.cacheRead / 1e6)}M — heavily discounted, NOT the cost driver`);
  }
  console.log(`tool-result bytes: ${Math.round(totalBytes / 1000)}k total (~${Math.round(totalBytes / 4000)}k tokens at first send)`);

  const ranked = rankToolResults(rows, turns).slice(0, Number(args.top) || 8);
  if (!ranked.length) { console.log('no tool results to rank'); return; }
  console.log('costliest results (bytes x turns re-sent):');
  for (const r of ranked) {
    const label = r.hint ? `${r.name}: ${r.hint}` : r.name;
    console.log(`  turn ${r.turn}/${turns}  ${Math.round(r.bytes / 1000)}k x${turns - r.turn}  ${label}`);
  }
  console.log(`fix: ${remediationHint(ranked[0])}`);

  // Repeat offenders are where a rule can actually help; a single big result is just a big result.
  const byLabel = new Map();
  for (const r of rows) {
    const k = r.name;
    const e = byLabel.get(k) || { calls: 0, bytes: 0 };
    e.calls++; e.bytes += r.bytes;
    byLabel.set(k, e);
  }
  const repeat = [...byLabel.entries()].filter(([, e]) => e.calls > 1).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 5);
  if (repeat.length) {
    console.log('by tool (total result bytes):');
    for (const [name, e] of repeat) console.log(`  ${name}  ${e.calls} calls  ${Math.round(e.bytes / 1000)}k`);
  }
}

// ---------- activity log reader ----------

function matchesSessionRef(ev, ref) {
  if (!ref) return true;
  if (ev.sid && ev.sid.startsWith(ref)) return true;
  return !!ev.name && ev.name.toLowerCase() === ref.toLowerCase();
}

function formatDuration(min) {
  if (!Number.isFinite(min)) return '';
  return min >= 60 ? `${Math.floor(min / 60)}h${min % 60}m` : `${min}m`;
}

// Events store UTC ISO timestamps but the reader speaks operator-local time,
// matching the local-date file bucketing.
function localTimeStr(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '--:--';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const ACTIVITY_LIST_MAX = 6;

function listSome(items) {
  const arr = items || [];
  const head = arr.slice(0, ACTIVITY_LIST_MAX).join(', ');
  return arr.length > ACTIVITY_LIST_MAX ? `${head} (+${arr.length - ACTIVITY_LIST_MAX} more)` : head;
}

function formatActivityLine(e) {
  switch (e.ev) {
    case 'session-start': return 'started';
    case 'session-end': {
      const how = e.swept ? 'went stale, swept' : e.reason === 'clear' ? '/clear' : 'ended';
      const dur = formatDuration(e.durationMin);
      const intent = e.intent && e.intent !== '(not yet declared)' ? ` intent="${e.intent}"` : '';
      const touched = (e.paths || []).length ? ` touched: ${listSome(e.paths)}` : '';
      return `${how}${dur ? ` (${dur})` : ''}${intent}${touched}`;
    }
    case 'claim': {
      const bits = [];
      if (e.intent) bits.push(`intent="${e.intent}"`);
      if ((e.paths || []).length) bits.push(`paths=[${listSome(e.paths)}]`);
      if ((e.resources || []).length) bits.push(`resources=[${listSome(e.resources)}]`);
      return `claimed ${bits.join(' ')}`;
    }
    case 'release': {
      const bits = [];
      if ((e.paths || []).length) bits.push(`paths=[${listSome(e.paths)}]`);
      if ((e.resources || []).length) bits.push(`resources=[${listSome(e.resources)}]`);
      return `released${e.all ? ' everything' : ''}${bits.length ? ` ${bits.join(' ')}` : ''}`;
    }
    case 'files': return `touched ${e.paths.length} file${e.paths.length === 1 ? '' : 's'}: ${listSome(e.paths)}`;
    case 'cmd': return `ran ${e.kind}${e.key ? ` (${e.key})` : ''}`;
    case 'sim-acquire': return `leased ${e.platform === 'android' ? 'emulator' : 'sim'} ${e.key} (${e.device})${e.reused ? ' again' : ''}${e.purpose ? ` for "${e.purpose}"` : ''}`;
    case 'sim-release': return e.all ? `released ${e.count} lease${e.count === 1 ? '' : 's'}` : `released ${e.platform === 'android' ? 'emulator' : 'sim'} ${e.key} (${e.device})`;
    case 'send': return e.broadcast ? `broadcast to ${e.to.length} session${e.to.length === 1 ? '' : 's'}` : `messaged ${listSome(e.to)}`;
    case 'handoff': return `handed off to ${e.to}${e.ledgerId ? ` (${e.ledgerId})` : ''}${e.movedClaims ? `, ${e.movedClaims} claim${e.movedClaims === 1 ? '' : 's'} moved` : ''}`;
    case 'deny': return `DENIED ${e.tool || '?'} → ${e.target || '?'}`;
    default: return e.ev || '?';
  }
}

function cmdLog(args, nowMs) {
  const files = readActivityFiles(nowMs, { date: args.date, days: args.days });
  let events = readActivityEvents(files);
  if (args.session) events = events.filter((e) => matchesSessionRef(e, args.session));
  if (args.repo) {
    const repo = args.repo === '.' ? gitInfo(process.cwd()).repo : args.repo;
    events = events.filter((e) => e.repo === repo);
  }
  events.sort((a, b) => ((a.ts || '') < (b.ts || '') ? -1 : (a.ts || '') > (b.ts || '') ? 1 : 0));
  if (args.json) { console.log(JSON.stringify(events, null, 1)); return; }
  if (!events.length) { console.log('activity: nothing recorded (try --days N or --date YYYY-MM-DD)'); return; }
  const byDay = new Map();
  for (const e of events) {
    const ms = Date.parse(e.ts);
    const day = Number.isFinite(ms) ? localDateStr(ms) : (e.ts || '').slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, new Map());
    const bySid = byDay.get(day);
    if (!bySid.has(e.sid)) bySid.set(e.sid, []);
    bySid.get(e.sid).push(e);
  }
  for (const [day, bySid] of byDay) {
    console.log(day);
    for (const [, evs] of bySid) {
      const head = evs[0];
      const repoName = head.repo ? path.basename(head.repo.replace(/^none:/, '').replace(/\/\.git$/, '')) : '?';
      console.log(`  ${head.name || head.sid}  ${repoName}${head.branch ? ` (${head.branch})` : ''}`);
      for (const e of evs) console.log(`    ${localTimeStr(e.ts)}  ${formatActivityLine(e)}`);
    }
    console.log('');
  }
}

// ---------- skills bridge ----------
//
// Claude Code reads `.claude/skills`; Codex, Gemini CLI, opencode, Cursor, Kimi and Copilot
// read `.agents/skills`; Grok Build reads `.grok/skills`. All of them follow symlinks, so one
// relative link per skill gives every harness the same catalog without moving anything —
// the real directories stay where Claude Code, the one harness that cannot be pointed
// elsewhere, wants them. Additive only: a real directory or someone else's link on the
// target side is a conflict to report, never something to overwrite.

const CLAUDE_SKILLS_DIR = path.join('.claude', 'skills');
const SKILL_TARGET_DIRS = { agents: path.join('.agents', 'skills'), grok: path.join('.grok', 'skills') };
const CLAUDE_SKILLS_RE = /(^|[\\/])\.claude[\\/]skills([\\/]|$)/;

/// Skill directories under `srcRoot`: a directory (through a symlink, if the source is
/// itself one) holding a SKILL.md. Dotfiles and loose files are not skills.
function listSkillDirs(srcRoot) {
  let names = [];
  try { names = fs.readdirSync(srcRoot); } catch { return []; }
  return names.filter((n) => {
    if (n.startsWith('.')) return false;
    try {
      return fs.statSync(path.join(srcRoot, n)).isDirectory() && fs.existsSync(path.join(srcRoot, n, 'SKILL.md'));
    } catch { return false; }
  }).sort();
}

function resolveLink(link) { return path.resolve(path.dirname(link), fs.readlinkSync(link)); }

/// What `link` would do to mirror `srcRoot` into `dstRoot`, one row per skill. Targets are
/// relative so a repo (or a home directory) can move without breaking them.
function skillLinkPlan(srcRoot, dstRoot) {
  const plan = [];
  for (const name of listSkillDirs(srcRoot)) {
    const src = path.resolve(srcRoot, name);
    const link = path.join(dstRoot, name);
    const row = { name, link, target: path.relative(path.dirname(link), src) };
    let st = null;
    try { st = fs.lstatSync(link); } catch {}
    if (!st) { plan.push({ ...row, action: 'create' }); continue; }
    if (!st.isSymbolicLink()) {
      plan.push({ ...row, action: 'conflict', detail: `${link} is a real ${st.isDirectory() ? 'directory' : 'file'}` });
      continue;
    }
    let resolved = '';
    try { resolved = resolveLink(link); } catch {}
    if (resolved === src) { plan.push({ ...row, action: 'ok' }); continue; }
    // A link of ours whose skill was renamed underneath it: safe to repoint.
    if (!fs.existsSync(link) && CLAUDE_SKILLS_RE.test(resolved)) {
      plan.push({ ...row, action: 'relink', detail: `dangling link to ${resolved}` });
      continue;
    }
    plan.push({ ...row, action: 'conflict', detail: `${link} already points at ${resolved || '?'}` });
  }
  return plan;
}

/// The inverse: only symlinks that resolve into `srcRoot` are ours to remove.
function skillUnlinkPlan(srcRoot, dstRoot) {
  let names = [];
  try { names = fs.readdirSync(dstRoot); } catch { return []; }
  const root = path.resolve(srcRoot);
  const plan = [];
  for (const name of names.sort()) {
    const link = path.join(dstRoot, name);
    let st = null;
    try { st = fs.lstatSync(link); } catch { continue; }
    if (!st.isSymbolicLink()) { plan.push({ name, link, action: 'keep', detail: 'not a symlink' }); continue; }
    let resolved = '';
    try { resolved = resolveLink(link); } catch {}
    if (resolved && boundaryPrefix(root, resolved)) plan.push({ name, link, action: 'remove' });
    else plan.push({ name, link, action: 'keep', detail: `points at ${resolved || '?'}` });
  }
  return plan;
}

function applySkillPlan(plan, opts = {}) {
  const counts = {};
  for (const row of plan) {
    counts[row.action] = (counts[row.action] || 0) + 1;
    if (opts.dryRun) continue;
    if (row.action === 'create' || row.action === 'relink') {
      fs.mkdirSync(path.dirname(row.link), { recursive: true });
      if (row.action === 'relink') fs.unlinkSync(row.link);
      fs.symlinkSync(row.target, row.link, 'dir');
    } else if (row.action === 'remove') {
      fs.unlinkSync(row.link);
    }
  }
  return counts;
}

/// `~/.codex/skills` is an undocumented legacy location; copies there of skills that also
/// live in `~/.claude/skills` are dead weight once the `~/.agents/skills` links exist.
function codexLegacySkillDuplicates(home) {
  const claude = new Set(listSkillDirs(path.join(home, CLAUDE_SKILLS_DIR)));
  return listSkillDirs(path.join(home, '.codex', 'skills')).filter((n) => claude.has(n));
}

function skillsConfig() {
  const out = { autoLink: true, targets: ['agents'] };
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile(), 'utf8')) || {};
    const s = cfg.skills || {};
    if (s.autoLink === false) out.autoLink = false;
    if (Array.isArray(s.targets) && s.targets.length) out.targets = s.targets.filter((t) => SKILL_TARGET_DIRS[t]);
  } catch {}
  return out;
}

function skillTargets(list) {
  const targets = list && list.length ? list : ['agents'];
  for (const t of targets) {
    if (!SKILL_TARGET_DIRS[t]) throw new Error(`unknown skills target "${t}" (known: ${Object.keys(SKILL_TARGET_DIRS).join(', ')})`);
  }
  return targets;
}

/// SessionStart side of the bridge: keep the repo a session just opened in sync, so a
/// Codex session started in a repo full of Claude skills sees them on its first prompt.
/// Quiet and fail-open like the hook it runs in; opt out with `skills.autoLink: false`.
function autoLinkSkills(worktree, repo) {
  if (!worktree || !repo || String(repo).startsWith('none:')) return;
  const cfg = skillsConfig();
  if (!cfg.autoLink) return;
  const src = path.join(worktree, CLAUDE_SKILLS_DIR);
  if (!fs.existsSync(src)) return;
  for (const t of cfg.targets) {
    try { applySkillPlan(skillLinkPlan(src, path.join(worktree, SKILL_TARGET_DIRS[t]))); } catch {}
  }
}

function cmdSkills(args, deps = {}) {
  const sub = args._[1] || 'status';
  if (!['status', 'link', 'unlink'].includes(sub)) throw new Error(`skills: unknown subcommand "${sub}" (status|link|unlink)`);
  const home = deps.home || os.homedir();
  const base = args.global ? home : path.resolve(gitInfo(path.resolve(args.repo || '.')).worktree);
  const src = path.join(base, CLAUDE_SKILLS_DIR);
  const targets = skillTargets(args.targets ? splitList(args.targets) : skillsConfig().targets);
  const dryRun = !!args['dry-run'];
  const plans = [];
  for (const t of targets) {
    const dir = path.join(base, SKILL_TARGET_DIRS[t]);
    const rows = sub === 'unlink' ? skillUnlinkPlan(src, dir) : skillLinkPlan(src, dir);
    const applied = sub !== 'status' && !dryRun;
    const counts = applySkillPlan(rows, { dryRun: !applied });
    plans.push({ target: t, dir, rows, counts, applied });
  }
  const legacyDuplicates = args.global ? codexLegacySkillDuplicates(home) : [];
  if (args.json) { console.log(JSON.stringify({ source: src, plans, legacyDuplicates }, null, 1)); return; }
  const short = (p) => (p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p);
  for (const p of plans) {
    const c = p.counts;
    const summary = sub === 'unlink'
      ? `${c.remove || 0} ${p.applied ? 'removed' : 'to remove'}, ${c.keep || 0} kept`
      : `${c.create || 0} ${p.applied ? 'linked' : 'to link'}, ${c.relink || 0} relinked, ${c.ok || 0} ok, ${c.conflict || 0} conflicts`;
    console.log(`${short(p.dir)}${dryRun ? ' (dry-run)' : ''}: ${summary}`);
    for (const r of p.rows) {
      if (r.action === 'ok' || r.action === 'keep') continue;
      const arrow = r.target && r.action !== 'conflict' ? ` → ${r.target}` : '';
      console.log(`  ${r.action.padEnd(8)} ${r.name}${arrow}${r.detail ? `  (${r.detail})` : ''}`);
    }
  }
  if (legacyDuplicates.length) {
    console.log(`~/.codex/skills duplicates of ~/.claude/skills (legacy location; ~/.agents/skills covers Codex now): ${legacyDuplicates.join(', ')}`);
  }
  const conflicts = plans.reduce((n, p) => n + (p.counts.conflict || 0), 0);
  if (conflicts) console.error(`skills: ${conflicts} conflict${conflicts === 1 ? '' : 's'} left untouched — resolve by hand or leave as is`);
}

// ---------- peek (the reader guard points at) ----------
//
// A denial with no alternative is just a wall, and the need behind `cat
// settings.json` is real: which MCP servers are configured, what the env block
// holds, whether a key is present at all. All of that is structure, and none
// of it is the value. peek prints the file with the values masked, so the
// question gets answered and nothing is burnt.
//
// Masks on the KEY as well as the value. A short secret and a long one look
// nothing alike, and "it was only eight characters" is not a reason to print
// a password.

const SECRET_KEY_RE = /(?:secret|token|password|passwd|^pw$|apikey|api_key|auth|bearer|credential|private|signature|session|cookie|dsn)/i;
// Values that are credentials whatever they are called. Prefixes first, then
// the shape: a long run with no spaces and no path separators.
const SECRET_VALUE_RE = /^(?:sk-|pk_live|rk_live|sntryu_|gh[pousr]_|xox[baprs]-|AIza|ya29\.|eyJ[\w-]+\.|-----BEGIN|AKIA|ASIA|glpat-|npm_|dop_v1_|shpat_)/;
const LONG_OPAQUE_RE = /^[A-Za-z0-9_\-+/=.]{20,}$/;

function looksSecretValue(value) {
  const v = String(value == null ? '' : value).trim().replace(/^["']|["'],?$/g, '');
  if (!v) return false;
  if (SECRET_VALUE_RE.test(v)) return true;
  // Paths, URLs, versions and plain numbers are long and harmless, and hiding
  // them is how a redacting reader becomes one nobody uses.
  if (/^[~./]|:\/\/|^\d+(\.\d+)*$/.test(v)) return false;
  if (/\s/.test(v)) return false;
  return LONG_OPAQUE_RE.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v);
}

function maskValue(value) {
  const raw = String(value == null ? '' : value);
  const quote = /^\s*"/.test(raw) ? '"' : '';
  const inner = raw.trim().replace(/^["']|["']$/g, '').replace(/,$/, '');
  const comma = /,\s*$/.test(raw) ? ',' : '';
  return `${quote}<redacted ${inner.length} chars>${quote}${comma}`;
}

const ASSIGN_RE = /^(\s*(?:export\s+)?["']?([\w.@-]+)["']?\s*[:=]\s*)(.*)$/;

function redactLine(line, inPem) {
  if (inPem) return { line: '  <redacted PEM body>', pem: !/-----END/.test(line) };
  if (/-----BEGIN/.test(line)) return { line, pem: !/-----END/.test(line) };
  const m = line.match(ASSIGN_RE);
  if (!m) return { line: looksSecretValue(line) ? `<redacted ${line.trim().length} chars>` : line, pem: false };
  const [, head, key, value] = m;
  if (!value.trim() || /^[[{]/.test(value.trim())) return { line, pem: false };
  if (SECRET_KEY_RE.test(key) || looksSecretValue(value)) return { line: head + maskValue(value), pem: false };
  return { line, pem: false };
}

function redactText(text) {
  let pem = false;
  return text.split('\n').map((line) => {
    const out = redactLine(line, pem);
    pem = out.pem;
    return out.line;
  }).join('\n');
}

const PEEK_MAX_LINES = 400;

function cmdPeek(args) {
  const target = args._[1];
  if (!target) throw new Error('usage: coord.js peek <file> [--keys] [--grep pattern]');
  const file = expandUser(target);
  if (!fs.existsSync(file)) throw new Error(`no such file: ${target}`);
  let lines = redactText(fs.readFileSync(file, 'utf8')).split('\n');
  if (args.keys) {
    lines = lines.map((l) => (l.match(ASSIGN_RE) || [])[2]).filter(Boolean);
  }
  if (args.grep) {
    const re = new RegExp(args.grep, 'i');
    lines = lines.filter((l) => re.test(l));
  }
  const shown = lines.slice(0, PEEK_MAX_LINES);
  console.log(shown.join('\n'));
  if (lines.length > shown.length) {
    console.log(`… ${lines.length - shown.length} more lines; narrow with --grep or --keys`);
  }
}

// ---------- dispatch ----------

const HOOK_CMDS = new Set(['register', 'inject', 'inject-codex', 'beat', 'guard', 'nudge', 'deregister']);

function main() {
  const cmd = process.argv[2];
  const nowMs = Date.now();
  if (HOOK_CMDS.has(cmd)) {
    // Hooks must never break a session: swallow everything, always exit 0.
    // No process.exit() here — it can truncate stdout still buffered in the
    // pipe to the harness; set exitCode and let node flush + exit naturally.
    try {
      const input = readStdinJson();
      // `--harness codex` is what the installer puts on every Codex hook command; the
      // `inject-codex` spelling is the pre-flag form and means the same thing.
      const harness = cmd === 'inject-codex' ? 'codex' : parseArgs(process.argv.slice(3)).harness;
      if (cmd === 'register') cmdRegister(input, nowMs, harness);
      else if (cmd === 'inject' || cmd === 'inject-codex') cmdInject(input, nowMs, harness);
      else if (cmd === 'beat') cmdBeat(input, nowMs, harness);
      else if (cmd === 'guard') cmdGuard(input, nowMs);
      else if (cmd === 'nudge') cmdStop(input, nowMs, harness);
      else cmdDeregister(input, nowMs, { live: true });
      if (['register', 'inject', 'inject-codex', 'beat'].includes(cmd)) {
        try { require('./codex-listener.js').ensureListener(input); } catch {}
      }
    } catch {}
    process.exitCode = 0;
    return;
  }
  try {
    const args = parseArgs(process.argv.slice(2));
    if (cmd === 'claim') cmdClaim(args, nowMs);
    else if (cmd === 'release') cmdRelease(args, nowMs);
    else if (cmd === 'send') cmdSend(args, nowMs);
    else if (cmd === 'who') cmdWho(nowMs, args);
    else if (cmd === 'listener') {
      const listener = require('./codex-listener.js');
      const id = args.session ? requireLiveSession(args, nowMs).sessionId : 'monitor';
      if (args._[1] === 'start' && args.session) listener.ensureListener({ session_id: id }, { manual: true });
      console.log(JSON.stringify(listener.readState(id) || { status: 'not started' }, null, 1));
    }
    else if (cmd === 'names') cmdNames(args);
    else if (cmd === 'doctor') cmdDoctor(args, nowMs);
    else if (cmd === 'sim') cmdSim(args, nowMs);
    else if (cmd === 'ledger') cmdLedger(args, nowMs);
    else if (cmd === 'handoff') cmdHandoff(args, nowMs);
    else if (cmd === 'sync') cmdSync(args, nowMs);
    else if (cmd === 'worktrees') cmdWorktrees(args, nowMs);
    else if (cmd === 'disk') cmdDisk(args, nowMs);
    else if (cmd === 'browsers') cmdBrowsers(args);
    else if (cmd === 'tasks') cmdTasks(args);
    else if (cmd === 'retro') cmdRetro(args);
    else if (cmd === 'log') cmdLog(args, nowMs);
    else if (cmd === 'skills') cmdSkills(args);
    else if (cmd === 'peek') cmdPeek(args);
    else if (cmd === 'install' || cmd === 'uninstall') {
      // The hook copies under ~/.claude/hooks ship without the installer; only the package or a
      // checkout can install.
      const installer = path.join(__dirname, 'install.js');
      if (!fs.existsSync(installer)) throw new Error(`run \`npx aircontrol ${cmd}\` (this is an installed copy without the installer)`);
      require(installer).main(process.argv.slice(2));
    }
    else {
      console.error('usage: aircontrol <install|uninstall|register|inject|inject-codex|beat|guard|deregister|claim|release|send|who|names|doctor|sim|ledger|handoff|worktrees|disk|browsers|tasks|retro|log|skills|peek> [--session id] [--intent "…"] [--paths a,b] [--resources r1,r2] [--to id|all] [--roots dir1,dir2] [--repair] [message]');
      console.error('       coord.js skills <status|link|unlink> [--repo path|--global] [--targets agents,grok] [--dry-run] [--json] — mirror .claude/skills into the dirs other harnesses read');
      console.error('       coord.js sim <list|acquire|release> [--for purpose] [--platform ios|android] [--bundle-id id] [--name pref] [--key udid|avd] [--keep-booted]');
      console.error('       coord.js ledger <add|list|show|take|note|block|unblock|done|drop> [--repo .|all|path] [--title "…"] [--points-at ref] [--status …] [--priority low|normal|high|urgent] [--depends-on id1,id2] [--mine] [--notes] — list omits notes; show <id> prints them');
      console.error('       coord.js handoff --session <me> --to <them> [--ledger-id id] [--note "context for the recipient"]');
      console.error('       machine-readable: who [--assignable] --json · ledger list --json · sim list --json');
      console.error('       coord.js peek <file> [--keys] [--grep pattern] — print a config or env file with its secrets masked');
      console.error('       coord.js sync — mirror state with configured peers (config.json machine/peers/autoSync)');
      console.error('       coord.js log [--date YYYY-MM-DD] [--days N] [--session name|id] [--repo path|.] [--json] — per-day activity history');
      process.exit(1);
    }
  } catch (e) {
    console.error(`aircontrol error: ${e.message}`);
    process.exit(1);
  }
}

module.exports = {
  renderDiskLine, diskUsage, staleDerivedData, derivedDataWorkspace, cmdDisk, DISK_DEFAULTS,
  staleSessionTmp, staleBuildRoots, staleLooseFiles, touchedSince, idleWorktrees,
  boundaryPrefix, pathsOverlap, isStale, isExpired, holdsClaims, mergeClaims, resolveIdPrefix, isSafeComponent,
  requireLiveSession,
  messageFilename, shortId, agoLabel, splitList, toolInputPaths, parseArgs, advisories,
  HARNESSES, codexHome, detectHarness, cliPathFor, harnessTag,
  SKILL_TARGET_DIRS, listSkillDirs, skillLinkPlan, skillUnlinkPlan, applySkillPlan, codexLegacySkillDuplicates,
  skillsConfig, autoLinkSkills, cmdSkills,
  renderInjection, renderMessageLines, claimSummary,
  hashId, friendlyName, saltedName, pickNameSalt, nameStyle, writeNameStyle, configFile, NAME_STYLES, DEFAULT_NAME_STYLE, MAX_NAME_SALT,
  ensureDirs, sessionFile, writeSession, readSession, updateSession, readSessions, gitInfo, gitEnv,
  sessionLockFile, trySessionLock,
  sweep, readStdinJson, readInbox, bounceUndelivered, cmdRegister, cmdBeat, cmdDeregister,
  expandUser, addGitDir, gitDirFromFile, discoverGitDirs, lockSnapshot, sameLock,
  parseLsofWritable, writableOpenState, gitProcessState, operationMarkers, inspectLock,
  doctorLogFile, doctorLocks, formatAge, cmdDoctor,
  cmdInject, cmdStop, cmdClaim, isAssignable, cmdRelease, cmdSend, cmdWho, cmdNames,
  cmdGuard, computeGuardDecision, commandText, commandOnly, deployPatterns, guardLogFile, classifyCommand, recordDenial,
  secretDumps, looksSecretValue, redactLine, redactText, cmdPeek,
  deployScopes, deployScopesOverlap, commandDeployScopes, guardDeployCheck, isDeployResource,
  leasesDir, affinityFile, leaseFile, runQuiet, prettyRuntime, parseSimctlDevices,
  listIosDevices, parseAdbSerials, androidEmulatorBin, listAndroidDevices, listDevices,
  readLeases, readLease, tryLease, releaseLease, releaseSessionLeases, shutdownLeaseDevice, shutdownAndReleaseLeases, quitSimulatorIfIdle, pruneLeases, touchLeases,
  readAffinity, writeAffinity, affinityFor, recordAffinity, clearAffinity, appInstalled,
  simDeviceRoot, installedBundleIds,
  acquireDevice, renderSimList, describeLease, cmdSim, SEED_PROBE_LIMIT,
  cmdWorktrees, selectBrowserProcs, classifyBrowserProcs, readAllProcs, liveClaudePids, browserContext, cmdBrowsers, reapOwnBrowsers, reapOrphanBrowsers,
  parseProcTable, claudeAncestor, classifyTaskProcs, descendantsOf, readTaskProcs, reapOwnTasks, cmdTasks,
  ownTasksRunning,
  rankToolResults, readTranscript, transcriptDir, newestTranscript, cmdRetro, describeToolCall, remediationHint, BROWSER_PROC_PATTERNS,
  isCodexRecord, describeCodexCall, codexOutputBytes, codexSessionsDir, findCodexRollout, resolveRetroTranscript, payloadTranscript,
  accumulateTranscriptLine, newTranscriptState, readTranscriptDelta, emptyBudget, mergePool, budgetTop,
  budgetThresholds, renderBudgetLine, sessionTranscript, humanBytes,
  BUDGET_DEFAULTS, BUDGET_TOP_N, BUDGET_POOL, BUDGET_PENDING_MAX,
  ledgerFile, readLedgerEvents, appendLedgerEvent, ledgerId, foldLedger, ledgerView,
  suggestNextLedgerItem, cmdHandoff, LEDGER_STALE_MS,
  syncConfig, repoUrlKey, gitOriginKey, remoteDir, outboxDir, readRemoteSessions,
  readRemoteLedgerEvents, readAllLedgerEvents, importRemoteMessages, quoteForRemoteShell, cmdSync, maybeAutoSync,
  compactLedger, ledgerCounts, renderLedgerLine, ledgerRepoFilter, formatLedgerItem, cmdLedger, sameRepo,
  LEDGER_MAX_LINES, LEDGER_DONE_TTL_MS, LEDGER_TITLE_MAX,
  STALE_MS, CLAIM_TTL_MS, READ_TTL_MS, UNREAD_TTL_MS, TEMP_TTL_MS, LOCK_STALE_MS, LEASE_TTL_MS,
  activityDir, localDateStr, activityFile, logActivity, readActivityFiles, readActivityEvents,
  activityRetentionDays, pruneActivity, activityBase, sessionEndEvent, matchesSessionRef,
  formatActivityLine, cmdLog,
};

if (require.main === module) main();
