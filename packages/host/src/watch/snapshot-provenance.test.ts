// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { ViewSnapshotSchema } from "@spi-code/contracts";
import {
  AREAS,
  type AreaName,
  buildBriefing,
  buildModel,
  RELEASES_EVERY_MS,
  type ReadRecord,
} from "@spi-code/core";
import { describe, expect, it } from "vitest";
import { fixtureInput, mixedFixtureInput } from "../../test/watch/snapshot-fixture.js";
import { projectWatch, type WatchInput } from "./project.js";
import { briefingProvenance, releaseProvenance, stationAreas } from "./provenance.js";
import { runProvenance } from "./recorded-runs.js";
import { projectReleases } from "./releases.js";
import { snapshotProvenance } from "./snapshot-provenance.js";

process.env.TZ = "UTC";

describe("Watch projection", () => {
  it("omits the provenance of a service run with no recorded run in its repository", () => {
    const run = Object.values(fixtureInput().facts.approvals.data ?? {}).flat()[0];
    if (!run) throw new Error("Pinned fixture must include an approval run");
    const hits = [
      { run: { ...run, id: 7 }, repo: "Azure/a", workflow: "approval", area: "approvals" } as const,
    ];
    expect(
      runProvenance("/services/0/runs", [{ id: "run:7" }, { id: "run:8" }], hits, "Azure/a"),
    ).toEqual([{ path: "/services/0/runs/0", areas: ["approvals"] }]);
    expect(runProvenance("/services/0/runs", [{ id: "run:7" }], hits, "Azure/b")).toEqual([]);
  });

  it.each(["failed", "stale"] as const)(
    "preserves the release reader's %s envelope in a valid snapshot with no release lines",
    (state) => {
      const input = fixtureInput();
      const now = input.context.clock.now();
      const observedAt = new Date(now.getTime() - 2 * RELEASES_EVERY_MS - 1).toISOString();
      const record: ReadRecord = {
        source: "github-releases",
        object: "Azure/osdu-spi",
        observedAt,
        completeness: { kind: "complete" },
        inferred: true,
        ...(state === "failed"
          ? { failure: "offline", observedAt: now.toISOString(), retainedFrom: observedAt }
          : {}),
      };
      const projected = projectWatch({ ...input, releaseRecords: [record] });
      const snapshot = {
        ...projected,
        releases: { ...projected.releases, lines: [] },
        provenance: [
          ...projected.provenance.filter(({ path }) => !path.startsWith("/releases")),
          ...releaseProvenance([], [record], now),
        ],
      };
      expect(ViewSnapshotSchema.parse(snapshot)).toEqual(snapshot);
      expect(snapshot.provenance.filter(({ path }) => path.startsWith("/releases"))).toEqual([
        {
          path: "/releases/lines",
          areas: ["fleet"],
          envelope: {
            source: "releases",
            state,
            observedAt,
            completeness: { kind: "complete" },
            inferred: true,
          },
        },
      ]);
      expect(snapshot.reads).toContainEqual(record);
    },
  );

  it.each(["failed", "stale"] as const)(
    "binds the release reader's own %s envelope to every release line",
    (state) => {
      const input = onlyInferred([]);
      const now = input.context.clock.now().getTime();
      const observedAt = new Date(now - 2 * RELEASES_EVERY_MS - 1).toISOString();
      const record: ReadRecord = {
        source: "github-releases",
        object: input.context.fleet.releaseRepos[0] ?? "Azure/osdu-spi",
        observedAt,
        completeness: { kind: "complete" },
        inferred: true,
        ...(state === "failed"
          ? {
              failure: "offline",
              observedAt: new Date(now).toISOString(),
              retainedFrom: observedAt,
            }
          : {}),
      };
      const snapshot = projectWatch({ ...input, releaseRecords: [record] });
      expect(snapshot.releases.lines.length).toBeGreaterThan(1);
      expect(snapshot.provenance.filter(({ path }) => path.startsWith("/releases/lines/"))).toEqual(
        snapshot.releases.lines.map((_, i) => ({
          path: `/releases/lines/${i}`,
          areas: ["fleet"],
          envelope: {
            source: "releases",
            state,
            observedAt,
            completeness: { kind: "complete" },
            inferred: true,
          },
        })),
      );
      expect(snapshot.tree.find(({ id }) => id === "releases")?.status).toBe(state);
      expect(snapshot.reads).toContainEqual(record);
    },
  );

  it("uses the release reader's cadence rather than the Facts sweep interval", () => {
    const input = onlyInferred([]);
    const start = input.context.clock.now().getTime();
    const releaseRecords: ReadRecord[] = [
      {
        source: "github-releases",
        object: "Azure/osdu-spi",
        observedAt: new Date(start).toISOString(),
        completeness: { kind: "complete" },
      },
    ];
    for (const [elapsed, state] of [
      [2 * RELEASES_EVERY_MS, "fresh"],
      [2 * RELEASES_EVERY_MS + 1, "stale"],
    ] as const) {
      const snapshot = projectWatch({
        ...input,
        releaseRecords,
        context: { ...input.context, clock: { now: () => new Date(start + elapsed) } },
      });
      expect(snapshot.provenance.find(({ path }) => path === "/releases/lines/0")).toMatchObject({
        envelope: { state, inferred: false },
      });
      expect(snapshot.tree.find(({ id }) => id === "releases")?.status).toBe(state);
    }
  });

  it("does not invent release evidence from cached values or an area's reads", () => {
    const snapshot = provenanceStep({ ...onlyInferred(AREAS), releaseRecords: [] });
    expect(snapshot.releases.lines.length).toBeGreaterThan(0);
    expect(snapshot.provenance.find(({ path }) => path === "/releases/lines/0")).toMatchObject({
      envelope: { source: "releases", state: "unread" },
    });
  });

  it("preserves cut and mixed-inference release records without borrowing fleet evidence", () => {
    const input = onlyInferred(["fleet"]);
    const observedAt = input.context.clock.now().toISOString();
    const completeness = { kind: "cut", reason: "page limit", read: 1, total: 3 } as const;
    const snapshot = projectWatch({
      ...input,
      releaseRecords: [
        {
          source: "github-created",
          object: "Azure/osdu-spi",
          observedAt,
          completeness,
          inferred: true,
        },
        {
          source: "github-pins",
          object: "Azure/osdu-partition@v1",
          observedAt,
          completeness: { kind: "complete" },
        },
      ],
    });
    expect(snapshot.provenance.find(({ path }) => path === "/releases/lines/0")).toMatchObject({
      envelope: { source: "releases", state: "incomplete", completeness, inferred: false },
    });
    expect(inferredAt(snapshot, "/releases/lines/0")).toBe(false);
  });
});

