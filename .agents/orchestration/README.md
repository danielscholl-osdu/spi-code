# Orchestrating spi-code

One orchestrator dispatches builders and reviewers, rules on disputes, and lands. It writes no product code and records no pass on code it wrote. `docs/sdlc.md` has the flow; `rules.md` beside this file has what every agent follows.

## State lives on the beads

A fresh orchestrator recovers everything from `bd`. Keep no private log of what is in flight.

| Label | Meaning | Set when | Cleared when |
|---|---|---|---|
| `stage:build` | A builder has it | you dispatch the builder | the builder reports |
| `stage:review` | Built, with a reviewer | you dispatch the review or recheck | the verdict arrives |
| `stage:fix` | Review returned findings | you dispatch the fix round | the builder reports |
| `stage:ready` | Passed, waiting to land | the pass is recorded | `scripts/land` closes the bead |

```bash
bd label add <id> stage:review && bd label remove <id> stage:build
bd list --label stage:review          # one stage
bd list --status in_progress          # everything in flight
```

Put the worktree path, the head and the CI run id in a bead note at each handoff. Record every ruling you make as a comment on the bead it settles. Rules that should outlive the thread go in this folder or a skill, through a bead, not into a handoff file.

## Seats

| Role | Seat |
|---|---|
| Builder, standard reviewer | Claude Opus 5.5 or Codex Sol, high effort |
| `risk:high` review | Two seats in parallel: Claude Fable 5.2 and Muse Wonder (Claude Opus 5.5 on Copilot when Muse is unavailable) |

The reviewer is always a different provider from the author. Alternate builders so the other provider is free to review. Change this table through a bead when the seats change.

## Dispatch

- At most 4 agents at once; a two-seat review counts as 2.
- Builders get their own worktree (`isolation: "worktree"`). A build dispatched without one damages the checkout it lands in.
- Before a wave, read every ready bead's files. Beads that edit the same file run one after another, or one owns the file and the others add their own files beside it.
- A review, a recheck and a fix round are each a new task. Don't reuse a finished agent's thread.

### Builder brief

```
You build bead <id> in spi-code. Read AGENTS.md, .agents/orchestration/rules.md and
.agents/skills/bead-build/SKILL.md, and follow that skill through step 4, then stop.
Record build.provider=<provider> and build.model=<model>.
main is at <sha>.
Notes for this bead: <ownership of shared files, rulings, what to leave alone>
```

### Review brief

```
You review bead <id> in spi-code, built by <author model> (<author provider>). You review as
<model> (<provider>). First line of your reply: the model you run as; if it is not that
provider, reply MODEL-MISMATCH and stop.
Worktree <path>, branch bead/<id>, head <sha>. CI run <run id>.
Read .agents/orchestration/rules.md and follow .agents/skills/bead-review/SKILL.md as the
<standard reviewer | council seat>.
Notes for this bead: <rulings, what a neighbour owns>
```

A council seat's brief is the same with one more line: `Don't write to the bead; the orchestrator records the verdict.`

### Fix and recheck briefs

A fix brief lists the findings that stand, each with its file and line and the smallest fix, and says which you ruled out and why. A recheck brief names the reviewed head, the new head, and the findings to confirm. Both follow the "Later rounds" section of the review skill.

## Review rounds

- Send both seats of a `risk:high` review at once, on the same head. Wait for both, write one synthesis on the bead, and send one fix round. One seat rechecks.
- When a finding is a disagreement with the design, rule on it and record the ruling; don't let it ride through fix rounds.
- If the second fix round fails for the same kind of reason as the first, stop and take the approach to the maintainer.

## Landing

`scripts/land <id>` once the bead is `stage:ready`. Landings queue on the merge slot. After each landing, read `bd ready --parent <epic>` and check main's CI run.

## Checkpoints

The maintainer signs off at natural boundaries: before screenshot or parity work, before a milestone closes, before anything irreversible or wider in scope. Model each as a `decision` bead that blocks the next wave, post what to look at as a comment on it, and stop dispatching past it.

## Handing over

When the thread grows long, start a fresh orchestrator when few agents are in flight. Give it the epic id. If you need to tell it anything the beads don't hold, that is a gap: put it on a bead first.
