# Inspector item data

Source: `keelson-rib-spi@59d6895`, `src/boards/inspect.ts`.

INSPECT1 ports the kind titles, status, next step and links, Why fields,
source evidence, related navigation, and on-demand same-entry rows into
`src/inspect/item.ts`. `inspectItem` takes the model, item, time, fleet context
and already-read filter results; it performs no I/O and returns no board or
action objects. Why and evidence retain their labelled, linked fields as data;
the host owns projection into the Watch transport.

`test/inspect/item.test.ts` covers the recorded queue, environment effects,
toolchain evidence and same-entry reading/order/folding from the first five
`test/inspect.test.ts` cases. The board-schema assertions stay in the rib.
The ten class cases project the existing frozen boards in
`fixtures/rib-59d6895/oracle/inspect/` (at the repository root, not under
`packages/core/test`). No oracle was missing or regenerated. Cause and effect
are compared to the oracle's combined lede, with its Java gap checked
separately; next, Why fields, status and source evidence are compared directly.

The empty/cleared selection board cases stay in the rib, as do board-specific
layout assertions. The three filter-read cases moved with FILTERS
(`migration/filters.md`). The five environment-verb cases, approval/action
assembly, template steps and their board assertions belong to INSPECT2.
Dismissed boards and last-action rendering stay in the rib until M4.
The inspector Next-line case in `test/next.test.ts` is covered here by a listed
filter entry changing the recommendation; its board assertion stays in the rib.
