# Evidence and pacing

`envelopeOf(records, {intervalMs, now})` takes the current read records for an
area, not an attempt history. Times on records are ISO-8601 strings; `now` is
epoch milliseconds supplied by the caller. A retained value's `retainedFrom`
is its original successful observation time. The envelope uses the oldest
successful or retained observation, never the retry time. Failure takes
precedence over a cut, and a cut over staleness. Exactly twice the interval is
still fresh. All original records remain available, including each cut's
details, even when the envelope reports failed or stale. The envelope's
completeness sums `read` and `total` across every cut read, with a reason naming
how many reads were cut, their services and their reasons. A single cut read's
completeness is kept exactly as recorded.
An empty area is unread. Only an area with exclusively inferred reads is
marked inferred.

`new BudgetPacer({floor, resetBudget}).plan(...)` is stateless. Supply the
account's actual full-window quota as `resetBudget`; it replaces an expired
remaining snapshot at and after `resetAt`. Pass a fresh budget snapshot on
each plan, including after reset, so spending since reset is accounted for.
The input's `remaining` and `resetAt` accept the corresponding GraphqlBudget
snapshot fields without importing the forge client.

Areas are considered in input order. Each running area reserves its estimate
from the shared remaining allowance; the floor is never spent. Estimates use
the largest cost in the supplied per-area history, or the area's configured
estimate when no history exists. With unknown remaining, only core areas run;
optional areas defer with `budget unknown`. Insufficient budget waits for a
future known reset, otherwise defers. Planning performs no reads or timers;
the sweeper owns execution and providing the next snapshot.
