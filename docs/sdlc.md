# How work moves in spi-code

Work is tracked in beads, built in parallel worktrees, reviewed adversarially by a different provider, and landed on `main` by a gate script. GitHub issues and pull requests are not part of the path. This is a starting point; change it when something doesn't work.

```
epic ──breakdown──▶ beads ──claim──▶ worktree ──build──▶ review ──land──▶ main
  (when we start)     (wave plan)    (one per bead)    (other provider) (scripts/land)
                                                                          │
                                       stop the line ◀── main breaks ◀────┘
```

## Pieces

| Piece | Role |
|---|---|
| **bd** (beads) | Source of truth for work: epics, beads, dependencies, claims, review results, the merge slot. Prefix `spicode`. Lives in `.beads/`, git-ignored and local to this machine. Every worktree finds it through git's common directory. |
| **Keelson beads board** | Where you watch it: the Epics wave map, In flight claims, Your calls (decisions waiting on you), Shipped. `beads-next` picks a bead; `beads-groom` checks backlog health. `beads-work` is not used, because it is built around draft PRs. |
| **Keelson workflows** | `adversarial-review` for high-risk beads (three lenses plus a verifier, with the author's model excluded). `design-converge` when a bead hits a real design fork. `investigate` when a fact needs establishing first. |
| **T3 Code** | The main place work is dispatched from: one delegated agent per bead, each in its own worktree, mixing Claude, Codex and Gemini. |
| **`scripts/check`** | The checks every bead passes before review and before landing. Installs the pinned dependencies with `pnpm install --frozen-lockfile` if `node_modules` is missing, then runs `pnpm run check`: Biome, a strict TypeScript build, Vitest and source license headers. |
| **`scripts/land`** | The only way onto `main`. It is deterministic, so it behaves the same whichever harness or model calls it. |
| **GitHub** | Not set up yet. When M0 needs CI for signed builds, `main` gets a remote and Actions runs on it. `scripts/land` pushes once a remote exists. No issues and no PRs. |

## 1. Epics, created up front

There is one epic per milestone (M0 to M7). Its description is the PRD's milestone row and the requirement IDs it ships. The PRD's open maintainer questions are `decision` beads, so they show under Your calls. Nothing finer is planned until an epic starts.

## 2. Breakdown, when an epic starts

Skill: `epic-breakdown`. One agent breaks the epic into beads:

- **Size:** one worktree and one reviewer per bead, and roughly 400 changed lines or less.
- **Requirements:** each bead names the PRD requirement IDs it satisfies. Its acceptance criteria are their "Verified by" checks, made concrete.
- **Dependencies:** set with `bd dep`, so `bd ready` shows what can run at once. `bd swarm validate` confirms the graph.
- **Risk:** label `risk:high` for credentials, the sandbox, approvals and tiers, durability and intents, and the Copilot session boundary. Label everything else `risk:std`.

A reviewer from another provider checks the breakdown. The maintainer then approves it once, and the epic gets the `breakdown:approved` label. **This is the human gate: once per epic, not once per change.**

## 3. Allocate

`bd ready --parent <epic>` lists the current wave. Each ready bead goes to one agent in its own worktree. Keep 3 or 4 in flight, spread across providers so a reviewer from another provider is always free.

The agent claims the bead atomically with `bd update --claim`, under a worker name of its own (`--actor`), because bd treats a repeat claim by the same actor as success. `bd heartbeat` keeps a long claim alive, and `bd reclaim` returns the beads of crashed agents to the queue.

## 4. Build

Skill: `bead-build`. Work happens only in the bead's worktree, on branch `bead/<id>`, never in the main checkout. Commits use `aipr` with a `Bead: <id>` trailer. Run `scripts/check` before asking for review. Anything outside the bead's acceptance becomes a new bead.

The scaffold uses Node 22.16 or newer, matching `engines` in `package.json`, and pnpm 10 (the exact pnpm version is in `package.json`). `node:sqlite` is unflagged from 22.13, but the host store also needs `DatabaseSync.isTransaction`, which arrived in 22.16.
`pnpm run build` compiles all six workspaces; `pnpm run lint`, `pnpm run typecheck`,
`pnpm run test` and `pnpm run check:headers` run individual checks. Vitest discovers
`src/**/*.test.ts` and `src/**/*.test.tsx` in each workspace, plus script tests.
The header check covers tracked and untracked, non-ignored sources, including
extensionless shebang scripts. Build output and dependencies are ignored.

## 5. Review

Skill: `bead-review`. The reviewer comes from a different provider than the author. The review is read-only against the bead's acceptance and `git diff main...bead/<id>`.

| Tier | Review |
|---|---|
| `risk:std` | One reviewer from another provider, up to 3 rounds. Stop when only nits remain. |
| `risk:high` | Keelson `adversarial-review` (`subject=bead/<id>`, `author=<model>`), or a three-provider council. |
| `review:exempt` | None. Only for Markdown outside `design/`, `.agents/` and `AGENTS.md`, which `scripts/land` enforces. |

A pass is recorded as bead metadata, which `scripts/land` reads:

| Key | Holds |
|---|---|
| `build.provider`, `build.model` | Who built the bead (set at claim) |
| `review.provider`, `review.model` | Who reviewed it |
| `review.verdict` | `pass` |
| `review.patch_id` | `git patch-id --verbatim` of the reviewed diff |
| `land.sha` | The commit `scripts/land` put on `main`, so a rerun after a failed push can finish |

A clean rebase keeps the patch-id. Any change to the diff, whitespace included, voids the review.

## 6. Land

Skill: `bead-land`. `scripts/land <id>`:

1. Refuses while a `main-broken` bead is open, unless this bead is that fix.
2. Takes the merge slot, so landings happen one at a time.
3. Syncs `main` from the remote if there is one, rebases the bead onto it, and runs `scripts/check`.
4. Verifies the review: a pass whose patch-id matches, from a provider other than the author's.
5. Checks again that `main` isn't broken, then fast-forwards `main` to the exact commit it checked. It pushes, closes the bead with "Landed <sha>", and cleans up worktrees under `.worktrees/`. If the push fails, the bead stays open, and rerunning the script finishes the landing.

Agents land their own beads once these gates pass. History stays linear, and `main` always equals a tree that passed the checks.

## 7. Stop the line

Skill: `stop-the-line`. When `main` breaks, open a P0 bug labelled `main-broken`. `scripts/land` then refuses everything else. Revert if the cause isn't clear within about 30 minutes; otherwise fix forward. The fix gets a `risk:std` review and lands. If the break got past `scripts/check`, the fix adds the missing check.

## Not doing yet

- A project Keelson workflow or factory-mode swarm that runs breakdown, dispatch and landing on its own. Worth it after the manual loop has run through one epic.
- GitHub branch protection. With no PRs, `scripts/land` and CI on `main` do that job.
- Planning beyond epics.
