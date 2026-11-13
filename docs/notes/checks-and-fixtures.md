# Checks, test conventions and fixtures

How the checks are put together, the window's text rules, time formatting, fixture regeneration, the shifted-clock pass and the license notices.

When Bun is on PATH, `scripts/check` requires Bun 1.3.13 or newer for the record-sweep proxy tests.

The scaffold uses Node 22.16 or newer, matching `engines` in `package.json`, and pnpm 10 (the exact pnpm version is in `package.json`). `node:sqlite` is unflagged from 22.13, but the host store also needs `DatabaseSync.isTransaction`, which arrived in 22.16.

`pnpm run build` compiles all six workspaces; `pnpm run lint`, `pnpm run typecheck`,
`pnpm run test` and `pnpm run check:headers` run individual checks. Vitest discovers
`src/**/*.test.{ts,tsx}` in each workspace, `packages/core/test/**/*.test.ts` and
`scripts/**/*.test.ts` (`vitest.config.ts`).
The header check covers tracked and untracked, non-ignored sources, including
extensionless shebang scripts. Build output and dependencies are ignored.

The window's text rules render every Watch snapshot named in
`test-utils/watch-fixtures.test-helper.ts`, one `app/text-rules.<stem>.test.tsx` per
snapshot (Vitest runs a file in one worker, so a file per fixture keeps each under the
timeout). A new `fixtures/watch` snapshot, committed or generated, fails
`watch-fixtures.test.ts` until it is listed with its file or excluded with a reason. The walk covers places,
strip, Line sheet, sidebar, command palette and Detail kinds. It checks headline length,
internal names, title emoji and empty or placeholder sections, with rule mutations.
Injected emoji cases cover Detail fields, Today sublines, template queue rows and
environment repository lines; ordinary symbols and navigation glyphs stay intact.

Core and window duration formatters share `timeUnit` from contracts. It binds each
number to its unit with U+00A0; compound durations may wrap between pairs. Title
cleanup preserves those bindings. After changing core time copy, regenerate Watch
fixtures with `TZ=UTC node scripts/watch-snapshot.mjs` after building, then format
`fixtures/watch`. The generator writes what `packages/host/test/watch/outputs.ts`
lists, running the host and the builders compiled from their current sources into a
temporary directory; it never loads `dist` or `packages/host/build`. It refuses and
writes nothing while `tsc -b --dry` would rebuild them, or when a module they import
has no current source.
Only `snapshot-1106.json` and `inspect-1106.json` are committed.
`node scripts/watch-generated.mjs` writes the rest into the git-ignored
`fixtures/watch/generated` with a digest of the sources it read. Tests read those files
through `scripts/watch-generated.mjs`, which refuses them, naming the command, when the
folder is missing or the digest no longer matches the checkout. `scripts/check` and
packaging run it first.
Recompute the models digest with
`SPI_RECORD_MODEL_DIGEST=1 pnpm vitest run packages/core/test/inspect/identity.test.ts`.
The frozen rib oracle stays unchanged; its comparison ignores only U+00A0.

`scripts/check` repeats Vitest with `SPI_TEST_CLOCK_SHIFT=1`, moving the wall
clock 400 days forward to catch expiring fixtures before they break main.
The shifted clock still ticks, leaves real timers alone, and allows explicit
fake clocks. Both passes respect `VITEST_MAX_WORKERS`. Tests with dated fixtures
should inject a clock or pin their own fake time rather than read today's date.

`scripts/check` also validates production dependency licenses offline and writes
`build/THIRD_PARTY_NOTICES.md`. `package:mac` repeats generation against the staged
production install plus the renderer's production dependency closure, then ships
the result in `Contents/Resources/THIRD_PARTY_NOTICES.md`. Missing license text or
an identifier outside the generator's allowlist fails the build. Electron's
`LICENSE.electron.txt` and `LICENSES.chromium.html`
remain supplied by electron-builder.

Pinned notice repairs in `scripts/third-party-notices.mjs` cover npm archives
that omit their upstream MIT text: Copilot SDK/platform 1.0.26 uses the GitHub
MIT notice from `github/copilot-sdk` LICENSE (blob
`28a50fa22639e32febe14e4ffc7a732b0ba8c90a`); Koffi platform 3.2.1 uses the
matching installed `koffi` package's LICENSE.txt. Other missing notices fail;
version updates require rechecking these repairs. Supplemental shipped notices
are retained too. `scripts/licenses/t3-code-MIT.txt` preserves T3 Code's LICENSE
for copied/ported portions, following its `docs/internals/open-source-licenses.md`.

Host and window tests import `@spi-code/core` from its built `dist`, not its source. When you
mutate core to see a host test fail, run `pnpm tsc -b packages/core` before the test, and again
after restoring; `pnpm run typecheck` also rebuilds it.

Watch fixtures use instant text through briefing and place readers; oracle inputs keep the default clock style. The reading context must reach service, engineering and environment readers as well as releases.

Desktop's boundary scan includes tests. Package imports use their public entry points;
the one named tooling exception is `scripts/watch-generated.mjs`, in desktop tests only.
`core-diff-rib.sh` is a historical extraction audit against 59d6895, not a current parity gate.

`CoreContext.words` is the wording twin of `timeStyle`: the default `"boards"` keeps the rib oracle's words, and the host and `appStyle` set `"app"` (ready, in maintenance). A changed string in code the rib also runs (brief/index.ts, brief/words.ts, model/queue.ts) goes behind it, with a paired test of both words; brief/places.ts, brief/verdict.ts and the readings are app-only.
