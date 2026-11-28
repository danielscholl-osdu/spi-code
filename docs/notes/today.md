# Today as redrawn

What the redrawn Today (epic spicode-ilge) taught that the code and tests don't show. Counts and members are in [today-count.md](today-count.md).

- The flow's connectors (each →, the narrow rail, its turn and the ↓) must be DOM text in aria-hidden elements. The smoke's rail rule (`smoke-flow-rail.ts`) measures elements, and it can't see a pseudo-element, so an arrow drawn in CSS passes no check.
- `.today` reserves its scrollbar gutter (`scrollbar-gutter: stable`), so the flow keeps its left edge and width when Yours turns into the taller or shorter Forks sheet. Local macOS uses overlay scrollbars, so a width that passes in a local smoke can still fail on CI's macOS and Windows runners. Trust the CI package jobs for widths.
- The narrow restack is a container query on `.today` at 560 px, and it applies to every Yours section (Blocked, Waiting on you, Moving without you, Can wait, and Since you last looked or Last 24 hours), not just the counted ones. The Forks sheet is the exception: it scrolls sideways. The smoke's 520 px centre fails if any Yours row's What cell is narrower than half the centre.
- Today's fleet, rollout tally and in-flight moves come from one projection (`todayProjection` in core). The host briefing passes its `flights` to `todaySummary` and the service home, so a fork's Overview and Today's Moving without you can't disagree about what is in flight.
- A member leaves its counted line only on its own proven re-run or running check. A runs read that fails keeps the earlier read's data, and that kept run still moves the member today (spicode-ilge.10).
- The Forks sheet classifies forks with `sortForks`, and the reachability helper follows it for placement. Classification tests therefore assert through the rendered sheet (`table.test.tsx`), never through the helper.
- Smoke captures of Today states the three mornings don't show (Quiet, Main red, the Integration filter, a pending request beside a Now row) are variants of the calm and busy snapshots built in `smoke-today-states.ts`. A pending request comes from a `threads.result` fixture, which is a response, not an event.
