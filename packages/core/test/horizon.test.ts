// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { fileURLToPath } from "node:url";
import { BriefingSchema, HorizonSchema } from "@spi-code/contracts";
import { describe, expect, it } from "vitest";
import { horizonStages, radarSyncPr } from "../src/brief/horizon.js";
import { buildBriefing } from "../src/brief/index.js";
import { builtInFleet, fleetOf } from "../src/config.js";
import { createContext } from "../src/context.js";
import { emptyFacts, type Facts } from "../src/facts.js";
import { buildModel, type Model } from "../src/model/index.js";
import { upstreamReading } from "../src/readings/index.js";
import sweep from "./fixtures/upstream-1106.json";

const context = createContext({
  fleet: fleetOf(
    builtInFleet(fileURLToPath(new URL("./fixtures/upstream-services.json", import.meta.url))),
  ),
});
const facts: Facts = { ...emptyFacts(), ...(structuredClone(sweep) as unknown as Partial<Facts>) };
const now = new Date(facts.sweep?.at ?? "");
const model = () => buildModel(structuredClone(facts), now, {}, context);
const brief = (m: Model) => buildBriefing(m, { state: "clear", problems: [] }, now, context);
const fork = (m: Model, service: string) => {
  const found = m.upstream.forks.find((f) => f.service === service);
  if (!found) throw new Error(`No ${service} fork`);
  return found;
};

describe("upstream horizon", () => {
  it("counts commits held in the fork's sync PR separately from the next sync", () => {
    const m = model();
    m.upstream.forks = [fork(m, "storage")];
    const stages = brief(m).horizon.stages;
    expect(stages?.nextSync).toMatchObject({ count: 0, services: [] });
    expect(stages?.held).toMatchObject({
      count: 11,
      services: ["storage"],
      prs: [{ service: "storage", pr: { number: 58, inspect: "gate1:storage" } }],
    });
    const q = m.queue.items.find((q) => q.id === "radar:storage");
    expect(q && radarSyncPr(m, q)?.id).toBe("gate1:storage");
  });

  it("joins only the same fork's Gate-1 item and never calls a will-halt item held", () => {
    const m = model();
    const q = m.queue.items.find((q) => q.id === "radar:storage");
    if (!q) throw new Error("No storage radar item");
    expect(
      radarSyncPr(m, { ...q, halt: { fork: "storage", code: "HALT", entries: ["pom.xml"] } }),
    ).toBeUndefined();
    m.queue.items = m.queue.items.filter((q) => q.id !== "gate1:storage");
    expect(radarSyncPr(m, q)).toBeUndefined();
  });

  it("keeps stopped and halted forks in the uncounted wontLand row", () => {
    const m = model();
    const storage = m.lines.find((l) => l.fork.id === "storage");
    const sync = storage?.stations.find((s) => s.id === "sync");
    if (!sync) throw new Error("No storage sync station");
    sync.state = "stopped";
    const stages = horizonStages(m);
    expect(stages.wontLand).toEqual([
      {
        service: "partition",
        reason: "halted",
        count: 8,
        text: "partition won't land: sync halted",
      },
      {
        service: "storage",
        reason: "stopped",
        count: 11,
        text: "storage won't land: sync stopped",
      },
    ]);
    expect(stages.nextSync.services).not.toContain("storage");
    expect(stages.nextSync.services).not.toContain("partition");
    expect(stages.held.services).not.toContain("storage");
  });

  it.each(["unread", "disordered"])("counts an unprovable %s split under next sync", (state) => {
    const f = structuredClone(facts);
    if (state === "unread") {
      const repo = f.github.data?.repos["Azure/osdu-spi-storage"];
      if (!repo) throw new Error("No storage repository");
      repo.prs = repo.prs.filter((p) => p.number !== 58);
    } else {
      const commits = f.upstream.data?.storage?.commits;
      const first = commits?.[0];
      const target = commits?.at(-1);
      if (!first || !target) throw new Error("No storage commits");
      first.at = new Date(Date.parse(target.at) + 60_000).toISOString();
    }
    const m = buildModel(f, now, {}, context);
    m.upstream.forks = [fork(m, "storage")];
    expect(horizonStages(m)).toMatchObject({
      nextSync: { count: 11, services: ["storage"] },
      held: { count: 0, prs: [], services: [] },
    });
  });

  it("uses the same station totals for the conveyor and Upstream figure", () => {
    const m = model();
    const stages = horizonStages(m);
    const total = m.lines.reduce((sum, line) => sum + (line.upstream?.lag ?? 0), 0);
    expect(stages.upstream.count).toBe(total);
    expect(
      stages.nextSync.count +
        stages.held.count +
        stages.wontLand.reduce((sum, f) => sum + f.count, 0),
    ).toBe(total);
    const reading = upstreamReading({
      model: m,
      items: [],
      radar: [],
      fleet: context.fleet,
      campaigns: [],
    });
    expect(reading.tiles[0]).toEqual({
      label: "Incoming",
      value: String(total),
      counts: `commits behind upstream · ${stages.held.count} in ${stages.held.prs.length} sync PRs · ${stages.nextSync.count} at ${stages.nextSync.at} · 8 won't land`,
    });
    expect(stages.forks.services).toEqual(["entitlements", "crs-catalog"]);
  });

  it("gives every briefing item an origin and sums ports owed per fork", () => {
    const m = model();
    const b = brief(m);
    const items = [...b.focus, ...b.rest];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.origin).toBe(
        item.ids.some((id) => /^(radar|halt|port|gate1):/.test(id)) ? "upstream" : "system",
      );
    }
    const owed = m.upstream.forks.flatMap((f) => {
      const count = m.radar.services[f.service]?.ports?.owed.length ?? 0;
      return count ? [{ service: f.service, count }] : [];
    });
    expect(b.horizon.owed?.services).toEqual(owed);
    expect(b.horizon.owed?.count).toBe(owed.reduce((sum, f) => sum + f.count, 0));
    expect(HorizonSchema.safeParse(b.horizon).success).toBe(true);
    expect(BriefingSchema.safeParse(b).success).toBe(true);
  });

  it("keeps unread stage and ports words honest", () => {
    const b = brief(buildModel(emptyFacts(), now, {}, context));
    expect(b.horizon.stages?.upstream.text).toBe("Upstream not read yet");
    expect(b.horizon.stages?.nextSync.text).toBe("Next sync not read yet");
    expect(b.horizon.stages?.held.text).toBe("Open sync PRs not read yet");
    expect(b.horizon.stages?.forks.services).toEqual([]);
    expect(b.horizon.owed?.text).toBe("Upstream ports not read yet");
  });

  it("keeps upstream-owned security findings in the system origin", () => {
    const m = model();
    m.queue.items = [
      {
        id: "security:storage",
        kind: "security",
        cls: "SECURITY",
        rung: 1,
        scope: "storage",
        text: "Upstream-owned findings",
        effects: [],
        cause: [],
        incident: false,
        blocks: 1,
      },
    ];
    expect(brief(m).focus[0]?.origin).toBe("system");
  });
});
