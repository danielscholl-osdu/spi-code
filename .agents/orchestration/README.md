# Orchestrating spi-code

One orchestrator dispatches builders and reviewers, rules on disputes, and lands. It writes no product code and records no pass on code it wrote. `docs/sdlc.md` has the flow; `rules.md` beside this file has what every agent follows.

## State lives on the beads

A fresh orchestrator recovers everything from `bd`. Keep no private log of what is in flight.

Every bead in flight carries exactly one stage label. You swap it in a single write at the moment you act, so there is never a gap and never two:

| Label | Means | You set it when |
|---|---|---|
| `stage:build` | A builder has it, or has reported and no reviewer is on it yet | you dispatch the builder |
| `stage:review` | A reviewer or recheck is running | you dispatch the review or recheck |
| `stage:fix` | Something must change before a reviewer passes it | a verdict with findings arrives, or you rule on a conflict the builder raised before review |
| `stage:ready` | Passed, waiting to land | the pass is recorded |

```bash
bd update <id> --add-label stage:review --remove-label stage:build   # one write, so never two stages
bd list --status in_progress --label stage:fix    # one stage
bd list --status in_progress                      # everything in flight
```

`scripts/land` closes the bead and leaves the label; on a closed bead it means nothing, which is why the queries above ask for `in_progress`. A bead in `stage:build` or `stage:fix` with no agent running is waiting for you: its latest note says whether to send a reviewer or a builder.

Put the worktree path, the head and the CI run id in a bead note at each handoff. Record every ruling you make as a comment on the bead it settles. Rules that should outlive the thread go in this folder or a skill, through a bead, not into a handoff file.

## Seats

| Role | Seat |
|---|---|
| Builder, standard reviewer | Claude Opus 5.5 or Codex Sol, high effort |
| `risk:high` review | Two seats in parallel: Claude Fable 5.2 and Muse Wonder (Claude Opus 5.5 on Copilot when Muse is unavailable) |

The reviewer is always a different provider from the author. Alternate builders so the other provider is free to review. Change this table through a bead when the seats change.

## Dispatch

- At most 4 agents at once; a two-seat review counts as 2.
- Builders get their own worktree (`isolation: "worktree"`). A build dispatched without one damages the checkout it lands in. The harness cuts that worktree from your checkout, not from `main`; step 2 of the build skill has the builder prepare it.
- A fix round, a review and a recheck work in or beside the bead's existing worktree, which the harness cannot start an agent in. Dispatch them without isolation and make the first line of the brief the worktree path, with: "Change directory there before anything else, and touch nothing where you start."
- Before a wave, read every ready bead's files. Beads that edit the same file run one after another, or one owns the file and the others add their own files beside it. The breakdown should have said who owns what; where it didn't, rule and record it on the beads before you dispatch.
- A review, a recheck and a fix round are each a new task. Don't reuse a finished agent's thread.
- A wave is the beads you were given, by label or by list. `bd ready --parent <epic>` after a landing shows everything the epic has ready; dispatch only what is in the wave.
- The sweep bead collects items of very different size. Before you dispatch it, rule on each: in, out, or its own bead when it changes what a user sees or leaves a contract unguarded.

### Builder brief

```
You build bead <id> in spi-code. Read AGENTS.md, .agents/orchestration/rules.md and
.agents/skills/bead-build/SKILL.md, and follow that skill through step 4, then stop.
Record build.provider=<provider> and build.model=<model>.
main is at <sha>.
Notes for this bead: <ownership of shared files, rulings, what to leave alone>
```

If a note depends on what a fixture holds or what the code does today, check it before you write it, or ask the builder to check first and stop if it is not so.

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
- When a finding is a disagreement with the design, rule on it and record the ruling; don't let it ride through fix rounds. The same goes for a conflict a builder raises before review: rule, send the fix, and only then send the reviewer.
- A reviewer's note about the bead's text (a missing statement, an unclear line) is yours: edit the bead and say so in a comment. It needs no recheck.
- If a fix round changes nothing in the diff's own lines (regenerated fixtures only), the review stands; send no recheck.
- If the second fix round fails for the same kind of reason as the first, stop and take the approach to the maintainer.

## Landing

`scripts/land --wait <id>` once the bead is `stage:ready`. It queues on the merge slot, runs the quick check here, and waits for CI on the exact commit, so several can wait at once without loading this machine. Run it the way your harness keeps a long command alive: in the foreground with a long timeout, or as a tracked background command you wait on, never one you walk away from. Each takes 10 to 15 minutes of CI once it holds the slot; land beads that are ready together in dependency order. After each landing, read `bd ready --parent <epic>`.

If a landing refuses because a watch fixture test fails after the rebase, a neighbour's landing changed what the fixture is generated from. You run the regeneration command from `rules.md` in the bead's worktree and commit the result with the bead trailer; it is generated output, not authored code, and the review stands.

A harness worktree outlives its task. When a bead has landed, remove its worktree and branch yourself, after the ignored-files check in `rules.md`.

## Checkpoints

The maintainer signs off at natural boundaries: before screenshot or parity work, before a milestone closes, before anything irreversible or wider in scope. Model each as a `decision` bead that blocks the next wave, post what to look at as a comment on it, and stop dispatching past it.

## Handing over

When the thread grows long, start a fresh orchestrator when few agents are in flight. Give it the epic id. If you need to tell it anything the beads don't hold, that is a gap: put it on a bead first.
