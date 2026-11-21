# Window layout behaviour

What the shell's layout tests pin: panes, the width budget, the top row and pane headers. `design/spi-code-window-layout.html` is the design; these notes record how the code meets it.

Window layout tests keep logical sections flat and reserve `.card` for separate
objects such as repository fact summaries. The shell calls the width budget on
resize and pane toggles, narrowing Detail, moving it to a sheet, stacking pinned
Line context and finally moving the sidebar off-canvas. The eight drawn cases are
covered together in the shell test. The desktop sets a 740 px content minimum;
the renderer clamps smaller viewports before budgeting. Each pane owns its part of
one 44 px top row; the centre's header holds the title, the capsule and, while Detail
is closed, the right-panel toggle. Views hand their title, chips and Pin to the shell
through `PaneTitle`, a store the shell renders without a portal; with no view title it
shows the route's name. The OS title stays `SPI Code · <place>`. The one sidebar
toggle sits outside the sidebar at a fixed x after the window controls; each header
under it leaves a no-drag `toggle-room`, because Electron subtracts no-drag only from
drag regions earlier in document order. The centre's header is a grid whose first column,
the title, takes the room, so the capsule and the end column after it sit at the end at
every width; the toggle's room sits in the title's padding and the Windows caption inset
in the end column's. Detail's tabs shrink before its toggle does, so the toggle stays clear of the caption.
The pips share one Line button with aggregate state counts;
each full-height pip target retains its service context menu, also reachable from
the service's Line sheet row. Status field buttons open Line and Cmd-L still toggles it.
Freshness is the last field: a muted, amber or red dot, the sweep time and an
affected-source count. Its hover and linked accessible label spell out failed,
incomplete and stale counts; unread sources are named too. Cut reads count as
incomplete but stay red, as do failures; other incomplete or stale reads are amber.
It opens the sweep's Evidence. The row's inset divider leaves the full 44 px for targets,
and pip marks themselves never take focus from their button.
Narrow sidebar and Detail sheets and their backdrops start below the 44 px row.
Opening a collapsed sidebar uses the budget for its open state, so one shortcut
opens it off-canvas after narrowing. Clearing a selection closes a Detail sheet;
inline sweep Evidence may stay open. Resizing an inline sidebar off-canvas moves
focus out of its hidden content to the sidebar toggle.
Pane headers share the 44 px `pane-header` rule. The centre reads left-aligned at
most 960 px wide with 20 by 24 px padding below the header row. The Line body also scrolls below its header and contains its
absolutely positioned accessibility labels. Service source sections use named, styled disclosures,
with nonempty Attention open by default.
Shell's effects live in hooks beside it, and the order Shell calls them is the effect order:
the tray-destination ref must be set before the host subscription, because the preload hands
a held destination to `onNavigate` synchronously (`shell-order.test.tsx`).
A pinned row's outlined count fills its ring with `--sidebar` on hover: Warm light `--error-text`
and `--warning-text` read 4.25 and 4.15 on `--hover`, under AA, and `--hover` is not a gated surface.
A source link is a `LinkPill` drawn from the `kind` core sent; its words take only the number or
hash from core's label, never the URL, and an absent kind draws as `other`. A muted pill hovers on
`--chrome`; muted text also passes AA on `--hover` (minimum 4.54).

The Template rollout ladder (`views/template/Rollout.tsx`) joins two core fields per fork: the engineering visual's slot (`done` is verified, `empty` is to dispatch, `broken` failed) and Sync Template's since row (`done` is merged). An `occupied` slot is "merged · verification pending" only when that row says merged; otherwise, and for `waiting` and `unknown`, it reads not read. `rollout-1116.json` beside it is core's output for those fields on the 16 Nov sweep; regenerate it from `packages/core/test/sweep-1116.ts` if core's rollout changes.

