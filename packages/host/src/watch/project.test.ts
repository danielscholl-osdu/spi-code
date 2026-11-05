// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ViewSnapshotSchema } from "@spi-code/contracts";
import {
  type ActionItem,
  AREAS,
  type AreaName,
  type ReadRecord,
  TEMPLATE_REPO,
} from "@spi-code/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appActions, projectReleases, projectWatch } from "./project.js";
import { briefingProvenance, stationAreas } from "./provenance.js";
import {
  fixtureInput,
  fixtureRoot,
  mixedFixtureInput,
  mixedSnapshotPath,
  oracle,
  snapshotPath,
} from "./snapshot-fixture.js";

process.env.TZ = "UTC";

const temporary: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Watch projection", () => {
  it("matches the frozen briefing, Releases pane, flow rows and six service stations", () => {
    const snapshot = projectWatch(fixtureInput());
    expect(snapshot.briefing).toEqual(oracle("briefing"));
    expect(snapshot.releases).toEqual(oracle("releases"));
    const lines = oracle("lines");
    expect({
      columns: ["Sync PR", "Cascade", "Sync to Main", "Main run"],
      flow: snapshot.briefing.flow.rows.map(({ fork, line }) => ({ fork, line })),
      services: snapshot.stations.map(({ service, stations }) => ({ fork: service, stations })),
    }).toEqual(lines);
  });

  it("rejects nested tampering of the projected snapshot", () => {
    const snapshot = projectWatch(fixtureInput());
    expect(
      ViewSnapshotSchema.safeParse({
        ...snapshot,
        briefing: {
          ...snapshot.briefing,
          environment: {
            ...snapshot.briefing.environment,
            lanes: [{ id: "upgrade", label: "Upgrade", events: [{ unexpected: true }] }],
          },
        },
      }).success,
    ).toBe(false);
    expect(
      ViewSnapshotSchema.safeParse({
        ...snapshot,
        stations: [{ service: "partition", stations: [] }],
      }).success,
    ).toBe(false);
  });

  it("fails when the committed snapshot differs from a fresh projection", () => {
    expect(projectWatch(fixtureInput())).toEqual(JSON.parse(readFileSync(snapshotPath, "utf8")));
    expect(projectWatch(mixedFixtureInput())).toEqual(
      JSON.parse(readFileSync(mixedSnapshotPath, "utf8")),
    );
  });

  it("preserves every read, including retained failures, cuts and inferred provenance", () => {
    const input = fixtureInput();
    const at = input.context.clock.now().toISOString();
    input.reads.github = [
      {
        source: "GitHub",
        object: "repositories",
        observedAt: at,
        retainedFrom: "2026-10-12T21:58:23.086Z",
        failure: "offline",
        completeness: { kind: "cut", reason: "page limit", read: 1, total: 3 },
        inferred: true,
      },
    ];
    const snapshot = projectWatch(input);
    expect(snapshot.reads).toContainEqual(input.reads.github[0]);
    expect(snapshot.tree.find(({ id }) => id === "repositories")?.status).toBe("failed");
    expect(snapshot.tree.find(({ id }) => id === "threads")?.status).toBe("unread");
    expect(snapshot.tree.filter(({ id }) => id.startsWith("service:"))).toHaveLength(
      input.context.fleet.forks.length,
    );
  });

  it("uses the injected clock for fresh, stale, incomplete and unread tree dots", () => {
    const fixture = fixtureInput();
    const record: ReadRecord = {
      source: "GitHub",
      object: "repositories",
      observedAt: fixture.context.clock.now().toISOString(),
      completeness: { kind: "complete" },
    };
    let input = { ...fixture, reads: { github: [record] } };
    expect(projectWatch(input).tree.find(({ id }) => id === "repositories")?.status).toBe("fresh");
    const stale = { ...record, observedAt: "2026-10-20T15:00:00.000Z" };
    input = { ...input, intervalMs: 0, reads: { github: [stale] } };
    expect(projectWatch(input).tree.find(({ id }) => id === "repositories")?.status).toBe("stale");
    input = {
      ...input,
      reads: {
        github: [
          {
            ...stale,
            completeness: { kind: "cut", reason: "limit", read: 1, total: 2 },
          },
        ],
      },
    };
    expect(projectWatch(input).tree.find(({ id }) => id === "repositories")?.status).toBe(
      "incomplete",
    );
    expect(projectWatch(input).tree.find(({ id }) => id === "setup")?.status).toBe("unread");
  });

  it("uses a service's GitLab provenance without borrowing another service's failure", () => {
    const input = fixtureInput();
    const fork = input.context.fleet.forks[0];
    if (!fork) throw new Error("Pinned fixture must include a service");
    const at = input.context.clock.now().toISOString();
    input.reads.upstream = [
      {
        source: fork.upstream,
        object: "compare",
        observedAt: at,
        completeness: { kind: "cut", reason: "page limit", read: 1, total: 2 },
      },
      {
        source: "another/project",
        object: "compare",
        observedAt: at,
        completeness: { kind: "complete" },
        failure: "offline",
      },
    ];
    expect(projectWatch(input).tree.find(({ id }) => id === `service:${fork.id}`)?.status).toBe(
      "incomplete",
    );
  });

  it("isolates approval run evidence by repository", () => {
    const input = fixtureInput();
    const run = Object.values(input.facts.approvals.data ?? {}).flat()[0];
    if (!run) throw new Error("Pinned fixture must include an approval run");
    const at = input.context.clock.now().toISOString();
    input.facts.approvals.data = {
      "Azure/healthy": [{ ...run, id: 1001 }],
      "Azure/failed": [{ ...run, id: 1002 }],
    };
    input.reads.approvals = [
      {
        source: "Azure/healthy",
        object: "approvals",
        observedAt: at,
        completeness: { kind: "complete" },
      },
      {
        source: "Azure/failed",
        object: "approvals",
        observedAt: at,
        completeness: { kind: "complete" },
        failure: "offline",
      },
    ];
    const { tree } = projectWatch(input);
    expect(tree.find(({ id }) => id === "run:1001")?.status).toBe("fresh");
    expect(tree.find(({ id }) => id === "run:1002")?.status).toBe("failed");
  });

  it.each(["repository source", "GitHub API path"])(
    "isolates lifecycle run evidence by %s",
    (scope) => {
      const input = fixtureInput();
      const run = input.facts.lifecycle.data?.refresh[0];
      if (!run) throw new Error("Pinned fixture must include a lifecycle run");
      const at = input.context.clock.now().toISOString();
      input.facts.lifecycle.data = {
        refresh: [
          { ...run, id: 1003, url: "https://github.com/Azure/healthy/actions/runs/1003" },
          { ...run, id: 1004, url: "https://github.com/Azure/failed/actions/runs/1004" },
        ],
        upgrade: [],
        smoke: [],
        sweeper: [],
      };
      input.reads.lifecycle = ["healthy", "failed"].map((repo) => ({
        source: scope === "repository source" ? `Azure/${repo}` : "github",
        object: scope === "repository source" ? "lifecycle" : `repos/Azure/${repo}/actions/runs`,
        observedAt: at,
        completeness: { kind: "complete" },
        ...(repo === "failed" ? { failure: "offline" } : {}),
      }));
      const { tree } = projectWatch(input);
      expect(tree.find(({ id }) => id === "run:1003")?.status).toBe("fresh");
      expect(tree.find(({ id }) => id === "run:1004")?.status).toBe("failed");
    },
  );

  it("includes failed release evidence in System and Today", () => {
    const input = fixtureInput();
    const record: ReadRecord = {
      source: "github",
      object: "github",
      observedAt: input.context.clock.now().toISOString(),
      completeness: { kind: "complete" },
    };
    const { tree } = projectWatch({
      ...input,
      reads: { github: [record] },
      releaseRecords: [{ ...record, source: "releases", object: "releases", failure: "offline" }],
    });
    for (const id of ["today", "system", "releases"]) {
      expect(tree.find((node) => node.id === id)?.status).toBe("failed");
    }
  });

  it("includes shared template dependency failures in every service dot", () => {
    const input = fixtureInput();
    const at = input.context.clock.now().toISOString();
    input.reads.github = input.context.fleet.forks.map((fork) => ({
      source: fork.repo,
      object: "repository",
      observedAt: at,
      completeness: { kind: "complete" },
    }));
    input.reads.template = [
      {
        source: TEMPLATE_REPO,
        object: `repos/${TEMPLATE_REPO}/contents/.github/sync-config.json`,
        observedAt: at,
        completeness: { kind: "complete" },
        failure: "offline",
      },
    ];
    const services = projectWatch(input).tree.filter(({ id }) => id.startsWith("service:"));
    expect(services.map(({ status }) => status)).toEqual(
      input.context.fleet.forks.map(() => "failed"),
    );
  });

  it.each(["github", "runs", "upstream", "radar", "template"] as const)(
    "includes an area-wide %s failure in a service dot",
    (area) => {
      const input = fixtureInput();
      const fork = input.context.fleet.forks[0];
      if (!fork) throw new Error("Pinned fixture must include a service");
      const at = input.context.clock.now().toISOString();
      const own: ReadRecord = {
        source: fork.repo,
        object: "repository",
        observedAt: at,
        completeness: { kind: "complete" },
      };
      input.reads.github = [own];
      input.reads[area] = [
        ...(input.reads[area] ?? []),
        {
          source: area,
          object: area,
          observedAt: at,
          completeness: { kind: "complete" },
          failure: "offline",
        },
      ];
      expect(projectWatch(input).tree.find(({ id }) => id === `service:${fork.id}`)?.status).toBe(
        "failed",
      );
    },
  );

  it.each(["fork", "stack", "area"] as const)(
    "scopes a failed GitHub %s read using the collector's object identity",
    (scope) => {
      const input = fixtureInput();
      const fork = input.context.fleet.forks[0];
      if (!fork) throw new Error("Pinned fixture must include a service");
      const at = input.context.clock.now().toISOString();
      const failedObject =
        scope === "fork" ? fork.repo : scope === "stack" ? "Azure/osdu-spi-stack" : "github";
      const github: ReadRecord[] = input.context.fleet.forks.map((service) => ({
        source: "github",
        object: service.repo,
        observedAt: at,
        completeness: { kind: "complete" },
        ...(service.repo === failedObject ? { failure: "offline" } : {}),
      }));
      if (scope !== "fork") {
        github.push({
          source: "github",
          object: failedObject,
          observedAt: at,
          completeness: { kind: "complete" },
          failure: "offline",
        });
      }
      const { tree } = projectWatch({ ...input, reads: { github } });
      for (const service of input.context.fleet.forks) {
        expect(tree.find(({ id }) => id === `service:${service.id}`)?.status).toBe(
          scope === "area" || service.repo === failedObject ? "failed" : "fresh",
        );
      }
    },
  );

  it.each(["fresh", "stale", "failed"] as const)(
    "keeps services without their own evidence unread despite a %s shared template read",
    (state) => {
      const input = fixtureInput();
      const now = input.context.clock.now();
      const template: ReadRecord = {
        source: TEMPLATE_REPO,
        object: "sync-config",
        observedAt:
          state === "stale"
            ? new Date(now.getTime() - 3 * input.intervalMs).toISOString()
            : now.toISOString(),
        completeness: { kind: "complete" },
        ...(state === "failed" ? { failure: "offline" } : {}),
      };
      const services = projectWatch({ ...input, reads: { template: [template] } }).tree.filter(
        ({ id }) => id.startsWith("service:"),
      );
      expect(services.map(({ status }) => status)).toEqual(
        input.context.fleet.forks.map(() => "unread"),
      );
    },
  );

  it.each(["fresh", "stale", "failed"] as const)(
    "uses a %s shared template read only to degrade a service with its own evidence",
    (state) => {
      const input = fixtureInput();
      const fork = input.context.fleet.forks[0];
      if (!fork) throw new Error("Pinned fixture must include a service");
      const now = input.context.clock.now();
      const template: ReadRecord = {
        source: TEMPLATE_REPO,
        object: "sync-config",
        observedAt:
          state === "stale"
            ? new Date(now.getTime() - 3 * input.intervalMs).toISOString()
            : now.toISOString(),
        completeness: { kind: "complete" },
        ...(state === "failed" ? { failure: "offline" } : {}),
      };
      const { tree } = projectWatch({
        ...input,
        reads: {
          github: [
            {
              source: "github",
              object: fork.repo,
              observedAt: now.toISOString(),
              completeness: { kind: "complete" },
            },
          ],
          template: [template],
        },
      });
      expect(tree.find(({ id }) => id === `service:${fork.id}`)?.status).toBe(state);
    },
  );

  it.each([false, true])(
    "applies a whole-area fork-runs record to run dots (failed: %s)",
    (failed) => {
      const input = fixtureInput();
      const run = input.facts.lifecycle.data?.refresh[0];
      if (!run) throw new Error("Pinned fixture must include a run");
      input.facts.runs.data = {
        "Azure/example": { sync: [{ ...run, id: 2001 }], template: [], cascade: [], main: [] },
      };
      input.reads.runs = [
        {
          source: "runs",
          object: "runs",
          observedAt: input.context.clock.now().toISOString(),
          completeness: { kind: "complete" },
          ...(failed ? { failure: "offline" } : {}),
        },
      ];
      expect(projectWatch(input).tree.find(({ id }) => id === "run:2001")?.status).toBe(
        failed ? "failed" : "fresh",
      );
    },
  );

  it("leaves the caller's timezone unchanged when loading fixtures", () => {
    vi.stubEnv("TZ", "America/New_York");
    fixtureInput();
    expect(process.env.TZ).toBe("America/New_York");
  });

  it("uses projection time before the first sweep without inventing a Briefing sweep time", () => {
    const input = fixtureInput();
    delete input.facts.sweep;
    const snapshot = projectWatch(input);
    expect(snapshot.sweptAt).toBe(input.context.clock.now().toISOString());
    expect(snapshot.briefing.sweptAt).toBeUndefined();
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

/** The window's isInferred rule: an exact pointer whose every named area is inferred. */
function inferredAt(snapshot: ReturnType<typeof projectWatch>, pointer: string): boolean {
  const source = snapshot.provenance.find(({ path }) => path === pointer);
  if (!source) return false;
  return source.areas.every(
    (area) => snapshot.areas.find((entry) => entry.area === area)?.envelope.inferred === true,
  );
}

// Values the views do not draw from a swept area: read metadata, the clock window, inspector
// ids and the fleet's own service names.
const UNDRAWN = [
  /^\/briefing\/(sweptAt|nextSyncAt)$/,
  /^\/briefing\/doctor\//,
  /^\/briefing\/environment\/(from|to)$/,
  /^\/briefing\/flow\/inspect$/,
  /^\/briefing\/repositories\/first$/,
  /^\/stations\/\d+\/service$/,
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
    expect(at("sync", "waiting", "gate 1 · PR #4")).toEqual(["github"]);
    expect(at("cascade", "stopped", "conflict")).toEqual(["github"]);
    expect(at("cascade", "moving", "running")).toEqual(["github", "runs"]);
    expect(at("main", "stopped", "gate 2 · PR #9 red")).toEqual(["github"]);
    expect(at("main", "waiting", "gate 2 · PR #9")).toEqual(["github"]);
    expect(at("main", "stopped", "main red")).toEqual(["github", "runs"]);
    expect(at("main", "unknown", "unproven")).toEqual(["github", "runs"]);
    expect(at("release", "waiting", "gate 3 · PR #2")).toEqual(["github"]);
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

  it("covers every rendered briefing and station value with provenance at it or an ancestor", () => {
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
      ]) {
        expect(paths.has(coarse), coarse).toBe(false);
      }
      const covered = (leaf: string): boolean =>
        [...paths].some((path) => leaf === path || leaf.startsWith(`${path}/`));
      const missing = renderedLeaves({ briefing: snapshot.briefing, stations: snapshot.stations })
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

  it("binds the environment figure to github when only the declared version is known", () => {
    const input = fixtureInput();
    const snapshot = projectWatch({
      ...input,
      facts: { ...input.facts, lifecycle: {} },
    });
    const figure = snapshot.provenance.find(({ path }) => path === "/briefing/facts/0/figure");
    expect(snapshot.briefing.facts[0]?.figure).not.toBe("?");
    expect(figure?.areas).toEqual(["github"]);
  });
});

describe("read-only app actions", () => {
  it("disables eligible and ineligible writes, preserves eligibility reasons and never confirms", () => {
    const items = [
      { type: "merge", label: "Merge", confirm: { irreversible: true, subject: "legal #1" } },
      { type: "rerun", label: "Re-run", disabled: true, reason: "Stack is held" },
    ];
    const before = structuredClone(items);
    expect(appActions(items)).toEqual([
      { id: "merge", label: "Merge", disabledReason: "writes arrive at M4" },
      {
        id: "rerun",
        label: "Re-run",
        disabledReason: "writes arrive at M4",
        eligibilityReason: "Stack is held",
      },
    ]);
    expect(items).toEqual(before);
  });

  it("retains the Re-run when deployable offer even while it cannot run", () => {
    const offer: ActionItem = {
      type: "rerun-when-deployable",
      label: "Re-run when deployable",
      disabled: true,
      reason: "this Keelson has no durable ops",
      confirm: { subject: "legal #1", body: "Wait for a deployable stack" },
    };
    expect(appActions([offer])).toEqual([
      expect.objectContaining({
        label: "Re-run when deployable",
        disabledReason: "writes arrive at M4",
        eligibilityReason: "this Keelson has no durable ops",
      }),
    ]);
  });

  it("reports an oversized pending label on its disabled action without losing other actions", () => {
    const items: ActionItem[] = [
      { type: "x", label: "X", pendingLabel: "a".repeat(41), reason: "Stack held" },
      { type: "y", label: "Y" },
    ];
    expect(appActions(items)).toEqual([
      {
        id: "x",
        label: "X",
        disabledReason: "writes arrive at M4",
        eligibilityReason: "Stack held; pendingLabel exceeds 40 characters",
      },
      { id: "y", label: "Y", disabledReason: "writes arrive at M4" },
    ]);
    expect(items[0]?.pendingLabel).toHaveLength(41);
    expect(appActions([{ type: "x", label: "X", pendingLabel: "a".repeat(40) }])).toHaveLength(1);
  });

  it("gives repeated act types unique IDs that are stable across projections", () => {
    const items: ActionItem[] = [
      { type: "act", label: "Merge" },
      { type: "act", label: "Re-run" },
      { type: "act-2", label: "Other action" },
      { type: "act", label: "Dispatch" },
    ];
    const actions = appActions(items);
    expect(actions.map(({ id }) => id)).toEqual(["act", "act-3", "act-2", "act-4"]);
    expect(appActions(structuredClone(items))).toEqual(actions);
  });

  it("requires a nonblank subject for irreversible actions before stripping confirmation", () => {
    for (const subject of [undefined, "", " "]) {
      expect(() =>
        appActions([
          {
            type: "x",
            label: "X",
            confirm: { irreversible: true, ...(subject === undefined ? {} : { subject }) },
          },
        ]),
      ).toThrow("subject");
    }
  });
});

describe("read-only release notes", () => {
  it("projects missing, invalid and ok notes into distinct Releases states without writing", () => {
    const appData = mkdtempSync(join(tmpdir(), "spi-watch-notes-"));
    temporary.push(appData);
    const input = fixtureInput();
    const project = () =>
      projectReleases(input.releases, appData, input.context.clock.now(), input.context);
    expect(project().documents[0]?.notes).toBe("none");
    mkdirSync(join(appData, "notes"));
    const path = join(appData, "notes", "2026-10.json");
    writeFileSync(path, "headline: [");
    expect(project().documents[0]).toMatchObject({
      notes: "invalid",
      notesError: expect.any(String),
    });
    const raw = readFileSync(join(fixtureRoot, "notes/2026-10.json"), "utf8");
    writeFileSync(path, raw);
    expect(project().pane.lines[0]).toMatchObject({
      notes: "approved",
      headline: "All 13 services <now> ship from SPI forks.",
    });
    expect(readFileSync(path, "utf8")).toBe(raw);
  });

  it("surfaces non-ENOENT file errors instead of claiming notes are missing", () => {
    const appData = mkdtempSync(join(tmpdir(), "spi-watch-error-"));
    temporary.push(appData);
    mkdirSync(join(appData, "notes", "2026-10.json"), { recursive: true });
    const input = fixtureInput();
    expect(() =>
      projectReleases(input.releases, appData, input.context.clock.now(), input.context),
    ).toThrow();
  });

  it("does not cap the release months silently", () => {
    const input = fixtureInput();
    input.releases.releases.extra = Array.from({ length: 15 }, (_, i) => ({
      tag: `v${i}`,
      at: new Date(Date.UTC(2024, i, 1)).toISOString(),
      body: "",
    }));
    expect(
      projectReleases(input.releases, input.appData, input.context.clock.now(), input.context).pane
        .lines.length,
    ).toBeGreaterThan(12);
  });
});
