---
name: ledger-drain
description: >
  Use when the user wants the aircontrol ledger worked through unattended, item after item —
  "drain the ledger", "work through the ledger", "do every ledger item you can", "implement the
  remaining ledger items", "loop the ledger until nothing is left", "/ledger-drain". Classifies
  each open item in this repo, implements the ones an agent can finish alone in a fresh subagent,
  opens a PR for each, and skips anything that needs a human, a design decision or a console.
  NOT for one item (that is `ledger-next`) and NOT for triage only (`ledger-next` Mode A).
---

# Ledger drain: work every automatable item, one subagent each

A loop over the ledger for **this repo**. The main session only orchestrates: it ranks,
classifies, and hands each buildable item to a **fresh subagent** that does the work and returns
about 12 lines. That subagent boundary replaces `/compact`, which a skill cannot invoke. The main
context grows by one summary per item, never by an item's build logs.

Verbs, the evidence rule and the `take`-first rule all come from `ledger-next`; read its
"The one rule" and Mode B. This skill adds only the loop, the classifier and the subagent contract.

Args: `--dry-run` (classify and print the table, write nothing), `--max N` (items built per
run, default 8).

## Consent

Most repos require the user's OK before an agent pushes or opens a PR. **Invoking this skill is
that OK, for this run, for the items it classifies AUTO**: push a branch, open a PR against the
base branch. Nothing else. It does not cover merging, deploying, store or cloud console actions,
posting anywhere public, sending messages, or paid API calls. Those stay on the user, and an
item that needs one is HUMAN.

## 0. Preflight

```bash
node ~/.claude/hooks/coord.js ledger list --repo . --json > "$TMPDIR/ledger.json"   # never --repo all
git fetch -q origin
```

- The JSON runs to tens of KB. Never print it; project it (`node -e`/`jq`) down to `id, title,
  pointsAt, priority, opened, updated, owner, abandonedBy, dependsOn, state, notes[].ts/.text`.
- Take the session name from the `[aircontrol]` block.
- A `disk:` line means run `coord.js disk --prune` first, or stop.
- Read the repo's instruction file once: `CLAUDE.md`, else `AGENTS.md`, else `CONTRIBUTING.md`,
  else the README's development section. With none, every value below takes its fallback. The
  repo's instruction file wins over any other config (e.g. a trello-backlog `worktreeDir`). Use `grep -n '^#'` and
  then `sed -n` for the sections you need. From it, resolve and write down these three things for
  the run:
  - **base**: the branch it says feature work targets ("integration branch", "PRs target …").
    Fall back to `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`.
  - **worktree rule**: its convention if it has one. Otherwise
    `git worktree add -b <type>/<slug> ../<repo>-<slug> origin/<base>`.
  - **gate**: in this order: `git config core.hooksPath`, the repo's ship or verify skill, the
    build/test section of the instruction file, then `package.json` scripts / `Makefile`. Use the
    cheapest gate that covers the change (unit before UI).
- Refused surfaces: always `CLAUDE.md`, `AGENTS.md`, `.claude/**`, `.agents/**`, secrets files,
  and payment, entitlement or paywall code. If `~/.claude/trello-backlog/config.json` has a board
  for this repo, add its `refuseSurfaces`.

## 1. Gather and rank

`next-steps` without its question. That skill stops to ask the user, which would end the loop.
From the JSON keep: `state == "open"` (`blocked-on-human`, `blocked-on-deps` and `in-progress`
are out), `owner` null or `abandonedBy` set, `dependsOn` all done.
Order by `priority` (urgent > high > normal > low), then oldest `opened`.

**Skip** any item that has a note starting `ledger-drain:`, unless its `updated` is later than
that note's `ts` (someone edited the title or added facts since). The note markers are this
loop's memory. Without them every run re-argues the same items.

## 2. Classify

Cheap reads only: `sed -n` / `grep` on the `pointsAt` target. A `memory:<name>[#anchor]` pointer
resolves to `~/.claude/projects/<repo path with / as ->/memory/<name>.md`; read only the section
the anchor or the title names. Then at most one `git log -S` or
`git log -- <path>`. Never a whole-file read. Each item gets exactly one verdict, checked in this
order:

| Verdict | When | Ledger write (skip all writes on `--dry-run`) |
|---|---|---|
| DONE | a commit or file already contains it | `done <id> --note "<sha or file:line>"` |
| STALE | its premise is gone: a passed date, a removed file, a superseded approach | `note <id> "ledger-drain: stale – <why>"` |
| HUMAN | physical device QA, a console or dashboard, a login, a credential, a paid run, posting or messaging, waiting on a date or an external event, a PR review, or no runnable gate | `block <id>` and `note <id> "ledger-drain: human – <what>"` |
| NEEDS-DESIGN | idea-stage, no written spec, or an open product or pricing choice | `note <id> "ledger-drain: needs-design – <the open question>"` |
| REFUSED | the change would touch a refused surface | `note <id> "ledger-drain: refused – <path>"` |
| AUTO | target and finished state are both clear, and the gate can prove it in this repo | go to step 3 |

