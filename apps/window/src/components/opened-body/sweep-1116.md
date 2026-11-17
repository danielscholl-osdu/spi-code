`sweep-1116.json` is the four opened-body cases from core on the 16 Nov sweep,
with their constituent items and blockers. It uses the pinned rib rollout and
Chicago clock from `packages/core/test/sweep-1116.ts`; the shared input is unchanged.
From the repository root, regenerate it with:

```sh
pnpm build
TZ=America/Chicago node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
import {
  buildBriefing, buildModel, builtInFleet, createContext, emptyFacts, fleetOf, parseRollout,
} from "./packages/core/dist/index.js";
import { todayLines } from "./packages/core/dist/brief/lines.js";

const fixtures = "./packages/core/test/fixtures/";
const read = (name) => readFileSync(fixtures + name, "utf8");
const facts = { ...emptyFacts(), ...JSON.parse(read("upstream-1116.json")) };
const now = new Date("2026-11-17T01:06:12.682Z");
const { rollout } = parseRollout(read("rib-59d6895/rollout.json"));
const context = createContext({
  fleet: fleetOf(builtInFleet(fixtures + "upstream-services.json")),
  rollout,
  clock: { now: () => now },
});
const model = buildModel(facts, now, { dismissed: [] }, context);
const briefing = buildBriefing(model, { state: "clear", problems: [] }, now, context);
const allItems = [...briefing.focus, ...briefing.rest];
const wanted = new Set([
  "blocked:halt:crs-conversion",
  "waiting:gate2:storage",
  "waiting:blocker:stack:lanes:gate2",
  "waiting:upgrade:os-core-common",
]);
const lines = todayLines(model, allItems, now, context).filter(({ id }) => wanted.has(id));
const ids = new Set(lines.flatMap(({ members }) => members.flatMap((member) => [
  member.id, ...member.ids, member.blockedBy,
])));
const items = allItems.filter(({ id }) => ids.has(id));
writeFileSync(
  "apps/window/src/components/opened-body/sweep-1116.json",
  JSON.stringify({ lines, items }, null, 2) + "\n",
);
JS
pnpm biome check --write apps/window/src/components/opened-body/sweep-1116.json
```
