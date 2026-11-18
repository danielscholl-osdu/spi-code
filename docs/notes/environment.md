# Environment

- Resets enter the maintenance replay only under the app context (`buildModel` passes `reset` to `buildStack` when `words` is `app`); the default context stays the rib's, which never reads `env-reset.yml`.
- `facts.lifecycle.data.smoke` and `.reset` are absent, not empty, when their listing failed with nothing retained. Missed nightly slots and the Reset lane both read that absence as not read.
- A lane's `cadence` and its last-run date are computed in `context.timeZone`, so they are wall-clock text even under the instant time style; the host's no-clock guard skips `cadence` for that reason.
- `fixtures/watch/snapshot-1106.json` is over Biome's 1 MiB limit; format it with `pnpm biome format --files-max-size=4000000 --write fixtures/watch/snapshot-1106.json`.
- For a live-store replay, `facts_snapshots.facts` wraps Facts in the saved sweep state. Use `envelope.briefing.environment.to` as the projection clock. A store written before the Reset collector can have recent runs on GitHub without a Reset listing in the saved facts.
- The timeline's range lives in the route (`#environment/7-days`, `#environment/2026-11-12`), so Back and Evidence return to it and reachability homes can start there; the saved last place drops it, so the place opens at 24 h.
- `lane.lasts` is keyed by each range's `from` and `to`. Core cuts days in `context.timeZone` and the window in the renderer's zone; when they differ, a day finds no last run and its empty lane says none.
