---
name: session-cleanup
description: >
  Use at the end of a working session, when the user says "wrap up", "clean up", "we're done",
  "finish up here", "clean up your mess", or asks to tidy worktrees, stale branches, leftover
  browser processes, or aircontrol claims. Also use INSTEAD of /clean_gone, which force-removes
  other agents' worktrees. Runs a transcript-measured retrospective first, mirrors explicitly
  approved global instruction changes into Codex's AGENTS.md, then reaps only this session's
  resources.
---

# Session cleanup

Five steps, in order. The retrospective goes **first**, while the context that produced it still
exists. Everything after it only removes things this session owns.

The one rule that governs all of it: **other sessions' work is untouchable.** Four agent sessions
routinely run in parallel on this machine, in separate worktrees, on separate simulators, with
separate browsers. A cleanup that guesses wrong destroys someone else's uncommitted work.

## 1. Retrospective — measure, then propose

```bash
node ~/.claude/hooks/coord.js retro --session <aircontrol-session-name>
```

Use the friendly name from the injected `[aircontrol] You are session …` line. Passing the
session explicitly works for both Claude transcripts and Codex rollout JSONL files; a bare
command is ambiguous when several sessions share a worktree. Codex keeps active rollouts under
`~/.codex/sessions/YYYY/MM/DD/` and archived rollouts under `~/.codex/archived_sessions/`.

This reads the session transcript mechanically and prints a summary. **Never read the transcript
yourself** — it is megabytes, and loading it to analyse cost is self-defeating. Do not rely on
memory either: recency bias is severe, and after a compaction you cannot see the early session at
all, which is where the worst waste usually is.

Read the output as follows:

- **`billed-ish tokens`** (`output + cache_creation`) is the number that matters. `cache reads` is
  printed separately and deliberately: it is heavily discounted, and treating it as spend makes
  every long session look catastrophic.
- **The ranking is `bytes × turns remaining`, not bytes.** A result is re-sent on every later turn,
  so a 13 KB result on turn 149 of 1354 costs more than a 40 KB result near the end. Act on the
  ranking, not on what felt big.
- **`by tool` is where rules live.** One large result is just a large result. The same tool
  producing large results 200 times is a habit, and a habit is the only thing a CLAUDE.md rule can
  fix.

Then propose — **do not edit anything unless the user has explicitly asked to apply the retrospective changes**:

- Findings must cite evidence from this session, **in the message to the user**. No speculative
  refactoring ideas.
- ⚠️ **The rule text itself carries no evidence.** Write general guidance only: no dates, session
  ids, commit hashes, measured token or byte counts, one-off file paths, or "last time X happened"
  anecdotes. A CLAUDE.md rule is read by every future session in a context where the incident is
  absent, so a specific example ages badly, invites the reader to argue with the example instead of
  following the rule, and quietly narrows a general instruction to the one case that produced it.
  The measurements are what persuade the user to accept the rule — they belong in the chat, and they
  stay there.
- **A threshold is not evidence.** A number the reader must act on — a size limit, a count, a
  command to run instead — is a parameter of the rule and stays in it. What goes is the provenance:
  keep "over ~45 KB, do X", drop "because on <date> a <n> KB file cost <n> tokens".
- Print the suggested CLAUDE.md diff and the file's line count before and after. Every rule added
  is a tax on every prompt of every future session in that repo, forever.
- You may **delete and merge** rules, not only add. Bias to net-zero. Dated evidence and worked
  examples already sitting in a section you are touching are the first things to cut.
- **"Nothing found" is a legitimate, complete answer** — same shape as `## Your Next Steps` →
  "Nothing needed." A ritual that always emits, emits noise. Say it plainly and move to step 2.

### Apply an approved global instruction change

Proposal-only is the default. If the user explicitly asks to apply an approved retrospective change,
edit the canonical `~/.claude/CLAUDE.md` (for the aircontrol section, edit its source template in
`install.js` in a clone of the aircontrol repository instead; the installer overwrites it), then
re-run the installer: `node install.js` from that clone, or `npx aircontrol@latest install`.

The installer owns the global Codex mirror. Never edit `~/.codex/AGENTS.md` directly. Verify that
its `<!-- aircontrol:mirror-start -->` block contains the updated rule, uses Codex hook paths, and
does not duplicate the AirControl coordination section. A second installer run must report the
mirror as up to date. Codex reads this skill through the existing
`~/.agents/skills/session-cleanup` symlink, so do not create a second skill copy.

