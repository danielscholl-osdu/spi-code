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
- **Tests:** ask for a missing test only when a real regression would get past without it. A missing test for copy, markup, layout or spacing is not a finding: the capture covers it (`.agents/orchestration/rules.md`, "What to test"). A new test that breaks those rules is a `nit`; name the row to fold it into, or say delete it.
- **Your own probes:** at least one beyond the builder's tests: an edge case, a split input, a failure path. This is where a review earns its cost.
- **Your copy:** mutations and probes run in your own copy of the worktree, which needs `pnpm install --frozen-lockfile` and `pnpm build` before anything runs, and a rebuild of any package you mutate before a dependent's test will see it.
- **Checks:** run `scripts/check --quick` in your copy once, and read the bead branch's CI run (`gh run list --branch bead/<id> --limit 1`). A green run is the cross-platform and packaged-smoke evidence; a run that is red or has not finished is something to say in the verdict, not to wait for. Don't run the full `scripts/check` or `pnpm package:mac`: CI runs both, and `scripts/land` lands only a commit CI passed.
- **Screens:** when the bead changes what a place draws, compare the captures for the surfaces it touches with the design section the bead names, and say match or mismatch per surface. Take them from the run's macOS smoke artifact: `gh run download <run id> -R <owner>/<repo> -n smoke-mac-arm64-<head sha> -D <scratch dir>` (the `-R` lets it work outside a checkout; `git remote get-url origin` names the repository). The captures are whole pages; `smoke.json` beside them records where each surface and measured row sits, which is quicker than finding it by eye. Never package locally to get them.
- **Gates and state machines:** a bead that changes a gate (`scripts/land`, a sandbox, a credential path) states in its acceptance what the gate must never allow and how far it must keep working when things go wrong. Hold it to that, and grade what you find by it:
  - the thing the gate must never allow, by any route, is a `blocker`;
  - a silent wait or a wrong refusal after ordinary work or an ordinary interruption (a killed script, a flaky run, a neighbour's landing) is a `should`;
  - a state someone must arrange by hand, or that needs a coincidence, is a follow-up, provided the gate ends with a message and lets nothing through.

  In round 1, write out every state the code can start in against every outcome, and probe each cell, so the builder gets the whole table at once. One new cell per round is how such a bead reaches six rounds.
- **The bead's own text:** if the acceptance is missing something it should state (a threat model, an owner, which of two readings is meant), that is a note for the orchestrator, who owns the text and can fix it without a new commit. Say it in your verdict. It is not a finding against the code and does not hold up a pass. Adding a path to the generated list in `scripts/land` is covered by the statement in `docs/sdlc.md` and the test that pins the list; it needs no statement of its own.

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
| `review:exempt` | None. `scripts/land` checks that the diff really is Markdown or pages in `design/`. The maintainer's approval is the review. |

## Later rounds

Round 1 is full. A recheck covers only the fix and the open findings:

- Read `git diff <reviewed head> <new head>`, not the whole bead again.
- For each finding, rerun the probe that found it and confirm the new test fails without the fix.
- A new finding in code the fix did not touch is a follow-up unless it is a `blocker`.
- When the round changed only the bead's text and the head is the same, there is nothing to rerun: confirm the text and record the pass.
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

`scripts/review-head` pins the commit you reviewed (the worktree must be clean) and prints it. `scripts/land` merges that commit onto the `main` it lands on and requires the bead to match the result, file for file. A rebase and a neighbour's landing keep the review valid. So does regenerating the watch fixtures that `scripts/watch-snapshot.mjs` writes, because the full check, which CI runs on the commit being landed, compares those with fresh output. Anything else written after the review voids it, and `scripts/land` will ask for a new round.