AUTO is the narrow verdict. **Bounded fixes only**: a bug, a missing test or telemetry call, a
spec'd small change, a docs or wiki line. "Verify X happened", "QA Y", "check the first run of Z"
are HUMAN or wait on an event. They are never AUTO, even when a query could half-answer them.
If you would have to pick a product default to start, the verdict is NEEDS-DESIGN.
If the only open question is "already done?" and answering it needs a build or a test run, call
it AUTO: the subagent checks first and returns `done-already`.

On `--dry-run`, classify every candidate, print the table, and stop.

## 3. Take, then dispatch one subagent

```bash
node ~/.claude/hooks/coord.js ledger take <id> --session <name>   # raced → skip this item
```

Dispatch **one** `general-purpose` subagent, foreground, inheriting the session model. Never a
haiku-tier model: those stall on long builds. Run items one at a time, never in parallel, because
simulators and build locks are shared across sessions. Prompt:

```
You are implementing one aircontrol ledger item end to end. Item JSON: <json>
pointsAt: <target>. Repo: <path>. Base: <base>. Gate: <gate>. Worktree rule: <rule>.
Your aircontrol session name for claims: <name>-<id>.

1. Read the pointsAt target. If finishing this needs a human (device, console, credential,
   decision), stop now and return status: blocked with the reason.
2. Create the worktree per the rule off origin/<base>; `coord.js claim` its path.
3. Follow the repo's CLAUDE.md/AGENTS.md. Bugs: superpowers:systematic-debugging. New code:
   superpowers:test-driven-development. Build what the item says, nothing adjacent. Never touch:
   <refused surfaces>.
4. A simulator/emulator goes through `coord.js sim acquire` and gets released before you return.
5. Run the gate. Use `set -o pipefail` or a log plus an anchored grep; never trust a piped exit
   code. Red → re-run the failing test on a clean worktree of <base> to attribute it. If yours,
   fix or reset and return status: failed. Never push red.
6. Green → commit `type(scope): …` with the session's trailer, push the branch,
   `gh pr create --base <base> --head <branch>`. <base> is never the head. Never merge, never deploy.
7. `coord.js release`. Leave the worktree in place.

Return at most 12 lines, nothing else:
status: pr | blocked | failed | done-already
pr: <url or ->   sha: <sha or ->
gate: <the success line, e.g. "Executed 812 tests, 0 failures">
qa: <one concrete step for the user to confirm it, or ->
reason: <one line, for blocked/failed/done-already>
bonus: <latent bugs or stale docs noticed, one line each, or ->
```

## 4. Close on the result

| status | Ledger |
|---|---|
| `pr` | `block <id>` + `note <id> "ledger-drain: pr – <url>, awaiting review/QA"`. Its next step is the user's merge, so blocked-on-human is accurate. |
| `done-already` | `done <id> --note "<evidence the subagent gave>"` |
| `blocked` | `block <id>` + `note <id> "ledger-drain: human – <reason>"` |
| `failed` | `drop <id>` + `note <id> "ledger-drain: failed – <reason>"` |

Bonus finds go in as new items: `ledger add --title … --points-at …`. Do not fix them in this run.
Add one row to the run table.

## 5. Loop

Back to step 1 with a fresh `ledger list`, since other sessions add and take items too. Stop when:

- no AUTO candidate is left, or
- `--max` items have been built, or
- **two `failed` in a row** (that is an environment problem, not two bad items), or
- a `disk:` warning appears or a coordination guard denies you.

## 6. Report

A table `id → verdict → PR / evidence`, then open/blocked counts before and after. List the
NEEDS-DESIGN items by their open question, since they are what to brainstorm next.

End with `## Your Next Steps`: for each PR, one numbered review/QA step naming the PR and the
`qa:` line; then the needs-design questions. Offer `session-cleanup` in one line.
`coord.js release --session <name>`.

## Harnesses without a subagent tool

Codex and others: do steps 0–4 for **one** AUTO item, report, and tell the user to start a fresh
session for the next one. The markers make the next run pick up where this one stopped.

## Red flags

- Building an item whose verdict you had to argue yourself into. Downgrade it to NEEDS-DESIGN.
- A subagent reply over 12 lines pasted into the main context. Summarise it to the contract.
- `done` without a sha or `file:line`.
- Merging, deploying, or editing an installed `coord.js`. Never part of this loop.
- Removing a worktree. They stay until the user confirms the PR; `session-cleanup` reaps them.