## 2. Background tasks

A background shell outlives the turn that started it, and nothing surfaces it afterwards. Sweep
before browsers and leases: a running `xcodebuild` holds the simulator step 5 hands back.

1. `TaskStop` every background task ID still in this conversation.
2. Then sweep, because step 1 only reaches what survived the last compaction:

```bash
node ~/.claude/hooks/coord.js tasks              # classify: mine / other sessions / orphaned
node ~/.claude/hooks/coord.js tasks --kill-mine
```

`--kill-mine` takes only direct children of **this** session's `claude` process carrying the Bash
tool's shell-snapshot signature, and it kills each shell's descendants first so an `xcodebuild`
underneath is not orphaned by its parent dying. Another session's shells hang off its own `claude`
pid and are unreachable by construction; an MCP server shares the parent but has no snapshot in its
argv, so it is never a target.

Orphans — parent already gone, reparented to launchd — are reported with the exact `kill` line and
left alone, the same posture as browsers. If the command refuses because no `claude` ancestor
resolved, report the PIDs and stop. Never `pkill -f zsh` or anything else pattern-based: that kills
live sessions' work mid-command.

SessionEnd reaps these too, so an abandoned session cleans up after itself. `/clear` deliberately
does not: the session carries on and its shells are still working.

## 3. Browsers

Close pages through the MCP tool first so the browser exits cleanly, then:

```bash
node ~/.claude/hooks/coord.js browsers            # classify: mine / other sessions / unattributed
node ~/.claude/hooks/coord.js browsers --kill-mine
```

`--kill-mine` touches only processes attributable to this session, via
`CLAUDE_CODE_MESSAGING_TOKEN`. Attribution crosses sibling MCP trees (playwright's processes carry
no token; they are matched through the shared session process) but **never** through pid 1 — every
orphan on the machine reparents to launchd, and grouping on that would hand this session ownership
of every dead session's browsers.

If the token cannot be read, the command refuses and exits non-zero. That is correct: report the
PIDs and let the user reap them. Never `pkill -f chrome` or similar — it kills live sessions'
browsers mid-navigation.

Report orphans with the exact `kill` line and leave them alone.

## 4. Worktrees and stale branches

**Do not use `/clean_gone`.** It runs `git worktree remove --force` over every `[gone]` branch with
no check for who is using it, and `--force` discards uncommitted work.

```bash
node ~/.claude/hooks/coord.js worktrees --others --session <your-name>
git branch -v | grep '\[gone\]'
```

For each `[gone]` branch, in this order:

1. **Held by another live session?** Skip it. Say whose it is.
2. **`git -C <worktree> status --porcelain` non-empty?** Skip it and report the path. Uncommitted
   work is someone's unfinished thought, including possibly your own.
3. Otherwise `git worktree remove <path>` — **without `--force`**. If it refuses, that refusal is
   information; report it rather than escalating.
4. Only delete a branch whose worktree was actually removed. Never `-D` one that was skipped.
5. Then reclaim the build output those worktrees left behind. Xcode never deletes a removed
   worktree's DerivedData (several GB each), and nothing else will:

   ```bash
   node ~/.claude/hooks/coord.js disk --prune
   ```

   It removes only folders whose project path is gone and unclaimed, so it is safe with other
   sessions live. Report the `reclaimed:` line.

## 5. Release aircontrol state

```bash
node ~/.claude/hooks/coord.js sim release --session <your-name>
node ~/.claude/hooks/coord.js release --session <your-name>
```

Release stops only devices leased by this session before handing them back. Simulator.app quits
only when no iOS simulator or lease remains active, so another session's device stays untouched.
A real SessionEnd performs the same best-effort shutdown; `/clear` deliberately does not because
the session continues. A lease dropped mid-session is past SessionEnd's reach, which is why
release stops the device rather than leaving that to cleanup.

Leases are still reclaimed after `LEASE_TTL_MS` if a session dies without deregistering, and the
next `sim list` or `sim acquire` shuts down the device that lease left booted. Devices held by a
live session are never touched, however old the lease.

Finally, if anything is still open — unpushed work, a decision the user owes, a QA step — log it so
the next session finds it:

```bash
node ~/.claude/hooks/coord.js ledger add --title "…" --points-at <spec|plan|PR|memory>
```
