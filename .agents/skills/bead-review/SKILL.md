---
name: bead-review
description: Adversarial review of one spi-code bead by a different provider than its author, recorded on the bead so scripts/land can verify it. Use when a bead is ready for review, when asked to review a bead or a bead/<id> branch, or when acting as a bead's reviewer.
---

# Review a bead

The reviewer is always from a different provider than the author (`build.provider` on the bead). The review is read-only: the reviewer changes no files and makes no commits. Its only write is the verdict it records on the bead.

## Scope of a review

- **Intent:** the bead's description and acceptance (`bd show <id>`) and the PRD requirements they name.
- **Diff:** `git diff main...bead/<id>`, run in the bead's worktree.
- **Look for:** bugs, acceptance criteria not actually met, a test that cannot fail, broken callers, security and durability holes, and anything the PRD forbids.
- **Packaged smoke:** if the diff touches `apps/window`, `apps/desktop`, `scripts/package*.mjs` or `scripts/packaged-host.mjs`, run `pnpm package:mac` in the bead's worktree and paste the smoke's tail in the review comment. A failing smoke is a `blocker`.
- **Checks:** run `scripts/check --quick` in the worktree once, and read the bead branch's CI run (`gh run list --branch bead/<id> --limit 1`). Don't run the full `scripts/check`: CI and `scripts/land` do. Spend the time on mutations and your own probes.
- **Not in scope:** wishes beyond the acceptance criteria. If something belongs outside the bead, name it as a follow-up bead; don't block on it.

Each finding gets a severity (`blocker`, `should`, `nit`), a file and line, and the smallest fix.

## Pick the tier

| Bead | Review |
|---|---|
| `risk:std` | One reviewer from another provider. Up to 3 rounds. Round 1 is full; later rounds check only the changed code and the open findings. Stop when only nits remain. |
| `risk:high` | Keelson's `adversarial-review` workflow (`workflow_run`, project `spi-code`, inputs `subject=bead/<id>` and `author=<build.model>`, with the bead's acceptance and the diff as the artifact), or a three-provider council. A pass needs CONFIRMED, or CONFIRMED-WITH-CHANGES followed by a `risk:std` review of those changes. |
| `review:exempt` | None. `scripts/land` checks that the diff really is Markdown outside `design/`, `.agents/` and `AGENTS.md`. |

In T3 Code, start the reviewer with `delegate_task` (`role: "review"`) on a model from another provider. Brief it with the bead id, the worktree path, and the instruction to follow this skill as the reviewer.

## Record the verdict

The reviewer records a pass only when no `blocker` or `should` finding remains open. Run this in the bead's worktree, against the exact diff that was reviewed:

```bash
patch=$(scripts/review-patch-id)
bd update <id> --set-metadata review.verdict=pass \
               --set-metadata review.patch_id=$patch \
               --set-metadata review.provider=<anthropic|openai|google|panel> \
               --set-metadata review.model=<model id>
bd comment <id> "Review pass, <model>, round <n>: <one-line summary; follow-ups filed>"
```

Without a pass, record the findings as a comment and leave the metadata alone.

`scripts/review-patch-id` covers the lines the bead adds and removes, without the context around them, and leaves out the watch fixtures that `scripts/watch-snapshot.ts` writes. A rebase, a neighbour's edit beside the bead's lines, and a fixture regeneration all keep the review valid; `scripts/check` proves the fixtures at landing. Any change to the bead's own lines voids it, and `scripts/land` will ask for a new round.
