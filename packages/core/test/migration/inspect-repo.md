# Repository inspector

Source: `keelson-rib-spi@59d6895d140e9482ed788a3307177855d10883f0`,
`src/boards/repo.ts`.

`packages/core/src/inspect/repo.ts` ports `repoBoard` as `inspectRepo`, with
`groupUrl` and `repoTitle`. It reads the existing core repository lines
(`brief/repos.ts`) and model rows; no planner or dependency was added. The host
routes `repo:<name>` ids in `WatchRoutes.inspect` after the step and release
branches, by exact match on a watched repository's name.

## Evidence and migration accounting

**New file:** `fixtures/rib-59d6895/oracle/repo-board.json`, generated from the
pinned rib, not core. No existing oracle or manifest was regenerated.

Generation extracted `git archive 59d6895` into disposable scratch, linked the
rib's installed dependencies, and ran Bun 1.3.13 with `TZ=UTC`, `LC_ALL=C`, a
scratch `KEELSON_HOME` and the pinned services fixture. It imported the pinned
`test/harness.ts`, `model/index.ts` and `boards/repo.ts`; no forge calls were
made, and the rib checkout was unchanged afterwards. At `2026-10-12T21:58:30Z`
it froze the board for every fixture repository (osdu-spi, osdu-spi-stack,
partition, entitlements, legal, schema, file), the unknown `repo:not-watched`
board, the `critical` variant's partition and the `code-hidden` variant's legal.

`test/inspect/repo.test.ts` rebuilds the rib's Canvas shape from the plain data
and deep-equals every oracle case. It also ports the three repository-board
cases from rib `test/repositories.test.ts`: human-required issues lead the
Issues tab; the critical partition title and its Issues, PRs, Vulnerabilities
and Code scanning tabs; and the unreadable code-scanning message. Those rib
tests stay until the rib's switch to core removes them.

Host `routes.test.ts` inspects every watched repository from the persisted
fixture sweep with no forge calls, and answers `not_found` for empty, unknown,
suffixed, encoded, case-changed, padded and prototype-key ids.

## Representation changes, not content changes

- `inspectRepo` returns plain data: no `view` or section `kind`, no info glyph
  on the summary, and links as `{ text, href }` rather than icon rows. Host and
  rib adapters own rendering.
- An unwatched id returns `undefined` where the rib drew its UNKNOWN board; the
  host answers `not_found`.
- Tone and wording, row order, the 25-row list cap and its "more" line are
  unchanged.

## Host mapping

The contract's `ItemClass` has no repository class, so a repository inspection
is `SECURITY`, constant like a step's `ROLLOUT`. `cause` is the title, `effect`
the status chip, `why` the PROGRAM/FORK label and summary. Every tab row becomes
a related row: text with its detail, state naming tab, section, chip and
trailing mark, and its link when it is a web URL. The GitHub links follow with
state "On GitHub". There is no next step, evidence, approval or action.

## Validation

The oracle's SHA-256 is
`a4f5ab6598ebef2e23e03bd963bffd9e2d58b024ae1ca82dc7d80f4c880229e5`.
