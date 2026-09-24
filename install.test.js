'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function count(text, needle) {
  return text.split(needle).length - 1;
}

function aircontrolHandlers(config) {
  return Object.values(config.hooks || {}).flatMap((entries) =>
    entries.flatMap((entry) => (entry.hooks || []).filter((handler) =>
      typeof handler.command === 'string' && handler.command.includes('coord.js"'))));
}

test('installer merges Claude and Codex hooks and is idempotent', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aircontrol-install-'));
  const claudeDir = path.join(home, '.claude');
  const codexDir = path.join(home, '.codex');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });

  const claudeSettings = {
    env: { EXISTING_SETTING: 'preserved' },
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'custom-claude-hook' }] }],
      // Stop is now an aircontrol event too — a third-party Stop hook must survive it.
      Stop: [{ hooks: [{ type: 'command', command: 'custom-claude-stop' }] }],
    },
  };
  const codexHooks = {
    description: 'Existing user hooks.',
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'custom-codex-hook' }] }],
      // A pre-flag install: the legacy spelling must be upgraded in place, not duplicated.
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: '"/old/node" "/old/coord.js" inject-codex', timeout: 10 }] }],
    },
  };
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(claudeSettings));
  fs.writeFileSync(path.join(codexDir, 'hooks.json'), JSON.stringify(codexHooks));
  fs.mkdirSync(path.join(claudeDir, 'skills', 'foo'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'skills', 'foo', 'SKILL.md'), '---\nname: foo\ndescription: t\n---\n');
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), [
    '# Personal instructions',
    '',
    'Keep this text.',
    '',
    '## Style',
    '',
    'Run `node ~/.claude/hooks/coord.js who` before deploying.',
    '',
    '## Parallel Claude sessions (aircontrol)',
    '',
    'Legacy protocol.',
  ].join('\n'));
  fs.writeFileSync(path.join(codexDir, 'AGENTS.md'), '# Personal instructions\n\nKeep this too.\n');

  const install = () => execFileSync(process.execPath, [path.join(__dirname, 'install.js')], {
    cwd: __dirname,
    env: { ...process.env, AIRCONTROL_HOME: home, AIRCONTROL_NAME_STYLE: '', AIRCONTROL_CMUX: '1' },
    encoding: 'utf8',
  });
  install();
  // AGENTS.md is written twice per run (protocol, then the mirror block); the backup must
  // be the pre-run file, not the mid-run one.
  assert.equal(fs.readFileSync(path.join(codexDir, 'AGENTS.md.bak-aircontrol'), 'utf8'), '# Personal instructions\n\nKeep this too.\n');
  install();

  const installedClaude = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
  const installedCodex = JSON.parse(fs.readFileSync(path.join(codexDir, 'hooks.json'), 'utf8'));
  assert.equal(installedClaude.hooks.SessionStart[0].hooks[0].command, 'custom-claude-hook');
  assert.equal(installedClaude.hooks.Stop[0].hooks[0].command, 'custom-claude-stop');
  assert.equal(installedCodex.hooks.Stop[0].hooks[0].command, 'custom-codex-hook');
  assert.equal(installedCodex.description, 'Existing user hooks.');
  assert.equal(installedClaude.env.EXISTING_SETTING, 'preserved');
  assert.equal(installedClaude.env.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(aircontrolHandlers(installedClaude).length, 6);
  assert.equal(aircontrolHandlers(installedCodex).length, 6);
  assert.ok(fs.existsSync(path.join(codexDir, 'hooks', 'codex-listener.js')));
  assert.ok(fs.existsSync(path.join(codexDir, 'hooks', 'node_modules', 'ws', 'index.js')));
  const cmuxLauncher = path.join(home, '.local', 'bin', 'aircontrol-cmux-codex');
  assert.ok(fs.existsSync(cmuxLauncher));
  assert.match(fs.readFileSync(cmuxLauncher, 'utf8'),
    /--remote "unix:\/\/\$socket" --cd "\$PWD"/,
    'the shared daemon must receive the invoking terminal directory');
  assert.match(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), /CMUX_CUSTOM_CODEX_PATH/);

  // Every Codex hook declares its harness (Codex exposes no env var for it); Claude,
  // being the default, never does.
  assert.ok(aircontrolHandlers(installedCodex).every((h) => / --harness codex$/.test(h.command)), JSON.stringify(aircontrolHandlers(installedCodex).map((h) => h.command)));
  assert.ok(aircontrolHandlers(installedClaude).every((h) => !h.command.includes('--harness')));

  // Push delivery on both harnesses: Codex's Stop hook honours decision:block like Claude's.
  const claudeNudge = installedClaude.hooks.Stop.find((entry) =>
    (entry.hooks || []).some((handler) => handler.command.includes('coord.js" nudge')));
  assert.ok(claudeNudge);
  assert.equal(claudeNudge.matcher, undefined);
  const codexNudge = installedCodex.hooks.Stop.find((entry) =>
    (entry.hooks || []).some((handler) => handler.command.includes('coord.js" nudge')));
  assert.ok(codexNudge, 'Codex gets the Stop/nudge hook');
  assert.equal(installedCodex.hooks.Stop.length, 2, "the user's own Stop hook survives");
  assert.equal(installedCodex.hooks.Stop[0].hooks[0].command, 'custom-codex-hook');

  const claudeGuard = installedClaude.hooks.PreToolUse.find((entry) =>
    (entry.hooks || []).some((handler) => handler.command.includes('coord.js" guard')));
  const codexGuard = installedCodex.hooks.PreToolUse.find((entry) =>
    (entry.hooks || []).some((handler) => handler.command.includes('coord.js" guard')));
  assert.equal(claudeGuard.matcher, 'Edit|Write|NotebookEdit|Bash');
  assert.equal(codexGuard.matcher, '*');

  const codexPost = installedCodex.hooks.PostToolUse.find((entry) =>
    (entry.hooks || []).some((handler) => handler.command.includes('coord.js" beat')));
  const codexPrompt = installedCodex.hooks.UserPromptSubmit.find((entry) =>
    (entry.hooks || []).some((handler) => handler.command.includes('coord.js" inject --harness codex')));
  const codexEnd = installedCodex.hooks.SessionEnd.find((entry) =>
    (entry.hooks || []).some((handler) => handler.command.includes('coord.js" deregister')));
  // Codex tool names are loosely documented and change (a missing `exec` once
  // silently killed heartbeats) — match everything, beat no-ops on the rest.
  assert.equal(codexPost.matcher, '*');
  assert.ok(codexPrompt);
  assert.equal(installedCodex.hooks.UserPromptSubmit.length, 1, 'the legacy inject-codex handler was upgraded in place, not duplicated');
  assert.ok(!JSON.stringify(installedCodex).includes('inject-codex'));
  assert.equal(codexEnd.hooks[0].timeout, 15);
  assert.match(codexPost.hooks[0].command, new RegExp(`${path.join(codexDir, 'hooks', 'coord.js').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" beat --harness codex$`));

  // Codex reads CLAUDE.md where no AGENTS.md sits beside it, and its shell gets the same
  // GIT_OPTIONAL_LOCKS=0 Claude's does. A fresh config.toml is created when absent.
  const toml = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
  assert.equal(count(toml, 'project_doc_fallback_filenames = ["CLAUDE.md"]'), 1);
  assert.equal(count(toml, '[shell_environment_policy.set]'), 1);
  assert.equal(count(toml, 'GIT_OPTIONAL_LOCKS = "0"'), 1);
  assert.ok(toml.indexOf('project_doc_fallback_filenames') < toml.indexOf('['), 'top-level keys precede the first table');

  // The user-level skills reach every harness that reads ~/.agents/skills.
  const fooLink = path.join(home, '.agents', 'skills', 'foo');
  assert.ok(fs.lstatSync(fooLink).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(fooLink, 'SKILL.md')));

  // aircontrol's own skills come from the repo, and reach ~/.agents/skills through that link.
  const nextSteps = path.join(claudeDir, 'skills', 'next-steps');
  assert.equal(fs.realpathSync(nextSteps), fs.realpathSync(path.join(__dirname, 'skills', 'next-steps')));
  assert.equal(fs.realpathSync(path.join(home, '.agents', 'skills', 'next-steps', 'SKILL.md')),
    fs.realpathSync(path.join(__dirname, 'skills', 'next-steps', 'SKILL.md')));

  const claudeMd = fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8');
  const agentsMd = fs.readFileSync(path.join(codexDir, 'AGENTS.md'), 'utf8');
  assert.equal(count(claudeMd, '## Parallel coding-agent sessions (aircontrol)'), 1);
  assert.equal(count(claudeMd, '## Parallel Claude sessions (aircontrol)'), 0);
  assert.equal(count(agentsMd, '## Cross-agent coordination (aircontrol)'), 1);
  assert.match(claudeMd, /Keep this text\./);
  assert.match(agentsMd, /Keep this too\./);
  assert.match(agentsMd, /Claude Code and Codex sessions/);
  assert.match(agentsMd, /doctor --roots/);
  assert.match(agentsMd, /sim acquire --session/);
  assert.match(agentsMd, /ledger list --repo \./);
  assert.match(agentsMd, /never `\/clean_gone`/);
  assert.match(agentsMd, /end of your turn/, 'Codex now gets the Stop hook, so it gets the end-of-turn promise too');

  // Global CLAUDE.md is mirrored into AGENTS.md (Codex has no @import), minus the aircontrol
  // section — which AGENTS.md carries in its own flavour — with hook paths rewritten, placed
  // before the protocol so the protocol upsert can never truncate it, and written once.
  assert.equal(count(agentsMd, '<!-- aircontrol:mirror-start -->'), 1);
  assert.equal(count(agentsMd, '<!-- aircontrol:mirror-end -->'), 1);
  const mirror = agentsMd.slice(agentsMd.indexOf('<!-- aircontrol:mirror-start -->'), agentsMd.indexOf('<!-- aircontrol:mirror-end -->'));
  assert.match(mirror, /Keep this text\./);
  assert.match(mirror, /## Style/);
  assert.match(mirror, /node ~\/\.codex\/hooks\/coord\.js who/);
  assert.doesNotMatch(mirror, /~\/\.claude\/hooks\/coord\.js/);
  assert.doesNotMatch(mirror, /Parallel coding-agent sessions|Parallel Claude sessions|Legacy protocol/);
  assert.ok(agentsMd.indexOf('<!-- aircontrol:mirror-start -->') < agentsMd.indexOf('## Cross-agent coordination (aircontrol)'));
  assert.equal(count(agentsMd, '## Cross-agent coordination (aircontrol)'), 1);

  assert.equal(
    fs.readFileSync(path.join(codexDir, 'hooks', 'coord.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, 'coord.js'), 'utf8'),
  );
  assert.ok(fs.existsSync(path.join(claudeDir, 'settings.json.bak-aircontrol')));
  assert.ok(fs.existsSync(path.join(codexDir, 'hooks.json.bak-aircontrol')));
  assert.ok(fs.existsSync(path.join(codexDir, 'AGENTS.md.bak-aircontrol')));

  // non-interactive install writes the default name style
  const config = JSON.parse(fs.readFileSync(path.join(claudeDir, 'agents', 'config.json'), 'utf8'));
  assert.equal(config.nameStyle, 'goofy');
});

test('installer honors --names and preserves the choice on re-run', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aircontrol-names-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const cfgPath = path.join(home, '.claude', 'agents', 'config.json');
  const install = (extra = []) => execFileSync(process.execPath, [path.join(__dirname, 'install.js'), ...extra], {
    cwd: __dirname,
    env: { ...process.env, AIRCONTROL_HOME: home, AIRCONTROL_NAME_STYLE: '' },
    encoding: 'utf8',
  });

  install(['--names', 'animal']);
  assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).nameStyle, 'animal');

  // re-run without the flag keeps the existing choice (idempotent, no prompt)
  install();
  assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).nameStyle, 'animal');

  // an unknown --names is ignored, existing choice preserved
  install(['--names', 'bogus']);
  assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).nameStyle, 'animal');
});