/** The fixture with one fresh read per area, inferred only for the named areas. */
function onlyInferred(inferred: readonly AreaName[]) {
  const input = fixtureInput();
  const observedAt = input.context.clock.now().toISOString();
  const reads = Object.fromEntries(
    AREAS.map((area) => [
      area,
      [
        {
          source: area,
          object: area,
          observedAt,
          completeness: { kind: "complete" as const },
          ...(inferred.includes(area) ? { inferred: true } : {}),
        },
      ],
    ]),
  );
  return { ...input, reads };
}

/** Inferred-only values require every feeding area and any non-area envelope to be inferred. */
function inferredAt(snapshot: ReturnType<typeof projectWatch>, pointer: string): boolean {
  const source = snapshot.provenance.find(({ path }) => path === pointer);
  if (!source) return false;
  return (
    (source.envelope === undefined || source.envelope.inferred === true) &&
    source.areas.every(
      (area) => snapshot.areas.find((entry) => entry.area === area)?.envelope.inferred === true,
    )
  );
}

// Values the views do not draw from a swept area: read metadata, the clock window, inspector
// ids and the fleet's own service names.
const UNDRAWN = [
  /^\/releases\/reading$/,
  /^\/briefing\/(sweptAt|nextSyncAt)$/,
  /^\/briefing\/doctor\//,
  /^\/briefing\/environment\/(from|to)$/,
  /^\/briefing\/flow\/inspect$/,
  /^\/briefing\/repositories\/first$/,
  /^\/stations\/\d+\/service$/,
  /^\/services\/\d+\/service$/,
];

/** Every scalar leaf pointer under the value, walked generically. */
function renderedLeaves(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object") {
    return UNDRAWN.some((pattern) => pattern.test(prefix)) ? [] : [prefix];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    renderedLeaves(child, `${prefix}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`),
  );
}

/** The provenance step alone, fed the core briefing and Releases pane instead of a projection. */
function provenanceStep(input: WatchInput) {
  const now = input.context.clock.now();
  const model = buildModel(input.facts, now, {}, input.context);
  const { pane: releases } = projectReleases(input.releases, input.appData, now, input.context);
  const provenance = snapshotProvenance(input, model, now, {
    briefing: buildBriefing(model, input.doctor, now, input.context),
    places: [],
    stations: [],
    releases,
    platform: {},
    services: [],
    runs: [],
  });
  return { releases, provenance };
}

