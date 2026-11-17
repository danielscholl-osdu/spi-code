`members-1116.json` freezes the 16 Nov home-member partition and the instruments
that the place heads mark: core lines, place claims, projected watch items,
repository associations and stations. It uses the unchanged facts and reads,
pinned rib rollout and clock in `packages/core/test/sweep-1116.ts`.
The place claims intentionally use no area envelopes, preserving the original
fixture's unread state; this fixture proves membership, not read freshness.

From the repository root, regenerate it with:

```sh
pnpm build
TZ=America/Chicago node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
import {
  buildModel, builtInFleet, createContext, emptyFacts, fleetOf, parseRollout,
} from "./packages/core/dist/index.js";
import { projectBriefing, settleBriefing } from "./packages/host/dist/watch/briefing.js";
import { placeReadings } from "./packages/host/dist/watch/readings.js";
import { projectStations } from "./packages/host/dist/watch/services.js";

const fixtures = "./packages/core/test/fixtures/";
const read = (name) => readFileSync(fixtures + name, "utf8");
const facts = { ...emptyFacts(), ...JSON.parse(read("upstream-1116.json")) };
const reads = JSON.parse(read("upstream-1116-reads.json"));
const now = new Date("2026-11-17T01:06:12.682Z");
const { rollout } = parseRollout(read("rib-59d6895/rollout.json"));
const context = createContext({
  fleet: fleetOf(builtInFleet(fixtures + "upstream-services.json")),
  rollout,
  clock: { now: () => now },
});
const input = {
  facts, reads, releases: {}, releaseRecords: [],
  doctor: { state: "clear", problems: [] }, context,
  appData: "", cursor: 1, intervalMs: 60_000,
};
const model = buildModel(facts, now, { dismissed: [] }, context);
const { briefing, horizon } = projectBriefing(model, input, now);
const readings = placeReadings(model, input, briefing, [], []);
const places = settleBriefing(briefing, horizon, model, input, readings, [], now);
writeFileSync(
  "apps/window/src/components/place/members-1116.json",
  JSON.stringify({
    lines: briefing.lines,
    places,
    items: [...briefing.focus, ...briefing.rest],
    repositories: briefing.repositories.rows,
    stations: projectStations(model, input),
  }, null, 2).replace(/[^\x00-\x7f]/g, (char) =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  ) + "\n",
);
JS
pnpm biome check --write apps/window/src/components/place/members-1116.json
```

To verify reproduction, run the block above and then
`git diff --exit-code -- apps/window/src/components/place/members-1116.json`.
