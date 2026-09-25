# aircontrol

Lightweight coordination for **parallel Claude Code and Codex sessions on one machine.**

When you run several coding-agent sessions at once (multiple apps, terminals, worktrees,
or repos), they can't see each other — two sessions will happily grab the same
simulator, deploy at the same time, or stomp each other's `git stash`. `aircontrol`
gives every session a shared view of the room and a way to stake claims and pass notes.

It wires into Claude Code and Codex via **hooks**, so every prompt automatically gets
an `[aircontrol]` context block injected.

- **Zero dependencies** — pure Node standard library.
- **Cross-agent** — Claude Code and Codex share one roster and message bus.
- **Machine-local** — state lives under `~/.claude/agents/`; each machine coordinates
  only its own sessions. Nothing leaves your box.
- **Fail-safe** — hook subcommands swallow every error and exit 0, so AirControl can
  never break a session.

## What you see

Every prompt gets a block like this, delivered **to the agent as context, not printed to
your terminal**:

```
[aircontrol] You are session mayor-mopplewhump.
Other sessions in THIS repo:
- captain-boopsnoot [feature/x @ myapp] "refactoring StoreManager" — claims: Store/, sim:iPhone-16 (seen 2m ago)
Elsewhere on this machine:
- herald-pumpernickel in web-api [main] "fixing lint" (seen 5m ago)
Messages for you:
- from captain-boopsnoot (1m ago): about to deploy, hold off on functions
⚠️ Advisories:
- Your path Store/StoreManager.swift overlaps captain-boopsnoot's claim "Store/" — coordinate before continuing.
[aircontrol] context: 1.9MB tool results (~475k tok, 80 results) — costliest: Read shot.jpg 261k x140 — fix: downsize before reading (sips -Z 900)
```

The roster is for the model, so it rides `hookSpecificOutput.additionalContext` on both
harnesses rather than bare stdout — bare stdout on `UserPromptSubmit` is echoed to the
operator as well as injected, which put a block of coordination state in front of the human
on every prompt. The one thing that *does* surface in your terminal is an inbound peer
message arriving at the end of a turn, via the `Stop` hook: that one is addressed to you and
needs an answer.

Each session shows as a stable, friendly **name** derived from its harness session id.
A name is chosen once, when the session first registers, and never changes after that —
renaming mid-life would strand every message and ledger row already addressed to the old
name. Pick the flavor at install time (or later with `coord.js names`): `goofy` (default,
e.g. `captain-boopsnoot`), `animal` (`sneaky-otter`), or `real` (`wilma`). `--session` /
`--to` accept a name **or** a session-id prefix.

**No two sessions alive at once share a word.** The plain hash of an id can collide, and
the half-collision is the dangerous one: `squire-grumbletoes` and `professor-grumbletoes`
read as the same session to anyone skimming a roster, so a handoff addressed by the shared
half goes to the wrong session and reports success. A new session therefore probes for a
name whose every word is unused by the live room, and stores the probe (a small integer
salt, not a rendered string, so `coord.js names <style>` still re-renders everything). A
name freed by a session that has ended is reusable. Sessions that registered before this
existed keep the name they have been answering to.

### The context budget line

`retro` (below) answers "where did the tokens go?" only once the session is over, which is
too late to act on: by then the 261 KB screenshot has already been re-sent 140 times. The
`context:` line is the same accounting delivered per-prompt, so the session can still change
course — it reports and never denies.

It stays **silent** until the session crosses a threshold; a number printed every turn
regardless of value is wallpaper. Defaults are 400 KB of cumulative tool results (~100k
tokens) or any single result over 60 KB, both overridable in `~/.claude/agents/config.json`:

```json
{ "budget": { "totalBytes": 400000, "singleBytes": 60000 } }
```

The meter reads only the bytes the transcript grew by since the last prompt, so the hook
cost is flat in session length: on a 68 MB transcript a full re-read takes ~218 ms while the
incremental read takes ~0.02 ms. Its totals and its ranking are verified to match `retro`
exactly — a divergence would show one number and bill another.

### The disk line

A full disk takes every session down at once: no tool can even create its temp directory,
so the agent cannot run the command that would free space. The `disk:` line fires while
there is still room to act, when free space on the session's volume drops below 20 GB or
10%, whichever is larger. It costs one `statfs` per prompt and stays silent otherwise.
Both limits are overridable in `~/.claude/agents/config.json`:

```json
{ "disk": { "minFreeBytes": 20000000000, "minFreeRatio": 0.1 } }
```

