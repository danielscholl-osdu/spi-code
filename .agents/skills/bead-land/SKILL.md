---
name: bead-land
description: Land a reviewed spi-code bead on main with scripts/land. Use when a bead has a recorded review pass and is ready to integrate, or when asked to land, merge or ship a bead.
---

# Land a bead

`scripts/land` is the only way onto `main`. Never commit, merge or push to `main` by hand.

```bash
scripts/land <id>
```

Run it from the bead's worktree or from the main checkout. It:

1. refuses if `main` is broken, unless this bead is the fix;
2. takes the merge slot, so landings happen one at a time;
3. syncs `main` from the remote when there is one, rebases `bead/<id>` onto `main`, and runs `scripts/check`;
4. checks the review: a pass from a provider other than the author's, for a commit that, merged onto `main`, equals what is landing (or `review:exempt` for qualifying docs);
5. checks again that `main` isn't broken, fast-forwards `main` to the exact commit it checked, pushes it when there is a remote, and closes the bead with "Landed <sha>";
6. removes the worktree and branch if they are under `.worktrees/`; otherwise the harness that made them cleans them up.

## When it refuses

| Message | Do |
|---|---|
| main is broken | Wait, or help fix it (`stop-the-line`). |
| the merge slot is held | Another landing is running. Try again in a minute. If the slot is stale after a crash: `bd merge-slot check`, then `bd merge-slot release`. |
| does not rebase cleanly | Rebase in the worktree and resolve. Resolving a conflict is new work: get a review round on it. |
| differs from the reviewed commit | Something was written after the review. The message names a `git diff` that shows it; get a review round on that. |
| no longer merges cleanly with main | A landing since the review touched the same lines. Rebase, resolve, and get a review round on the resolution. |
| the diff changed since review | A pass recorded the old way, against the whole diff's patch-id, and the diff or its context has changed. Get a review round; it will record `review.head`. |
| a watch fixture test fails after the rebase | Regenerate the fixtures (`pnpm build && TZ=UTC bun scripts/watch-snapshot.ts && pnpm biome check --write`), commit, and land again. The review stands. |
| scripts/check failed | Fix it in the worktree. If the fix changes the diff, it needs review again. |
| uncommitted changes | Commit or discard them. Never land a dirty tree. |
| moved while checks ran | Something committed to the branch during the checks. Make sure the work is finished, then run it again. |
| the push failed | The commit is on local `main`, and the bead stays open. Fix the remote, then rerun `scripts/land <id>`; it pushes and finishes. Don't push by hand. |

After landing, check `bd ready --parent <epic>` and say which beads this one released, and read main's CI run (`gh run list --branch main --limit 1`). A red run on `main` is a `stop-the-line`.
