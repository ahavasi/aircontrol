---
name: next-steps
description: >
  Use when the user asks what to do next or wants the next stretch of work planned — "come up
  with a plan for next steps", "what should I do next", "what's next", "plan the next bit",
  "where were we", "what should I pick up". Also use when the user accepts the aircontrol
  Stop-hook offer that names this skill. Gathers what is actually outstanding — the work ledger,
  uncommitted and unpushed work, the previous turn's "Your Next Steps", open peer threads — ranks
  it, asks which thread to take, and enters plan mode on the one chosen. NOT for working a single
  known ledger item, which is `ledger-next`, and NOT the ledger CLI reference, which is `ledger`.
---

# Planning the next stretch

The user asks this by typing some version of "let's come up with a plan for next
steps" and then entering plan mode by hand. The planning was never the friction.
Remembering to ask was, and so was reconstructing what had been left open —
which is spread across the ledger, the working tree, the last thing you told
him, and whatever other sessions are holding.

**The invariant: this skill decides *what* to work on, and hands the *how* to
whoever already owns it.** It orchestrates; it never reimplements another
workflow. Three skills sit next to each other and it is worth being exact about
the boundary, because two of them already claim overlapping trigger phrases:

| Skill | Question it answers |
|---|---|
| `ledger` | "What does the ledger CLI do?" — command reference. |
| `ledger-next` | "Do this one known item." — single item, execution. |
| `next-steps` | "What should the next stretch be about?" — synthesis, then a plan. |

If the user already named the thing they want to work on, they did not need
this skill. Say so and go do it.

## 1. Gather

Cheap and bounded. Every one of these is a line or two of output; none of them
justifies a large read. Run them together.

```bash
node ~/.claude/hooks/coord.js ledger list --repo .
git -C . status --short && git -C . log --oneline @{u}..HEAD 2>/dev/null | head
git -C . branch -v | grep '\[gone\]'
```

Never pass `--notes` and never `--repo all` — both are called out as costly in
the `ledger` skill, and neither changes the decision you are about to make.

Four sources, in rough order of how directly they state what is outstanding:

1. **The previous turn's `## Your Next Steps`.** The global instructions require
   it on every substantive reply, so it is already in context and free to read.
   It is the most direct statement of what was left on him, and it is the one
   people forget to look at.
2. **The working tree.** Uncommitted changes, unpushed commits, branches merged
   or abandoned. In a shared worktree, check whose work is whose before
   attributing any of it — other sessions edit the same tree.
3. **The ledger**, for work filed but not started.
4. **The `[aircontrol]` block**, for open peer threads, unanswered questions,
   and anything another session is blocked on you for.

## 2. Rank

Order candidates by what is actually blocking, not by what is nearest:

1. **Blocked on the user** — a decision only they can make, a credential, a QA step
   on a physical device. These block other work and often block other sessions.
2. **Unfinished work in this repo** — a branch not merged, a fix not pushed, a
   test not landed. Cheapest to resume because the context is still live.
3. **Filed but unstarted** — ledger items, deferred work, known defects.
4. **Adjacent finds** — things noticed in passing and never written down.

Drop anything already done. Verify before listing: a ledger item can be stale,
and offering finished work as a next step is worse than offering nothing.

## 3. Ask

One `AskUserQuestion` call, the ranked candidates as options, your
recommendation first with `(Recommended)` in the label. Each option's
description says what actually happens if he picks it — the cost, the
dependency, what it unblocks — because he is choosing between outcomes.

Keep it to the real candidates. Four plausible options beat eight where half are
filler.

**"Nothing found" is a complete answer.** If everything is genuinely closed, say
so plainly in a sentence and stop. Do not manufacture a next step to justify
having been invoked — a ritual that always emits, emits noise.

## 4. Plan the one he picked

Enter plan mode with `EnterPlanMode`, then hand off by shape rather than
planning everything yourself:

| The chosen thread is… | Hand to |
|---|---|
| A ledger item | `ledger-next` Mode B — it already does take → claim → read `pointsAt` → close with evidence. |
| A multi-step build or new feature | `superpowers:brainstorming`, which classifies and gates on approval. |
| Something with a spec already written | `superpowers:writing-plans`. |
| A bug | `superpowers:systematic-debugging`. |
| A small bounded change | Stay here. Plan it directly; a handoff would cost more than the work. |

Before touching anything, claim it so other sessions can see:

```bash
node ~/.claude/hooks/coord.js claim --session <your-name> --intent "<what you're doing>" --paths <dirs>
```

## What this skill does not do

- It does not write `## Your Next Steps`. That section is the human-action list
  the global instructions already require on every reply, and it keeps its own
  job: only things the user must personally do. This skill produces the *plan*.
- It does not take or close ledger items. `ledger-next` owns that.
- It does not clean up the session. `session-cleanup` owns that, and it is the
  right skill when the user is wrapping up rather than continuing.
