# Environment

- Resets enter the maintenance replay only under the app context (`buildModel` passes `reset` to `buildStack` when `words` is `app`); the default context stays the rib's, which never reads `env-reset.yml`.
- `facts.lifecycle.data.smoke` and `.reset` are absent, not empty, when their listing failed with nothing retained. Missed nightly slots and the Reset lane both read that absence as not read.
- A lane's `cadence` and its last-run date are computed in `context.timeZone`, so they are wall-clock text even under the instant time style; the host's no-clock guard skips `cadence` for that reason.
- `fixtures/watch/snapshot-1106.json` is over Biome's 1 MiB limit; format it with `pnpm biome format --files-max-size=4000000 --write fixtures/watch/snapshot-1106.json`.