The usual cause on a Mac is Xcode DerivedData. Xcode keys it by project path, so every
throwaway worktree a session builds in leaves a multi-GB folder behind that Xcode never
collects. `disk` lists the folders whose project no longer exists; `disk --prune` removes them.
It never touches a folder without a project path (Xcode's shared caches, or one being created
mid-build) or one under a path a live session has claimed.

`disk` also covers what macOS leaves in `/tmp` until the next reboot:

- **Ended sessions' tmp dirs** (`/tmp/claude-<uid>/<project>/<session-id>`: task output and
  scratchpad, often holding a `-derivedDataPath` build). "Ended" means the session has no
  record, since SessionEnd deletes it. A session that has only gone quiet past the roster TTL
  keeps its record and its dir. Taken once nothing inside has changed for 1 hour.
- **Unowned build output** directly in `/tmp`, `/tmp/claude-<uid>` or `$TMPDIR`: an Xcode
  DerivedData root (`Build` + `ModuleCache.noindex` or `SourcePackages`) or a SwiftPM scratch dir
  (`workspace-state.json` + `checkouts`), idle for 24 hours and not under a claimed path.

It also **reports** (never removes) linked git worktrees that nobody is using: no live session
in them, nothing uncommitted, nothing that exists on no remote, and no git activity for 7 days.
It checks every repo a session has ever worked in, from the activity log. A forgotten worktree
is where an agent's in-tree `-derivedDataPath build` quietly grows to 10 GB; the line prints its
size and the `git worktree remove` command, and session-cleanup is where it normally goes.

All windows are overridable: `{ "disk": { "sessionIdleMs": 3600000, "buildIdleMs": 86400000, "worktreeIdleMs": 604800000 } }`.

Naming the offender isn't the same as fixing it, so the line pairs it with a general,
offender-keyed remediation (`remediationHint`, also appended to `retro`'s ranked list) —
not a diagnosis of what happened this session, just which of three shapes it is:

| Offender | Fix |
|---|---|
| Image/screenshot result | Downsize before reading, e.g. `sips -Z 900`; never `Read` a full-page capture |
| Large `Read`, re-sent across many turns | Re-read only the needed slice (`offset`/`limit`) instead of the whole file |
| Repeated or fan-out tool calls | Delegate the sweep to a subagent so only its conclusion lands in context |

## Install

Requires Node ≥ 18 and Claude Code and/or Codex.

```bash
npx aircontrol install
```

Re-run `npx aircontrol@latest install` to update. To hack on it, install from a clone
instead; skills are then symlinked so edits land in the repo:

```bash
git clone https://github.com/ahavasi/aircontrol.git
cd aircontrol && npm install
node install.js        # or: npm run setup
```

The installer is **idempotent** — safe to re-run any time (e.g. after editing `coord.js`
or switching Node versions). It:

1. Copies `coord.js` to both `~/.claude/hooks/coord.js` and
   `~/.codex/hooks/coord.js`.
2. Merges five lifecycle hooks (`register`, `inject`, `beat`, `nudge`, `deregister`) plus
   the `guard` enforcement hook (PreToolUse) into `~/.claude/settings.json` and
   `~/.codex/hooks.json`, preserving unrelated hooks and making `.bak-aircontrol`
   backups. Every Codex command carries `--harness codex`, which is how sessions get
   tagged: Codex exposes no session-id or harness env var to hooks.
3. Sets `GIT_OPTIONAL_LOCKS=0` for both harnesses — in Claude Code's `env` block and in
   Codex's `[shell_environment_policy.set]`. This prevents read-only status lines and
   hooks from creating optional index-refresh locks; Git write operations still take
   required locks normally.
4. Writes `project_doc_fallback_filenames = ["CLAUDE.md"]` into `~/.codex/config.toml`,
   so Codex reads a repo's `CLAUDE.md` wherever no `AGENTS.md` sits beside it. The upsert
   is line-level and conservative: top-level keys go before the first `[table]`, an
   existing single-line array is extended, anything harder is left alone with a warning.
5. Adds the coordination protocol to `~/.claude/CLAUDE.md` and the global
   `~/.codex/AGENTS.md`, and **mirrors** the rest of `~/.claude/CLAUDE.md` into
   `~/.codex/AGENTS.md` inside a marked block (Codex has no `@import`). Edit the source
   and re-run; `--no-mirror-global` turns the mirror off and removes the block.
6. Installs aircontrol's own skills (`skills/`: `ledger`, `ledger-next`, `next-steps`,
   `session-cleanup`) into `~/.claude/skills/`. From a clone they are symlinked, so editing
   one in place edits the repo; from the npm package they are copied (the npx cache is
   temporary) and marked with `.aircontrol-managed`. A directory already there that
   aircontrol did not put there is replaced if identical, otherwise moved to
   `~/.claude/skills-backup-aircontrol/`. Then links `~/.claude/skills/*` into
   `~/.agents/skills/` so every harness that reads the Agent Skills standard location sees
   them (see *Skills across harnesses* below).
