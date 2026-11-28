# Opening Today rows from outside Today

- `openTodayRow` in `apps/window/src/views/today/Table.tsx` is the one way in from outside the view (palette, tray, notifications): it navigates to Today, then sets the open selection, since the open selection is keyed by the hash it was set under. The table's own effect scrolls the open row into view.
- An item a Today member merges (`member.ids`) opens that member's row; one shared by several members of a line (`stack:lanes`) opens the line's header row; one on rows of different lines, or on none, opens nothing.
- `openEvidence(null)` from any page is the whole sweep with the way back kept; on Evidence it equals `showWholeSweep`.
- Today's tab and station filter live in the route, `#today[/<tab>[/<station>]]`: `#today/forks`, or `#today/yours/<station>` for a pressed station. The retired `#today/activity` still parses, to Yours, which holds Moving without you and the history. Plain `#today` is Yours unfiltered, so `openTodayRow` and `openCause` always land where every row is drawn.
- A Can wait cause opens as the selection `{ kind: "cause", id }` on plain `#today`; its body clears that selection on unmount, the way `OpenedBody` does, so leaving and returning through a door reopens it cleanly.
- Find opens a Today line with `openTodayLine`, by the line's id: the row Today draws for the line, which is the member's row for a line of one and the group row otherwise (a rollout line keeps its group row even with one fork). A line or cause gone since Find drew it lands on plain `#today` with nothing open.
- The sidebar's Today row and Find's Today go to `lastTodayRoute()`, the Today route last shown this launch; a launch, ⌘L and the outside openers above do not.
