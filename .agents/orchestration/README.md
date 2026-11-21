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
| Builder of a bead whose gate is rendered (captures, the packaged smoke's geometry), mostly `apps/window` | Claude Opus 5.5, high effort; Codex Sol reviews |
| Builder of a bead whose gate is logic, and every `risk:high` build | MAI Code 2 on Copilot; Claude Opus 5.5 reviews a `risk:std` one |
| `risk:high` review | Two seats in parallel: Claude Fable 5.2 and Muse Wonder (Codex Sol when Muse is busy) |

The reviewer is always a different provider from the author, so Opus never builds a `risk:high` bead: the Fable seat is the same provider. Change this table through a bead when the seats change.

The provider is the model's vendor, not the harness that runs it. When Codex or Claude is short of capacity, run the same model on Copilot (`acpRegistry_copilot`): GPT-6.2 Sol in place of Codex Sol, and Claude Opus 5.5 in place of the Claude seat. Record `review.provider` as the vendor (`openai`, `anthropic`), and say in the review comment that it ran on Copilot. A Copilot seat's first verdicts are compared with the native seat's record on the same kind of bead before it is relied on alone.

## Dispatch

- At most 4 agents at once; a two-seat review counts as 2.
- A waiting `risk:high` review takes free slots before a new build. A wave hands off at most two `risk:high` beads together.
- Builders get their own worktree (`isolation: "worktree"`). A build dispatched without one damages the checkout it lands in. The harness cuts that worktree from your checkout, not from `main`; step 2 of the build skill has the builder prepare it.
- A fix round, a review and a recheck work in or beside the bead's existing worktree, which the harness cannot start an agent in. Dispatch them without isolation and make the first line of the brief the worktree path, with: "Change directory there before anything else, and touch nothing where you start."
- Before a wave, read every ready bead's files. Beads that edit the same file run one after another, or one owns the file and the others add their own files beside it. The breakdown should have said who owns what; where it didn't, rule and record it on the beads before you dispatch.
- Name the land order at dispatch, on each bead, for beads that share a file. The later bead rebases onto the earlier one's head in its own fix round, not as a task after its pass.
- A dependent bead may start once what it depends on is `stage:ready`: its brief names that passed head as the base. If the predecessor changes after its pass, its pass is void anyway, and the dependent rebases in its fix round.
- A dependency edge stands for behaviour. Where two beads only share files, they start together from the same head, add their own files beside each other and land in the named order.
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

A fix brief lists the findings that stand, each with its file and line and the smallest fix, and says which you ruled out and why. When the land order puts another bead first, its first step is to rebase onto that bead's head; for `risk:high` that happens before the recheck, so the seat reads the rebased head. After a recheck it lists blockers only. For `risk:high` it also names each seat's probe file: the builder adds those rows to the bead's tests and pushes only when every row passes, or stops and says so when a ruling makes a row fail. Only `risk:high` gets a recheck brief: it names the reviewed head, the new head, and the findings to confirm. Both follow the "Later rounds" section of the review skill.

## Review rounds

- One review round. After round 1, only a blocker buys another cycle. A fix round adds no behaviour outside acceptance.
- After a `risk:std` fix round, read the fix diff, confirm CI green and record the pass citing the review. Use the reviewer's `review.provider` and `review.model`, and pin the fixed head with `scripts/review-head`. Send no recheck.
- Send both seats of a `risk:high` review at once, on the same head. Wait for both, write one synthesis on the bead, and send one fix round. One seat rechecks.
- When a round 1 blocker is one member of an open class, the synthesis rules the structural fix then, or asks the maintainer then. It also names the cut that lands with no further round if the recheck fails.
- A recheck finding graded `should` or follow-up goes to the epic's hardening bead as a comment, and the passing head lands. The first such finding files that bead: `risk:high`, two seats, blocking the closing checkpoint.
- A `risk:high` fix that changes only tests gets no recheck. You confirm it when it removes or loosens no assertion or fixture row on a gate and CI is green on the platform that was red, then record the pass citing the review.
- Only wrong behaviour against acceptance, a broken gate or red CI blocks a pass. Put nits, test tidy-ups, evidence gaps and captures in comments on the epic's sweep bead. Break-and-restore evidence is required only for stores, state machines, parsing and gates.
- Reviewers check CI once: red blocks, running is fine. They don't wait. `scripts/land --wait` still lands only a commit CI passed.
- The roughly 800-line size cap counts product code only, not tests, smoke or fixtures.
- When a finding is a disagreement with the design, rule on it and record the ruling; don't let it ride through fix rounds. The same goes for a conflict a builder raises before review: rule, send the fix, and only then send the reviewer.
- A reviewer's note about the bead's text (a missing statement, an unclear line) is yours: edit the bead and say so in a comment. It needs no recheck.
- If a fix round changes nothing in the diff's own lines (regenerated fixtures only), the review stands; send no recheck.
- If the `risk:high` recheck finds the same kind of failure, the cut the synthesis named lands with no further round: you confirm its diff removes or narrows only what the synthesis named and CI is green. With none named, stop and take the approach to the maintainer.

## Landing

Read the package jobs about seven minutes into any branch run you are waiting on: they report well before the `check` jobs. Never call `scripts/land` on a head whose branch run is red, and don't hold a green bead behind one whose CI is not green.

`scripts/land --wait <id>` once the bead is `stage:ready`. It queues on the merge slot, runs lint and typecheck here, and waits for CI on the exact commit, so several can wait at once without loading this machine. Run it the way your harness keeps a long command alive: in the foreground with a long timeout, or as a tracked background command you wait on, never one you walk away from. Each takes 10 to 15 minutes of CI once it holds the slot; land beads that are ready together in dependency order. After each landing, read `bd ready --parent <epic>`.

If a landing refuses because CI failed on a watch fixture test, a neighbour's landing changed what the fixture is generated from. You run the regeneration command from `rules.md` in the bead's worktree and commit the result with the bead trailer; it is generated output, not authored code, and the review stands.

A harness worktree outlives its task. When a bead has landed, remove its worktree and branch yourself, after the ignored-files check in `rules.md`.

## Checkpoints

The maintainer signs off at natural boundaries: before screenshot or parity work, before a milestone closes, before anything irreversible or wider in scope. Model each as a `decision` bead that blocks the next wave, post what to look at as a comment on it, and stop dispatching past it.

## Handing over

When the thread grows long, start a fresh orchestrator when few agents are in flight. Give it the epic id. If you need to tell it anything the beads don't hold, that is a gap: put it on a bead first.