7. Picks the session **name style** and records it in `~/.claude/agents/config.json`.
   In an interactive terminal it prompts (default `goofy`); otherwise it uses the
   existing choice or the default. Override without prompting via `--names <style>` or
   the `AIRCONTROL_NAME_STYLE` env var. Re-running never re-prompts once a style is set.
8. Only if cmux is installed: puts a launcher at
   `~/.local/bin/aircontrol-cmux-codex` and exports `CMUX_CUSTOM_CODEX_PATH` from a marked
   block in `~/.zshrc` and `~/.zprofile`, so cmux's Codex sessions go through the local
   aircontrol daemon. Nothing touches your shell profiles otherwise.

### Codex

```bash
brew install --cask codex     # or: npm install -g @openai/codex
codex login                   # ChatGPT plan (Free/Go/Plus/Pro) or an API key
node install.js --codex-daemon
```

`--codex-daemon` installs and starts Codex's local daemon and an aircontrol monitor. It requires
the official standalone Codex package (`https://chatgpt.com/codex/install.sh`); Homebrew
or npm alone cannot bootstrap it. No remote-control access is enabled. Ordinary new
CLI launches automatically connect to the daemon. On macOS, a persistent user LaunchAgent
starts the monitor at login and restarts it if it fails; the monitor also recovers a
disconnected daemon. Existing embedded sessions must be
reopened for live title updates. Launches with `-c`, `--strict-config`, custom loader
overrides, or `--dangerously-bypass-hook-trust` use an embedded server: their names are
persisted but may not refresh until reopened. Native queued messages still reach those
sessions, with Codex polling its external queue about every ten seconds.

The monitor discovers newly loaded root threads before their first prompt (Codex itself
delays SessionStart until the first turn). Every registration starts one lightweight
`codex-listener.js` process. It sets the
thread title to the aircontrol name, watches that session's inbox, and queues a native
Codex wakeup when messages arrive while idle. The normal prompt hook delivers and marks
the messages read. The listener itself uses no model tokens. It reconnects on daemon
failures and exits when the session ends or its owning Codex process dies. Prompt and
heartbeat hooks restart a missing listener. Custom titles set after initialization are
preserved. A real Codex `SessionEnd` also archives the completed chat through the local
daemon, keeping it recoverable under `~/.codex/archived_sessions/` but out of the active
sidebar. `/clear` is not an end and is never archived. Check a session with:

```bash
node ~/.codex/hooks/coord.js listener --session <name>
node ~/.codex/hooks/coord.js listener                       # daemon monitor status
node ~/.codex/hooks/coord.js listener start --session <name>  # repair an older session
```

`listening` means the listener reached the daemon and checked the thread. `retrying`
means it has not; the unread inbox remains available to the prompt/Stop hooks. Wakeups
are at-least-once: a connection lost after acceptance but before acknowledgement can
produce an extra wakeup. An already-handled wakeup carries no new task.

Codex requires a one-time trust review for new or changed user hooks. Open `/hooks` inside
Codex after installing and trust the six aircontrol entries. Global `AGENTS.md` guidance
loads in new Codex sessions even before hook trust, but registration, roster injection,
enforcement and message delivery begin only after the hooks are trusted. `guard`
(PreToolUse) and `nudge` (Stop) are **blocking** hooks, so they need a fresh trust review
after every install. Both use the same JSON protocol as Claude Code
(`hookSpecificOutput.permissionDecision` and `decision: block`), which Codex documents and
which was verified live.

The hook commands name an absolute Node binary — a version-independent path such as
`/opt/homebrew/bin/node` when one exists, otherwise the interpreter that ran the
installer — so they keep working in shells where `node` isn't on `PATH` (nvm, etc.).
**After moving your Node install, re-run `node install.js`.**

## The protocol

- **At task start**, declare yourself:
  ```bash
  node ~/.codex/hooks/coord.js claim --session <your-id> \
    --intent "<what you're doing>" \
    --paths <dirs,you,will,touch> \
    --resources sim:<name>,deploy:<target>,stash
  ```
  Claude Code sessions can use the equivalent `~/.claude/hooks/coord.js` path.
  Claim only what applies. Resources are freeform names — `sim:*` and `deploy:*` are
  machine-global; `stash` is per-repo. Deploys are compared by target, so `deploy:asc`
  and `deploy:firebase` do not contend; bare `deploy` means every target and contends
  with all of them.
