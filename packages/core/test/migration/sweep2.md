# Collector sweep wiring (spicode-t1k.43)

Ports `keelson-rib-spi@59d6895:src/sweep.ts` collector orchestration,
cadences, proof-job walk, cache validation and pruning into `createSweeper`.
Every GitHub collector, including radar's ledger/pin readers and releases,
uses the same fleet-local GraphQL account. `cache.budget` records each sweep's
charged cost, GraphQL calls, remaining points, reset time and deferred reasons.
Cut-body retries retain the forge account's estimate when no cost is readable.
Optional areas respect the pacer's floor; core reads continue. Release reads
and their envelopes remain in `cache.releases`, separate from `Facts`.

The generic shell still accepts injected areas and schemas. The collector
factory supplies the real cache schema, composed prune hook and a resolved
fleet context. Callers supply their Facts schema and persistence/exec ports.
Exec replay uses `ReplayExec`; snapshot replay accepts a validated
`{facts, cache, reads}` value without executing or saving.

Moved cases from rib `test/sweep.test.ts`: missing-fork GitLab cadence,
failed radar last-good retention, and unreachable gh/glab rendering.
They run in `test/sweep/areas.test.ts`, alongside multi-area replay accounting,
low/unknown budgets, exact cadence boundaries, fleet isolation, snapshot
replay, malformed pin timestamps and bounded collector caches.
The two remaining rib cases stay: in-flight recomposition belongs to SWEEP3;
dispatch tracking remains in the rib until M4. No rib test is deleted here.

Deferred council fixes are covered in `test/collect/radar.test.ts` (cached
diff replay envelopes and retained filters), `test/collect/pins.test.ts`
(head/pin evidence and removal retry), and the shell's no-invented-provenance
case when persisted reads are empty. Total outages preserve prior per-fork
and approval records; no timestamp is synthesized from an area's `at`.
