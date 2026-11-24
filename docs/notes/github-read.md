# GitHub issues and PRs read

- GitHub's GraphQL server gives up at about 10 s and answers 502 or 504. One fork's read takes 2 to 3.6 s; five in one request took 7.6 to 10.3 s on 2026-11-24, so each fork is its own request, `GITHUB_READS_AT_ONCE` at a time.
- GraphQL cost is linear in forks, so batching saves no points: a `rateLimit(dryRun: true) { cost }` probe on 2026-11-24 priced each of 13 forks at 3 (39 in all) and the old 5-fork batches at 15, 15 and 9 (39 in all).
- A gateway resend waits `GATEWAY_RETRY_WAIT_MS` out of the same per-sweep allowance as throttle waits (`GraphqlBudget.pause`), so a broad outage cannot stretch a sweep past it.