- **Before** grabbing a simulator, deploying, stashing, merging, or editing near another
  session's claims: check the roster block first.
- **⚠️ Advisories are stop-and-coordinate signals** — message the other session and wait a
  turn rather than pushing through.
- **Messaging:**
  ```bash
  node ~/.codex/hooks/coord.js send --session <your-name> --to <their-name> "text"
  ```
  On both harnesses a `Stop` hook delivers pending messages at the end of the recipient's
  turn, so nobody has to type for a message to land; an idle session sees them when it
  next finishes a turn or receives a prompt.

  For a **live Claude Code peer**, the built-in `ListAgents` + `SendMessage` tools are
  faster still — they deliver mid-turn. Match a peer to its roster line by worktree and
  branch, not by name: the two registries name sessions differently, and a session idle
  for 30+ minutes drops off this roster while remaining reachable natively. `coord.js
  send` remains the path for Codex peers and for messages that must survive the
  recipient being offline.
- **When done:** `node ~/.codex/hooks/coord.js release --session <your-id>`.

## CLI

`coord.js` is also a plain CLI (exposed as `aircontrol` if installed via npm):

| Command | What it does |
|---|---|
| `claim --session <id> [--intent "…"] [--paths a,b] [--resources r1,r2]` | Stake intent / paths / resources |
| `release --session <id> [--paths …] [--resources …]` | Drop claims (all, if none specified) |
| `send --session <id> --to <id\|all> "message"` | Message another live session |
| `who [--assignable] [--json]` | List live sessions grouped by repo; `--assignable` shows only sessions with no declared intent and no claims (`--idle` is a back-compat alias) |
| `names [goofy\|animal\|real]` | Show or set the session name style |
| `doctor [--roots dir1,dir2] [--min-age-minutes N] [--repair]` | Diagnose stale Git index locks; remove only safely classified locks when repair is explicit |
| `sim <list\|acquire\|release> [--for "…"] [--platform ios\|android] [--bundle-id id] [--name pref] [--key udid\|avd]` | Lease a simulator or emulator exclusively |
| `ledger <add\|list\|show\|take\|drop\|note\|block\|unblock\|done> [--repo .\|all\|path] [--priority low\|normal\|high\|urgent] [--depends-on id1,id2] [--notes]` | Track open work across every repo on the machine. `list` prints titles and pointers; `--notes` or `show <id>` for the notes |
| `handoff --session <me> --to <them> [--ledger-id id] [--note "…"]` | Transfer in-progress work: ledger ownership, claims, and a context note move to the recipient |
| `worktrees [--others] [--session id]` | Which worktrees live sessions are sitting in |
| `disk [--prune]` | Free space, plus build output and session tmp dirs nothing owns any more (deleted worktrees' DerivedData, ended sessions' `/tmp` dirs, idle `/tmp` builds); `--prune` removes them |
| `browsers [--kill-mine]` | Classify browser-MCP processes by session; reap only your own |
| `retro [--session name\|id] [--file path] [--top N]` | Where this session's tokens actually went; a live session by name, a Claude transcript id, or a Codex rollout id |
| `log [--date YYYY-MM-DD] [--days N] [--session name\|id] [--repo path\|.] [--json]` | Per-day history of what every session did |
| `skills <status\|link\|unlink> [--repo path\|--global] [--targets agents,grok] [--dry-run] [--json]` | Mirror `.claude/skills` into the directories other harnesses read |

Sessions can be referenced by their friendly **name** or by a unique session-id prefix
(e.g. `--to captain-boopsnoot` or `--to 7619`).

`who`, `ledger list`, and `sim list` accept `--json` for machine-readable output. Together
with `who --assignable` and `handoff`, that is the dispatcher toolkit: one session can read
the roster and the ledger programmatically, pick an assignable session, message it an
assignment, and record the transfer as a ledger `handoff` event — the message is the nudge, the ledger is
the truth. Deliberately *not* included: spawning worker sessions. aircontrol coordinates
sessions; it does not execute work.

> **`assignable` is not "doing nothing".** It means the session declared no intent and
> holds no claims — a session can be mid-turn, editing files and running builds, and still
> be assignable. Claude Code's own cross-session roster uses *idle* for the other sense
> (finished its turn, nothing queued). A dispatcher that reads one as the other will hand
> work to a session that is already busy. A bare `release` returns a session to the pool by
> setting its intent to `unassigned`.