test('hook commands name a version-independent Node binary, not process.execPath', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aircontrol-node-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const settingsPath = path.join(home, '.claude', 'settings.json');

  const install = (extraEnv = {}) => execFileSync(process.execPath, [path.join(__dirname, 'install.js')], {
    cwd: __dirname,
    env: { ...process.env, AIRCONTROL_HOME: home, AIRCONTROL_NAME_STYLE: '', ...extraEnv },
    encoding: 'utf8',
  });

  // A Homebrew Cellar / nvm path embeds a version that disappears on upgrade —
  // that is exactly what broke every hook with "No such file or directory".
  const commandsFrom = () =>
    aircontrolHandlers(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).map((h) => h.command);

  install();
  const commands = commandsFrom();
  assert.ok(commands.length > 0, 'expected aircontrol hooks to be installed');
  for (const command of commands) {
    assert.doesNotMatch(command, /Cellar\/node\/\d/, `version-pinned Cellar path in: ${command}`);
    assert.doesNotMatch(command, /\.nvm\/versions/, `version-pinned nvm path in: ${command}`);
  }

  // Whatever it picked must actually be executable from a bare shell — the
  // hooks run in a non-interactive /bin/sh with no profile and no PATH help.
  const [nodeBin] = commands[0].match(/^"([^"]+)"/).slice(1);
  assert.ok(fs.existsSync(nodeBin), `${nodeBin} does not exist`);
  assert.doesNotThrow(() => fs.accessSync(nodeBin, fs.constants.X_OK));

  // An explicit override wins when it is a usable interpreter...
  install({ AIRCONTROL_NODE: process.execPath });
  assert.ok(commandsFrom().every((c) => c.startsWith(`"${process.execPath}"`)));

  // ...and a bogus override falls through to a real binary rather than
  // writing a command that cannot run.
  install({ AIRCONTROL_NODE: path.join(home, 'no-such-node') });
  for (const command of commandsFrom()) {
    assert.ok(!command.includes('no-such-node'), `unusable override leaked into: ${command}`);
    const [bin] = command.match(/^"([^"]+)"/).slice(1);
    assert.doesNotThrow(() => fs.accessSync(bin, fs.constants.X_OK));
  }
});

