# Radar collector

Source: `keelson-rib-spi@59d6895`, `src/collect/radar.ts`. MIT relicensing follows
`AGENTS.md`.

## Moved cases

The Radar section of `test/collect.test.ts` moves to
`packages/core/test/collect/radar.test.ts`:

- "a list is read 100 at a time until a short page, each page counted" is
  exercised through `readRadar` with 103 MRs and exact forge page paths.
  Forge's own page/counter contract remains covered by the forge tests.
- "MRs keep their fields, paths and pom lines; a failed diff stays unread,
  not empty" also records and replays its Exec log to identical Radar facts
  and evidence.
- "each diff is read once per head sha and commit sha" preserves warm-cache
  reuse and retries failed diffs.
- "prune keeps every diff a current MR or queued commit names, then the
  newest up to the cap" adds merged MR references and the default 200 cap.
- "the recorded frame holds each fixture fork's filter and the diffs behind
  its halts" keeps the fixture filters, halt paths, Java hunks and anonymized
  authors assertions.

The classifier, model and queue cases in `test/radar.test.ts` already live in
core's model test suite. Its inspector board assertions remain in the rib.
Nothing in this bead deletes source tests.

## Non-import deltas

- `readRadar` requires `CoreContext`. Fleet membership and every observation
  time come from that context. Pin/latest/removal collection is composed from
  the dedicated pin reader and ledger state is separate from pin state.
- `RadarRead` extends `RadarFacts` with per-read evidence. Forge errors for
  MR lists, diffs and filters are explicit failure records; one failed fork
  does not prevent another fork's result. Unread diffs and filters remain
  absent instead of empty success-shaped substitutes.
- MR lists and diff lists use `Glab.restAll`, with no local truncation cap.
  GitLab oversized/collapsed files retain all paths and deletion metadata.
  Only missing classification hunks (`pom.xml` or `.fossa.yml`) emit cut
  evidence and prevent caching; non-hunk omissions are complete for Radar
  and cached. Partial hunk reads still publish paths and available hunks.
- Complete immutable diffs refresh their evidence observation from the context
  clock on cache hits, without rereading GitLab. Legacy cache
  entries without evidence or deletion information are reread, not assigned
  a fabricated observation time. Pruning removes orphaned evidence too.
  As in the source, live references take priority over the 200-entry cache
  cap; only unreferenced entries are evicted oldest-first. Pin POM caches
  retain the source's 60-entry cap.
- New cases cover rename/deletion/hunk extraction, oversized diffs, isolated
  failures, legacy merged-diff refresh, context-clock cache freshness, and pin
  reader composition/retention. Clock cases deliberately set system time to
  2040 while the context remains fixed in 2026; ages and retained evidence
  must still come from the context clock.
- The collect barrel exports the state type as `RadarCollectorState` because
  the model already exports a different `RadarState`.
- Round 1 regression cases failed before the fix: both oversized and collapsed
  non-hunk paths must still Halt and cache on MR and commit endpoints; flagged
  POM files retain paths, emit cuts and retry. Cached MR/commit evidence stays
  fresh beyond the envelope's stale threshold using the context clock.