### Enforcement: the guard hook

Claims and leases are **enforced**, not just advisory. A `PreToolUse` hook (`guard`) runs
before every Edit/Write/NotebookEdit/Bash call and **denies**:

- edits on a path that overlaps another *live* session's explicit claim (same repo only;
  unclaimed paths always pass, and `recentPaths` stay advisory);
- `xcrun simctl boot|bootstatus <udid>` / `emulator -avd <name>` unless *this* session
  holds that device's lease;
- mutating `git stash` without the repo-scoped `stash` resource claim, or when another
  live session in the repo claims it too;
- deploy-shaped commands (`firebase deploy`, `npm run deploy`, `eas submit`,
  `wrangler deploy`, fastlane lanes) without a deploy claim that covers the target. Each
  built-in pattern names the system it ships to — `firebase deploy` needs `deploy:firebase`,
  `wrangler deploy` needs `deploy:cloudflare`, `fastlane deliver|pilot` needs `deploy:asc`,
  `fastlane supply` needs `deploy:play` — and a bare `deploy` claim covers all of them. A
  lane whose target is only knowable from its config (`fastlane beta`, `npm run deploy`,
  `eas submit`) stays unscoped: any deploy claim satisfies it, and it contends with every
  other deploy claim on the machine. Deploys have no fixed shape, so this list is
  best-effort and extendable per machine via `guardPatterns.deploy` in
  `~/.claude/agents/config.json` — an array whose entries are either a regex string or
  `{ "pattern": "<regex>", "scope": "<target>" }`.

A denial names the conflicting session and the command to run next; denials are recorded
in the session's `blockedAttempts` and appended to `guard.log`. Everything else is
*silence* — guard never emits an explicit allow, so stricter hooks and user permission
rules keep the last word, and any internal guard error fails open. Known limits:
`xcodebuild -destination` boots a simulator internally without a literal `simctl boot`,
which guard cannot see; intent and custom resources remain advisory.

### Simulator leases

A lease is an `O_EXCL` lockfile per device, so two
sessions cannot both hold one simulator no matter how they race.

```bash
node ~/.claude/hooks/coord.js sim acquire --session captain-boopsnoot \
  --for "myapp device QA" --platform ios --bundle-id com.example.myapp
# leased 287FD8C8-… (iPhone 17, iOS 26.5, shutdown) — affinity hit, app already installed
# export AIRCONTROL_SIM_UDID=287FD8C8-…

node ~/.claude/hooks/coord.js sim release --session captain-boopsnoot
# shut down and released 1 lease held by captain-boopsnoot; Simulator.app quit
```

- **Always a UDID, never a device name.** A name-based `-destination` resolves against
  `OS:latest`, and when that runtime holds no matching device `xcodebuild` executes **zero
  tests** and still exits 0.
- **Affinity.** The device a repo last used is remembered in `sim-affinity.json` and preferred on
  the next acquire, so agents reuse the simulator that already carries the app's data instead of
  seeding a cold one. Affinity is *verified*, not trusted: a single `simctl get_app_container`
  call confirms the app is really installed, and a miss falls through to a free device and
  rewrites the mapping.
- **Denial is loud.** A failed acquire prints the holder and exits non-zero, so a script that
  ignores the message still fails.
- **Cleanup shuts down what it owns.** `sim release` shuts down only the caller's leased devices
  before releasing them, and quits Simulator.app only when no iOS device or lease remains active.
  A real `SessionEnd` does the same best-effort cleanup; `/clear` only releases, because the
  session carries on. Pass `--keep-booted` to hand a device back still running.
- **A lease never outlives its holder, and neither does its device.** `sweep` clears any lease whose
  session has gone stale, and the next `sim list` or `sim acquire` shuts down the device that lease
  left booted. A live holder is always skipped, however old its lease, so this cannot stop a
  simulator that work is still running on.

Enumeration shells out to `simctl` / `adb` only inside `sim` subcommands and SessionEnd cleanup.
A missing Xcode or Android SDK yields an empty list, not an error.

### Work ledger

An index of open work across every repo on the machine, so a fresh session can find what a dead
one left behind.

```bash
node ~/.claude/hooks/coord.js ledger add --title "Remote Config device QA" \
  --points-at "openspec/changes/2026-08-26-remote-config-foreground-refresh/tasks.md#6.1-6.4" \
  --status blocked-on-human
node ~/.claude/hooks/coord.js ledger list --repo .
node ~/.claude/hooks/coord.js ledger take lg_7f2c1a --session captain-boopsnoot
```

