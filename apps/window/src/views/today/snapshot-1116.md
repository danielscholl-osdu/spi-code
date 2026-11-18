`snapshot-1116.json` is the window's snapshot of the 16 Nov sweep: core's
`upstream-1116.json` facts projected by the host as the app would, with the
pinned rib rollout and releases, reads inferred from the facts' own times, and
the clock at 01:06 UTC on 17 Nov. Today's lower sections and the PS-19
reachability test read it. From the repository root, regenerate it with:

```sh
pnpm build
TZ=America/Chicago node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
import { AREAS } from "./packages/contracts/dist/index.js";
import {
  builtInFleet, createContext, emptyFacts, fleetOf, parseRollout,
} from "./packages/core/dist/index.js";
import { projectWatch } from "./packages/host/dist/watch/project.js";

const rib = "./packages/core/test/fixtures/rib-59d6895/";
const fixtures = "./packages/core/test/fixtures/";
const read = (path) => readFileSync(path, "utf8");
const now = new Date("2026-11-17T01:06:12.682Z");
const facts = { ...emptyFacts(), ...JSON.parse(read(fixtures + "upstream-1116.json")) };
const releases = JSON.parse(read(rib + "releases.json"));
const { rollout } = parseRollout(read(rib + "rollout.json"));
const reads = Object.fromEntries(AREAS.flatMap((area) => facts[area].at
  ? [[area, [{ source: area, object: area, observedAt: facts[area].at, completeness: { kind: "complete" }, inferred: true }]]]
  : []));
const context = Object.freeze({
  ...createContext({ fleet: fleetOf(builtInFleet(fixtures + "upstream-services.json")), rollout, clock: { now: () => now } }),
  timeStyle: "instant", words: "app",
});
const snapshot = projectWatch({
  facts, releases, context, cursor: 1, appData: rib, doctor: { state: "clear", problems: [] },
  intervalMs: 300_000, reads,
  releaseRecords: releases.at ? [{ source: "releases", object: "releases", observedAt: releases.at, completeness: { kind: "complete" }, inferred: true }] : [],
});
writeFileSync("apps/window/src/views/today/snapshot-1116.json", JSON.stringify(snapshot, null, 2) + "\n");
JS
pnpm biome format --write --files-max-size=4194304 apps/window/src/views/today/snapshot-1116.json
```

The snapshot exceeds Biome's default 1 MiB limit. The explicit limit lets
Biome format the generated arrays before committing the snapshot.
