# Environment: who has it, and for how long

The Environment place's design, settled on 2026-11-18. Its mock is `spi-code-environment.html` beside this page. This page wins over the mock, and for the Environment place over the window layout, the window design and the visual design. It replaces PS-09's description of the Environment place's tiles, timeline and quiet list.

## What the place answers

1. Is the shared environment in use, idle or in maintenance, and for how long.
2. Which forks borrowed it, when, and how it went.
3. When Refresh, Reset, Upgrade and Smoke run, and how their runs went.
4. How long each maintenance hold lasted.

The sidebar does not change: it shows green or in maintenance, never in use.

## Status line

One line, then one facts line. The three tiles go.

| State | When | Line |
|---|---|---|
| In maintenance | a hold is open | `In maintenance 1 d 4 h` then, muted, the run that likely set it: `Refresh v0.35.5 failed 22:08 Tue` |
| In use | a fork deployment to the lane is in progress | `In use 1 h 21 min` then, muted, the forks borrowing now; each name opens its live borrow |
| Usage unknown | no borrow in progress and a fork's deployments were not read | `Usage unknown` then, muted, the forks not read by name (`legal, file not read`), or a count above three (`5 forks not read`); never "n of m" |
| Idle | otherwise | `Idle 3 h 12 min` then, muted, the last borrow: `last: search, green 09:00`; with no known last borrow, `Idle` and no length |

The order of the rows is the precedence. The length is the state's own: in use is the contiguous in-use stretch ending now, across forks; idle is the time since the last borrow ended; in maintenance is the open hold's length.

The facts line: running version, readiness share, and the newest smoke: `v0.35.5 · ready 81% of 21 d · smoke failed 11:43, rerunning`. It is left out in maintenance.

"Idle" means no fork deploying. A fork's deployment ending is not its Restore step, so a fork can still be proving while the place says Idle. EV-08 lane events replace this reading when they exist.

## Timeline

Heading `Last 24 hours` or `Last 7 days`, with a `24 h | 7 days` switch. The range is 24 h each time the place opens. Seven days starts at local midnight six days back, so there is no part-day column on the left.

Under the heading, one summary line whose parts add up to the range: `27 borrows · ≈6 h 33 min borrowed · 13 min maintenance · 17 h 14 min idle · 34 min fork overlap`. Maintenance wins over borrowed where they meet; fork overlap is part of borrowed, reported beside it and not added again; a zero part is left out; `≈` when any borrow in it has an estimated end. All of it in muted ink.

### Activity row

- Maintenance is a grey hatched band, with its full length printed on or beside it (`‹ 2 d 13 h` when it began before the range). The band and its label open a popover: span, and `Likely set by <run>. Likely cleared by <run>.`
- Borrows are blue bars over it. Where two different forks' measured borrows overlap, the bar is taller, with no outline; touching overlaps merge into one. An overlap's popover names the forks (`indexer × search`), its span and length, in neutral ink.
- A borrow with an estimated end is a lighter bar.
- An idle gap longer than about an eighth of the range is labelled `idle 9 h 35 min`, on a backing so grid lines do not cross the text.

### Stack lanes

Refresh, Reset, Upgrade and Smoke, each with its cadence under its name, taken from the workflow's cron in the user's time zone (`Sun–Thu 22:00`, `nightly 02:15`), or `on version bump`, or `by hand, weekly` for Reset.

- One bar per run, coloured by result: green, failed, running, cancelled. A popover gives the run's span, length, trigger and its link.
- A run started by hand on Refresh or Smoke carries a small ◆. Reset is always by hand and is not marked.
- An empty lane shows its last run on a backing: `‹ Tue 3 Nov · green`. At now, Reset adds its age (`15 days ago`, amber after 7 days) and Upgrade adds a version waiting to be adopted (`v0.35.6 not adopted`); inside an opened past day neither does.
- Smoke draws a dashed slot only for a nightly that did not run.
- The Reset lane is absent until core reads `env-reset.yml`.

### Forks

- 24 h: one row per fork that borrowed in the range, newest first. One bar per borrow, coloured by result; an estimated end is a start tick with a dashed tail. Overlapping borrows of one fork stack in tiers.
- 7 days: one neutral pill per fork per day, `9 · 4✕` (borrows, failed), with a small amber dot while one is running. The five most recent forks, then `All 13 forks`. A pill or a day heading opens that day.
- A day heading shows its borrow count when it has any. Day headings and the last day's pills stay inside the now line.
- An opened day is the 24 h view of that day with `‹ 7 days` before the summary, which returns to 7 days and puts focus on that day's heading.
- No row for idle forks.

### Popovers

A borrow's popover: fork, branch, result, span and length (`≈` when estimated), and, when other forks overlapped it, `Overlapped storage, legal for 16 min` (each fork once; above three, `Overlapped 5 forks for 16 min`). Links: run, deployment, the fork's home. Popovers stay inside the pane, opening above their anchor when there is no room below. Close and Escape return focus to the anchor.

### Legend

One line under the timeline listing only the marks in the current range.

## Below the timeline

Waiting on you, the Stack runs fold and the Stack repository fold stay. The Version and Fork deploys rows go.

## Data and its limits

- A borrow is a fork's deployment to the lane environment (`Azure/osdu-spi-*` deployments). In progress is running; success and failure end at their status time.
- An INACTIVE deployment has no recorded end. Its end is estimated: its start plus the median measured borrow, but no later than the same fork's next deployment. Estimated borrows are left out of fork overlap.
- Fork overlap counts only measured borrows of different forks, so it is a lower bound.
- Hold set and clear are matched to runs by time.

## Words

Every word on the place comes from core, as PS-09 requires; the window rewrites none. The window positions bars, sums lengths for the summary line, and formats a length or a time with the helpers it already has.
