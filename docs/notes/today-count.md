# The Today count

`todayMembers` in `@spi-code/contracts` is the one count of what is yours: the members on Blocked and Waiting on you, each once in line order. The sidebar's Today row, the macOS dock badge and the tray tooltip all read its length, so a change to who counts is made there once.

The hidden sidebar toggle's dot still counts Interrupts (`countInterrupts` in `apps/window/src/views/today/selectors.ts`): its label is "Something needs you now", and the packaged smoke asserts that a mid-sweep calm snapshot shows only the sweep's tone.

The "Today is ready" hand-over notification shares the tray's Today count (maintainer Q4, spicode-djg.29): zero members or missing Today lines give no body. `interruptions` remains for Interrupt-specific callers; the tray tests' `briefed` and 16 Nov brief set Interrupts and members apart so a surface that counts the wrong one fails.

A snapshot's provenance points into `/briefing/lines/…`; a test that rewrites `lines` drops those entries, or the schema rejects the message and the tray silently ignores it.
