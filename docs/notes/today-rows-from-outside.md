# Opening Today rows from outside Today

- `openTodayRow` in `apps/window/src/views/today/Table.tsx` is the one way in from outside the view (palette, tray, notifications): it navigates to Today, then sets the open selection, since the open selection is keyed by the hash it was set under. The table's own effect scrolls the open row into view.
- An item a Today member merges (`member.ids`) opens that member's row; one shared by several members of a line (`stack:lanes`) opens the line's header row; one on rows of different lines, or on none, opens nothing.
- `openEvidence(null)` from any page is the whole sweep with the way back kept; on Evidence it equals `showWholeSweep`.
