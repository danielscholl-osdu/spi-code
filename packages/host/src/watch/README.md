# Watch projection

`projectWatch` turns the sweep's Facts, release reads and read records into the
validated Watch snapshot the window draws. It runs named steps that live beside it,
each with its own test file. It posts no messages, executes no actions and registers
no routes; `WatchRoutes` does that.

Rules the types cannot state:

- The tree shows evidence states, not service health: a stopped service can have
  fresh evidence.
- A reading with `content: null` was not computed. It is not an empty reading, and
  the window omits it.
- `provenance` names only the areas that fed a value. Never reconstruct a source
  from an item's class, its text, a read record's `source` or `object`, or the worst
  area state. An unknown label falls back to a superset, never to fewer areas.
- Request-time reads (the FILTERS check for a halt) go in a result's `evidence`.
  They never replace the stored area envelopes.
- Inspector actions are read-only until M4; every one carries a `disabledReason`.

Fixture regeneration is in `.agents/orchestration/rules.md`, under "This machine".
