#!/usr/bin/env node
// Installs aircontrol for Claude Code and Codex. The installer copies coord.js
// into both agent homes, merges lifecycle hooks without replacing unrelated
// hooks, and adds durable protocol guidance. Idempotent — safe to re-run after
// editing coord.js or switching Node versions.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
// Reused for the friendly-name style list + defaults (pure data; requiring coord.js does
// not run its CLI — the `require.main === module` guard sees install.js as the entry).
const coord = require('./coord.js');

const HOME = process.env.AIRCONTROL_HOME || os.homedir();

// Hooks run in a non-interactive /bin/sh that never sources the user's profile,
// so `node` is often absent from PATH — the command has to name an absolute
// binary. But `process.execPath` names the *exact* interpreter that ran the
// installer, which for Homebrew is a version-pinned Cellar directory
// (/opt/homebrew/Cellar/node/<version>/bin/node) and for nvm a versioned
// directory under ~/.nvm. Both vanish on the next `brew upgrade node` or nvm
// prune, and every hook then dies with "No such file or directory".
//
// Prefer a version-independent path that the package manager keeps pointing at
// the current install. Fall back to process.execPath only when no stable
// candidate is usable, so the installer still works on unusual layouts.
const MIN_NODE_MAJOR = 18; // matches package.json "engines"
const STABLE_NODE_PATHS = [
  '/opt/homebrew/bin/node', // Homebrew (Apple silicon) — symlink into Cellar
  '/usr/local/bin/node',    // Homebrew (Intel) / nodejs.org installer
  '/usr/bin/node',          // system package managers
];

function usableNode(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
  } catch {
    return false;
  }
  // A dangling symlink passes some checks but fails to exec, and an old major
  // would run coord.js under an unsupported runtime. Ask the binary itself.
  const probe = execFileSync(candidate, ['--version'], { encoding: 'utf8', timeout: 5000 });
  return Number.parseInt(probe.trim().replace(/^v/, ''), 10) >= MIN_NODE_MAJOR;
}

function resolveNode() {
  const candidates = [process.env.AIRCONTROL_NODE, ...STABLE_NODE_PATHS].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (usableNode(candidate)) return candidate;
    } catch {
      // Unreadable, not executable, or failed to run — try the next one.
    }
  }
  return process.execPath;
}

const NODE = resolveNode();
const source = path.join(__dirname, 'coord.js');
const claudeDir = path.join(HOME, '.claude');
const codexDir = path.join(HOME, '.codex');
const claudeTarget = path.join(claudeDir, 'hooks', 'coord.js');
const codexTarget = path.join(codexDir, 'hooks', 'coord.js');
const cmuxRemoteSource = path.join(__dirname, 'cmux-codex-remote.sh');
const cmuxRemoteTarget = path.join(HOME, '.local', 'bin', 'aircontrol-cmux-codex');
// Runtime coord.js reads name-style from <dataDir>/config.json; dataDir defaults to
// ~/.claude/agents. Write it under HOME so tests (AIRCONTROL_HOME) stay sandboxed.
const configPath = path.join(claudeDir, 'agents', 'config.json');
const NAME_STYLES = Object.keys(coord.NAME_STYLES);

function copyRuntime(target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  fs.copyFileSync(path.join(__dirname, 'codex-listener.js'), path.join(path.dirname(target), 'codex-listener.js'));
  fs.cpSync(path.dirname(require.resolve('ws/package.json')), path.join(path.dirname(target), 'node_modules', 'ws'), { recursive: true });
  console.log(`copied coord.js -> ${target}`);
}

const CMUX_REMOTE_START = '# >>> aircontrol cmux Codex daemon >>>';
const CMUX_REMOTE_END = '# <<< aircontrol cmux Codex daemon <<<';

function writeMarkedShellBlock(file, body) {
  let previous = '';
  try { previous = fs.readFileSync(file, 'utf8'); } catch {}
  const start = previous.indexOf(CMUX_REMOTE_START);
  const end = start < 0 ? -1 : previous.indexOf(CMUX_REMOTE_END, start);
  const without = start < 0 ? previous : `${previous.slice(0, start).trimEnd()}\n${end < 0 ? '' : previous.slice(end + CMUX_REMOTE_END.length).trimStart()}`.trimEnd();
  const next = `${without}${without ? '\n\n' : ''}${CMUX_REMOTE_START}\n${body}\n${CMUX_REMOTE_END}\n`;
  if (next !== previous) fs.writeFileSync(file, next);
}

// Editing shell profiles is only justified for someone who runs cmux. An existing block means
// an earlier install already opted in, so it keeps being refreshed.
function cmuxPresent() {
  if (process.env.AIRCONTROL_CMUX === '1') return true;
  if (process.env.AIRCONTROL_CMUX === '0') return false;
  if (fs.existsSync(cmuxRemoteTarget)) return true;
  if (path.resolve(HOME) !== os.homedir()) return false;
  if (fs.existsSync('/Applications/cmux.app')) return true;
  return (process.env.PATH || '').split(path.delimiter).some((dir) => dir && fs.existsSync(path.join(dir, 'cmux')));
}

function installCmuxRemoteLauncher() {
  if (!fs.existsSync(cmuxRemoteSource) || !cmuxPresent()) return;
  fs.mkdirSync(path.dirname(cmuxRemoteTarget), { recursive: true });
  fs.copyFileSync(cmuxRemoteSource, cmuxRemoteTarget);
  fs.chmodSync(cmuxRemoteTarget, 0o755);
  const exportLine = `export CMUX_CUSTOM_CODEX_PATH="${cmuxRemoteTarget}"`;
  // New interactive cmux terminals read .zshrc; login-style terminals read
  // .zprofile. Keep both idempotently managed.
  for (const file of [path.join(HOME, '.zshrc'), path.join(HOME, '.zprofile')]) writeMarkedShellBlock(file, exportLine);

  if (path.resolve(HOME) !== os.homedir()) return; // installer tests must not touch real cmux surfaces

  // Existing cmux surfaces retain their original environment. Their generated
  // shim is safe to patch in place and is regenerated by cmux when the surface
  // ends; future surfaces receive the export above.
  const roots = [path.join(os.tmpdir(), 'cmux-cli-shims')];
  for (const root of roots) {
    let children = [];
    try { children = fs.readdirSync(root); } catch { continue; }
    for (const child of children) {
      const shim = path.join(root, child, 'codex');
      let text;
      try { text = fs.readFileSync(shim, 'utf8'); } catch { continue; }
      if (!text.includes('cmux-codex-wrapper') || text.includes('AIRCONTROL_CMUX_REMOTE_SHIM')) continue;
      const marker = `export CMUX_CUSTOM_CODEX_PATH="${cmuxRemoteTarget}" # AIRCONTROL_CMUX_REMOTE_SHIM\n`;
      const needle = 'if [[ -x "$cmux_wrapper" ]]; then\n';
      if (!text.includes(needle)) continue;
      fs.writeFileSync(shim, text.replace(needle, marker + needle));
    }
  }
  console.log('cmux Codex: routes new sessions through the local aircontrol daemon');
}

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

