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

  it("supplies compact counts for held commits, distinct sync PRs and current forks", () => {
    const m = model();
    const storage = fork(m, "storage");
    storage.behind = 17;
    m.upstream.forks = [storage, fork(m, "entitlements"), fork(m, "crs-catalog")];
    expect(brief(m).horizon).toMatchObject({
      compact: { nextSyncCount: 6, heldCount: 11, heldPrCount: 1, currentForkCount: 2 },
    });
    const current = m.upstream.forks[1];
    if (!current) throw new Error("No current fork");
    current.behind = 3;
    current.phase = "prepared";
    delete current.halt;
    const sync = m.lines
      .find((line) => line.fork.id === current.service)
      ?.stations.find((station) => station.id === "sync");
    if (!sync) throw new Error("No current sync station");
    sync.state = "waiting";
    current.syncPr = {
      number: 91,
      url: "https://example.com/pr/91",
      headSha: "abc",
      verdict: "green",
      holds: 3,
    };
    expect(brief(m).horizon).toMatchObject({
      compact: { nextSyncCount: 6, heldCount: 14, heldPrCount: 2, currentForkCount: 1 },
    });
    m.upstream.forks = [fork(m, "crs-catalog")];
    expect(brief(m).horizon).toMatchObject({
      compact: { nextSyncCount: 0, heldCount: 0, heldPrCount: 0, currentForkCount: 1 },
    });
  });

  it.each(["all", "upstream", "upstream-fork", "github", "repository", "order"])(
    "keeps compact counts unknown with a missing %s read or unproved split",
    (missing) => {
      const f = structuredClone(facts);
      if (missing === "all" || missing === "upstream") f.upstream = {};
      if (missing === "all" || missing === "github") f.github = {};
      if (missing === "upstream-fork" && f.upstream.data) delete f.upstream.data.storage;
      if (missing === "repository" && f.github.data)
        delete f.github.data.repos["Azure/osdu-spi-storage"];
      if (missing === "order") {
        const commits = f.upstream.data?.storage?.commits;
        if (!commits?.[0]) throw new Error("No storage commits");
        commits[0].at = "not a date";
      }
      const h = brief(buildModel(f, now, {}, context)).horizon;
      expect(h).toMatchObject({
        compact: { nextSyncCount: null, heldCount: null, heldPrCount: null },
      });
      if (missing !== "order") expect(h).toMatchObject({ compact: { currentForkCount: null } });
      if (missing === "order") {
        expect(h.stages).toMatchObject({ nextSync: { count: null }, held: { count: null } });
        expect(h.stages?.nextSync.services).not.toContain("storage");
        expect(h.stages?.held.services).not.toContain("storage");
        expect(h.stages?.nextSync.text).toMatch(/unknown/i);
        expect(h.stages?.held.text).toMatch(/unknown/i);
        expect(h.headline).toMatch(/unknown/i);
        expect(HorizonSchema.safeParse(h).success).toBe(true);
      }
    },
  );

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
        text: "partition won't land: sync will halt",
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

  it.each([false, true])("distinguishes predicted and open halts (open=%s)", (open) => {
    const m = model();
    const partition = fork(m, "partition");
    if (!partition.halt) throw new Error("No partition halt");
    partition.halt.open = open;
    expect(horizonStages(m).wontLand.find((fork) => fork.service === "partition")).toEqual({
      service: "partition",
      reason: "halted",
      count: 8,
      text: `partition won't land: sync ${open ? "halted" : "will halt"}`,
    });
  });

  it.each(["unread", "disordered"])(
    "distinguishes an absent PR from an unproved %s split",
    (state) => {
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
        nextSync: {
          count: state === "unread" ? 11 : null,
          services: state === "unread" ? ["storage"] : [],
        },
        held: { count: state === "unread" ? 0 : null, prs: [], services: [] },
      });
    },
  );

  it("uses the same station totals for the conveyor and Upstream figure", () => {
    const m = model();
    const stages = horizonStages(m);
    expect(brief(m).horizon).toMatchObject({
      compact: { nextSyncCount: 65, heldCount: 37, heldPrCount: 3, currentForkCount: 2 },
      stages: { nextSync: { count: 65 }, held: { count: 37 } },
    });
    const total = m.lines.reduce((sum, line) => sum + (line.upstream?.lag ?? 0), 0);
    expect(stages.upstream.count).toBe(total);
    expect(
      (stages.nextSync.count ?? 0) +
        (stages.held.count ?? 0) +
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