test('requiring install.js does not install anything', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aircontrol-require-'));
  // Requiring the installer to reach a helper — or merely to check it parses —
  // must not copy runtime files or rewrite settings.json and CLAUDE.md.
  const out = execFileSync(process.execPath, [
    '-e', `const m = require(${JSON.stringify(path.join(__dirname, 'install.js'))}); console.log(typeof m.main);`,
  ], { cwd: __dirname, env: { ...process.env, AIRCONTROL_HOME: home }, encoding: 'utf8' });
  assert.equal(out.trim(), 'function');
  assert.deepEqual(fs.readdirSync(home), [], 'require wrote nothing');
});

// A machine-wide install is the wrong default for a flag the installer does not know:
// `node install.js --help` used to install the hooks instead of explaining itself.
test('--help and unknown flags explain themselves and install nothing', () => {
  const script = path.join(__dirname, 'install.js');

  const helpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aircontrol-help-'));
  const help = execFileSync(process.execPath, [script, '--help'], {
    cwd: __dirname, env: { ...process.env, AIRCONTROL_HOME: helpHome }, encoding: 'utf8',
  });
  assert.match(help, /aircontrol installer/);
  assert.deepEqual(fs.readdirSync(helpHome), [], '--help wrote nothing');

  const badHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aircontrol-bad-'));
  let status = 0;
  try {
    execFileSync(process.execPath, [script, '--bogus'], {
      cwd: __dirname, env: { ...process.env, AIRCONTROL_HOME: badHome }, encoding: 'utf8', stdio: 'pipe',
    });
  } catch (e) { status = e.status; }
  assert.equal(status, 2, 'unknown flag exits non-zero');
  assert.deepEqual(fs.readdirSync(badHome), [], 'unknown flag wrote nothing');

  // The one flag it does know must still install.
  const okHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aircontrol-names-'));
  execFileSync(process.execPath, [script, '--names', 'animal'], {
    cwd: __dirname, env: { ...process.env, AIRCONTROL_HOME: okHome }, encoding: 'utf8',
  });
  assert.ok(fs.readdirSync(okHome).length > 0, '--names still installs');
});

