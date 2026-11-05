# Sweeper shell (spicode-t1k.26)

CO-05 / EV-01. Ported from `keelson-rib-spi@59d6895:src/sweep.ts`:
ordered area execution, sweep coalescing, last-good measurements on failure,
pruning and model rebuilding. Persistence is an asynchronous, filesystem-free
port carrying `{facts, cache, reads}`. Core validates load and save through
`sweepStateSchema`; callers provide the facts and cache schemas and an empty
cache factory. Loading happens once, inside the first coalesced sweep.
The model is rebuilt as soon as valid persisted facts load, before any
potentially slow area completes.

Approved orchestrator delta: cache schemas and `prune(facts, cache, now)` are
injected. Wiring `DetailCache`, `jobsKey` and `pruneRadar` belongs to SWEEP2
(`spicode-t1k.43`), after RUNS2 and RADAR supply those collector helpers.
No collector implementation or parallel cache type is introduced here.

Read records use the existing core evidence type and a structural validator
in the persistence schema, keeping the standalone core package independent
of the app's contracts package at runtime.
A failed area retains its data, measurement time and per-read completeness;
each failed attempt records its own time and `retainedFrom` keeps the original
observation time through repeated failures. An invalid cache is replaced by
the validated empty cache, preserving independently valid facts and reads.
Invalid facts or provenance discard the persisted frame. Load/validation
failures become persist read records; save failures are recorded and reject
the sweep rather than silently claiming durability.
Persistence diagnostics are transient: they are never saved or restored,
and a later successful save clears the previous attempt's diagnostic. A new
load/validation failure remains visible for the current sweep, even if its
repaired state saves successfully.

Council delta from the rib: each area receives isolated facts/cache/reads,
and returned data plus cache writes are schema-validated before committing
either. A malformed result follows the failed-area path without overwriting
last-good facts or leaking cache mutations. Empty read arrays use the same
failure-provenance fallback as absent arrays. Previously successful partial
reads retain their observation time even if they already carried a failure.

`test/sweep/sweeper.test.ts` adapts the rib's "failed radar read keeps the last
good frame and its age" case to an injected area, and covers order, ports,
force, pruning, model rebuilding, cold failures, persistence round-trip,
invalid state/cache, coalescing and persistence errors. This is new shell
coverage, not a deletion of rib tests.

The five original `test/sweep.test.ts` cases stay in the rib for now:
in-flight recomposition moves with SWEEP3; dispatch tracking stays until M4;
missing-fork cadence and unreachable real collectors move with SWEEP2; the
real radar retention integration remains until collector wiring moves.
Cadences, pacing, replay, polling, timers and dispatch holds are not ported
by this bead.
