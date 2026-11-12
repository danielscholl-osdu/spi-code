---
name: bead-review
description: Adversarial review of one spi-code bead by a different provider than its author, recorded on the bead so scripts/land can verify it. Use when a bead is ready for review, when asked to review a bead or a bead/<id> branch, or when acting as a bead's reviewer.
---

# Review a bead

The reviewer is always from a different provider than the author (`build.provider` on the bead). The review is read-only: the reviewer changes no files in the bead's worktree and makes no commits. Its only write is the verdict it records on the bead. Read `.agents/orchestration/rules.md` first.

## Scope of a review

- **Intent:** the bead's description and acceptance (`bd show <id>`) and the requirements they name.
- **Diff:** `git diff main...bead/<id>`, run in the bead's worktree.
- **Look for:** bugs, acceptance criteria not actually met, a test that cannot fail, the case the code cannot prove reported as a claim, broken callers, security and durability holes, and anything the PRD forbids.
- **The builder's evidence:** the bead note lists, for each acceptance line, the test that proves it and how the builder saw it fail. Repeat at least one of those mutations yourself, and every one that looks weak. A missing or untrue evidence table is a `should`.
- **Your own probes:** at least one beyond the builder's tests: an edge case, a split input, a failure path. This is where a review earns its cost.
- **Checks:** run `scripts/check --quick` in your copy once, and read the bead branch's CI run (`gh run list --branch bead/<id> --limit 1`). A green run is the cross-platform and packaged-smoke evidence. Don't run the full `scripts/check` or `pnpm package:mac`: CI did, and `scripts/land` will.
- **Screens:** when the bead changes what a place draws, open the captures in the CI run's smoke artifact for the surfaces it touches and compare them with the design section the bead names. Say match or mismatch per surface.
- **Threat model:** a bead that changes a gate (`scripts/land`, a sandbox, a credential path) states in its acceptance what the gate defends against. Hold it to that. If it states none, say so as a `should` before you go looking for bypasses.

Each finding gets a severity (`blocker`, `should`, `nit`), a file and line, and the smallest fix.

## Follow-ups

Something outside the acceptance is not a finding. Decide what it is:

- **It changes what a user sees, or leaves a contract unguarded:** file a bead (`bd create ... --deps discovered-from:<id>`), and say so in your verdict.
- **It is polish, a test tidy-up or an edge nobody has hit:** add one line to the epic's sweep bead (`bd comment <sweep id> "<file:line> <what>"`). The epic's breakdown names the sweep bead; it is built once, near the end.
- **It is a nit inside the diff:** put it in the verdict. The builder takes it in the fix round if there is one, and otherwise it is dropped.

## Pick the tier

| Bead | Review |
|---|---|
| `risk:std` | One reviewer from another provider. Up to 3 rounds. |
| `risk:high` | Two seats from different providers, reviewing the same head at the same time. Neither writes to the bead. The orchestrator writes one synthesis, sends one fix round, and one seat rechecks. Keelson's `adversarial-review` workflow is the alternative. |
| `review:exempt` | None. `scripts/land` checks that the diff really is Markdown outside `design/`, `.agents/` and `AGENTS.md`. |

## Later rounds

Round 1 is full. A recheck covers only the fix and the open findings:

- Read `git diff <reviewed head> <new head>`, not the whole bead again.
- For each finding, rerun the probe that found it and confirm the new test fails without the fix.
- A new finding in code the fix did not touch is a follow-up unless it is a `blocker`.
- If this round's finding is the same kind as the last round's, say so plainly. The approach needs changing, and the orchestrator takes it to the maintainer.

## Record the verdict

The reviewer records a pass only when no `blocker` or `should` finding remains open. Run this in the bead's worktree, at the commit that was reviewed:

```bash
head=$(scripts/review-head <id>)
bd update <id> --set-metadata review.verdict=pass \
               --set-metadata review.head=$head \
               --set-metadata review.provider=<anthropic|openai|panel> \
               --set-metadata review.model=<model id>
bd comment <id> "Review pass, <model>, round <n>: <one-line summary; follow-ups filed>"
```

Without a pass, record the findings as a comment and leave the metadata alone.

`scripts/review-head` pins the commit you reviewed (the worktree must be clean) and prints it. `scripts/land` merges that commit onto the `main` it lands on and requires the bead to match the result, file for file. A rebase and a neighbour's landing keep the review valid. So does regenerating the watch fixtures that `scripts/watch-snapshot.ts` writes, because `scripts/check` compares those with fresh output. Anything else written after the review voids it, and `scripts/land` will ask for a new round.
