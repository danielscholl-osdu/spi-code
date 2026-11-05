# Security collector migration

Source: `keelson-rib-spi@59d6895`, `src/collect/security.ts` (entire file)
and all four cases of `test/security.test.ts`.

All four cases move to `packages/core/test/collect/security.test.ts` under Vitest:
Dependabot fix/scope/moderate parsing; code-scanning rule severity; hidden lists;
retaining a repository's last good lists. No cases stay behind or are deleted.
The rib source checkout is not modified by this bead.

## Non-import deltas

- Replace Apache-2.0 with the project's MIT header.
- Type the severity lookup as `ReadonlySet<string>` to satisfy the context
  boundary's immutable module-collection rule; lookup behavior is unchanged.
- `readSecurity` takes a required `CoreContext`; `ctx.fleet.repos` replaces
  module-level `REPOS` and `ctx.clock` supplies observation times.
- Previous and returned state is `SecurityRead` (`data`, `reads`), a plain value.
  There is no store, file read, JSON load or collector cache. Persistence loading
  and validation remain the sweeper's responsibility.
- Replace the error accumulator with one `ReadRecord` per repository in fleet
  order. Both lists remain atomic per repository. A failed repository retains
  its prior data and original successful `observedAt` as `retainedFrom`;
  repeated failures preserve that time. A cold failure invents no retained time.
  Successful reads clear failure/retention. The area envelope is computed with
  the existing `envelopeOf`, not duplicated here.
- All-repository failure (at least one repo) throws an Error carrying the first
  failure message, as the rib did, so the Sweeper records an outage and retries.
  Partial failure still returns per-repository failed records.
- `SecurityRead.at` is the area's own observation time. When previous data holds a
  repo but no read record (legacy state), a failed read falls back to it for
  `retainedFrom`; without it, none is invented.
- Remove the old readSecurity comment describing its superseded failure policy.
  Both parsers, jq projections, hidden-list detection and paginated list bodies
  are unchanged. `Gh.pages` still invokes `gh api --paginate` for the whole list;
  no GraphQL calls or independent budget accounting are introduced.
- Tests use the typed Exec port instead of a cast RibExec and fixed context
  clocks instead of globals. Extend the four cases with 403/404 coverage,
  fresh sibling records, failed area/oldest observation, repeated/cold failures
  and recovery. Add one caller-fleet isolation case.

No dependencies added. No shared barrels or package/configuration files changed.
