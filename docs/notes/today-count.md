# The Today count

`todayMembers` in `@spi-code/contracts` counts the members on Blocked and Waiting on you, each once in line order. The Yours chip, the sidebar's Today row, the macOS dock badge and the tray tooltip read its length. A rollout member with a fork ID represents that fork's open template sync PR and also counts on its Overview. A rollout with no eligible PR keeps its fleet member when it needs the operator's move.

The hidden sidebar toggle's dot still counts Interrupts (`countInterrupts` in `apps/window/src/views/today/selectors.ts`): its label is "Something needs you now", and the packaged smoke asserts that a mid-sweep calm snapshot shows only the sweep's tone.

The "Today is ready" hand-over notification shares the tray's Today count (maintainer Q4, spicode-djg.29): zero members or missing Today lines give no body. `interruptions` has no product caller and is used only by tests; the tray tests' `briefed` and 16 Nov brief set Interrupts and members apart so a surface that counts the wrong one fails.

A snapshot's provenance points into `/briefing/lines/…`; a test that rewrites `lines` drops those entries, or the schema rejects the message and the tray silently ignores it.

Use the Template door in `briefing.today.fleet.doors` for the sidebar mark's count, hover forks and unread forks. The rollout verification count serves the Template place. Release and Dependabot use the service door partition by PR URL. Complete fork reads supply the Can wait figures and the Blocked and Waiting remainders. Held PRs from incomplete reads sit under Not read, and program repositories and repositories with no known group sit under Outside the forks.
