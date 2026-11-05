# Template collector migration

Source: `keelson-rib-spi@59d6895`, `src/collect/template.ts` (all 248 lines).
Requirements: CO-04, CO-05, EV-01. Bead: `spicode-t1k.21`.

## Moved tests

Three cases from `test/collect.test.ts` now run in
`packages/core/test/collect/template.test.ts` under Vitest:

- `template changes`: a merge commit carries its PR title; a squash keeps its subject and number.
- `template changes`: only main's first-parent chain counts as changes.
- `template positions`: a commit is named by the newest release it contains, even from a cached compare.

The positions case uses a real first read to populate the evidence-bearing cache,
then verifies the cached read's label, target label and lack of repeated requests.
It replaces the rib's hand-built cache, which had no observation records.
Exec fixtures use the core port instead of `RibExec`; the fleet and clock are fixed.
The rib file is not edited here. Its unrelated GraphQL, GitHub parsing, lifecycle
and radar cases stay there until their owning collector beads move them.

## Non-import deltas

- Replace the Apache header with the project's MIT header.
- `changeOf` and `firstParentChanges` keep their bodies' behavior; formatting
  compacts the same expressions and return objects. `RawCommit` and the compare
  response types now derive from Zod schemas.
- `TemplateState` becomes a returned request-cache value rather than the rib's
  mutable compares/labels/aheads/files/synced/tags maps. Each entry holds its
  response and original ReadRecord, including completeness. This allows cached
  labels and comparisons to retain evidence for each source read, not a new
  observation time. `templateStateSchema` validates saved state; each requested
  entry is additionally checked against that request's schema. Invalid state is
  discarded with a `persist` failure record. There is no filesystem/store port.
- `readTemplate(ctx, gh, repos, stored?, previous?)` returns the TemplateFacts
  fields plus `state` and `reads`. Pass the last result as `previous` and its
  `state` as `stored` on subsequent sweeps. It does not mutate either argument.
  Both former `FORKS` loops use `ctx.fleet.forks`; time comes only from
  `ctx.clock`. No head still means no remote reads.
- A local `read` helper records every logical API read (all pages of a compare
  form one read). Complete immutable responses reuse their original records;
  failed and cut responses retry. Failures are explicit records instead of
  escaping the entire collector or disappearing in helper catches. Repeated
  failures preserve the original retainedFrom. Returned reads are deduplicated
  by source/object; file and position caches have separate keys from commit
  walks, since their projections of the same endpoint differ.
- `releaseTags` is inlined where it was called. Its semver filter, sort,
  latest-tag insertion and fallback to the latest tag are unchanged. `Gh.pages`
  now follows all tag pages, rather than silently taking the first 30. The
  latest release remains part of its cache key.
- `label` is now local so its individual tag comparisons use the evidence
  helper. It keeps the five-tag bound, identical/ahead selection and short-SHA
  fallback. Cached raw comparisons replace the derived label map and are
  reused when a newer release causes older tags to be checked again.
- Main-ahead reads retain their previous value with evidence on failure.
  Marker comparisons paginate 100 commits per page, at most ten pages, using
  `total_commits`. The first-parent walk and shas still use the returned commits.
  Hitting the page bound returns partial data with a cut record. An empty page
  before total_commits is a failed read, not an apparently complete walk.
  On failure, a marker's prior TemplateCompare, including its changes and head,
  is retained with its original observation, even across a head change.
- `changeFiles` is inlined; it still reads first-parent comparisons, skips
  parentless commits, caches immutable file sets and leaves failed cold reads
  unread. Changes shared by forks are deduplicated before reading. GitHub's
  unpageable compare-files limit of 300 is conservatively marked cut when
  reached; the record's total is the known count, and its reason explicitly
  says the actual total is unknown. File records have a `files:` object prefix
  so they cannot mask commit-walk evidence for the same compare endpoint.
- `syncedPaths` is inlined; its projection and head-specific cache remain.
  Previous sync paths are passed in via `previous`, retained on failure and
  attributed to their original observation instead of silently falling back.
- The target-marker set and labels keep the rib's behavior, restricted to the
  caller's fleet. Template planning and barrel exports are unchanged.

Additional cases cover RecordingExec/ReplayExec equality and exhaustion, complete
multi-page reads, cut walks, repeated retention, independent fleets, missing
heads, invalid saved state and GitHub's file ceiling. No dependency was added.
