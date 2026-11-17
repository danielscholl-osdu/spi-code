# Place popovers

Upstream, Releases, the service pages and the Template open what is clicked in the shared Popover through `usePlaceOpening` in `components/place/opening.tsx`. Spread `opener(selection)` on a control to make it open and close that selection; a Place item reports its id to `openItem`. The anchor is the clicked control, else the place item, else the first `[data-opens]` on the page and then in the document, because a place's head actions draw in the shell's title row outside the page.

`itemContent` tells an item's body: a Today member's reading when the item is on a line, else the item's own, else its repository row. `timed` reads the instants core writes in the body's words as local times. `PopoverFields` draws a row's own facts under the body (a flow's fields, a theme's forks) and reads `·` as blank.

A service station that is a Line column opens that Line cell with `cellOpening`; the release review, which has no column, opens its own body. Service repository lines reuse `RepositoryLine` with a `place` prop naming the service.

On the Template the Details repository lines are static: the Repositories table owns the popovers for the same `rline` ids, and two openers for one id would open two popovers.

The palette (`store/watch.ts`) and the tray or notification route (`app/destination.ts`) still select into the Detail panel; they are not views.