// ---------- Codex config.toml: minimal line-level upserts, no TOML library ----------

test('upsertTomlTopLevelArray inserts before the first table, extends an existing array, and leaves hard cases alone', () => {
  const { upsertTomlTopLevelArray } = require('./install.js');
  const key = 'project_doc_fallback_filenames';

  const fresh = upsertTomlTopLevelArray('', key, 'CLAUDE.md');
  assert.equal(fresh.text, 'project_doc_fallback_filenames = ["CLAUDE.md"]\n');
  assert.equal(fresh.changed, true);

  const withTables = '\nmodel = "x"\n\n[features]\njs_repl = false\n';
  const inserted = upsertTomlTopLevelArray(withTables, key, 'CLAUDE.md');
  const lines = inserted.text.split('\n');
  assert.ok(lines.indexOf('project_doc_fallback_filenames = ["CLAUDE.md"]') < lines.indexOf('[features]'), inserted.text);
  assert.match(inserted.text, /\[features\]\njs_repl = false\n/, 'the table body is untouched');
  assert.equal(upsertTomlTopLevelArray(inserted.text, key, 'CLAUDE.md').changed, false, 'idempotent');
  assert.equal(upsertTomlTopLevelArray(inserted.text, key, 'CLAUDE.md').text, inserted.text);

  const extended = upsertTomlTopLevelArray('project_doc_fallback_filenames = ["AGENTS.override.md"]\n[x]\n', key, 'CLAUDE.md');
  assert.equal(extended.text, 'project_doc_fallback_filenames = ["AGENTS.override.md", "CLAUDE.md"]\n[x]\n');

  const multiLine = 'project_doc_fallback_filenames = [\n  "X",\n]\n';
  const skippedMulti = upsertTomlTopLevelArray(multiLine, key, 'CLAUDE.md');
  assert.equal(skippedMulti.text, multiLine);
  assert.equal(skippedMulti.changed, false);
  assert.match(skippedMulti.note, /multi-line/);

  const inTable = '[features]\nproject_doc_fallback_filenames = ["X"]\n';
  const skippedTable = upsertTomlTopLevelArray(inTable, key, 'CLAUDE.md');
  assert.equal(skippedTable.text, inTable);
  assert.match(skippedTable.note, /inside a table/);
});

