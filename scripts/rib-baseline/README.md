# Recorded rib baseline

Run `node scripts/rib-baseline.mjs` from this worktree with Bun **1.3.13**, Git and tar
installed. It exports `59d6895` from `/Users/danielscholl/keelson/keelson-rib-spi`
to a fresh temporary directory, installs the archived lockfile there and deletes
the export afterward. No install, edits or worktree operations run in either
reference repository. The archived dependency is the pinned `@keelson/shared`
v0.128.0 release tarball, not a sibling workspace.

The script prints both reference repositories' porcelain status and worktree list
before and after, requires a clean starting status and verifies that neither
changed. It replaces the generated fixtures under
`packages/core/test/fixtures/rib-59d6895/` only after rendering and tests succeed.

## Inputs and outputs

`facts.json`, `releases.json`, `services.json` and `rollout.json` come from the
archived rib's `test/fixtures/`. `notes/2026-10.json` is the approved-notes case
transcribed from `test/releases.test.ts` at that revision, including its deliberately
escaped headline. It is test data, not a claim about the live fleet. Other months
have no written notes. The script preserves this checked-in notes input.

`render.json` records the full source SHA, Bun version, fixed time
`2026-10-21T15:00:00.000Z`, UTC timezone, en-US locale, input filenames, the
12-month limit and the idle release-reader state. Facts were swept on October 12;
the fixed render time is the October 21 time used by the rib's release tests.

`console.html` is the raw `consoleHtml` output, not a complete HTML document.
It contains Today, Repositories, Environment, Flow, Horizon and Releases in one
frame. The renderer uses the rib's replay Sweeper, in-memory Store and real
briefing/release functions. Any attempt to call a forge throws.

`test-count.json` records each top-level JUnit file's tests, assertions, failures
and skipped count, plus their totals. Nested describe suites are not counted
twice. Counts must add up and agree with the `bun test` summary; duration,
hostname and other volatile reporter fields are excluded.

## Reuse after the core switch

Export the switched rib to a separate temporary directory, install its
dependencies there and copy `scripts/rib-baseline/render.mjs` to its root as
`baseline-render.mjs`. Copy these fixtures to a temporary input/output directory,
then run the helper in the switched export with:

```sh
TZ=UTC LC_ALL=C \
RIB_SPI_FACTS_FILE=<fixtures>/facts.json \
RIB_SPI_SERVICES_FILE=<fixtures>/services.json \
RIB_SPI_ROLLOUT_FILE=<fixtures>/rollout.json \
RIB_SPI_NOTES_DIR=<fixtures>/notes \
bun baseline-render.mjs <fixtures>
```

Use the temporary fixture copy, not the committed directory: the helper writes
`console.html`. Compare that file byte-for-byte with this baseline. Do not rerun
the baseline capture against the switched revision: the capture stays pinned
to `59d6895`. For determinism, run the capture twice and compare its printed
SHA-256 map (all generated inputs and outputs), or hash the fixture directory
after each run.
