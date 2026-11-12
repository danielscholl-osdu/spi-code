# Window layout behaviour

What the shell's layout tests pin: panes, the width budget, the top row and pane headers. `design/spi-code-window-layout.html` is the design; these notes record how the code meets it.

Window layout tests keep logical sections flat and reserve `.card` for separate
objects such as repository fact summaries. The shell calls the width budget on
resize and pane toggles, narrowing Detail, moving it to a sheet, stacking pinned
Line context and finally moving the sidebar off-canvas. The eight drawn cases are
covered together in the shell test. The desktop sets a 740 px content minimum;
the renderer clamps smaller viewports before budgeting. The title bar and strip share
one 44 px top row; the place name is in the centre header and the OS title stays
`SPI Code · <place>`. The pips share one Line button with aggregate state counts;
each full-height pip target retains its service context menu, also reachable from
the service's Line sheet row. Status field buttons open Line and Cmd-L still toggles it.
Freshness is the last field: a muted, amber or red dot, the sweep time and an
affected-source count. Its hover and linked accessible label spell out failed,
incomplete and stale counts; unread sources are named too. Cut reads count as
incomplete but stay red, as do failures; other incomplete or stale reads are amber.
It opens the sweep's Evidence. The row's inset divider leaves the full 44 px for targets,
and pip marks themselves never take focus from their button.
The shell measures the row into `--topbar-height`; narrow sidebar and Detail sheets
and their backdrops use that offset, fall back to 44 px before measurement,
and update when the row resizes.
Opening a collapsed sidebar uses the budget for its open state, so one shortcut
opens it off-canvas after narrowing. Clearing a selection closes a Detail sheet;
inline sweep Evidence may stay open. Resizing an inline sidebar off-canvas moves
focus out of its hidden content to the sidebar toggle.
Pane headers share the 44 px `pane-header` rule. The centre reads left-aligned at
most 960 px wide with 20 by 24 px padding; its full-width place header stays above
the scrolling body. The Line body also scrolls below its header and contains its
absolutely positioned accessibility labels. Service source sections use named, styled disclosures,
with nonempty Attention open by default.
