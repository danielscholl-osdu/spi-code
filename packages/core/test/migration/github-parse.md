# GitHub parsing: spicode-t1k.10

Source: `keelson-rib-spi` at `59d6895`, `src/collect/github.ts:159-475`,
`test/collect.test.ts` and `test/work.test.ts`.

The entire source slice, including raw interfaces and all fourteen parser
functions, is byte-identical. Imports target core's config and facts modules;
the Apache header is replaced with the MIT header. No package barrel changes.

Approved delta: the orchestrator authorized copying the private
`const LIFECYCLE_KINDS = Object.keys(LIFECYCLE_WORKFLOWS) as LifecycleKind[]`
from outside the slice. It derives its values from core's exported workflow
map; no workflow list is hard-coded.

## Moved cases

All eight cases run in `packages/core/test/collect/github-parse.test.ts`.
Their bodies and assertions are unchanged; imports use Vitest and core.
Test setup passes a context with the existing pinned
`fixtures/rib-59d6895/services.json` fleet, keeping the baseline planned-service
assertion independent of today's built-in fleet and local environment.

| Rib file and lines | Case |
|---|---|
| `collect.test.ts:41-70` | the template's merged PRs keep their author and a fork reads its Sync Template schedule |
| `collect.test.ts:97-149` | the stack's releases and workflow schedules, and a fork's past gates, are parsed |
| `collect.test.ts:151-160` | a planned repository that does not exist reads as missing, not as an error |
| `collect.test.ts:164-171` | every cron line in a workflow file is a schedule |
| `collect.test.ts:173-180` | the halt line follows the ### Halt heading |
| `collect.test.ts:182-191` | the declaration yields version, location, profile and trusted forks |
| `collect.test.ts:193-209` | the newest Upstream-Sha trailer on fork_upstream is what the fork synced |
| `work.test.ts:134-176` | a repository read reports authors' association, app authors and open totals |

## Staying cases

No rib test is deleted by this bead. The eight migrated cases should be counted
once when the rib switches to core; the rib still retains its originals until
that integration.

The three remaining `GraphQL query` cases in `collect.test.ts` stay for GHREAD:
reads the template, stack, forks and planned repositories (`21-39`); keeps query
cost beside the budget (`72-78`, mixed parsing and query-shape assertions);
fork batching and merged costs (`80-95`). The mixed case stays whole rather
than silently dropping its query assertion.

The other thirteen `collect.test.ts` cases stay with their respective ports:
`template changes` (2), `GraphQL reads` (4), `template positions` (1),
`upstream radar` (5), and `lifecycle jobs` (1). The other four `work.test.ts`
cases are already covered by core's existing `test/work.test.ts`; they are not
duplicated here.

## Reviewer comparison

Follow-up `spicode-t1k.72` makes `parseGithub(data, context)` read
`context.fleet.planned` instead of the module-level `PLANNED`, matching the
context that `readGithub` already passes to its parser callback. An additional
case interleaves custom, pinned and empty fleets. The original eight cases remain.

Run from this worktree using Bash; the only body differences are the explicit
context parameter and the planned-list lookup:

```bash
diff -u \
  <(git -C /Users/danielscholl/keelson/keelson-rib-spi show 59d6895:src/collect/github.ts | sed -n '159,475p') \
  <(sed -n '/^interface RawCheck/,$p' packages/core/src/collect/github-parse.ts)
```

`pnpm vitest list packages/core/test/collect/github-parse.test.ts` discovers all
nine cases. `pnpm vitest run` with that path exercises them without
network reads or the rib harness.
