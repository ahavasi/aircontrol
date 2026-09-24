---
name: ledger-next
description: >
  Use to read, triage, or work the aircontrol work ledger — the cross-repo list of unfinished work
  that `coord.js ledger` tracks and that gets injected into every prompt as an "[aircontrol] ledger:
  N open" line plus a "suggested next" nudge. Triggers on "what's on the ledger", "any ledger
  items", "next ledger item", "triage the ledger", "clean up the ledger", "work the ledger", "pick
  up ledger work", "what's unfinished here", "anything left over", and on accepting the injected
  nudge itself — "take that one", "do the suggested item", "yes, lg_xxxxxx".
---

# Ledger: triage and work

The ledger is an append-only pointer list at `~/.claude/agents/ledger.jsonl`, folded into current
state by `coord.js`. **An entry indexes work, it never restates it** — `pointsAt` is mandatory, so
every item has a target you can read: an OpenSpec `tasks.md`, a wiki page, a memory file, a source
path, a PR.

Two modes. Ask which if the request is ambiguous; "any ledger items?" means **triage**, "what's
next" means **work one**.

- **Triage** (Mode A) — make `state: open` mean *an agent can start this now*. Ledger writes only.
- **Work one** (Mode B) — take the top item, do it, close it honestly.

Full CLI:

```
node ~/.claude/hooks/coord.js ledger <add|list|take|note|block|unblock|done|drop> [id]
    [--repo .|all] [--status open|blocked-on-human|blocked-on-deps|in-progress] [--mine] [--json]
    [--title "…"] [--points-at <ref>] [--priority low|normal|high|urgent] [--depends-on id1,id2]
    [--note "…"] [--session <your-name>]
```

## The one rule

**Never close an item you did not verify against source.** A `done` note that says "verified" or
"I believe this shipped" is a failed triage — it is the same failure as a test that asserts nothing.
Every `done` carries a commit sha, a `file:line`, or a query result. If you cannot produce one,
the verb is `note`, not `done`.

---

## Mode A — triage

**1. Read the list.**

```bash
node ~/.claude/hooks/coord.js ledger list --repo . --json
```

`--repo .` by default. Use `--repo all` only when the user asks for other repos by name — another
repo's items are not actionable from here, and pulling 70+ of them is pure context cost.

**2. Batch the cheap checks before going item by item.**

Group items by what would answer them, then run one command per group:

| Item points at | One command answers many |
|---|---|
| a source path | `git log --oneline --since=<oldest opened> -- <paths>` , or `git log -S<symbol>` |
| an OpenSpec `tasks.md#N` | `grep -n '^- \[' <that file>` — a ticked box is evidence |
| a wiki page or memory file | `sed -n` the named section; do not read the whole file |
| a shipped-version claim | `git tag --sort=-v:refname \| head`, `CHANGELOG.md`, the store listing |
| telemetry ("verify N events land") | the Sentry / PostHog MCP tools, not a guess |

**3. Ask four questions per item, in this order.**

1. **Already done?** A commit, a ticked task box, a file that now contains the fix.
2. **Premise stale?** A version in the title that has since shipped, a gate date that has passed,
   a file that no longer exists, a bug someone else fixed en route to something else.
3. **Duplicate?** Fold into the **older** id. The newer one gets `done --note "duplicate of lg_x"`.
4. **Needs a human?** Device QA on physical hardware, a store or cloud console click, an
   interactive login, an unanswered design question. These can never be `open` — an open item a
   session cannot start is what teaches everyone to ignore the nudge.

**4. Apply exactly one verb per item.**

```bash
ledger done  <id> --note "<evidence: sha / file:line / query result>"   # verified finished
ledger block <id>                                                       # needs a human
ledger note  <id> <text>                                                # new facts, still open
ledger drop  <id>                                                       # hand back ownership
```

…or leave it untouched. Nothing else. Triage does not edit code.

**5. Report.** A table of `id → verdict → evidence`, then the before/after counts by state. Say
plainly which items you left alone and why.

### Reversibility

`block` → `unblock`. `drop` → `take`. **`done` is the one-way one**: done items are compacted away
after a 30-day TTL (`LEDGER_DONE_TTL_MS`, `coord.js`). When in doubt, `note` and leave it open.

---

## Mode B — work one item

**1. Pick.**

Honor the injected `suggested next` if the prompt carries one. Otherwise re-derive its rule
(`suggestNextLedgerItem` in `coord.js`): `state === 'open'`, **this repo only**, highest `priority`,
then oldest `opened`. Skip anything only a human can do — that gets `block`, not an attempt.

**2. `take` it FIRST, before reading anything.**

```bash
node ~/.claude/hooks/coord.js ledger take <id> --session <your-name>
```

Taking first is what stops two parallel sessions doing the same work. It is append-then-verify
race-safe: if it errors `raced with <name> — they won`, that is real, pick another item. Never take
an item whose JSON shows another live `owner`. An `abandonedBy` value means the owner died and it
is fair game.

**3. Then claim the paths.**

```bash
node ~/.claude/hooks/coord.js claim --session <your-name> --intent "<id>: <title>" --paths <dirs>
```

**4. Read the `pointsAt` target, then delegate.**

This skill orchestrates; it never reimplements another workflow. Hand off by item shape:

| Item shape | Hand off to |
|---|---|
| OpenSpec change with unticked tasks | `openspec-apply-change` |
| a bug or unexplained behavior | `superpowers:systematic-debugging` |
| new code or a new function | `superpowers:test-driven-development` |
| landing finished work | that repo's ship or merge skill, if it has one |
| a release step | that repo's `release-prep` |

Follow the repo's own `CLAUDE.md` for conventions — build commands, commit style, whether OpenSpec
is required. Do not carry one repo's rules into another.

**5. Close honestly.**

```bash
ledger done  <id> --note "<sha>: <what was verified, how>"   # finished AND verified
ledger block <id>                                            # turned out to need a human
ledger drop  <id>                                            # abandoning mid-way
node ~/.claude/hooks/coord.js release --session <your-name>
```

`drop` matters: an item left owned by a session that ends looks in-progress to everyone else until
the session expires.

**6. One item per session** unless the user says otherwise. Chaining items is how a session ends up
re-sending a huge transcript on every turn.

---

## Logging new work

When you defer something, log it rather than leaving it in a file nobody will find:

```bash
node ~/.claude/hooks/coord.js ledger add --title "<80 chars max>" \
  --points-at <spec|plan|PR|memory|file:line> [--priority high] [--depends-on lg_a,lg_b]
```

`--points-at` is mandatory and `--title` is capped at 80 characters — both on purpose. Detail lives
behind the pointer, never in the title. If triage uncovers a real bug, `ledger add` it; do not fix
it inline and blow up the scope of a triage pass.

## Guard rails

- Never `done` without evidence in the note.
- Never `take` an item another live session owns.
- Triage mode makes zero code changes.
- `--repo .` unless the user names another repo.
- Do not edit `~/.claude/hooks/coord.js` — it is the installed copy. Changes go through a clone of
  the aircontrol repository and `node install.js`.
- "Nothing to close" is a complete, legitimate answer. A triage that always emits closures is a
  triage that closes things it did not verify.
