---
name: aircontrol
description: Full reference for aircontrol parallel-session coordination: claims, deploy targets, simulator leases, shared-tree git hygiene, test queue, ledger, disk, index.lock, cleanup. Use when claiming paths, leasing a simulator, queueing an Xcode build, committing in a shared tree, or when an aircontrol denial or advisory needs interpreting.
---

Codex sessions: read `~/.codex/hooks/coord.js` wherever this says `~/.claude/hooks/coord.js`.

# aircontrol reference

Every prompt receives an `[aircontrol]` context block with your session name, other live
Claude Code and Codex sessions on the machine, messages, and conflict advisories. Sessions
show as friendly names (e.g. `captain-snugglepants`); `--session`/`--to` accept a name or a
session-id prefix.

- **At the start of any task that may edit files or use shared resources**, declare
  intent and claim only the paths/resources that apply:
  `node ~/.claude/hooks/coord.js claim --session <your-name> --intent "<what you're doing>" --paths <dirs,you,will,touch> --resources sim:<name>,deploy:<target>,stash`
- **Claim the deploy target, not bare `deploy`.** `deploy:asc`, `deploy:firebase`,
  `deploy:cloudflare`, `deploy:play` — two sessions shipping to different systems then
  never wait on each other. Bare `deploy` still means every target and collides with all
  of them, so reach for it only when the lane's destination is genuinely unknown.
- **Before** editing near another claim, using a simulator, deploying, stashing, or
  merging, check the roster block.
- **⚠️ Advisories are stop-and-coordinate signals.** Message the other session and wait
  a turn instead of pushing through:
  `node ~/.claude/hooks/coord.js send --session <your-name> --to <their-name> "text"`
- **Some conflicts are enforced, not advisory.** A PreToolUse guard DENIES edits on paths
  claimed by another live session, simulator/emulator boots without your own lease, and
  `git stash` / deploy commands without the matching resource claim. A denial names who
  holds the conflict and what to run: read the reason, message/claim/wait as it says,
  then retry the tool call. Do not try to route around a denial.
- **Inbound messages reach you at the end of your turn**, with nobody typing: a Stop hook
  delivers them and hands you back control to act. Answer the ones that need an answer before
  you finish. For a **live Claude Code peer**, prefer the built-in `ListAgents` + `SendMessage`
  tools — delivery there is immediate and mid-turn. Match a peer to its roster line by worktree
  and branch, not by name: the two registries name sessions differently, and a session idle for
  30+ minutes drops off the roster while still being reachable natively. Use
  `node ~/.claude/hooks/coord.js send` for Codex peers and for anything that must survive the recipient
  being offline.
- **When the task is complete**, release its claims:
  `node ~/.claude/hooks/coord.js release --session <your-name>`
- If the roster block is missing, run `node ~/.claude/hooks/coord.js who` and do not assume the room
  is empty. For Claude Code, review and trust the installed hooks before shared-resource work.
- **Queue Xcode builds and simulator tests when testing is enabled**: submit through the project verification entrypoint or `node ~/.claude/hooks/coord.js test submit --session <your-name> --kind ios-test|build -- <argv>`. Submission returns immediately; `test status <job-id>` reports progress. Never release a queued job's simulator manually: cancel the job or wait for cleanup. The queue is simulator-only: a UI test on a physical device runs outside it, and only after `dsmemberutil checkmembership -U $USER -G _developer` reports membership, or xcodebuild blocks on a terminal `Password:` prompt the user never sees. If a device run still fails, switch to manual device QA instead of retrying.
- **An `unhealthy sim <name>` warning** means a queued boot hung twice; the queue now skips that device. Once nobody holds it, `node ~/.claude/hooks/coord.js sim reset <name>` shuts it down, erases it and returns it to the pool. Never boot or erase it by hand.
- **Never boot a simulator or emulator without leasing it first** — a lease is enforced,
  unlike a claim: `node ~/.claude/hooks/coord.js sim acquire --session <your-name> --for "<what you're testing>"`.
  It returns a **UDID**: use the one from *this* acquire, never one from an earlier lease (a
  name-based `-destination` silently runs zero tests). It prefers the
  device that already has that app's data installed. `sim list` shows who holds what.
  Gate every later step on the grant (`… sim acquire … | grep -q '^leased' || exit 1`):
  a denial prints `DENIED` and the next chained command still runs.