The Template repositories table (`views/template/Repositories.tsx`) and the service page mark a line on Today only from the line's `onToday`, which core's `repositoryToday` resolves: a Today member's own item names the URL as subject or evidence, or the line is the sync engine's "Ready for Review" companion issue of such a sync PR (`syncCompanions`). The window does no URL matching of its own. `repositories-1116.json` beside it is the host's repositories and watch items on the 16 Nov sweep (`buildBriefing`, `itemAttention`, `todayLines`, `repositoryToday` and `repositoryLines` over `packages/core/test/sweep-1116.ts`).

The Line's five drawn stations exclude Release, which core still uses in service release gates and readings. `views/line/fixtures/sweep-1116.json` freezes the Line fields projected from `packages/core/test/fixtures/upstream-1116.json` on dcbc3288 with that fixture's sweep clock and the pinned rib rollout; it leaves the shared 16 Nov input untouched. Cell membership uses existing briefing item identities and scopes; missing actor or item evidence gets no Today dot.

Evidence is a route (`#evidence?from=<page>&sel=item~<id>|line~<id>&open=<kind>~<id>&sheet=line[~<column>]`). `sel` is what Evidence shows; `open` is what Back reopens (the selection when absent) and `sheet` says the Line overlay lay over the page. A Today row, place popover or Line cell that opens calls `setOpenSelection` with any `kind~id` it can reopen from; the store keys it by hash and by whether the overlay is up. `openEvidence(subject)` keeps that open selection separate from the subject, Whole sweep and the capsule on Evidence keep it, and `leaveEvidence` navigates back, reopens the overlay with its column and sets the selection for `useOpenSelection`. The page resolves a selection against `briefing.lines` (member `evidence` and `fork`) and groups the sweep's reads by fork with `readFork`, the same naming Failed reads uses; it never reads the Detail panel's selection store.

`components/opened-body/OpenedBody.tsx` is the shared body, not a mount: callers pass the open selection, its Today subject (or null), its place destination and close handler. `todayContent` keeps core’s headline, ordering and primary URL; it uses the raw item only for a single step and additional sources. `repositoryContent` reads core’s `RepoLine.onToday` for source and companion membership, and takes `briefing.today.canWait` to claim Can wait only for a counted URL. An unassociated, uncounted URL has no disposition. Pass resolved companion links to `todayContent`; it never manufactures file or operation URLs.

Opened-body rulings R8-1–3: a Today body omits its row’s pill even when primary, retaining that source for ⌘↵; a place body shows primary first. Group bodies carry only shared sources, with member pills on their sub-rows; a member body in a group names its fork on each pill. The bridge URL allowlist lives in `app/external-links.ts`, independent of the Detail panel. The opened-body fixture’s sibling `sweep-1116.md` gives its exact regeneration command.

Today's Blocked and Waiting on you (`views/today/Table.tsx`) keep no open state of their own: a row opens by `setOpenSelection` with `item~<member id>` (a single-member line or a sub-row) or `line~<line id>` (a group header), and the table reads `useOpenSelection`, so Evidence's Back and a place's "On Today" link reopen the same row. A group header's body drops `primary` (R9-2: no ⌘↵ target without a pill in Open). In the reachability suite a row that opens in place is `opens: { click, opened }`, the selector the opened body must match.

R19-1: a place head steps only its home members from `briefing.lines`, joined to core's `briefing.places[].itemIds`; repository `onToday` associations are cross-references. Homes come from `members[].home`; absent home claims stay unmarked. `components/place/members-1116.json` freezes lines, watch items, place membership, repository associations and stations projected by `projectBriefing`, `placeReadings`, `settleBriefing` and `projectStations` from the unchanged 16 Nov facts/reads, pinned rib rollout and sweep clock in `packages/core/test/sweep-1116.ts`. Head stepping registers an `item` open selection to mark the instrument; fresh-item bodies use `fresh-item` with the member as Evidence subject, and never select into the inspector.

