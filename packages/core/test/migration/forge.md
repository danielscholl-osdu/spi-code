# Forge migration

Source: `keelson-rib-spi@59d6895`, `src/forge.ts`.

Moved to `src/forge.test.ts` (Vitest, recording/replay Exec, no network):

- `collect.test.ts`: GraphQL cut-body retry, two cut bodies, two empty bodies,
  and partial data alongside NOT_FOUND errors.
- `act.test.ts`: gh scopes from the sign-in probe; fine-grained tokens list none.

Added: REST, jq pagination, text, GitLab REST pagination and GraphQL replay;
shared-budget concurrency across clients; rateLimit injection, existing and
aliased selections; error propagation and queue recovery.

Staying in the rib: collector, action and board cases in `collect.test.ts` and
`act.test.ts`. Their moves belong to their respective M2 beads. No rib test is
deleted by this bead.

## Budget seam

Import from `src/forge.ts` directly; no barrel changes. Pass the same
`GraphqlBudget` as the third `Gh` constructor argument to share an account.
`Gh.graphql(query, estimate = 1)` serializes each attempt through that account.
Snapshots contain cumulative `spent` and `calls`, plus the latest observed
`remaining` and `resetAt` (null before the first observation). Insufficient
remaining waits until the server's reset time. Pacing policy stays outside.

A cut/empty body or transport failure cannot supply actual cost: its estimate
remains charged, rather than silently refunding an attempted request. Successful
responses reconcile that reservation to GitHub's reported cost, including retries.
Collectors with known query costs should pass that estimate. Resetting the window
does not reset cumulative counters. The returned data retains the rateLimit field
for compatibility; collectors must use the shared account, not sum it themselves.
