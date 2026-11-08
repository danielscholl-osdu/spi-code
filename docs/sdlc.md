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
`scripts/land` rejects AI co-author trailers and "Generated with" lines in incoming commits; human co-authors and existing `main` history are allowed.

The scaffold uses Node 22.16 or newer, matching `engines` in `package.json`, and pnpm 10 (the exact pnpm version is in `package.json`). `node:sqlite` is unflagged from 22.13, but the host store also needs `DatabaseSync.isTransaction`, which arrived in 22.16.
The host's `setup.check` request rechecks every readiness row, bypasses the Copilot
seat cache, and publishes `setup.state` with the check time in `checkedAt`, even
when readiness is unchanged. Ordinary refreshes retain the last check time.
Concurrent requests share one check. After publishing readiness, a five-second,
abortable read of GitHub's REST `rate_limit` endpoint refreshes the GraphQL points
without entering the sweeper's reservation queue. It runs only when gh is usable
and merges the figures into the latest `sweep.status`, retaining its floor and
deferred areas. Failed budget probes report unavailable points rather than stale
ones. Older state fixtures may omit the timestamp; tests use fixture tools and
never a live credential or Copilot seat.
`pnpm run build` compiles all six workspaces; `pnpm run lint`, `pnpm run typecheck`,
`pnpm run test` and `pnpm run check:headers` run individual checks. Vitest discovers
`src/**/*.test.ts` and `src/**/*.test.tsx` in each workspace, plus script tests.
The header check covers tracked and untracked, non-ignored sources, including
extensionless shebang scripts. Build output and dependencies are ignored.

The window's `app/text-rules.test.tsx` renders every Watch fixture across its places,
strip, Line sheet, sidebar, command palette and Detail kinds. It checks headline length,
internal names, title emoji and empty or placeholder sections, with rule mutations.
Injected emoji cases cover Detail fields, Today sublines, template queue rows and
environment repository lines; ordinary symbols and navigation glyphs stay intact.

Window layout tests keep logical sections flat and reserve `.card` for separate
objects such as repository fact summaries. The shell measures the title bar plus
strip into `--topbar-height`; narrow sidebar and Detail sheets and their backdrops
use that offset, fall back to 40 px before measurement, and update when either row resizes.
Pane headers share the 44 px `pane-header` rule. The centre reads left-aligned at
most 960 px wide with 20 by 24 px padding; its place header stays at the top of
the scrolling frame. Service source sections use named, styled disclosures,
with nonempty Attention open by default.

`scripts/check` repeats Vitest with `SPI_TEST_CLOCK_SHIFT=1`, moving the wall
clock 400 days forward to catch expiring fixtures before they break main.
The shifted clock still ticks, leaves real timers alone, and allows explicit
fake clocks. Both passes respect `VITEST_MAX_WORKERS`. Tests with dated fixtures
should inject a clock or pin their own fake time rather than read today's date.

`scripts/check` also validates production dependency licenses offline and writes
`build/THIRD_PARTY_NOTICES.md`. `package:mac` repeats generation against the staged
production install plus the renderer's production dependency closure, then ships
the result in `Contents/Resources/THIRD_PARTY_NOTICES.md`. Missing license text or
an identifier outside the generator's allowlist fails the build. Electron's
`LICENSE.electron.txt` and `LICENSES.chromium.html`
remain supplied by electron-builder.