A place head omits the status word when no shared field supplies one; only a core place row with unread areas permits the fallback “not read yet”. Security’s busy/bad snapshots exercise the read case. The home-member fixture’s sibling `components/place/members-1116.md` gives its exact regeneration command, including the original empty area envelopes.

Today member homes are core's `lines[].members[].home`, separate from place readings' broader `itemIds` and repository cross-references. A radar move absorbed by a sync PR lives on the Line; a radar-only move or upstream port lives in Upstream. The 16 Nov member fixtures regenerate with the commands in `components/place/members-1116.md` and `components/opened-body/sweep-1116.md`; the recorded watch snapshot uses the regeneration line in `.agents/orchestration/rules.md`.

R11-1: every place's popover is `components/popover/Popover.tsx` around `OpenedBody`. Its Escape listens on `window` in the capture phase, so the Line sheet's own window Escape never sees it; its outside close listens for `click` on `document` after React's handlers, ignores clicks on a control marked `data-keeps-popover` (the Swept capsule and its popup, so its Evidence button opens Evidence for the open popover) and closes on every other click outside, sidebar and top row included, but only while its selection is still the open one, so a stepper or another cell clicked outside moves the popover instead of closing it. A Line cell opens as `cell~<fork>:<station>` with its most urgent member (core's line order) as Evidence subject, and a stepped `item~<id>` opens on that member's first Line cell. When its anchor scrolls out of view the popover is clamped to the window's edge rather than closed, so a passive scroll never clears the open selection that Evidence and Back read. A cell with no member takes its source from the runs the sweep read on its fork: the station's latest run (Upstream reads Sync Upstream), the lane's deployments, else the fork's Actions page; with no run read it has no source and no ⌘↵.

R12: rollout popovers mount the shared shell and Today body. A stepped rollout member marks all seven pending forks and opens at the first; a clicked rung keeps its own selection for Evidence Back. Dispatch names every `todo` rung, uses the member’s core deadline, and exposes only the template comparison while M4 operations are absent. Merged/verified rungs read Sync Template’s since slot and latest observed run; missing reads never supply a run or a merge claim.

The Environment opens everything in the shared popover and nothing in the panel: a run or hold as `event~<lane>:<event id>`, a reading item as `item~<id>`, a stack repository line as `repository-line~<line id>`, each control marked `data-opens` (a Place item by its `data-selection-id`). Events carry no URL, so a run's pill is `<stack repository>/actions/runs/<id>`, the repository taken from a GitHub line the sweep read on osdu-spi-stack; with none read the run has no pill. "Stayed ready" needs readiness yes now, a read Held lane holding nothing over the run, and no refresh or upgrade over it that was not green. The Upstream syncs block in Stack runs opens the Line sheet: the plan button bare, an Also waiting row on that fork's first stopped or waiting station.

Back and forward (⌘[ ⌘] on macOS, Alt+← Alt+→ on Windows) walk the window's own hash history. Each entry this launch made carries `spiHistory: { launch, index }` in `history.state`, so the keys stop at the launch's first entry. A step is in flight until its popstate or hashchange lands on another entry; presses meanwhile, and auto-repeats, do nothing, so the keys alone never reach an entry from before a reload. A step taken any other way (a mouse button, a gesture) is not gated, and a pre-reload entry it lands on is counted as a new entry of this launch. `navigate()` advances the index itself because happy-dom copies the old entry's state onto a new hash entry, where Chromium gives it null. Opening a Today row in place adds no entry; a service row is in the hash and does.

A thread's right panel (`panels/thread/`) opens only on a started thread, never on `#thread/new`. `usePaneLayout(inThread)` owns its open state and passes `context: "thread"` to the budget; a saved open panel reopens at launch only where it would sit inline, and only a user toggle, Escape or the backdrop writes the preference. Each tab is its own file listed in `tabs.ts`. Reading mounts the scope's place under a throwaway `TitleProvider`, so the place's `PaneTitle` stays out of the thread's top row.
