---
name: ledger
description: >-
  List and manage aircontrol ledger items — the deferred-work index shared across Claude Code and
  Codex sessions on this machine. Use whenever the user asks what is left, what is outstanding,
  what was deferred, what the ledger says, "show me the ledger", "what's open on this project",
  "anything abandoned", "what should I pick up next", or wants to file, take, note, block or close
  a piece of deferred work. Also use when a session-start `ledger:` line reports open items and the
  user wants to see them.
---

# The aircontrol ledger

An append-only index of work that was deliberately deferred, shared by every Claude Code and Codex
session on this machine. It **indexes** work; it does not restate it — every item carries a
`--points-at` pointer to the spec, plan, PR, or memory file that holds the detail.

The CLI is `node ~/.claude/hooks/coord.js ledger <sub> …`.

## Listing

Default to the current project. Nearly every question is about this repo:

```bash
node ~/.claude/hooks/coord.js ledger list --repo .
```

| flag | effect |
|---|---|
| `--repo .` | this repo — matches by path **and** by git origin URL, so a detached worktree of the same repo still finds its items |
| `--repo <path>` | that path only; the origin-URL fallback is deliberately not applied |
| `--repo all` | every repo on the machine |
| `--status open` | open items only |
| `--status blocked-on-human` | waiting on a person |
| `--mine` | only items this session has taken (needs `--session <name>`) |
| `--notes` | include every note on every item |
| `--json` | machine-readable, for filtering |

**Two behaviours that surprise people, both real:**

- **`list` always excludes `done`.** The status filter is applied *after* that, so `--status done`
  returns nothing at all rather than the closed items. To read a closed item, use `show <id>`.
- **Notes are omitted until you ask.** That is a deliberate cost decision: one unfiltered
  `ledger list` was once the single costliest tool result of an entire session, because every tool
  result is re-sent on every later turn. Reach for `--notes` on one item via `show`, not across a
  listing.

## Reading one item

```bash
node ~/.claude/hooks/coord.js ledger show <id>
```

`show` always includes the full note history. This is the right way to read an item's detail — a
ledger item's notes are where corrections and retractions live, and the last note supersedes
earlier ones.

## Working an item

```bash
node ~/.claude/hooks/coord.js ledger take <id> --session <your-name>    # claim before working
node ~/.claude/hooks/coord.js ledger note <id> "what you found"
node ~/.claude/hooks/coord.js ledger drop <id>                          # hand back, still open
node ~/.claude/hooks/coord.js ledger done <id>
```

`take` detects races honestly: two sessions taking the same item at once will not both succeed, and
the loser is told who won rather than silently proceeding. An item whose owning session has died is
free to pick up.

`block` marks an item as waiting on a person; `unblock` returns it to open and accepts `--note`.

## Filing new work

```bash
node ~/.claude/hooks/coord.js ledger add \
  --title "one line, under 80 chars" \
  --points-at <spec|plan|PR url|memory file> \
  [--priority urgent|high|normal|low] [--status open|blocked-on-human]
```

`--points-at` is **required** and `--title` is capped at 80 characters, both on purpose: the ledger
is an index. Put the reasoning in the thing it points at, or in a `note` afterwards, not in the
title.

File an item rather than leaving deferred work in a comment or a file nobody will open again.

## When answering "what is left?"

1. `ledger list --repo .` first — scoped, and without notes.
2. If something looks relevant, `ledger show <id>` for that one item.
3. Report the conclusion, not the dump. Do not paste a whole listing back to the user when three
   items matter.

Closed items are invisible to `list` by design, so "nothing open" means exactly that — not that
the ledger is empty.

## Never edit the installed copy

`~/.claude/hooks/coord.js` is an installed copy: an edit there is overwritten on the next install
and is not under version control. Change a clone of the aircontrol repository and run
`node install.js`, or update the published package with `npx aircontrol@latest install`.