test('upsertTomlTableKey appends under an existing table, creates the table at EOF, and skips an inline set', () => {
  const { upsertTomlTableKey } = require('./install.js');
  const table = '[shell_environment_policy.set]';

  const existing = '[shell_environment_policy.set]\nA = "1"\n\n[other]\nb = 1\n';
  const added = upsertTomlTableKey(existing, table, 'GIT_OPTIONAL_LOCKS', '"0"');
  assert.equal(added.text, '[shell_environment_policy.set]\nA = "1"\nGIT_OPTIONAL_LOCKS = "0"\n\n[other]\nb = 1\n');
  assert.equal(upsertTomlTableKey(added.text, table, 'GIT_OPTIONAL_LOCKS', '"0"').changed, false, 'idempotent');

  const absent = upsertTomlTableKey('model = "x"\n', table, 'GIT_OPTIONAL_LOCKS', '"0"');
  assert.equal(absent.text, 'model = "x"\n\n[shell_environment_policy.set]\nGIT_OPTIONAL_LOCKS = "0"\n');

  const inline = '[shell_environment_policy]\nset = { X = "1" }\n';
  const skipped = upsertTomlTableKey(inline, table, 'GIT_OPTIONAL_LOCKS', '"0"');
  assert.equal(skipped.text, inline);
  assert.match(skipped.note, /inline/);

  const different = '[shell_environment_policy.set]\nGIT_OPTIONAL_LOCKS = "1"\n';
  const kept = upsertTomlTableKey(different, table, 'GIT_OPTIONAL_LOCKS', '"0"');
  assert.equal(kept.text, different, "a deliberate different value is the user's");
  assert.match(kept.note, /already set/);
});

test('--no-mirror-global removes the mirror block and is remembered across re-runs', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aircontrol-nomirror-'));
  const claudeDir = path.join(home, '.claude');
  const codexDir = path.join(home, '.codex');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), '# Mine\n\nMirror me.\n');
  const install = (...flags) => execFileSync(process.execPath, [path.join(__dirname, 'install.js'), ...flags], {
    cwd: __dirname,
    env: { ...process.env, AIRCONTROL_HOME: home, AIRCONTROL_NAME_STYLE: '' },
    encoding: 'utf8',
  });
  install();
  assert.match(fs.readFileSync(path.join(codexDir, 'AGENTS.md'), 'utf8'), /Mirror me\./);
  install('--no-mirror-global');
  let agentsMd = fs.readFileSync(path.join(codexDir, 'AGENTS.md'), 'utf8');
  assert.doesNotMatch(agentsMd, /Mirror me\.|aircontrol:mirror/);
  assert.match(agentsMd, /## Cross-agent coordination \(aircontrol\)/, 'the protocol section stays');
  assert.equal(JSON.parse(fs.readFileSync(path.join(claudeDir, 'agents', 'config.json'), 'utf8')).mirrorGlobalDoc, false);
  install();
  agentsMd = fs.readFileSync(path.join(codexDir, 'AGENTS.md'), 'utf8');
  assert.doesNotMatch(agentsMd, /Mirror me\./, 'the opt-out is remembered');
});

