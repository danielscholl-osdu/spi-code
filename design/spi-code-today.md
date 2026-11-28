# Today

The [draft 10 mock](spi-code-today.html) draws Today on a calm afternoon, on a quiet evening, on a blocked day, with a group opened, in every header and flow state, and at the narrowest centre. Where the mock and this file differ, this file wins.

A council (Opus 5.5, GPT-6.2 Sol, Gemini 4 Neon) held five rounds on the redraw on 2026-11-27. Round 5 scored it 9, 8.5 and 9, and the one blocking finding left was applied after. The maintainer approved it the same day.

This page owns Today: its header, the fleet flow, the Yours and Forks tabs, rows, counts and the narrow layout. It replaces the Today rulings in [the service home page](spi-code-service-home.md) and the Today section of [Today and places](spi-code-today-and-places.md). What it does not restate stays as those pages have it: what each Can wait row holds, pending requests, Find, and what an opened row's steps say.

## What Today answers

In a few seconds: is anything broken, what is mine to do now, what is coming, and can I trust what I am reading. Every word on screen does work. Nothing explains the interface.

## Header

| State | Reads |
|---|---|
| Read complete | "Read 15:21 · 13 forks" |
| Reading again | "Read 15:21 · reading 5 of 13", and Read again is disabled |
| Partly read | an amber chip "⌀ 2 ›" before "Read 15:21"; the chip opens Evidence and its title names what was not read |
| First read | "Reading 5 of 13" |

When Blocked and Waiting on you are both empty, one line stands in their place: "Nothing is yours to move." It becomes "At 15:21, nothing was yours to move." while a re-read runs, "Nothing is yours in what was read." on a partial read, and "Reading the fleet." on a first read.

## The fleet flow

One bordered diagram. A stations lane (Upstream → Sync PR → Integration) and a dashed lane labelled "Straight into main" (Template, Release, Dependabot, Other PRs) both lead into Main, and Main leads into Environment.

Four marks, each with one meaning:

| Mark | Means |
|---|---|
| A tinted, bordered cell | A filter. Red only when the cell holds a Blocked row, amber only when it holds a Waiting on you row. |
| A plain value ending in › | A link. |
| → | Flow. Never a link. |
| ⌀ in amber | Not read. It always opens Evidence. |

- **Values carry their unit:** "3 forks stopped", "4 forks behind · 18:00", "5 open", "8 PRs · 6 red", "3 to review", "7 to dispatch", "13 open".
- **Known empty:** a muted dot, inert. Only a read that came back empty earns it.
- **Not read:** ⌀ in place of the value. A cell with both a value and a gap keeps its value and its own action, and carries a separate "⌀ ›" chip named for what was not read: in the corner of a tinted cell, beside the label of a plain one.
- **Main is a readout and never a button.** Green reads "✓ Green" over "13 forks". Red reads "2 red" in red text over "11 green".
- **Environment** shows its state over its version and lane use ("✓ Ready", "v0.35.5 · 1 lane busy") and opens its place.
- **Where a plain door leads:** Release and Dependabot show their Can wait rows. Other PRs shows the cause on the most forks. Upstream and Environment open their places. Sync PR opens Forks. A door opens only when it has a target.
- **One not-read line** sits under the flow, names what was not read and links to Evidence.

**Filter.** Upstream, Sync PR, Integration and Template toggle a filter when tinted. The pressed cell gets a dark outline and its title says pressing again shows all. Nothing else in the flow dims. The Yours tab keeps the fleet totals. The filter's own scope, "Integration · 8 waiting", sits at the right of the tab row beside "Show all". The filter keeps matching rows and group members in Yours and hides Can wait and pending requests.

**Width.** The flow keeps the reading width on both tabs, so it does not move when the tab changes.

## Tabs

Two tabs: Yours and Forks. There is no Activity tab and no right-hand column.

- **Yours** carries the split as counts: "3 blocked 15 waiting". A count of none is left out.
- **Forks** shows "8 stopped" for the whole fleet when any fork is stopped.

## Yours

Sections in this order, in one grid of Fork, What, Link and Age: Blocked, Waiting on you, pending requests, Moving without you, Can wait, then Since you last looked (or Last 24 hours when there is no seen time).

**What counts.**

- A row that says "n forks" counts n.
- One operation across many forks is labelled by its place ("Template", "Upstream") and counts 1.
- A rerun or check still in flight is not the maintainer's yet. It sits under Moving without you and is not counted.
- Pending requests are not members.

**Order inside Blocked and Waiting on you.** Rows with a deadline first, soonest first. Then failing rows. Then the rest, oldest first.

**Rows.**

- Every headline that expands starts with the same chevron, and chevron and headline are one button. A group's "n forks" is plain text. The chevron hangs in the gutter so headlines and plain rows share a left edge.
- Groups are collapsed and name their forks on a second line. Nothing opens itself on load.
- A deadline is a chip on its row: a clock and the time ("Tue 02:00"), red in Blocked and amber in Waiting on you, with the reason on hover.
- A cause the read proved follows the headline in muted text.
- A row whose source was not fully read carries "⌀ 1 ›" beside its age, named for what was not read.
- A teal dot marks a row as new only when there is a "Since you last looked" time.
- A rollout row draws its bar across the forks, with the tally beneath.
- An opened row shows one sentence, its steps, and its buttons. › is never used as a separator in copy.

**Moving without you** lists what is in flight or scheduled, time first. **Since you last looked** gives its time in the heading; a failure there is written in red.

## Forks

The sheet takes the full centre width, with no cap. Forks that hold something come first, and one fold names the rest ("9 release-only forks · oldest 42d on search"). The chevron expands a fork and is named "Expand <fork> details"; the name opens its service page. A value that navigates ends in ›.

## Narrowest centre

At 520 px the flow restacks. Each lane ends in its own → into a rail down the right edge. The rail turns along the bottom and one ↓ lands on Main, and one → leads from Main to Environment. No arrow sits under a door.

Rows restack to two lines: fork and headline, then link and age. The tab row wraps, so the filter scope and "Show all" drop to a second line.

## Left for later

- **The alert trend** ("4 new this week") is drawn in the mock. Core keeps no baseline for it, so it is not built until it does.
- **A red Main:** whether its forks count as Blocked or Waiting on you is not settled here.
