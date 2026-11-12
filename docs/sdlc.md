# How work moves in spi-code

Work is tracked in beads, built in parallel worktrees, reviewed adversarially by a different provider, and landed on `main` by a gate script. GitHub issues and pull requests are not part of the path.

```
epic ──breakdown──▶ beads ──claim──▶ worktree ──build──▶ review ──land──▶ main
  (when we start)     (wave plan)    (one per bead)    (other provider) (scripts/land)
                                                                          │
                                       stop the line ◀── main breaks ◀────┘
```

This file is the process and nothing else. What a builder learned about the product goes in `docs/notes/`, and only when the code and its tests don't already say it. Change the process through a bead, like any other change.

## Pieces

| Piece | Role |
|---|---|
| **bd** (beads) | Source of truth for work: epics, beads, dependencies, claims, stage labels, review results, the merge slot. Prefix `spicode`. Lives in `.beads/`, git-ignored and local to this machine. Every worktree finds it through git's common directory. |
| **Orchestrator** | One agent that dispatches builders and reviewers, rules on disputes and lands. `.agents/orchestration/README.md` is its guide. |
| **`.agents/orchestration/rules.md`** | What every agent follows: where to work, secrets, commits, checks and load. |
| **`scripts/check --quick`** | The builder's and reviewer's pass: lint, typecheck, license headers and, once, the tests the diff reaches. |
| **`scripts/check`** | Everything: lint, a strict TypeScript build, every test twice (the second time 400 days ahead in another time zone), license headers and third-party notices. CI runs it. |
| **CI** | The Packaged smoke workflow runs the full check and the packaged smoke on macOS and Windows for `main`, every pushed `bead/**` branch, and the `land/**` branch a landing waits on. |
| **`scripts/land`** | The only way onto `main`. It is deterministic, so it behaves the same whichever harness or model calls it. |
| **Keelson** | The beads board shows the wave map and the decisions waiting on the maintainer. The `adversarial-review` workflow is an alternative to a two-seat review for `risk:high` beads. |

## 1. Epics, created up front

There is one epic per milestone (M0 to M7), and one for each design pass the maintainer approves between them. Its description is the PRD's milestone row, or the approved design, and the requirement IDs it ships. Open maintainer questions are `decision` beads. Nothing finer is planned until an epic starts.

## 2. Breakdown, when an epic starts

Skill: `epic-breakdown`. One agent breaks the epic into beads:

- **Size:** one worktree and one reviewer per bead, and roughly 400 changed lines or less.
- **Requirements:** each bead names the requirement IDs it satisfies. Its acceptance criteria are their "Verified by" checks, made concrete, including the case the code cannot prove.
- **Dependencies:** set with `bd dep`, so `bd ready` shows what can run at once. `bd swarm validate` confirms the graph.
- **Risk:** label `risk:high` for credentials, the sandbox, approvals and tiers, durability and intents, and the Copilot session boundary. Label everything else `risk:std`.
- **Checkpoints:** a `decision` bead wherever the maintainer signs off, blocking the wave after it.

A reviewer from another provider checks the breakdown. The maintainer then approves it once, and the epic gets the `breakdown:approved` label. **This is the human gate: once per epic, not once per change.**

## 3. Allocate

`bd ready --parent <epic>` lists the current wave. The orchestrator gives each ready bead to one builder in its own worktree, at most 4 agents at a time, alternating providers so the other one is free to review.

The builder claims the bead atomically with `bd update --claim`, under a worker name of its own (`--actor`), because bd treats a repeat claim by the same actor as success.

Every bead in flight carries one stage label, swapped by the orchestrator as it acts: `stage:build`, `stage:review`, `stage:fix`, `stage:ready`. A fresh orchestrator finds everything in flight with `bd list --status in_progress`.

## 4. Build

Skill: `bead-build`. Work happens only in the bead's worktree, on branch `bead/<id>`, never in the main checkout. Commits use `aipr` with a `Bead: <id>` trailer and no AI attribution.

The builder runs `scripts/check --quick`, pushes the branch so CI runs the full check and the packaged smoke on both platforms, and hands off with evidence: for each acceptance line, the test that proves it and how the builder saw it fail. Anything outside the bead's acceptance is a follow-up.