- **Release the device when you are done with it, not at some later cleanup** —
  `node ~/.claude/hooks/coord.js sim release --session <your-name>` shuts it down and hands it back in one
  step (`--keep-booted` opts out for a handoff). A real session end does the same for anything
  you still hold, but a lease you dropped earlier is past its reach: a device released while it is
  still booted is an orphan nothing else knows to stop.
- **When you start fresh in a repo**, the once-per-session `ledger:` line tells you whether
  unfinished work is waiting. `node ~/.claude/hooks/coord.js ledger list --repo .` to see it, `ledger take <id>`
  before working on it. Items abandoned by a dead session are yours to pick up. Log deferred work
  with `ledger add --title "…" --points-at <spec|plan|PR|memory>` rather than leaving it in a
  file nobody will find.
- **A shared working tree means a shared file is not yours to `git add`.** When another live
  session has uncommitted edits in a file you also changed, `git add <file>` stages their
  half-finished work into your commit, and `git diff HEAD -- <file>` carries it into any
  verification worktree built from that diff -- which then fails on their change, not yours.
  `git add -p` is interactive and unavailable here, and `git stash` is a claimed resource that
  takes their work with it. Rebuild your own hunks on a fresh copy instead: patch
  `git show HEAD:<file>`, then `git hash-object -w` it and
  `git update-index --cacheinfo 100644,<blob>,<file>` to stage only your version. Their
  working-tree edits survive untouched.
- **In a shared tree, HEAD is shared too.** `git commit` lands on whatever branch the last
  session checked out, so another session's work can arrive on your branch without either of
  you doing anything wrong. Run `git branch --show-current` before committing, and announce a
  branch switch to the room before and after. While another live session works in the tree, never
  `checkout`/`checkout -b` there: start your branch in a worktree off `origin/<default>` instead.
  Undoing a merge with `git reset --hard` strands
  everything reachable only through the ref you move, not only what you noticed: check
  `git log <target>..<current>` first for what the move would lose, and
  `git branch --contains <sha>` after for each stranded commit. An orphaned one returns empty
  and survives only in the reflog until it is collected.
- **Before exploring, planning or editing an existing surface, `git fetch` and read it at
  `origin/<default>`.** Uncommitted local copies may be superseded by merged work; plan and build on
  the remote version, not the stale one.
- **A `context:` line in the block means this session's tool results are getting expensive.**
  It names the costliest one, scored the way `retro` scores it (`bytes x turns re-sent`) but live
  rather than post-mortem. Two things actually move that number: bound an image result the way
  *Big tool results* says, and hand a broad fan-out search to an Explore subagent so only its
  conclusion lands in this context. Bounded edits stay inline — delegating those costs more
  than doing them.
- **A `disk:` line means the volume is running out of space.** Act on it now: at 0 bytes free
  no tool can run, including the one that frees space. Run `node ~/.claude/hooks/coord.js disk --prune` first, which
  removes only build output and tmp dirs nothing owns any more (DerivedData of deleted worktrees,
  ended sessions' /tmp dirs, idle /tmp builds). Tell the operator what it reclaimed,
  and ask before deleting anything else (simulators, caches, runtimes, and any `idle worktree`
  it lists, which it reports but never removes).
- **When a turn that did real work ends with nothing pending, the Stop hook offers
  the `next-steps` skill.** Pass the offer on in one line and finish the turn; do not
  invoke the skill or start planning off the back of it, because the offer is for the
  operator to accept, not an instruction to act. It stays quiet after pure conversation
  and while messages are waiting, and re-arms only once further work has happened.
- **At the end of a session, use the `session-cleanup` skill — never `/clean_gone`.** That command
  runs `git worktree remove --force` over every `[gone]` branch with no check for who is using it,
  so it silently discards another live session's uncommitted work. `session-cleanup` skips claimed
  and dirty worktrees, reaps only this session's browser processes
  (`node ~/.claude/hooks/coord.js browsers --kill-mine`), and runs `node ~/.claude/hooks/coord.js retro` first to measure where
  the session's tokens actually went.
- If Git reports a stale `.git/index.lock`, diagnose first with
  `node ~/.claude/hooks/coord.js doctor --roots <project-root>`. Repair is explicit
  (add `--repair`) and only removes old, zero-byte, unchanged locks when no Git
  operation, writable handle, or Git process is active.
- Never edit the installed hook copy directly: the next install overwrites it. Update with
  `npx aircontrol@latest install`, or edit a clone of the repository and run `node install.js`.
  Once a clone has installed, update from that clone: the package refuses to replace a clone install
  without `--force`, because the published package can lag the clone's main.