- **`--points-at` is mandatory.** An entry indexes work; it never restates it. The pointer is an
  OpenSpec change, a plan file, a PR url, a `questions.md` item, or a memory file — whatever
  already holds the detail. This is what stops the ledger becoming a third copy of everyone's
  task list.
- **`in-progress` is derived, not stored.** If the owning session dies, the item folds back to
  `open` and displays `abandoned by <name>` — that is the pick-up path.
- **Priorities and dependencies are first-class.** `--priority low|normal|high|urgent` orders
  the queue; `--depends-on id1,id2` derives a `blocked-on-deps` state until every dep is done
  (a dep compacted away counts as met). Items untouched for 14 days are flagged
  `⚠ stale` in `ledger list`.
- **`ledger list` leaves the notes out.** Notes run to paragraphs and a machine can carry
  dozens of open items, so the default listing is one item per two lines: title, pointer,
  state, age. The pointer stays because it is how `take` finds the spec. `--notes` prints
  them inline and `ledger show <id>` prints every note on one item. This is not cosmetic:
  an agent re-sends every tool result on every later turn, and on 2026-09-12 a single
  `ledger list` was the most expensive result of an entire session.
- **Each session gets one suggestion.** The once-per-session ledger notice appends the
  highest-priority open item *in this repo* with deps met and no owner — so a fresh session
  knows what to pick up without asking.
- **`handoff` moves work between live sessions.** Ledger ownership transfers first (the durable
  record — a `handoff` event, not an ambiguous drop+take), then the sender's claims merge onto
  the recipient, then the recipient gets a message carrying the `--note` context. A crash
  mid-handoff reconciles from the ledger event.
- **Storage** is `~/.claude/agents/ledger.jsonl`, append-only. Every mutation is one JSON line
  and readers fold the log, so appending sessions cannot lose each other's writes. The one
  rewriter — compaction, run by `sweep` past 500 lines to drop items done more than 30 days
  ago — takes an `O_EXCL` lock and aborts untouched if the file moves under it.
- **Surfacing costs one line per session, not per prompt.** `register` arms the notice and the
  next `inject` renders it once, so it re-appears after `/clear` or a compact — when the context
  that knew about the work has just been thrown away — and never inflates the per-prompt roster
  block.

### Activity log

Every session leaves a durable per-day trail under `~/.claude/agents/activity/YYYY-MM-DD.jsonl`
— one compact JSON line per event, appended from the hooks and CLI commands that already see
the action. Deliberately lightweight: enough to look back and see who touched what, not a
transcript.

```bash
node ~/.claude/hooks/coord.js log                        # today, everyone
node ~/.claude/hooks/coord.js log --days 7 --repo .      # last week, this repo
node ~/.claude/hooks/coord.js log --session captain-boopsnoot --json
```

Recorded: session start and end (the end event carries final intent, touched paths, and open
claims — history that today would vanish with the session file), claims and releases, the
first touch of each file (an edit-heavy loop on one file logs once, not fifty times), notable
shell commands (deploys, `git push`, mutating `git stash`, simulator/emulator boots), simulator
lease acquire/release, message sends and handoffs (recipient only — message text never enters
the log), and guard denials.

Kept forever by default; set `activityRetentionDays` in `~/.claude/agents/config.json` to have
`sweep` prune day files older than that. Never synced across machines — like `guard.log`, it is
machine-local history.

### Cross-machine mirror (opt-in)

By default nothing leaves your box — with no `peers` configured, every cross-machine code
path is inert and the machine-local story stays literally true. Opting in means adding to
`~/.claude/agents/config.json`:

```json
{
  "machine": "macbook",
  "peers": [{ "name": "devbox", "host": "me@devbox", "dir": "~/.claude/agents" }],
  "autoSync": true
}
```

`coord.js sync` then mirrors each machine's canonical state (`sessions/`, `ledger.jsonl`,
`outbox/`) into the other's `remote/<machine>/…` namespace over plain `rsync`+`ssh` — your
existing ssh config does the auth; aircontrol stores no credentials. With `autoSync: true`,
`sweep` fires a detached, 60-second-throttled sync on session start; otherwise run it
manually or from cron. A dead peer just logs to `sync.log` and machine-local behavior
continues untouched.

What crosses machines and what doesn't:

- **Roster**: `who` shows remote sessions tagged `name@machine` (display-only — guard and
  advisories act only on local state; a remote claim never hard-blocks a local edit).
