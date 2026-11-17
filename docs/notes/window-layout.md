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
`--chrome`, not `--hover`, for the same contrast reason.

The Engineering system rollout ladder (`views/template/Rollout.tsx`) joins two core fields per fork: the engineering visual's slot (`done` is verified, `empty` is to dispatch, `broken` failed) and Sync Template's since row (`done` is merged). An `occupied` slot is "merged · verification pending" only when that row says merged; otherwise, and for `waiting` and `unknown`, it reads not read. `rollout-1116.json` beside it is core's output for those fields on the 16 Nov sweep; regenerate it from `packages/core/test/sweep-1116.ts` if core's rollout changes.

The Engineering system repositories table (`views/template/Repositories.tsx`) marks a line on Today when an item whose `actor` is the operator has the line's URL as its `subject` or as an evidence link; an item without an actor claims nothing. It does not apply the mock's companion-issue rule (a sync engine "Ready for Review" issue standing for its sync PR's item); that join is core work. `repositories-1116.json` beside it is the host's repositories and watch items on the 16 Nov sweep (`buildBriefing`, `repositoryLines` and `itemAttention` over `packages/core/test/sweep-1116.ts`).

The Line's five drawn stations exclude Release, which core still uses in service release gates and readings. `views/line/fixtures/sweep-1116.json` freezes the Line fields projected from `packages/core/test/fixtures/upstream-1116.json` on dcbc3288 with that fixture's sweep clock and the pinned rib rollout; it leaves the shared 16 Nov input untouched. Cell membership uses existing briefing item identities and scopes; missing actor or item evidence gets no Today dot.