`package:mac` copies the workspace manifests and tested `pnpm-lock.yaml` into
staging and installs production dependencies with `--frozen-lockfile` before
adapting the manifests for electron-builder. A manifest/lockfile mismatch fails
packaging. Manifest discovery uses pnpm's workspace patterns and exclusions rather
than a separate directory list. The packaged smoke test runs the app extracted from
the generated ZIP, including the shipped runtime handshake, rather than the
builder's app directory.
Before starting the host proof, it renders `fixtures/watch/snapshot-1106.json`
at 1280 x 800 content bounds and pins the app's Appearance selector to light
and dark. `build/package-<mac|win>/views/` holds 22 PNGs, a side-by-side
`index.html` review report and a copy of the window design. `smoke.json.views`
lists the shots and their image and DOM qualifier evidence; the existing smoke
artifact uploads the folder on both platforms. Setup tools are fixture-ready,
not a live sign-in check. The renderer reloads before the host proof, so the
fixture cannot affect its persisted-snapshot and supervision checks.
Missing shots, images smaller than 640 x 400 or 1024 PNG bytes, or images
with 99.5% of pixels in one 4-bit-per-channel RGB bucket fail the smoke.
Every shot must carry the title-bar sweep line; Today, Upstream, the selected
Detail's place and the affected service must also carry their failed-read or
truncation qualifier. The report names the corresponding window-design section;
the reviewer records match or mismatch per surface on the bead, not the smoke.
The listener scan checks the main pid and every app descendant, including the
Copilot runtime before it stops. Each scan takes one socket snapshot (`lsof` on
macOS, `netstat -ano` on Windows), followed by one process-table snapshot (`ps`
or CIM). Start times exclude stale parent links and reused pids; exited
processes need no liveness probes. Both queries share an eight-second budget.
`smoke.json` records the runtime scan's `scannedPids` and `scanDurationMs` under
`runtime.listenerCheck`. `scannedPids` lists only the pids the socket snapshot
sampled, never the scan's own `ps` or PowerShell, and the packaged gate fails
unless it holds the main, host, runtime and renderer pids and the duration is
under eight seconds. The scan runs after the handshake, without extending
the host's hello deadline.
Runtime staging excludes compiled `*.test.*` files and `smoke-launch.*`, including
their declarations and maps, across the desktop and bundled workspace libraries.
The in-app smoke modules remain bundled; the launcher runs from the build checkout.
The renderer's turn spike is a headless test harness in `apps/window/src/index.tsx`,
enabled only by `window.spi.proof` for packaged smoke and live proof runs. No page
renders a turn panel or composer; the harness still pings the host and starts one
turn per renderer load when the model catalog arrives.

Pinned notice repairs in `scripts/third-party-notices.mjs` cover npm archives
that omit their upstream MIT text: Copilot SDK/platform 1.0.26 uses the GitHub
MIT notice from `github/copilot-sdk` LICENSE (blob
`28a50fa22639e32febe14e4ffc7a732b0ba8c90a`); Koffi platform 3.2.1 uses the
matching installed `koffi` package's LICENSE.txt. Other missing notices fail;
version updates require rechecking these repairs. Supplemental shipped notices
are retained too. `scripts/licenses/t3-code-MIT.txt` preserves T3 Code's LICENSE
for copied/ported portions, following its `docs/internals/open-source-licenses.md`.

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
3. Syncs `main` from the remote if there is one, rebases the bead onto it, installs the pinned dependencies (the rebase may bring new ones), and runs `scripts/check`.
4. Verifies the review: a pass whose patch-id matches, from a provider other than the author's.
5. Checks again that `main` isn't broken, then fast-forwards `main` to the exact commit it checked. It pushes, closes the bead with "Landed <sha>", and cleans up worktrees under `.worktrees/`. If the push fails, the bead stays open, and rerunning the script finishes the landing.

Agents land their own beads once these gates pass. History stays linear, and `main` always equals a tree that passed the checks.

## 7. Stop the line

Skill: `stop-the-line`. When `main` breaks, open a P0 bug labelled `main-broken`. `scripts/land` then refuses everything else. Revert if the cause isn't clear within about 30 minutes; otherwise fix forward. The fix gets a `risk:std` review and lands. If the break got past `scripts/check`, the fix adds the missing check.

## Not doing yet

- A project Keelson workflow or factory-mode swarm that runs breakdown, dispatch and landing on its own. Worth it after the manual loop has run through one epic.
- GitHub branch protection. With no PRs, `scripts/land` and CI on `main` do that job.
- Planning beyond epics.