- **Ledger**: remote events fold into `ledger list` tagged `@machine`; writes stay strictly
  local and mirrors are read-only. Repos are matched across machines by normalized
  `origin` URL (`git@host:a/b.git` ≡ `https://host/a/b`), since local `.git` paths differ
  per machine. Timestamps assume NTP-synced clocks.
- **Messages**: `send --to <name>` of a remote session stages the message in
  `outbox/<machine>/…`; the next sync on either side carries it over and the recipient's
  machine imports it exactly once (deduped by filename).
- **Never synced**: leases and simulators — a lease means exclusive use of a physically
  local device — plus `guard.log`, the `activity/` history, affinity, and config.

### Session cleanup

Four agent sessions routinely share this machine, so cleanup has to be session-scoped or it
destroys someone else's work. Three queries back the `session-cleanup` skill:

```bash
node ~/.claude/hooks/coord.js worktrees --others --session captain-boopsnoot
node ~/.claude/hooks/coord.js browsers --kill-mine --kill-orphaned
node ~/.claude/hooks/coord.js retro
```

- **`worktrees`** answers "is anyone else working here?" — the check `/clean_gone` lacks before it
  runs `git worktree remove --force`.
- **`browsers`** attributes `chrome-devtools-mcp` / `playwright-mcp` process trees by walking up
  to the owning `claude` ancestor process, not by env token — `playwright-mcp` trees carry no
  `CLAUDE_CODE_MESSAGING_TOKEN` of their own, so token-based attribution silently misclassified
  them. `--kill-mine` reaps trees that resolve to *this* session's `claude` and refuses if none
  resolve; `--kill-orphaned` additionally reaps trees whose owning `claude` has verifiably exited
  (no live socket under `/tmp/cc-socks`), and refuses rather than guess if liveness can't be
  checked. Attribution never resolves an owner through pid 1: orphans reparent to launchd, and
  grouping on that would let one session's orphan claim every dead session's browsers — or a live
  peer's.
- **`retro`** ranks tool results by `bytes × turns remaining`, because a result is re-sent on every
  later turn — a 13 KB result early costs far more than a 40 KB result last. It reports
  `output + cache_creation` as spend and prints `cache_read` separately, labelled as discounted;
  reporting the raw figure makes every long session look catastrophic. It prints a summary only,
  never transcript content.

### Git lock doctor

`doctor` is read-only by default. It finds repository and worktree Git directories,
then classifies each `index.lock`. A lock is repairable only when it is a regular,
zero-byte file at least 10 minutes old, has not changed across two probes, has no Git
operation marker, has no writable open file handle, and no Git process is running.
If any safety check cannot be completed, AirControl leaves the lock alone.

```bash
# Diagnose every repo under a project directory
node ~/.codex/hooks/coord.js doctor --roots ~/Documents/Projects

# Explicitly remove only the locks that pass every safety check
node ~/.codex/hooks/coord.js doctor --roots ~/Documents/Projects --repair
```

Repairs are recorded as JSON Lines in `~/.claude/agents/doctor.log`. Lock files are
never removed automatically during hooks or ordinary roster operations.

## Skills across harnesses

Skills follow one open standard (a `SKILL.md` with frontmatter) but not one location.
Claude Code reads `.claude/skills/` and `~/.claude/skills/`; Codex, Gemini CLI, opencode,
Cursor, Kimi, Amp and Copilot read `.agents/skills/` and `~/.agents/skills/`; Grok Build
reads `.grok/skills/`. All of them follow symlinks, and Claude Code cannot be pointed
elsewhere, so aircontrol leaves the real directories in `.claude/skills` and writes one
relative symlink per skill into the other locations:

```
.agents/skills/release-prep -> ../../.claude/skills/release-prep
```

- **Automatic per repo.** `register` (SessionStart, either harness) links the repo the
  session opened in whenever it has a `.claude/skills` directory. The links show up as
  untracked files; commit them so the next clone has them too. Opt out with
  `{ "skills": { "autoLink": false } }` in `~/.claude/agents/config.json`, or add targets
  with `{ "skills": { "targets": ["agents", "grok"] } }`.
- **Once for the user level.** The installer runs `skills link --global`, which fills
  `~/.agents/skills/` from `~/.claude/skills/`.
- **Additive, never destructive.** A real directory or someone else's symlink on the
  target side is reported as a conflict and left alone. A dangling link of ours whose
  skill was renamed is repointed. `skills unlink` removes only links that resolve into
  `.claude/skills`.
