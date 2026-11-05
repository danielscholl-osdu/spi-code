# GitHub reads migration

Source: `keelson-rib-spi@59d6895`, `src/collect/github.ts:40-158,476-495`.
The pinned tree has no `github.test.ts`; query tests are in `test/collect.test.ts`.

## Moved coverage

`test/collect/github-read.test.ts` ports the query-shape repository, marker,
declaration, schedules, history and batching assertions from `collect.test.ts`.
The old merged-cost assertion is replaced by a two-query Exec recording/replay
that charges costs 3 and 9 to FORGE's account. New tests cover cut connections,
batch-local failures, partial errors, missing repositories and invalid batch sizes.

## Staying coverage

Parser assertions in the mixed GraphQL describe block (merged PR authors,
cron parsing, rate parsing, releases and gate history) belong to GHPARSE,
not this reader. Other collector suites remain with their corresponding beads.

## Non-import deltas

- Replace mutable global FORKS/PLANNED with the supplied CoreContext fleet.
  `buildQueries(ctx, perQuery)` rejects nonpositive/noninteger sizes rather than
  looping forever. Private query constants/helpers move locally unchanged except
  for the count selections and rate selection described below.
  Freeze HALT_LABELS and LIFECYCLE_KINDS to keep module collections immutable.
- `readGithub(gh, ctx, parse)` injects the structural parser `(raw, ctx) => T`.
  It returns `{facts, records}`; SWEEP2 supplies GHPARSE and composes the envelope.
  No parser is copied or imported.
- Remove the query's rateLimit selection and all local RateRead arithmetic.
  FORGE injects its own rate selection and is the only budget authority.
  `mergeReads` strips legacy rateLimit fields instead of aggregating them;
  parsed facts do not receive a collector-local cost or remaining value.
- Add totalCount only to connections whose truncation loses data: open pull
  requests, open issues, labels and check contexts. Recency windows (commits(last: 1),
  upstream history, deployments, pastPrs, pastIssues, releases) keep their original
  selections, so a healthy repo with a long history is complete.
- `repoField` JSON-encodes owner and name so a malformed repo cannot alter the query.
  `readGithub` takes the batch size once and uses it for queries and batch numbering.
- `cutsOf` recursively returns every cut with its connection path and counts;
  null nodes are not counted as reads. A repo record carries the first cut,
  consistent with the evidence envelope's first-cut summary. Counts without
  nodes (issue comments) are not connection reads.
- Replace all-or-nothing batch rejection/missing-repo throw with explicit
  per-repository failure records. Records use the context clock at batch completion;
  GraphQL errors apply to their alias, or the whole batch when pathless.
  Null planned probes with only NOT_FOUND errors are successful absence reads.
  Successful partial raw data still reaches the parser; parser errors propagate.
  No prior facts are retained here; SWEEP2 owns retention.