## 5. Review

Skill: `bead-review`. The reviewer comes from a different provider than the author. The review is read-only against the bead's acceptance and `git diff main...bead/<id>`. The reviewer checks the builder's evidence, runs its own probes, and does not rerun the full check.

| Tier | Review |
|---|---|
| `risk:std` | One reviewer from another provider, up to 3 rounds. Round 1 is full; later rounds cover only the fix and the open findings. Nits are taken in the fix round or dropped. |
| `risk:high` | Two seats from different providers, in parallel on the same head, then one synthesis and one fix round. Or Keelson `adversarial-review`. |
| `review:exempt` | None. Only for Markdown outside `design/`, `.agents/` and `AGENTS.md`, which `scripts/land` enforces. |

A pass is recorded as bead metadata, which `scripts/land` reads:

| Key | Holds |
|---|---|
| `build.provider`, `build.model` | Who built the bead (set at claim) |
| `review.provider`, `review.model` | Who reviewed it |
| `review.verdict` | `pass` |
| `review.head` | The reviewed commit, pinned and printed by `scripts/review-head` |
| `land.sha` | The commit `scripts/land` put on `main`, so a rerun after a failed push can finish |

`scripts/land` merges the reviewed commit onto the `main` it lands on and requires the bead to equal the result, apart from the generated watch fixtures, which `scripts/check` compares with a fresh projection. A rebase, a neighbour's landing and a fixture regeneration keep the review. Anything else written after it, whitespace included, voids it.

The gate guards against ordinary work landing unreviewed: a late commit, an amend, a conflict resolution. It is not a boundary against someone who tampers with the repository or writes the review metadata by hand.

## 6. Land

Skill: `bead-land`. `scripts/land <id>`:

1. Refuses while a `main-broken` bead is open, unless this bead is that fix.
2. Takes the merge slot, so landings happen one at a time.
3. Syncs `main` from the remote, rebases the bead onto it, installs the pinned dependencies (the rebase may bring new ones), and runs `scripts/check --static`: lint, typecheck and license headers, no tests, so a busy machine cannot refuse a landing.
4. Verifies the review: a pass from a provider other than the author's, for a commit that still equals what is landing once merged onto `main`.
5. Waits for CI to pass on that exact commit, on macOS and Windows, with the packaged smoke. A green run from the bead's own branch counts when the rebase changed nothing; otherwise the commit goes to a new `land/<id>--…` branch to get a run. Failed jobs are rerun once; a second failure refuses the landing.
6. Checks again that `main` isn't broken, then fast-forwards `main` to the exact commit CI passed. It pushes, closes the bead with "Landed <sha>", and cleans up worktrees under `.worktrees/`. If the push fails, the bead stays open, and rerunning the script finishes the landing.

`scripts/land --wait <id>` queues behind other landings instead of refusing. `SPI_LAND_LOCAL=1` runs the full check on this machine instead of waiting for CI, for when CI is down; it says so in its output, and it checks neither Windows nor the packaged smoke.

A checkout with no remote runs the full check locally in place of steps 3 and 5.

History stays linear, and `main` always equals a commit that passed every check on both platforms, except a landing made with no remote or under `SPI_LAND_LOCAL=1`, which passed them on this machine only.

## 7. Stop the line

Skill: `stop-the-line`. When `main` breaks, locally or in CI, open a P0 bug labelled `main-broken`. `scripts/land` then refuses everything else. Revert if the cause isn't clear within about 30 minutes; otherwise fix forward. The fix gets a `risk:std` review and lands. If the break got past the checks, the fix adds the missing one.

## Not doing

- **Pull requests.** Review is recorded on beads and the maintainer signs off at checkpoints, so a pull request would track the same thing twice. Revisit when a second person reviews changes.
- **GitHub branch protection.** With no pull requests, `scripts/land` waiting on CI does that job.
- **A workflow that runs breakdown, dispatch and landing on its own.** The orchestrator does this by hand, from the guide.
- **Planning beyond epics.**