- **Not plugins.** Skills shipped by Claude Code plugins (hundreds, on a busy install)
  stay Claude-only: Codex caps its skill catalog at 2% of the context window by default,
  and a flood of plugin skills would crowd out the ones that matter.
- **`~/.codex/skills` is legacy.** It is undocumented today; `skills status --global`
  lists any skills there that duplicate `~/.claude/skills`, so you can delete the copies
  once the `~/.agents/skills` links cover Codex.

`skills status` shows what would happen; `link --dry-run` shows the exact plan; `--json`
makes either machine-readable.

## How it works

- **State:** one JSON file per session under `~/.claude/agents/sessions/`, plus a
  per-session inbox under `~/.claude/agents/messages/`, one lockfile per leased device under
  `~/.claude/agents/leases/`, the append-only `~/.claude/agents/ledger.jsonl`, per-day activity
  history under `~/.claude/agents/activity/`, the repo→device
  map in `~/.claude/agents/sim-affinity.json`, and the name-style choice in
  `~/.claude/agents/config.json`. Override the root with the `AIRCONTROL_DIR` env var.
- **Hooks:** both clients map `SessionStart` → `register`, `UserPromptSubmit` →
  `inject`, file-editing `PostToolUse` → `beat`, `PreToolUse` → `guard`, `Stop` →
  `nudge`, and `SessionEnd` → `deregister`. `nudge` delivers pending messages at the end
  of a turn and blocks at most once per batch — delivered messages are marked read, so the
  following `Stop` finds an empty inbox and the turn ends.
  Codex also starts a background inbox listener from registration; the native queue
  wakes idle threads without another user prompt. Its real SessionEnd archives the completed
  thread; `/clear` remains active and is excluded. Listener status and singleton locks
  live under `~/.claude/agents/listeners/`.
- **Harness parity:**

  | | Claude Code | Codex |
  |---|---|---|
  | roster, claims, guard, messages, sim leases, ledger | ✓ | ✓ |
  | `Stop` push delivery | ✓ | ✓ |
  | persistent idle inbox listener and automatic thread title | — | ✓ (local daemon) |
  | context budget line, `retro` | ✓ (transcript JSONL) | ✓ (rollout JSONL, plus Codex's own `token_count`) |
  | `[codex]` tag in `who` and the roster | — | ✓ |
  | background-task reaping (`tasks`) | ✓ | — (no shell snapshots to attribute) |

  Codex exposes no session-id env var, so every Codex hook command carries
  `--harness codex`; a session registered by an older hooks.json is still recognised by the
  `~/.codex/sessions/` rollout path in `transcript_path`.
- **Codex edits:** `apply_patch` paths are extracted from the patch and recorded as
  recent paths for overlap advisories.
- **Liveness:** a session with no claims goes stale after 30 min without a heartbeat and
  is swept automatically. A session **holding claims** survives for 2 hours instead:
  going quiet is not evidence of death, and expiring a claim on that evidence would
  silently unlock a path whose holder is alive and still editing it. `SessionEnd` and
  `release` are the fast paths; the TTL is only the backstop for a session that died
  without either. A denial names the claimant's last-seen age, and
  `release --session <them>` frees the claim of one that is plainly gone. Read messages are cleaned up after 7 days; orphaned unread messages
  after 30 days; abandoned session temp files after 24 hours; empty inbox directories
  are removed. These state sweeps never touch project files.
- **Read-only Git:** AirControl's own Git inspection always uses
  `GIT_OPTIONAL_LOCKS=0`, and the installer applies the same protection to Claude Code's
  background status lines and hooks.

## Develop / test

```bash
node --test        # built-in node:test runner; no dependencies
```

`coord.js` keeps logic in exported helpers so the fs/git layer stays thin and testable.
Installer tests run against a temporary home and verify hook merging and idempotence.
After editing, re-run `node install.js` to redeploy both hook copies.

## Uninstall

```bash
npx aircontrol uninstall          # add --purge to also delete ~/.claude/agents
```

This removes the hook entries from `~/.claude/settings.json` and `~/.codex/hooks.json`
(leaving your own hooks), the runtime copies under both `hooks/` dirs, the AirControl
sections and mirror block in `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`, the skills
aircontrol installed, the cmux launcher and its shell-profile block, and the Codex
monitor LaunchAgent. It leaves `GIT_OPTIONAL_LOCKS` and the `~/.codex/config.toml` keys
in place (restore the `.bak-aircontrol` backups to drop them), plus any
`skills link --repo` links (`coord.js skills unlink --repo <path>` removes those).

## License

MIT © Andre Havasi