test('upsertMarkdownSection is byte-stable across repeated installs', () => {
  // It used to grow the file by one blank line every run: `after` kept the
  // trailing newline of the previous write and the join appended another. The
  // operator's CLAUDE.md is rewritten on every install, so this accumulated
  // silently until the file ended in a block of blank lines.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aircontrol-md-'));
  const file = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(file, '# Top\n\nintro\n\n## Mine\n\nold body\n\n## After\n\ntail\n');

  const { upsertMarkdownSection } = require('./install.js');
  upsertMarkdownSection(file, '## Mine', 'new body');
  const once = fs.readFileSync(file, 'utf8');
  upsertMarkdownSection(file, '## Mine', 'new body');
  const twice = fs.readFileSync(file, 'utf8');

  assert.equal(once, twice, 'a second identical install must change nothing');
  assert.ok(!/\n\n\n/.test(twice), 'no run of blank lines');
  assert.ok(twice.endsWith('tail\n'), 'exactly one trailing newline');
  assert.match(twice, /## Mine\n\nnew body\n\n## After/);
});

test('installRepoSkills links repo skills, replaces identical copies, and backs up differing ones', () => {
  const { installRepoSkills } = require('./install.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aircontrol-skills-'));
  const src = path.join(root, 'repo', 'skills');
  const dst = path.join(root, 'home', '.claude', 'skills');
  const bak = path.join(root, 'home', '.claude', 'skills-backup-aircontrol');
  const skill = (dir, body) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
  };
  for (const n of ['fresh', 'same', 'edited', 'linked']) skill(path.join(src, n), `repo ${n}\n`);
  skill(path.join(dst, 'same'), 'repo same\n');
  skill(path.join(dst, 'edited'), 'local edit\n');
  fs.symlinkSync(path.relative(dst, path.join(src, 'linked')), path.join(dst, 'linked'), 'dir');
  fs.mkdirSync(path.join(root, 'elsewhere', 'other'), { recursive: true });

  const quiet = console.warn;
  console.warn = () => {};
  try { installRepoSkills(src, dst, bak); } finally { console.warn = quiet; }

  for (const n of ['fresh', 'same', 'edited', 'linked']) {
    assert.ok(fs.lstatSync(path.join(dst, n)).isSymbolicLink(), n);
    assert.equal(fs.realpathSync(path.join(dst, n)), fs.realpathSync(path.join(src, n)), n);
  }
  assert.deepEqual(fs.readdirSync(bak), ['edited']);
  assert.equal(fs.readFileSync(path.join(bak, 'edited', 'SKILL.md'), 'utf8'), 'local edit\n');

  const counts = installRepoSkills(src, dst, bak);
  assert.deepEqual(counts, { ok: 4 });
});

test('installer leaves shell profiles alone when cmux is absent', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aircontrol-nocmux-'));
  execFileSync(process.execPath, [path.join(__dirname, 'install.js'), '--names', 'goofy'], {
    cwd: __dirname, env: { ...process.env, AIRCONTROL_HOME: home, AIRCONTROL_CMUX: '0' }, encoding: 'utf8',
  });
  assert.equal(fs.existsSync(path.join(home, '.zshrc')), false);
  assert.equal(fs.existsSync(path.join(home, '.local', 'bin', 'aircontrol-cmux-codex')), false);
});

test('package installs copy skills instead of linking into the npx cache', () => {
  const { installRepoSkills } = require('./install.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aircontrol-copyskills-'));
  const src = path.join(root, 'pkg', 'skills');
  const dst = path.join(root, 'home', '.claude', 'skills');
  const backups = path.join(root, 'backup');
  for (const name of ['alpha', 'beta', 'gamma']) {
    fs.mkdirSync(path.join(src, name), { recursive: true });
    fs.writeFileSync(path.join(src, name, 'SKILL.md'), `# ${name} v1\n`);
  }
  fs.mkdirSync(dst, { recursive: true });
  fs.mkdirSync(path.join(dst, 'beta'));
  fs.writeFileSync(path.join(dst, 'beta', 'SKILL.md'), '# hand-edited beta\n');
  fs.symlinkSync(path.join(root, 'gone', 'gamma'), path.join(dst, 'gamma'), 'dir');

  const counts = installRepoSkills(src, dst, backups, { copy: true });
  assert.equal(counts.copy, 3);
  for (const name of ['alpha', 'beta', 'gamma']) {
    assert.ok(!fs.lstatSync(path.join(dst, name)).isSymbolicLink(), `${name} is a real directory`);
    assert.equal(fs.readFileSync(path.join(dst, name, 'SKILL.md'), 'utf8'), `# ${name} v1\n`);
  }
  assert.equal(fs.readFileSync(path.join(backups, 'beta', 'SKILL.md'), 'utf8'), '# hand-edited beta\n');

  fs.writeFileSync(path.join(src, 'alpha', 'SKILL.md'), '# alpha v2\n');
  installRepoSkills(src, dst, backups, { copy: true });
  assert.equal(fs.readFileSync(path.join(dst, 'alpha', 'SKILL.md'), 'utf8'), '# alpha v2\n');
  assert.equal(fs.existsSync(path.join(backups, 'alpha')), false, 'its own copy is replaced, not backed up');

  // Back on a checkout, the managed copy gives way to a link without a backup.
  installRepoSkills(src, dst, backups, { copy: false });
  assert.ok(fs.lstatSync(path.join(dst, 'alpha')).isSymbolicLink());
  assert.equal(fs.existsSync(path.join(backups, 'alpha')), false);
});

