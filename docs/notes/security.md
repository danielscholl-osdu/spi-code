# The Security place

Each section owns three files and nothing else: its schema under `packages/contracts/src/watch/security/`, its function under `packages/core/src/security/`, and its component and css under `apps/window/src/views/security/pane/`. Top is `top.ts`, `page.ts` with `figure.ts`, and `Top.tsx`; By rule is `by-rule.ts` and `ByRule.tsx`; the opened rule is `opened-rule.ts` and `OpenedRule.tsx`, drawn by By rule inside its open row; By repository is `by-repo.ts` and `ByRepository.tsx`. The rest is shared: `security.ts` and `security/base.ts` in contracts, `classify.ts`, `index.ts` and `contract.ts` in core, and `Pane.tsx`, `state.ts` and `Words.tsx` in the window.

Core classifies each alert once, by its own path with `groupOf`, into `SecurityInput`; a section reads that and never the facts. `index.ts` totals each lane and sets `atLeast` before any section runs, and builds the no-list-read pane without calling one, so a section's words never change `fixtures/watch/snapshot-1106.json`, whose facts hold no security area.

The fixtures are `packages/core/test/fixtures/upstream-1116.json` (16 Nov, both lists in all 15 repositories, with pastPrs) and the edits in `security-cases.json` beside it: partial (workflow's code scanning and crs-conversion's Dependabot absent), retained (file's read failed, its lists kept), failed (every read failed, lists kept), clean (every SPI alert removed) and single (one alert in one repository). Core tests load them through `packages/core/test/security-cases.ts`; the watch generator writes each as a pane to `fixtures/watch/generated/security/<name>.json` through `packages/host/test/watch/security-fixture.ts`. They sit in a folder of their own because the fixture sweeps over `fixtures/watch` (the snapshot parse and the text rules) read whole snapshots.

Core's security files take contract types only from `packages/core/src/security/contract.ts`, which re-exports the contract whole: core's pack drops the contracts dependency and links that one line to the copied security declarations, so a section can use any security type without touching `packages/core/scripts/pack.mjs`.

Each classified alert carries its owner (`spi`, `upstream`, or `setting` when it has no file); only a tests-lane row words it on its second line. No fixture holds a rule that mixes a setting with paths, or a setting on a fork.

The packaged smoke draws the page from `smoke-security.ts`: the 16 Nov snapshot with each generated pane put in its place, walked through every bar and view for overflow at each width. The text rules read the generated panes the same way in `app/security.text-rules.test.tsx`, and `securityReadingCases` in the reachability helper lists what the old place drew from the security reading.

The page keeps a new Briefing item's chip through `FreshItems` beneath it. A fresh id that is one of the reading's alerts has no chip, since the page draws rules; `placeFreshCases` exempts it with the reason.
