# The Today count

`todayCounts` in `@spi-code/contracts` is the count on Blocked and Waiting on you, split by section. A line reading “n forks” contributes those distinct members; an operation labelled “Template” or “Upstream” contributes one; a single-fork line contributes one. A member on two lines is counted once, and pending requests are not members. `todayMembers` keeps the member rows for places and threads; the sidebar's Today row, macOS dock badge, tray tooltip and “Today is ready” notification read `todayCounts`.

Rollout classification is per fork: merged, to review, checking, to dispatch, not started or not read. Open PRs to review form an “n forks” line. A dispatch owed is one “Template” line, even when both kinds exist. A fork with unread data is neither review nor dispatch. Ports are one “Upstream” operation.

A member leaves its line only when its own re-run is proven in flight or its own check was read as running. It becomes a Now row under Moving without you with its fork, link, age and not-read evidence, and no longer contributes to the count. Unknown or unrelated running results leave it on its original counted line. In-flight rows are never capped; only the first three scheduled rows are kept.

The hidden sidebar toggle's dot still counts Interrupts (`countInterrupts` in `apps/window/src/views/today/selectors.ts`): its label is "Something needs you now", and the packaged smoke asserts that a mid-sweep calm snapshot shows only the sweep's tone.

The "Today is ready" hand-over notification shares the tray's Today count (maintainer Q4, spicode-djg.29): zero members or missing Today lines give no body. `interruptions` has no product caller and is used only by tests; the tray tests' `briefed` and 16 Nov brief set Interrupts and members apart so a surface that counts the wrong one fails.

A snapshot's provenance points into `/briefing/lines/…`; a test that rewrites `lines` drops those entries, or the schema rejects the message and the tray silently ignores it.

Use the Template door in `briefing.today.fleet.doors` for the sidebar mark's count, hover forks and unread forks. The rollout verification count serves the Template place. Release and Dependabot use the service door partition by PR URL. Complete fork reads supply the Can wait figures and the Blocked and Waiting remainders. Held PRs from incomplete reads sit under Not read, and program repositories and repositories with no known group sit under Outside the forks.
