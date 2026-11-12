---
name: epic-breakdown
description: Break a spi-code milestone epic into beads and dispatch the ready wave to parallel agents. Use when starting work on an epic, when asked to "break down", "flesh out", "plan" or "start" a milestone (M0 to M7), or when asked to allocate or dispatch ready beads.
---

# Epic breakdown

An epic is a milestone. It stays one bead until we start it. Breakdown turns it into beads that can be built in parallel, gets the plan reviewed, and waits for the maintainer's approval once. See `docs/sdlc.md` for the whole flow.

## 1. Read the milestone

- `bd show <epic>` for the milestone and its requirement IDs.
- In `design/spi-code-prd.md`, read every requirement the epic names, its "Verified by", the milestone acceptance row, and any open question it depends on.
- Read the code that already exists on `main`. Don't plan work that is already done.

## 2. Write the beads

Each bead is one slice: one worktree, one author, one reviewer, one landing.

- **Size:** a diff of about 400 changed lines or less, excluding fixtures and generated files. If it is bigger, split it along a seam the code already has.
- **Title:** what exists afterwards, not the activity. "Host starts the Copilot runtime by path", not "Work on CP-01".
- **Description:** the requirement IDs it satisfies, what is in scope, what is explicitly out, and the files or packages it touches.
- **Acceptance:** the PRD's "Verified by" for those requirements, made concrete: the test or observation that closes the bead. Most review bounces come from what the acceptance left unsaid, so say it:
  - the case the code cannot prove (a missing read, an unknown order, an empty history), and that it must report the quieter state;
  - where the design is silent and a builder would have to guess, your ruling, or a `decision` bead for the maintainer;
  - for a bead that changes a gate (`scripts/land`, the sandbox, a credential path), what the gate defends against and what it does not.
- **Shared files:** when several beads will edit one file, say which bead owns it and have the others add files beside it. Give those beads dependencies so they land in turn.
- **Labels:** `risk:high` if it touches credentials, the sandbox, approvals or tiers, intents and durability, or the Copilot session boundary (PRD areas AU, RN, CT, CP, EV-05, NF-01 to NF-03); otherwise `risk:std`. Add `review:exempt` only for Markdown changes outside `design/`, `.agents/` and `AGENTS.md`.
- **Type:** `task` or `feature` for build work, `spike` for a probe whose answer decides later beads, `decision` for a call only the maintainer makes.

```bash
bd create "<title>" -t task -p 1 --parent <epic> -l risk:std \
  -d "<description>" --acceptance "<acceptance>"
bd dep add <bead> <blocker>        # <bead> waits for <blocker>
bd swarm validate <epic>           # confirms the graph and shows the waves
```

Prefer a wide first wave. A bead that only creates shared scaffolding (the monorepo, a contracts package) goes first and alone, so everything after it can run side by side.

Create one **sweep bead** per epic (`-t chore -p 3`, title "<epic>: sweep"), blocked by the epic's last build bead. Reviewers add polish, test tidy-ups and unhit edges to it as comments instead of filing a bead each; it is built once, as one change.

Add a `decision` bead wherever the maintainer should look before work goes on: before screenshot or parity work, before the epic closes, before anything irreversible. It blocks the wave after it.

Don't add beads for work the epic doesn't name. Findings that belong to another milestone become beads under that epic, or are left for its breakdown.

## 3. Review the breakdown

Ask a reviewer from a different provider than yours to check the plan read-only: missing requirements, beads that are too big, wrong or missing dependencies, an acceptance check that cannot fail, and scope beyond the milestone. Give it the epic id and `bd children <epic>` output. Fix what holds up; push back on what doesn't.

## 4. Get approval

Summarize for the maintainer: the beads in each wave, the high-risk ones, and any decisions waiting on them. Stop there. When they approve:

```bash
bd label add <epic> breakdown:approved
bd update <epic> --status in_progress
```

No bead under an epic is claimed before the epic has `breakdown:approved`.

## 5. Dispatch a wave

```bash
bd ready --parent <epic>
```

From here the orchestrator runs the epic: `.agents/orchestration/README.md` has the seats, the stage labels, the brief for each kind of agent and the limits. In short: each ready bead goes to one builder in its own worktree, at most 4 agents at a time, alternating providers so the other one is free to review.

When a bead lands, `bd ready --parent <epic>` shows what it released. Dispatch those beads. When every child is closed, check the epic's acceptance row in the PRD, then close the epic with the evidence as its reason.