test('uninstall removes only what install added', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aircontrol-uninstall-'));
  const claudeDir = path.join(home, '.claude');
  const codexDir = path.join(home, '.codex');
  fs.mkdirSync(path.join(claudeDir, 'skills', 'mine'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'skills', 'mine', 'SKILL.md'), '# mine\n');
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'custom-claude-stop' }] }] },
  }));
  fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), '# Personal\n\nKeep me.\n');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, 'AGENTS.md'), '# Codex personal\n\nKeep me too.\n');
  const run = (...args) => execFileSync(process.execPath, [path.join(__dirname, 'coord.js'), ...args], {
    cwd: __dirname, env: { ...process.env, AIRCONTROL_HOME: home, AIRCONTROL_CMUX: '1' }, encoding: 'utf8',
  });
  run('install', '--names', 'goofy');
  assert.ok(fs.existsSync(path.join(claudeDir, 'hooks', 'coord.js')));
  assert.ok(fs.existsSync(path.join(claudeDir, 'skills', 'ledger')));

  run('uninstall');
  const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
  assert.equal(aircontrolHandlers(settings).length, 0);
  assert.deepEqual(Object.keys(settings.hooks), ['Stop']);
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'custom-claude-stop');
  const codexHooks = JSON.parse(fs.readFileSync(path.join(codexDir, 'hooks.json'), 'utf8'));
  assert.equal(aircontrolHandlers(codexHooks).length, 0);
  for (const dir of [claudeDir, codexDir]) {
    assert.equal(fs.existsSync(path.join(dir, 'hooks', 'coord.js')), false);
    assert.equal(fs.existsSync(path.join(dir, 'hooks', 'codex-listener.js')), false);
    assert.equal(fs.existsSync(path.join(dir, 'hooks', 'node_modules')), false);
  }
  assert.equal(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8'), '# Personal\n\nKeep me.\n');
  const agents = fs.readFileSync(path.join(codexDir, 'AGENTS.md'), 'utf8');
  assert.ok(!agents.includes('aircontrol'), agents);
  assert.ok(agents.includes('Keep me too.'));
  assert.equal(fs.existsSync(path.join(claudeDir, 'skills', 'ledger')), false);
  assert.ok(fs.existsSync(path.join(claudeDir, 'skills', 'mine', 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(home, '.local', 'bin', 'aircontrol-cmux-codex')), false);
  assert.ok(!fs.readFileSync(path.join(home, '.zshrc'), 'utf8').includes('CMUX_CUSTOM_CODEX_PATH'));
  assert.ok(fs.existsSync(path.join(claudeDir, 'agents', 'config.json')), 'session data survives without --purge');

  run('uninstall', '--purge');
  assert.equal(fs.existsSync(path.join(claudeDir, 'agents')), false);
});

test('an installed hook copy refuses to install and points at npx', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aircontrol-hookcopy-'));
  fs.copyFileSync(path.join(__dirname, 'coord.js'), path.join(dir, 'coord.js'));
  assert.throws(
    () => execFileSync(process.execPath, [path.join(dir, 'coord.js'), 'install'], {
      env: { ...process.env, AIRCONTROL_HOME: dir }, encoding: 'utf8', stdio: 'pipe',
    }),
    (err) => /npx aircontrol install/.test(err.stderr),
  );
});