describe("area envelopes and provenance", () => {
  it("gives every area an envelope, unread when it has no reads", () => {
    const input = fixtureInput();
    const snapshot = projectWatch({ ...input, reads: { github: input.reads.github ?? [] } });
    expect(snapshot.areas.map(({ area }) => area)).toEqual([...AREAS]);
    for (const { area, envelope } of snapshot.areas) {
      expect(envelope.source).toBe(area);
      expect(envelope.state).toBe(area === "github" ? "stale" : "unread");
    }
  });

  it("turns an area stale past twice its own sweep interval as the clock moves", () => {
    const input = fixtureInput();
    const start = input.context.clock.now().getTime();
    let now = start;
    const context = { ...input.context, clock: { now: () => new Date(now) } };
    const read = (area: string): ReadRecord => ({
      source: area,
      object: area,
      observedAt: new Date(start).toISOString(),
      completeness: { kind: "complete" },
    });
    const at = (ms: number) => {
      now = start + ms;
      const { areas } = projectWatch({
        ...input,
        context,
        intervalMs: 600_000,
        intervals: { runs: 60_000 },
        reads: { runs: [read("runs")], github: [read("github")] },
      });
      return Object.fromEntries(areas.map(({ area, envelope }) => [area, envelope.state]));
    };
    expect(at(0)).toMatchObject({ runs: "fresh", github: "fresh" });
    expect(at(120_000)).toMatchObject({ runs: "fresh", github: "fresh" });
    expect(at(120_001)).toMatchObject({ runs: "stale", github: "fresh" });
    expect(at(1_200_001)).toMatchObject({ runs: "stale", github: "stale" });
  });

  it("names the feeding areas for every drawn value with resolving, unique paths", () => {
    const snapshot = projectWatch(fixtureInput());
    const paths = snapshot.provenance.map(({ path }) => path);
    expect(new Set(paths).size).toBe(paths.length);
    const areas = (path: string) => snapshot.provenance.find((p) => p.path === path)?.areas;
    expect(areas("/briefing/environment/facts/1/figure")).toEqual(["lifecycle"]);
    expect(areas("/briefing/environment/lanes/3")).toEqual(["lifecycle"]);
    expect(areas("/briefing/environment/note")).toEqual(["github"]);
    expect(areas("/briefing/repositories/rows/0/cells/issues")).toEqual(["github"]);
    expect(areas("/briefing/repositories/rows/0/cells/vulnerabilities")).toEqual([
      "radar",
      "template",
      "security",
    ]);
    expect(areas("/briefing/flow/rows/0")).toEqual([
      "github",
      "runs",
      "lifecycle",
      "upstream",
      "radar",
    ]);
    expect(areas("/briefing/focus/0")).toContain("approvals");
    expect(areas("/briefing/focus/0")).toContain("security");
  });

  it("marks each station inferred exactly when the areas that fed it are inferred", () => {
    // Independent of provenance.ts: what core's buildLine read for each fixture branch.
    const feeding = (id: string, text: string): AreaName[] => {
      if (id === "upstream")
        return text === "0 behind" ? ["upstream"] : ["github", "upstream", "radar"];
      if (id === "sync") return text === "clean" ? ["github", "runs"] : ["github"];
      if (id === "cascade" || id === "main") return ["github", "runs"];
      if (id === "release") return ["github"];
      if (id === "lane")
        return text === "blocked by the stack" ? ["lifecycle"] : ["github", "lifecycle"];
      throw new Error(`no feeding areas pinned for ${id}`);
    };
    const kinds = new Set<string>();
    const base = projectWatch(onlyInferred([]));
    for (const [s, row] of base.stations.entries()) {
      for (const [k, station] of row.stations.entries()) {
        const pointer = `/stations/${s}/stations/${k}`;
        const areas = feeding(station.id, station.text);
        const unrelated = AREAS.filter((area) => !areas.includes(area));
        kinds.add(`${station.id}:${areas.join(",")}`);
        expect(inferredAt(projectWatch(onlyInferred(areas)), pointer), pointer).toBe(true);
        expect(inferredAt(projectWatch(onlyInferred(unrelated)), pointer), pointer).toBe(false);
        for (const area of areas) {
          const rest = AREAS.filter((a) => a !== area);
          expect(inferredAt(projectWatch(onlyInferred(rest)), pointer), pointer).toBe(false);
        }
      }
    }
    expect([...kinds].sort()).toEqual([
      "cascade:github,runs",
      "lane:lifecycle",
      "main:github,runs",
      "release:github",
      "sync:github",
      "sync:github,runs",
      "upstream:github,upstream,radar",
      "upstream:upstream",
    ]);
  });

  it("shows the release tag as inferred when only github reads are inferred", () => {
    const snapshot = projectWatch(onlyInferred(["github"]));
    const k = snapshot.stations[0]?.stations.findIndex(({ id }) => id === "release") ?? -1;
    expect(snapshot.stations[0]?.stations[k]?.text).toBe("v1.3.1");
    expect(inferredAt(snapshot, `/stations/0/stations/${k}`)).toBe(true);
  });

  it("binds every station branch to the areas core read for it", () => {
    const at = (id: string, state: string, text: string) => stationAreas({ id, state, text });
    expect(at("upstream", "unknown", "lag unmeasured")).toEqual(["upstream"]);
    expect(at("sync", "stopped", "Sync Upstream failed")).toEqual(["github", "runs"]);
    expect(at("sync", "waiting", "PR #4")).toEqual(["github"]);
    expect(at("cascade", "stopped", "conflict")).toEqual(["github"]);
    expect(at("cascade", "moving", "running")).toEqual(["github", "runs"]);
    expect(at("main", "stopped", "PR #9 red")).toEqual(["github"]);
    expect(at("main", "waiting", "PR #9")).toEqual(["github"]);
    expect(at("main", "stopped", "main red")).toEqual(["github", "runs"]);
    expect(at("main", "unknown", "unproven")).toEqual(["github", "runs"]);
    expect(at("release", "waiting", "PR #2")).toEqual(["github"]);
    expect(at("lane", "idle", "last run ok")).toEqual(["github", "lifecycle"]);
    expect(at("lane", "waiting", "last run failed")).toEqual(["github", "lifecycle"]);
    // Precedence: a later branch also reads the absences that let core reach it.
    expect(at("upstream", "waiting", "3 behind")).toEqual(["github", "upstream", "radar"]);
    expect(at("cascade", "waiting", "held")).toEqual(["github", "runs"]);
  });

  it("binds the flight tiles to the areas their forks' phases read", () => {
    const { briefing } = projectWatch(fixtureInput());
    const tile = (label: string) => ({ label, value: "1", sub: "", tone: "neutral" as const });
    const flight = {
      ...briefing,
      flow: { ...briefing.flow, tiles: [tile("On main"), tile("Stopped")] },
    };
    type Args = Parameters<typeof briefingProvenance>;
    const areas = (i: number) =>
      briefingProvenance(flight as Args[0], {} as Args[1]).find(
        ({ path }) => path === `/briefing/flow/tiles/${i}`,
      )?.areas;
    expect(areas(0)).toEqual(["github", "runs", "upstream", "radar"]);
    // A stopped phase is a conflict issue or stop label with no cascade PR: github alone.
    expect(areas(1)).toEqual(["github"]);
  });

  it("binds every release line to its release reads and the fleet, never another area", () => {
    const lines = projectWatch(fixtureInput()).releases.lines;
    expect(lines.length).toBeGreaterThan(1);
    const others = AREAS.filter((area) => area !== "fleet");
    for (const i of lines.keys()) {
      const pointer = `/releases/lines/${i}`;
      expect(inferredAt(projectWatch(onlyInferred(["fleet"])), pointer), pointer).toBe(true);
      expect(inferredAt(projectWatch(onlyInferred(others)), pointer), pointer).toBe(false);
    }
    const { provenance } = projectWatch(fixtureInput());
    expect(
      provenance
        .filter(({ path }) => path.startsWith("/releases/lines/"))
        .map(({ path, areas }) => ({ path, areas })),
    ).toEqual(lines.map((_, i) => ({ path: `/releases/lines/${i}`, areas: ["fleet"] })));
  });

  it("covers every briefing, station, service and release value with provenance at it or an ancestor", () => {
    const base = fixtureInput();
    const variants = [
      base,
      { ...base, facts: { ...base.facts, lifecycle: {} } },
      { ...base, facts: { ...base.facts, security: {} } },
    ];
    for (const input of variants) {
      const snapshot = projectWatch(input);
      const paths = new Set(snapshot.provenance.map(({ path }) => path));
      for (const coarse of [
        "",
        "/briefing",
        "/stations",
        "/briefing/flow",
        "/briefing/environment",
        "/releases",
        "/releases/today",
      ]) {
        expect(paths.has(coarse), coarse).toBe(false);
      }
      const covered = (leaf: string): boolean =>
        [...paths].some(
          (path) => path !== "/releases/lines" && (leaf === path || leaf.startsWith(`${path}/`)),
        );
      const missing = renderedLeaves({
        briefing: snapshot.briefing,
        stations: snapshot.stations,
        services: snapshot.services,
        releases: snapshot.releases,
      })
        .map((leaf) => leaf.replace(/\/facts\/(\d+)\/(label|sub|tone)$/, "/facts/$1/figure"))
        .filter((leaf) => !covered(leaf));
      expect(missing).toEqual([]);
    }
  });

  it("pins every fixture fact and flow tile label to the areas that feed it", () => {
    const pinned: Record<string, AreaName[]> = {
      "facts:Environment": ["lifecycle"],
      "facts:Upstream sync": ["github", "runs", "details", "template"],
      "facts:Template": ["github", "template"],
      "environment/facts:Running": ["lifecycle"],
      "environment/facts:Deployable · 21 days": ["lifecycle"],
      "environment/facts:Last proof": ["lifecycle"],
      "repositories/facts:Issues": ["github"],
      "repositories/facts:Pull Requests": ["github"],
      "repositories/facts:Dependabot Bumps": ["github"],
      "repositories/facts:Vulnerabilities · ours": ["radar", "template", "security"],
      "repositories/facts:Code scanning · ours": ["radar", "template", "security"],
      "flow/tiles:Behind upstream": ["upstream"],
      "flow/tiles:Toolchain move": ["github", "runs", "upstream", "radar"],
      "flow/tiles:Will halt": ["github", "runs", "upstream", "radar"],
      "flow/tiles:Lanes": ["github", "runs"],
    };
    for (const input of [fixtureInput(), mixedFixtureInput()]) {
      const snapshot = projectWatch(input);
      const areas = (path: string) => snapshot.provenance.find((p) => p.path === path)?.areas;
      expect(areas("/briefing/horizon/stages/upstream")).toEqual(["upstream"]);
      expect(areas("/briefing/horizon/stages/held")).toEqual([
        "github",
        "runs",
        "upstream",
        "radar",
      ]);
      expect(areas("/briefing/horizon/owed")).toEqual(["github", "radar"]);
      const { briefing } = snapshot;
      const seen = [
        ...briefing.facts.map((f, i) => [`facts:${f.label}`, `/briefing/facts/${i}/figure`]),
        ...briefing.environment.facts.map((f, i) => [
          `environment/facts:${f.label}`,
          `/briefing/environment/facts/${i}/figure`,
        ]),
        ...briefing.repositories.facts.map((f, i) => [
          `repositories/facts:${f.label}`,
          `/briefing/repositories/facts/${i}/figure`,
        ]),
        ...briefing.flow.tiles.map((t, i) => [
          `flow/tiles:${t.label}`,
          `/briefing/flow/tiles/${i}`,
        ]),
      ].map(([key, path]) => [
        (key as string).replace(/^facts:Template\b.*$/, "facts:Template"),
        path,
      ]);
      for (const [key, path] of seen) {
        expect(pinned[key as string], `unpinned label ${key}`).toBeDefined();
        expect(areas(path as string), key).toEqual(pinned[key as string]);
      }
      expect(seen.map(([key]) => key).sort()).toEqual(Object.keys(pinned).sort());
    }
  });

  it("binds the declared-version fallback to the lifecycle read that found no running version", () => {
    const input = fixtureInput();
    const snapshot = projectWatch({
      ...input,
      facts: { ...input.facts, lifecycle: {} },
    });
    const areasAt = (at: string) => snapshot.provenance.find(({ path }) => path === at)?.areas;
    expect(snapshot.briefing.facts[0]?.figure).not.toBe("?");
    expect(areasAt("/briefing/facts/0/figure")).toEqual(["github", "lifecycle"]);
    const running = snapshot.briefing.environment.facts.findIndex(
      ({ label }) => label === "Running",
    );
    expect(running).toBeGreaterThanOrEqual(0);
    expect(snapshot.briefing.environment.facts[running]?.figure).not.toBe("?");
    expect(areasAt(`/briefing/environment/facts/${running}/figure`)).toEqual([
      "github",
      "lifecycle",
    ]);
  });
});