// One backup per file per run: AGENTS.md is written twice in one install (protocol section,
// then the mirror block), and the second write must not replace the pre-install copy with a
// mid-install one.
const backedUp = new Set();
function backup(file) {
  if (backedUp.has(file)) return;
  backedUp.add(file);
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak-aircontrol');
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backup(file);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  console.log(`updated ${file}${fs.existsSync(file + '.bak-aircontrol') ? ` (backup at ${file}.bak-aircontrol)` : ''}`);
}

function hookCommand(target, sub, args = '') {
  return `"${NODE}" "${target}" ${sub}${args ? ` ${args}` : ''}`;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `args` rides on every command of one harness (`--harness codex`); `legacySubs` are older
// spellings of the same hook that an earlier install may have written, upgraded in place.
function ensureHook(hooks, event, sub, target, statusMessage, { matcher, timeout = 10, legacySubs = [], args = '' } = {}) {
  hooks[event] = hooks[event] || [];
  const recognized = [sub, ...legacySubs].map((candidate) => new RegExp(`coord\\.js" ${escapeRe(candidate)}(\\s|$)`));
  for (const entry of hooks[event]) {
    for (const handler of entry.hooks || []) {
      if (typeof handler.command !== 'string' || !recognized.some((re) => re.test(handler.command))) continue;
      handler.type = 'command';
      handler.command = hookCommand(target, sub, args);
      handler.timeout = timeout;
      handler.statusMessage = statusMessage;
      if (matcher) entry.matcher = matcher;
      else delete entry.matcher;
      console.log(`${event}/${sub}: updated`);
      return;
    }
  }
  const entry = {
    hooks: [{
      type: 'command',
      command: hookCommand(target, sub, args),
      timeout,
      statusMessage,
    }],
  };
  if (matcher) entry.matcher = matcher;
  hooks[event].push(entry);
  console.log(`${event}/${sub}: wired`);
}

function installClaudeHooks() {
  const settingsPath = path.join(claudeDir, 'settings.json');
  const settings = readJson(settingsPath);
  // Claude status lines and read-only hooks frequently run `git status`. Prevent those
  // background reads from taking optional index-refresh locks; write operations still
  // take Git's required locks normally.
  settings.env = settings.env || {};
  settings.env.GIT_OPTIONAL_LOCKS = '0';
  settings.hooks = settings.hooks || {};
  ensureHook(settings.hooks, 'SessionStart', 'register', claudeTarget, 'aircontrol: registering session');
  ensureHook(settings.hooks, 'UserPromptSubmit', 'inject', claudeTarget, 'aircontrol: reading the room');
  ensureHook(settings.hooks, 'PostToolUse', 'beat', claudeTarget, 'aircontrol: heartbeat', { matcher: 'Edit|Write|NotebookEdit|Bash' });
  // The enforcement hook: denies edits on paths claimed by another live session
  // and Bash commands that grab a leased/claimed resource. Silence = no opinion.
  ensureHook(settings.hooks, 'PreToolUse', 'guard', claudeTarget, 'aircontrol: checking claims', { matcher: 'Edit|Write|NotebookEdit|Bash' });
  // Push delivery: `inject` only fires on a human prompt, so a message to a busy
  // session waited on its operator. Stop fires at end of turn, so the nudge lands
  // without anyone typing.
  ensureHook(settings.hooks, 'Stop', 'nudge', claudeTarget, 'aircontrol: delivering messages');
  ensureHook(settings.hooks, 'SessionEnd', 'deregister', claudeTarget, 'aircontrol: signing off');
  writeJson(settingsPath, settings);
}

function installCodexHooks() {
  const hooksPath = path.join(codexDir, 'hooks.json');
  const config = readJson(hooksPath);
  if (!config.description) config.description = 'Machine-local AirControl coordination for Claude Code and Codex.';
  config.hooks = config.hooks || {};
  // Codex exposes no session-id or harness env var to hooks, so every command says which
  // harness it serves; coord.js then tags the session and names the right coord.js copy.
  const codex = { args: '--harness codex' };
  ensureHook(config.hooks, 'SessionStart', 'register', codexTarget, 'aircontrol: registering session', codex);
  ensureHook(config.hooks, 'UserPromptSubmit', 'inject', codexTarget, 'aircontrol: reading the room', { ...codex, legacySubs: ['inject-codex'] });
  // Codex's tool names are loosely documented and drift (a missing `exec` once
  // silently killed heartbeats mid-build). Match everything; beat no-ops cheaply
  // on tools it doesn't care about. Claude keeps its enumerated matcher — those
  // names are a stable, documented public API.
  ensureHook(config.hooks, 'PostToolUse', 'beat', codexTarget, 'aircontrol: heartbeat', { ...codex, matcher: '*' });
  // Same deny protocol as Claude (`hookSpecificOutput.permissionDecision`), verified live.
  // Being a *blocking* hook, it needs a fresh `/hooks` trust review in Codex.
  ensureHook(config.hooks, 'PreToolUse', 'guard', codexTarget, 'aircontrol: checking claims', { ...codex, matcher: '*' });
  // Codex's Stop hook honours `decision: block` exactly like Claude's, so push delivery
  // works on both. Also blocking, also needs the trust review.
  ensureHook(config.hooks, 'Stop', 'nudge', codexTarget, 'aircontrol: delivering messages', codex);
  ensureHook(config.hooks, 'SessionEnd', 'deregister', codexTarget, 'aircontrol: signing off', { ...codex, timeout: 15 });
  writeJson(hooksPath, config);
}

// --- Codex config.toml ---
//
// Two keys, upserted at line level with no TOML library. `project_doc_fallback_filenames`
// makes Codex read a repo's CLAUDE.md wherever no AGENTS.md sits beside it; the
// `shell_environment_policy.set` entry gives Codex's shell the same GIT_OPTIONAL_LOCKS=0
// Claude Code's environment gets. The TOML trap: a top-level key appended at the end of the
// file lands inside whatever `[table]` came last, so it goes before the first header.

function upsertTomlTopLevelArray(text, key, value) {
  const lines = text.split('\n');
  const keyRe = new RegExp(`^\\s*${escapeRe(key)}\\s*=`);
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const limit = firstTable < 0 ? lines.length : firstTable;
  const idx = lines.findIndex((l) => keyRe.test(l));
  if (idx >= limit) return { text, changed: false, note: `${key} is set inside a table; left alone` };
  if (idx >= 0) {
    const line = lines[idx];
    const open = line.indexOf('[');
    const close = line.lastIndexOf(']');
    if (open < 0 || close < open) return { text, changed: false, note: `${key} is a multi-line array; add "${value}" by hand` };
    const items = [...line.slice(open + 1, close).matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => (m[1] !== undefined ? m[1] : m[2]));
    if (items.includes(value)) return { text, changed: false };
    lines[idx] = `${line.slice(0, open)}[${[...items, value].map((v) => JSON.stringify(v)).join(', ')}]${line.slice(close + 1)}`;
    return { text: lines.join('\n'), changed: true };
  }
  const entry = `${key} = [${JSON.stringify(value)}]`;
  if (firstTable < 0) {
    const base = text.trimEnd();
    return { text: `${base ? `${base}\n` : ''}${entry}\n`, changed: true };
  }
  lines.splice(firstTable, 0, entry, '');
  return { text: lines.join('\n'), changed: true };
}

function upsertTomlTableKey(text, table, key, valueLiteral) {
  const lines = text.split('\n');
  const segments = table.replace(/^\[|\]$/g, '').split('.');
  const parent = segments[0];
  const child = segments.slice(1).join('.');
  // `[parent]` with `child = { … }` inline: defining the same table twice is a TOML error.
  const parentIdx = lines.findIndex((l) => l.trim() === `[${parent}]`);
  if (parentIdx >= 0 && child) {
    for (let i = parentIdx + 1; i < lines.length && !/^\s*\[/.test(lines[i]); i++) {
      if (new RegExp(`^\\s*${escapeRe(child)}\\s*=`).test(lines[i])) {
        return { text, changed: false, note: `${parent}.${child} is an inline table; add ${key} = ${valueLiteral} to it by hand` };
      }
    }
  }
  const entry = `${key} = ${valueLiteral}`;
  const tableIdx = lines.findIndex((l) => l.trim() === table);
  if (tableIdx < 0) {
    const base = text.trimEnd();
    return { text: `${base ? `${base}\n\n` : ''}${table}\n${entry}\n`, changed: true };
  }
  let end = tableIdx + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  const keyRe = new RegExp(`^\\s*${escapeRe(key)}\\s*=`);
  for (let i = tableIdx + 1; i < end; i++) {
    if (!keyRe.test(lines[i])) continue;
    const current = lines[i].slice(lines[i].indexOf('=') + 1).trim();
    if (current === valueLiteral) return { text, changed: false };
    return { text, changed: false, note: `${key} already set to ${current} under ${table}; left alone` };
  }
  let insertAt = end;
  while (insertAt > tableIdx + 1 && lines[insertAt - 1].trim() === '') insertAt--;
  lines.splice(insertAt, 0, entry);
  return { text: lines.join('\n'), changed: true };
}

function ensureCodexConfigToml() {
  const file = path.join(codexDir, 'config.toml');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  const notes = [];
  let changed = false;
  for (const step of [
    (t) => upsertTomlTopLevelArray(t, 'project_doc_fallback_filenames', 'CLAUDE.md'),
    (t) => upsertTomlTableKey(t, '[shell_environment_policy.set]', 'GIT_OPTIONAL_LOCKS', '"0"'),
  ]) {
    const r = step(text);
    if (r.note) notes.push(r.note);
    if (r.changed) { text = r.text; changed = true; }
  }
  if (changed) {
    fs.mkdirSync(codexDir, { recursive: true });
    backup(file);
    fs.writeFileSync(file, text);
    console.log(`updated ${file} (project_doc_fallback_filenames, shell_environment_policy.set)`);
  } else {
    console.log('config.toml: Codex settings already in place');
  }
  for (const n of notes) console.warn(`warning: config.toml: ${n}`);
}

// --- global CLAUDE.md → AGENTS.md mirror ---
//
// Codex reads ~/.codex/AGENTS.md and has no @import, so the global rules a user keeps in
// ~/.claude/CLAUDE.md never reach it. Mirror them into a marked block. Markers rather than
// a heading-delimited section: the mirrored body contains `## ` headings of its own, which
// the heading scanner would mistake for the end of the section. The block sits *before*
// the protocol heading so the protocol upsert's next-heading scan can never cut into it.

const MIRROR_START = '<!-- aircontrol:mirror-start -->';
const MIRROR_END = '<!-- aircontrol:mirror-end -->';

function withoutMarkedBlock(markdown) {
  const s = markdown.indexOf(MIRROR_START);
  if (s < 0) return markdown;
  const e = markdown.indexOf(MIRROR_END, s);
  const end = e < 0 ? markdown.length : e + MIRROR_END.length;
  const rest = `${markdown.slice(0, s).trimEnd()}\n\n${markdown.slice(end).trimStart()}`.trim();
  return rest ? `${rest}\n` : '';
}

function withMarkedBlock(markdown, body, beforeHeading) {
  const stripped = withoutMarkedBlock(markdown);
  const block = `${MIRROR_START}\n${body.trim()}\n${MIRROR_END}`;
  const at = beforeHeading ? stripped.indexOf(beforeHeading) : -1;
  const parts = at >= 0
    ? [stripped.slice(0, at).trimEnd(), block, stripped.slice(at).trimEnd()]
    : [stripped.trimEnd(), block];
  return `${parts.filter(Boolean).join('\n\n')}\n`;
}

function mirrorGlobalClaudeMd(enabled) {
  const agentsPath = path.join(codexDir, 'AGENTS.md');
  let agents = '';
  try { agents = fs.readFileSync(agentsPath, 'utf8'); } catch {}
  let body = '';
  if (enabled) {
    let claude = '';
    try { claude = fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8'); } catch {}
    // AGENTS.md carries the protocol in its own Codex flavour; the Claude one would duplicate it.
    for (const h of ['## Parallel coding-agent sessions (aircontrol)', '## Parallel Claude sessions (aircontrol)']) claude = withoutMarkdownSection(claude, h);
    body = claude.split('~/.claude/hooks/coord.js').join('~/.codex/hooks/coord.js').trim();
  }
  const next = body
    ? withMarkedBlock(agents, `<!-- Mirrored from ~/.claude/CLAUDE.md by aircontrol install.js. Edit the source and re-run the aircontrol installer; --no-mirror-global turns this off. -->\n\n${body}`, '## Cross-agent coordination (aircontrol)')
    : withoutMarkedBlock(agents);
  if (next === agents) { console.log(`AGENTS.md: global mirror ${body ? 'up to date' : 'off'}`); return; }
  fs.mkdirSync(path.dirname(agentsPath), { recursive: true });
  backup(agentsPath);
  fs.writeFileSync(agentsPath, next);
  console.log(`AGENTS.md: global CLAUDE.md ${body ? 'mirrored' : 'mirror removed'}`);
}

// --- aircontrol's own skills: <repo>/skills → ~/.claude/skills ---
function sameTree(a, b) {
  const sa = fs.lstatSync(a);
  const sb = fs.lstatSync(b);
  if (sa.isDirectory() !== sb.isDirectory()) return false;
  if (!sa.isDirectory()) return sa.isFile() && sb.isFile() && fs.readFileSync(a).equals(fs.readFileSync(b));
  const na = fs.readdirSync(a).sort();
  const nb = fs.readdirSync(b).sort();
  return na.length === nb.length && na.every((n, i) => n === nb[i] && sameTree(path.join(a, n), path.join(b, n)));
}

// From a git checkout the skills are linked, so an in-place edit (skill-creator,
// writing-skills) lands in the repo and shows up in git instead of drifting from it. From a
// published package they are copied: `npx` runs out of a cache that npm may clear at any
// time, and a link into it would dangle. A real directory in the way is the pre-repo copy:
// identical ones are replaced, differing ones are moved aside, not deleted. Link targets are
// absolute: HOME and the repo need not share a root, and a relative link climbs out wrong
// when either path runs through a symlinked directory (/var -> /private/var).
const MANAGED_MARKER = '.aircontrol-managed';
const isCheckout = (dir = __dirname) => fs.existsSync(path.join(dir, '.git'));

function moveAside(link, name, backupRoot) {
  fs.mkdirSync(backupRoot, { recursive: true });
  const backupDir = path.join(backupRoot, name);
  fs.rmSync(backupDir, { recursive: true, force: true });
  fs.renameSync(link, backupDir);
  console.warn(`skills: ${link} differed from the aircontrol copy; moved to ${backupDir}`);
}

function installRepoSkills(srcRoot = path.join(__dirname, 'skills'), dstRoot = path.join(claudeDir, 'skills'),
  backupRoot = path.join(claudeDir, 'skills-backup-aircontrol'), { copy = !isCheckout() } = {}) {
  if (copy) return copyRepoSkills(srcRoot, dstRoot, backupRoot);
  const plan = coord.skillLinkPlan(srcRoot, dstRoot).map((planned) => {
    const row = { ...planned, target: path.resolve(srcRoot, planned.name) };
    if (row.action !== 'conflict' || fs.lstatSync(row.link).isSymbolicLink()) return row;
    if (fs.existsSync(path.join(row.link, MANAGED_MARKER)) || sameTree(path.join(srcRoot, row.name), row.link)) {
      fs.rmSync(row.link, { recursive: true });
    } else {
      moveAside(row.link, row.name, backupRoot);
    }
    return { ...row, action: 'create' };
  });
  for (const row of plan) {
    if (row.action === 'conflict') console.warn(`skills: left ${row.name} alone (${row.detail})`);
  }
  return coord.applySkillPlan(plan);
}

function copyRepoSkills(srcRoot, dstRoot, backupRoot) {
  const counts = {};
  const bump = (action) => { counts[action] = (counts[action] || 0) + 1; };
  for (const name of fs.readdirSync(srcRoot).sort()) {
    const src = path.join(srcRoot, name);
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) continue;
    const dst = path.join(dstRoot, name);
    let st = null;
    try { st = fs.lstatSync(dst); } catch {}
    if (st && st.isSymbolicLink()) {
      if (fs.existsSync(dst)) { console.warn(`skills: left ${name} alone (${dst} is a link)`); bump('conflict'); continue; }
      fs.unlinkSync(dst);
    } else if (st && !fs.existsSync(path.join(dst, MANAGED_MARKER))) {
      if (sameTree(src, dst)) fs.rmSync(dst, { recursive: true });
      else moveAside(dst, name, backupRoot);
    } else if (st) {
      fs.rmSync(dst, { recursive: true });
    }
    fs.mkdirSync(dstRoot, { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
    fs.writeFileSync(path.join(dst, MANAGED_MARKER), 'Installed by aircontrol; replaced on the next install.\n');
    bump('copy');
  }
  return counts;
}

// --- user-level skills → ~/.agents/skills ---
function linkGlobalSkills() {
  try { coord.cmdSkills({ _: ['skills', 'link'], global: true }, { home: HOME }); }
  catch (e) { console.warn(`warning: skills link --global failed: ${e.message}`); }
}

function withoutMarkdownSection(markdown, heading) {
  const start = markdown.indexOf(heading);
  if (start < 0) return markdown;
  const nextHeading = markdown.indexOf('\n## ', start + heading.length);
  const before = markdown.slice(0, start).trimEnd();
  const after = nextHeading >= 0 ? markdown.slice(nextHeading + 1).trimStart() : '';
  return [before, after].filter(Boolean).join('\n\n');
}

function upsertMarkdownSection(file, heading, body, legacyHeadings = []) {
  let markdown = '';
  try { markdown = fs.readFileSync(file, 'utf8'); } catch {}
  for (const legacy of legacyHeadings) markdown = withoutMarkdownSection(markdown, legacy);
  const section = `${heading}\n\n${body.trim()}`;
  const start = markdown.indexOf(heading);
  if (start >= 0) {
    const nextHeading = markdown.indexOf('\n## ', start + heading.length);
    const before = markdown.slice(0, start).trimEnd();
    const after = nextHeading >= 0 ? markdown.slice(nextHeading + 1).trimStart() : '';
    // trimEnd before the final newline, not after: `after` keeps the trailing
    // newline the previous write left on it, so joining and appending another
    // grew the file by one blank line on every single install.
    markdown = [before, section, after].filter(Boolean).join('\n\n').trimEnd() + '\n';
    console.log(`${path.basename(file)}: protocol updated`);
  } else {
    markdown = [markdown.trimEnd(), section].filter(Boolean).join('\n\n').trimEnd() + '\n';
    console.log(`${path.basename(file)}: protocol appended`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backup(file);
  fs.writeFileSync(file, markdown);
}

function protocol(cliPath, guidanceName) {
  // Both harnesses run the Stop hook now, so both get the end-of-turn promise. Only Claude
  // Code has the native peer-messaging tools, so that paragraph stays Claude-only.
  const delivery = guidanceName === 'Claude Code'
    ? `- **Inbound messages reach you at the end of your turn**, with nobody typing: a Stop hook
  delivers them and hands you back control to act. Answer the ones that need an answer before
  you finish. For a **live Claude Code peer**, prefer the built-in \`ListAgents\` + \`SendMessage\`
  tools — delivery there is immediate and mid-turn. Match a peer to its roster line by worktree
  and branch, not by name: the two registries name sessions differently, and a session idle for
  30+ minutes drops off the roster while still being reachable natively. Use
  \`node ${cliPath} send\` for Codex peers and for anything that must survive the recipient
  being offline.`
    : `- **Inbound messages reach you at the end of your turn**, with nobody typing: a Stop hook
  delivers them and hands you back control to act. Answer the ones that need an answer before
  you finish, with \`node ${cliPath} send\`; it reaches Claude Code and Codex peers alike and
  survives the recipient being offline. Codex also starts a background inbox listener at
  registration, sets your thread title, and wakes idle sessions through the native queue.
  Check \`node ${cliPath} listener --session <your-name>\`: \`listening\` confirms the
  connection; \`retrying\` means messages still await the daemon or normal prompt/Stop hooks.`;
  return `
Every prompt receives an \`[aircontrol]\` context block with your session name, other live
Claude Code and Codex sessions on the machine, messages, and conflict advisories. Sessions
show as friendly names (e.g. \`captain-snugglepants\`); \`--session\`/\`--to\` accept a name or a
session-id prefix.

- **At the start of any task that may edit files or use shared resources**, declare
  intent and claim only the paths/resources that apply:
  \`node ${cliPath} claim --session <your-name> --intent "<what you're doing>" --paths <dirs,you,will,touch> --resources sim:<name>,deploy:<target>,stash\`
- **Claim the deploy target, not bare \`deploy\`.** \`deploy:asc\`, \`deploy:firebase\`,
  \`deploy:cloudflare\`, \`deploy:play\` — two sessions shipping to different systems then
  never wait on each other. Bare \`deploy\` still means every target and collides with all
  of them, so reach for it only when the lane's destination is genuinely unknown.
- **Before** editing near another claim, using a simulator, deploying, stashing, or
  merging, check the roster block.
- **⚠️ Advisories are stop-and-coordinate signals.** Message the other session and wait
  a turn instead of pushing through:
  \`node ${cliPath} send --session <your-name> --to <their-name> "text"\`
- **Some conflicts are enforced, not advisory.** A PreToolUse guard DENIES edits on paths
  claimed by another live session, simulator/emulator boots without your own lease, and
  \`git stash\` / deploy commands without the matching resource claim. A denial names who
  holds the conflict and what to run: read the reason, message/claim/wait as it says,
  then retry the tool call. Do not try to route around a denial.
${delivery}
- **When the task is complete**, release its claims:
  \`node ${cliPath} release --session <your-name>\`
- If the roster block is missing, run \`node ${cliPath} who\` and do not assume the room
  is empty. For ${guidanceName}, review and trust the installed hooks before shared-resource work.
- **Never boot a simulator or emulator without leasing it first** — a lease is enforced,
  unlike a claim: \`node ${cliPath} sim acquire --session <your-name> --for "<what you're testing>"\`.
  It returns a **UDID** (a name-based \`-destination\` silently runs zero tests) and prefers the
  device that already has that app's data installed. \`sim list\` shows who holds what.
- **Release the device when you are done with it, not at some later cleanup** —
  \`node ${cliPath} sim release --session <your-name>\` shuts it down and hands it back in one
  step (\`--keep-booted\` opts out for a handoff). A real session end does the same for anything
  you still hold, but a lease you dropped earlier is past its reach: a device released while it is
  still booted is an orphan nothing else knows to stop.
- **When you start fresh in a repo**, the once-per-session \`ledger:\` line tells you whether
  unfinished work is waiting. \`node ${cliPath} ledger list --repo .\` to see it, \`ledger take <id>\`
  before working on it. Items abandoned by a dead session are yours to pick up. Log deferred work
  with \`ledger add --title "…" --points-at <spec|plan|PR|memory>\` rather than leaving it in a
  file nobody will find.
- **A shared working tree means a shared file is not yours to \`git add\`.** When another live
  session has uncommitted edits in a file you also changed, \`git add <file>\` stages their
  half-finished work into your commit, and \`git diff HEAD -- <file>\` carries it into any
  verification worktree built from that diff -- which then fails on their change, not yours.
  \`git add -p\` is interactive and unavailable here, and \`git stash\` is a claimed resource that
  takes their work with it. Rebuild your own hunks on a fresh copy instead: patch
  \`git show HEAD:<file>\`, then \`git hash-object -w\` it and
  \`git update-index --cacheinfo 100644,<blob>,<file>\` to stage only your version. Their
  working-tree edits survive untouched.
- **In a shared tree, HEAD is shared too.** \`git commit\` lands on whatever branch the last
  session checked out, so another session's work can arrive on your branch without either of
  you doing anything wrong. Run \`git branch --show-current\` before committing, and announce a
  branch switch to the room before and after. Undoing a merge with \`git reset --hard\` strands
  everything reachable only through the ref you move, not only what you noticed: check
  \`git log <target>..<current>\` first for what the move would lose, and
  \`git branch --contains <sha>\` after for each stranded commit. An orphaned one returns empty
  and survives only in the reflog until it is collected.
- **Before editing an existing surface, \`git fetch\` and diff the target files against
  \`origin/<default>\`.** Uncommitted local copies may be superseded by merged work; build on the
  remote version, not the stale one.
- **A \`context:\` line in the block means this session's tool results are getting expensive.**
  It names the costliest one, scored the way \`retro\` scores it (\`bytes x turns re-sent\`) but live
  rather than post-mortem. Two things actually move that number: bound an image result the way
  *Big tool results* says, and hand a broad fan-out search to an Explore subagent so only its
  conclusion lands in this context. Bounded edits stay inline — delegating those costs more
  than doing them.
- **A \`disk:\` line means the volume is running out of space.** Act on it now: at 0 bytes free
  no tool can run, including the one that frees space. Run \`node ${cliPath} disk --prune\` first, which
  removes only build output and tmp dirs nothing owns any more (DerivedData of deleted worktrees,
  ended sessions' /tmp dirs, idle /tmp builds). Tell the operator what it reclaimed,
  and ask before deleting anything else (simulators, caches, runtimes, and any `idle worktree`
  it lists, which it reports but never removes).
- **When a turn that did real work ends with nothing pending, the Stop hook offers
  the \`next-steps\` skill.** Pass the offer on in one line and finish the turn; do not
  invoke the skill or start planning off the back of it, because the offer is for the
  operator to accept, not an instruction to act. It stays quiet after pure conversation
  and while messages are waiting, and re-arms only once further work has happened.
- **At the end of a session, use the \`session-cleanup\` skill — never \`/clean_gone\`.** That command
  runs \`git worktree remove --force\` over every \`[gone]\` branch with no check for who is using it,
  so it silently discards another live session's uncommitted work. \`session-cleanup\` skips claimed
  and dirty worktrees, reaps only this session's browser processes
  (\`node ${cliPath} browsers --kill-mine\`), and runs \`node ${cliPath} retro\` first to measure where
  the session's tokens actually went.
- If Git reports a stale \`.git/index.lock\`, diagnose first with
  \`node ${cliPath} doctor --roots <project-root>\`. Repair is explicit
  (add \`--repair\`) and only removes old, zero-byte, unchanged locks when no Git
  operation, writable handle, or Git process is active.
- Never edit the installed hook copy directly: the next install overwrites it. Update with
  \`npx aircontrol@latest install\`, or edit a clone of the repository and run \`node install.js\`.
`;
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')) || {}; } catch { return {}; }
}

function writeConfig(patch) {
  const cfg = { ...readConfig(), ...patch };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 1) + '\n');
  if (patch.nameStyle) console.log(`session name style: ${patch.nameStyle} (change later: node ~/.claude/hooks/coord.js names <${NAME_STYLES.join('|')}>)`);
}

// Read one line synchronously, no dependencies. Only called when stdin is a TTY. Reads
// from a freshly opened /dev/tty rather than fd 0: Node puts inherited stdin in
// non-blocking mode, so fs.readSync(0, …) throws EAGAIN instead of waiting for the user.
// A fresh tty fd is blocking. EAGAIN is retried defensively; any hard error degrades to
// '' so the caller falls back to the default style.
function readLine() {
  let fd = 0;
  let opened = false;
  try { fd = fs.openSync('/dev/tty', 'rs'); opened = true; } catch { fd = 0; }
  const buf = Buffer.alloc(1);
  let out = '';
  try {
    for (;;) {
      let n;
      try {
        n = fs.readSync(fd, buf, 0, 1, null);
      } catch (e) {
        if (e.code === 'EAGAIN') continue; // non-blocking fd with no data yet: spin
        if (e.code === 'EOF') break;
        throw e;
      }
      if (n === 0) break;
      const ch = buf.toString('utf8', 0, 1);
      if (ch === '\n') break;
      if (ch !== '\r') out += ch;
    }
  } catch { return ''; } finally {
    if (opened) { try { fs.closeSync(fd); } catch {} }
  }
  return out.trim();
}

function promptStyle() {
  process.stdout.write(
    `Session name style?  ${NAME_STYLES.map((s, i) => `${i + 1}) ${s}`).join('   ')}  [${coord.DEFAULT_NAME_STYLE}]: `);
  const answer = readLine().toLowerCase();
  if (!answer) return coord.DEFAULT_NAME_STYLE;
  const byNumber = NAME_STYLES[parseInt(answer, 10) - 1];
  if (byNumber) return byNumber;
  if (NAME_STYLES.includes(answer)) return answer;
  console.log(`  unrecognized — using ${coord.DEFAULT_NAME_STYLE}`);
  return coord.DEFAULT_NAME_STYLE;
}

// Precedence: --names flag > AIRCONTROL_NAME_STYLE env > existing config > TTY prompt >
// default. Non-interactive runs (tests, CI, pipes) never block: they keep the existing
// choice or fall back to the default. Re-running is idempotent unless a flag/env overrides.
function resolveNameStyle() {
  const args = coord.parseArgs(process.argv.slice(2));
  const flag = args.names && String(args.names).toLowerCase();
  const env = process.env.AIRCONTROL_NAME_STYLE && String(process.env.AIRCONTROL_NAME_STYLE).toLowerCase();
  const existing = readConfig().nameStyle;
  if (flag) {
    if (NAME_STYLES.includes(flag)) return flag;
    console.warn(`warning: unknown --names "${args.names}" (options: ${NAME_STYLES.join(', ')}); ignoring`);
  }
  if (env && NAME_STYLES.includes(env)) return env;
  if (existing && NAME_STYLES.includes(existing)) return existing;
  if (process.stdin.isTTY) return promptStyle();
  return coord.DEFAULT_NAME_STYLE;
}

// Guarded like coord.js: requiring this file must not install. Without it,
// `require('./install.js')` runs the whole installer as a side effect — copying
// runtime files and rewriting settings.json and CLAUDE.md — which is a trap for
// anything that pulls it in to reach a helper, including a syntax check.
const USAGE = `aircontrol installer

  npx aircontrol install [--names goofy|animal|real] [--no-mirror-global] [--codex-daemon]
  npx aircontrol uninstall [--purge]
  (from a clone: node install.js [install|uninstall] ...)

Copies coord.js into ~/.claude/hooks and ~/.codex/hooks, merges the lifecycle and
guard hooks into both harnesses' settings, points Codex at CLAUDE.md files and
GIT_OPTIONAL_LOCKS=0 via ~/.codex/config.toml, links ~/.claude/skills into
~/.agents/skills for the harnesses that read it, and adds the coordination protocol to
~/.claude/CLAUDE.md and ~/.codex/AGENTS.md (with ~/.claude/CLAUDE.md mirrored into the
latter). Idempotent; makes .bak-aircontrol backups.

  --names <style>       Session name style; skips the interactive prompt.
  --codex-daemon        Install and start Codex's durable local daemon for live names
                        and idle-session message delivery (no remote control).
  --no-mirror-global    Stop mirroring ~/.claude/CLAUDE.md into ~/.codex/AGENTS.md
                        (remembered in config.json; removes the existing mirror block).
  --purge               With uninstall: also delete ~/.claude/agents (roster, messages,
                        ledger). Kept by default.
  --help, -h            Print this and install nothing.
`;

const KNOWN_FLAGS = new Set(['--names', '--no-mirror-global', '--codex-daemon']);

function codexLaunchAgent(binary) {
  const xml = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.aircontrol.codex-daemon</string>
<key>ProgramArguments</key><array><string>${xml(resolveNode())}</string><string>${xml(path.join(codexDir, 'hooks', 'codex-listener.js'))}</string><string>--monitor</string><string>--binary</string><string>${xml(binary)}</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>\n`;
}

function installCodexDaemon() {
  if (process.env.AIRCONTROL_HOME && path.resolve(HOME) !== os.homedir()) throw new Error('--codex-daemon requires the real user home');
  const binary = path.join(HOME, '.codex', 'packages', 'standalone', 'current', 'codex');
  if (!fs.existsSync(binary)) throw new Error('Install official standalone Codex first: https://chatgpt.com/codex/install.sh');
  execFileSync(binary, ['app-server', 'daemon', 'bootstrap'], { stdio: 'inherit', timeout: 30000 });
  execFileSync(binary, ['app-server', 'daemon', 'start'], { stdio: 'inherit', timeout: 30000 });
  // macOS Codex uses a detached PID backend, not launchd. Its bootstrap alone
  // does not survive reboot or restart a crashed daemon. A user LaunchAgent
  // runs the monitor, which starts/reconnects to the native daemon and discovers
  // empty threads before Codex lazily runs its first SessionStart hook.
  if (process.platform === 'darwin') {
    const file = path.join(HOME, 'Library', 'LaunchAgents', 'com.aircontrol.codex-daemon.plist');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const content = codexLaunchAgent(binary);
    const changed = !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content;
    fs.writeFileSync(file, content);
    const service = `gui/${process.getuid()}/com.aircontrol.codex-daemon`;
    let loaded = false;
    try { execFileSync('launchctl', ['print', service], { stdio: 'ignore', timeout: 5000 }); loaded = true; } catch {}
    if (loaded && changed) { execFileSync('launchctl', ['bootout', service], { stdio: 'inherit', timeout: 10000 }); loaded = false; }
    if (!loaded) execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, file], { stdio: 'inherit', timeout: 10000 });
    console.log('Codex monitor: login startup, daemon recovery, and pre-prompt registration installed');
  }
}

const HOOK_SUBS = ['register', 'inject', 'inject-codex', 'beat', 'guard', 'nudge', 'deregister'];
const OURS_RE = new RegExp(`coord\\.js" (${HOOK_SUBS.map(escapeRe).join('|')})(\\s|$)`);

function withoutAircontrolHooks(hooks = {}) {
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    hooks[event] = (hooks[event] || []).map((entry) => {
      const kept = (entry.hooks || []).filter((h) => !(typeof h.command === 'string' && OURS_RE.test(h.command)));
      removed += (entry.hooks || []).length - kept.length;
      return { ...entry, hooks: kept };
    }).filter((entry) => entry.hooks.length);
    if (!hooks[event].length) delete hooks[event];
  }
  return removed;
}

function uninstallHooks(file) {
  if (!fs.existsSync(file)) return;
  const config = readJson(file);
  if (!withoutAircontrolHooks(config.hooks)) return;
  if (config.hooks && !Object.keys(config.hooks).length) delete config.hooks;
  writeJson(file, config);
}

function removeRuntime(target) {
  const dir = path.dirname(target);
  for (const f of [target, path.join(dir, 'codex-listener.js')]) fs.rmSync(f, { force: true });
  fs.rmSync(path.join(dir, 'node_modules', 'ws'), { recursive: true, force: true });
  try { fs.rmdirSync(path.join(dir, 'node_modules')); } catch {}
}

function removeMarkdown(file, transform) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  const next = transform(text);
  if (next === text) return;
  backup(file);
  fs.writeFileSync(file, next.trim() ? `${next.trimEnd()}\n` : '');
  console.log(`${path.basename(file)}: aircontrol sections removed`);
}

// Only skills aircontrol put there go: its managed copies, and links whose skill sits in an
// aircontrol checkout (a `coord.js` two levels up) or that no longer resolve at all.
function removeSkills(names, dstRoot = path.join(claudeDir, 'skills')) {
  for (const name of names) {
    const dst = path.join(dstRoot, name);
    let st = null;
    try { st = fs.lstatSync(dst); } catch { continue; }
    let ours = false;
    if (st.isSymbolicLink()) {
      let resolved = '';
      try { resolved = fs.realpathSync(dst); } catch {}
      ours = !resolved || fs.existsSync(path.join(resolved, '..', '..', 'coord.js'));
    } else {
      ours = fs.existsSync(path.join(dst, MANAGED_MARKER));
    }
    if (!ours) { console.warn(`skills: left ${dst} alone (not installed by aircontrol)`); continue; }
    fs.rmSync(dst, { recursive: true, force: true });
    const agentsLink = path.join(HOME, '.agents', 'skills', name);
    try { if (fs.lstatSync(agentsLink).isSymbolicLink() && !fs.existsSync(agentsLink)) fs.unlinkSync(agentsLink); } catch {}
    console.log(`skills: removed ${name}`);
  }
}

function uninstallCmux() {
  fs.rmSync(cmuxRemoteTarget, { force: true });
  for (const file of [path.join(HOME, '.zshrc'), path.join(HOME, '.zprofile')]) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const start = text.indexOf(CMUX_REMOTE_START);
    const end = start < 0 ? -1 : text.indexOf(CMUX_REMOTE_END, start);
    if (end < 0) continue;
    const next = `${text.slice(0, start).trimEnd()}\n${text.slice(end + CMUX_REMOTE_END.length).trimStart()}`.trimStart();
    fs.writeFileSync(file, next.trim() ? next : '');
  }
}

function uninstallCodexDaemon() {
  if (path.resolve(HOME) !== os.homedir() || process.platform !== 'darwin') return;
  const file = path.join(HOME, 'Library', 'LaunchAgents', 'com.aircontrol.codex-daemon.plist');
  if (!fs.existsSync(file)) return;
  try { execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/com.aircontrol.codex-daemon`], { stdio: 'ignore', timeout: 10000 }); } catch {}
  fs.rmSync(file, { force: true });
  console.log('Codex monitor: LaunchAgent removed');
}

function uninstall(argv) {
  uninstallHooks(path.join(claudeDir, 'settings.json'));
  uninstallHooks(path.join(codexDir, 'hooks.json'));
  removeRuntime(claudeTarget);
  removeRuntime(codexTarget);
  const skillNames = fs.readdirSync(path.join(__dirname, 'skills')).filter((n) => fs.existsSync(path.join(__dirname, 'skills', n, 'SKILL.md')));
  removeSkills(skillNames);
  removeMarkdown(path.join(claudeDir, 'CLAUDE.md'), (t) =>
    ['## Parallel coding-agent sessions (aircontrol)', '## Parallel Claude sessions (aircontrol)'].reduce(withoutMarkdownSection, t));
  removeMarkdown(path.join(codexDir, 'AGENTS.md'), (t) =>
    withoutMarkedBlock(withoutMarkdownSection(t, '## Cross-agent coordination (aircontrol)')));
  uninstallCmux();
  uninstallCodexDaemon();
  if (argv.includes('--purge')) {
    fs.rmSync(path.join(claudeDir, 'agents'), { recursive: true, force: true });
    console.log(`removed ${path.join(claudeDir, 'agents')} (roster, messages, ledger)`);
  }
  console.log('aircontrol uninstalled. GIT_OPTIONAL_LOCKS and Codex config.toml keys were left in place;');
  console.log('restore the .bak-aircontrol backups if you want them gone too.');
  if (!argv.includes('--purge')) console.log(`Session data kept in ${path.join(claudeDir, 'agents')}; --purge deletes it.`);
}

function main(argv = process.argv.slice(2)) {
  // Installing is a machine-wide side effect, so it belongs to a bare invocation only.
  // Every flag but --names used to fall straight through to a full install: `node
  // install.js --help` installed the hooks instead of explaining itself.
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  if (argv[0] === 'install') argv = argv.slice(1);
  if (argv[0] === 'uninstall') {
    const extra = argv.slice(1).filter((a) => a !== '--purge');
    if (extra.length) {
      process.stderr.write(`unknown option ${extra.join(' ')}\n\n${USAGE}`);
      process.exitCode = 2;
      return;
    }
    uninstall(argv.slice(1));
    return;
  }
  const unknown = argv.filter((a) => a.startsWith('-') && !KNOWN_FLAGS.has(a) && argv[argv.indexOf(a) - 1] !== '--names');
  if (unknown.length) {
    process.stderr.write(`unknown option ${unknown.join(' ')}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  if (coord.parseArgs(argv)['no-mirror-global']) writeConfig({ mirrorGlobalDoc: false });
  writeConfig({ nameStyle: resolveNameStyle() });

  copyRuntime(claudeTarget);
  copyRuntime(codexTarget);
  installCmuxRemoteLauncher();
  installRepoSkills();
  linkGlobalSkills();
  installClaudeHooks();
  installCodexHooks();
  ensureCodexConfigToml();
  if (argv.includes('--codex-daemon')) {
    installCodexDaemon();
  }

  upsertMarkdownSection(
    path.join(claudeDir, 'CLAUDE.md'),
    '## Parallel coding-agent sessions (aircontrol)',
    protocol('~/.claude/hooks/coord.js', 'Claude Code'),
    ['## Parallel Claude sessions (aircontrol)'],
  );
  upsertMarkdownSection(
    path.join(codexDir, 'AGENTS.md'),
    '## Cross-agent coordination (aircontrol)',
    protocol('~/.codex/hooks/coord.js', 'Codex'),
  );
  mirrorGlobalClaudeMd(readConfig().mirrorGlobalDoc !== false);

  const codexOverride = path.join(codexDir, 'AGENTS.override.md');
  if (fs.existsSync(codexOverride)) {
    console.warn(`warning: ${codexOverride} overrides AGENTS.md; add the AirControl section there or remove the override`);
  }
  console.log('aircontrol installed for Claude Code and Codex');
  console.log('Codex: run `codex login` once, then open /hooks inside Codex and trust the six aircontrol entries.');
  console.log('       Review new or changed hook commands; unchanged commands retain their existing trust.');
}

module.exports = {
  main, uninstall, withoutAircontrolHooks, ensureHook, protocol, installClaudeHooks, installCodexHooks, upsertMarkdownSection, resolveNode, codexLaunchAgent,
  upsertTomlTopLevelArray, upsertTomlTableKey, withoutMarkedBlock, withMarkedBlock, installRepoSkills,
};

if (require.main === module) main();
