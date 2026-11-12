// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { ViewSnapshotSchema } from "@spi-code/contracts";
import { buildModel, type ReadRecord } from "@spi-code/core";
import { describe, expect, it } from "vitest";
import { projectWatch } from "./project.js";
import { projectReleases } from "./releases.js";
import { fixtureInput, mixedFixtureInput } from "./snapshot-fixture.js";
import { stationSubstate } from "./substate.js";

process.env.TZ = "UTC";

describe("Watch projection", () => {
  it("projects core substates for every recorded station", () => {
    for (const input of [fixtureInput(), mixedFixtureInput()]) {
      const snapshot = projectWatch(input);
      expect(
        snapshot.stations.map(({ service, stations }) => ({
          service,
          substates: stations.map(({ substate }) => substate),
        })),
      ).toEqual([
        {
          service: "partition",
          substates: ["ready", "ready", "ready", "ready", "ready", "stopped"],
        },
        {
          service: "entitlements",
          substates: ["stopped", "stopped", "ready", "ready", "ready", "stopped"],
        },
        {
          service: "legal",
          substates: ["waiting-on-clock", "stopped", "ready", "ready", "ready", "stopped"],
        },
        { service: "schema", substates: ["ready", "ready", "ready", "ready", "ready", "stopped"] },
        { service: "file", substates: ["ready", "ready", "ready", "ready", "ready", "stopped"] },
      ]);
    }
  });

  it("maps a moving station to in-progress even when the pinned fleet has none", () => {
    const input = fixtureInput();
    const line = buildModel(input.facts, input.context.clock.now(), {}, input.context).lines[0];
    const station = line?.stations[0];
    if (!line || !station) throw new Error("Missing fixture station");
    expect(stationSubstate({ ...station, state: "moving" }, line, input)).toBe("in-progress");
  });

  it("projects scheduled syncs and release reviews from their facts", () => {
    const input = fixtureInput();
    const repo = input.facts.github.data?.repos["Azure/osdu-spi-partition"];
    const upstream = input.facts.upstream.data?.partition;
    const pr = input.facts.github.data?.repos["Azure/osdu-spi"]?.prs.find((pr) =>
      pr.head.startsWith("release-please--"),
    );
    if (!repo || !upstream || !pr) throw new Error("Missing fixture facts");
    upstream.lag = 3;
    repo.prs.push({ ...pr, repo: repo.repo });
    const stations = projectWatch(input).stations.find(
      (row) => row.service === "partition",
    )?.stations;
    expect(stations?.find((station) => station.id === "upstream")?.substate).toBe(
      "waiting-on-clock",
    );
    expect(stations?.find((station) => station.id === "release")?.substate).toBe(
      "waiting-on-clock",
    );
  });

  it("rejects a missing or unrecognized station substate at the snapshot boundary", () => {
    for (const substate of [undefined, "unknown", "waiting"]) {
      const snapshot = projectWatch(fixtureInput());
      const row = snapshot.stations[0];
      if (!row) throw new Error("Missing fixture service");
      const invalid = {
        ...snapshot,
        stations: [
          {
            ...row,
            stations: row.stations.map((station, index) =>
              index === 0 ? { ...station, substate } : station,
            ),
          },
          ...snapshot.stations.slice(1),
        ],
      };
      expect(ViewSnapshotSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("fills each service's runs, release documents and current gate from recorded inputs", () => {
    const input = fixtureInput();
    const snapshot = projectWatch(input);
    const { documents } = projectReleases(
      input.releases,
      input.appData,
      input.context.clock.now(),
      input.context,
    );
    const model = buildModel(input.facts, input.context.clock.now(), {}, input.context);
    expect(snapshot.services).toHaveLength(input.context.fleet.forks.length);
    for (const service of snapshot.services ?? []) {
      const line = model.lines.find((line) => line.fork.id === service.service);
      if (!line) throw new Error("Missing fixture service");
      const lanes = input.facts.runs.data?.[line.fork.repo];
      const recorded = [
        ...Object.values(
          lanes
            ? {
                sync: lanes.sync,
                template: lanes.template,
                cascade: lanes.cascade,
                main: lanes.main,
              }
            : {},
        ).flat(),
        ...(input.facts.approvals.data?.[line.fork.repo] ?? []),
      ];
      const unique = [...new Map(recorded.map((run) => [run.id, run])).values()].sort(
        (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id,
      );
      expect(service.runs).toEqual(
        unique.map((run) => ({
          id: `run:${run.id}`,
          workflow: run.name,
          result: run.status === "completed" ? (run.conclusion ?? "completed") : run.status,
          time: run.createdAt,
          ...(run.status === "completed" ? { completedAt: run.updatedAt } : {}),
          url: run.url,
        })),
      );
      expect(
        service.releases?.map(
          ({ month, releasePr: _pr, gate: _gate, readTimes: _times, ...row }) => ({
            month,
            row,
          }),
        ),
      ).toEqual(
        documents.flatMap((doc) =>
          doc.rows
            .filter((row) => row.id === service.service)
            .map((row) => ({ month: doc.month, row })),
        ),
      );
      const current = service.releases?.find(({ month }) => month === snapshot.sweptAt.slice(0, 7));
      expect(current?.gate).toEqual(
        line.stations
          .filter((s) => s.id === "release")
          .map(({ state, text }) => ({ state, text }))[0],
      );
      const pr = line.releasePr?.pr;
      expect(current?.releasePr).toEqual(
        pr ? { number: pr.number, title: pr.title, url: pr.url } : undefined,
      );
      expect(
        service.releases
          ?.filter((row) => row !== current)
          .every(({ releasePr, gate }) => releasePr === undefined && gate === undefined),
      ).toBe(true);
    }
    const lines = snapshot.briefing.repositories.rows.flatMap((r) =>
      r.sections.flatMap((s) => s.lines),
    );
    for (const prefix of ["pr:", "issue:", "alert:"]) {
      expect(lines.some((line) => line.id?.startsWith(prefix) && line.url)).toBe(true);
    }
  });

  it("uses each service's GitHub read even when the aggregate is from an older batch", () => {
    const input = mixedFixtureInput();
    const repo = "Azure/osdu-spi-entitlements";
    const own = "2026-10-12T21:59:00.000Z";
    const older = "2026-10-12T21:50:00.000Z";
    input.reads.github = [
      releaseRead("github", "Azure/osdu-spi-partition", older),
      releaseRead("github", repo, own),
    ];
    const snapshot = projectWatch(input);
    const row = snapshot.services?.find((s) => s.service === "entitlements")?.releases[0];
    expect(row?.readTimes?.github).toBe(own);
    expect(snapshot.areas.find((a) => a.area === "github")?.envelope).toMatchObject({
      observedAt: older,
    });
  });

  it("uses the service's release history read, not an older cached pin or another repository", () => {
    const input = mixedFixtureInput();
    const repo = "Azure/osdu-spi-entitlements";
    const history = "2026-10-21T16:00:00.000Z";
    const pinned = "2026-10-01T08:00:00.000Z";
    const snapshot = projectWatch({
      ...input,
      releaseRecords: [
        releaseRead("github-pins", `${repo}@v1.2.1`, pinned),
        releaseRead("github-releases", "Azure/osdu-spi-partition", pinned),
        releaseRead("github-releases", repo, history),
      ],
    });
    const i = snapshot.services?.findIndex((s) => s.service === "entitlements") ?? -1;
    expect(snapshot.services?.[i]?.releases[0]?.readTimes?.history).toBe(history);
    expect(
      snapshot.provenance.find((p) => p.path === `/services/${i}/releases`)?.envelope,
    ).toMatchObject({
      observedAt: pinned,
    });
  });

  it.each(["retained", "failed", "missing"] as const)(
    "keeps per-service read times honest for %s reads without borrowing aggregate times",
    (state) => {
      const input = mixedFixtureInput();
      const repo = "Azure/osdu-spi-entitlements";
      const attempt = "2026-10-22T12:00:00.000Z";
      const github = "2026-10-12T21:58:23.086Z";
      const history = "2026-10-21T15:10:40.718Z";
      const record = (source: string, retainedFrom: string): ReadRecord[] =>
        state === "missing"
          ? []
          : [
              {
                ...releaseRead(source, repo, attempt),
                failure: "offline",
                ...(state === "retained" ? { retainedFrom } : {}),
              },
            ];
      const snapshot = projectWatch({
        ...input,
        reads: {
          ...input.reads,
          github: [releaseRead("github", "github", attempt), ...record("github", github)],
        },
        releaseRecords: [
          releaseRead("releases", "releases", attempt),
          ...record("github-releases", history),
        ],
      });
      const rows = snapshot.services?.find((s) => s.service === "entitlements")?.releases;
      expect(rows?.length).toBeGreaterThan(0);
      for (const row of rows ?? []) {
        expect(row.readTimes).toEqual(state === "retained" ? { github, history } : {});
      }
    },
  );

  it("adds a recorded release PR to this month's service row, never to older months", () => {
    const input = fixtureInput();
    const fork = input.context.fleet.forks[0];
    const repo = fork && input.facts.github.data?.repos[fork.repo];
    const pr = Object.values(input.facts.github.data?.repos ?? {}).flatMap((r) => r.prs)[0];
    if (!fork || !repo || !pr) throw new Error("Fixture must have repositories and PRs");
    const releasePr = {
      ...pr,
      repo: fork.repo,
      number: 700,
      title: "chore: release service",
      head: "release-please--branches--main",
      labels: ["autorelease: pending"],
      url: `https://github.com/${fork.repo}/pull/700`,
    };
    repo.prs.push(releasePr);
    const service = projectWatch(input).services?.find((s) => s.service === fork.id);
    const rows = service?.releases;
    expect(rows?.find((r) => r.month === "2026-10")).toMatchObject({
      releasePr: { number: 700, title: releasePr.title, url: releasePr.url },
      gate: { state: "waiting", text: "#700 waiting on review" },
    });
    expect(rows?.filter((r) => r.month !== "2026-10").every((r) => !r.gate && !r.releasePr)).toBe(
      true,
    );
  });

  it("scopes, deduplicates and orders runs across existing areas, retaining live status", () => {
    const input = fixtureInput();
    const fork = input.context.fleet.forks[0];
    const run = Object.values(input.facts.runs.data ?? {}).flatMap((lanes) => lanes.sync)[0];
    const lifecycle = input.facts.lifecycle.data?.refresh[0];
    if (!fork || !run || !lifecycle)
      throw new Error("Fixture must have service and lifecycle runs");
    const active = { ...run, id: 9001, status: "in_progress", createdAt: "2026-10-12T21:59:00Z" };
    input.facts.runs.data = {
      [fork.repo]: { sync: [active], template: [], cascade: [active], main: [] },
    };
    input.facts.approvals.data = {
      [fork.repo]: [
        { ...active, conclusion: "failure" },
        { ...run, id: 9002 },
      ],
      "example/other": [{ ...run, id: 9003 }],
    };
    input.facts.lifecycle.data = {
      refresh: [
        { ...lifecycle, id: 9004, url: `https://github.com/${fork.repo}/actions/runs/9004` },
      ],
      upgrade: [],
      smoke: [],
      sweeper: [],
    };
    const snapshot = projectWatch(input);
    const i = snapshot.services?.findIndex((s) => s.service === fork.id) ?? -1;
    const service = snapshot.services?.[i];
    expect(service?.runs?.map((r) => r.id).sort()).toEqual(["run:9001", "run:9002", "run:9004"]);
    expect(service?.runs?.[0]).toMatchObject({ id: "run:9001", result: "in_progress" });
    for (const projected of service?.runs ?? []) {
      if (projected.id === "run:9001") expect(projected).not.toHaveProperty("completedAt");
      else
        expect(projected.completedAt).toBe(
          projected.id === "run:9002" ? run.updatedAt : lifecycle.updatedAt,
        );
    }
    for (const [k, r] of (service?.runs ?? []).entries()) {
      expect(snapshot.provenance.find((p) => p.path === `/services/${i}/runs/${k}`)?.areas).toEqual(
        [r.id === "run:9001" ? "runs" : r.id === "run:9002" ? "approvals" : "lifecycle"],
      );
    }
    expect(
      snapshot.services?.filter((s) => s.service !== fork.id).every((s) => s.runs.length === 0),
    ).toBe(true);
  });

  it("keeps runs from two repositories that share a numeric run id", () => {
    const input = fixtureInput();
    const [a, b] = input.context.fleet.forks;
    const run = Object.values(input.facts.runs.data ?? {}).flatMap((lanes) => lanes.sync)[0];
    if (!a || !b || !run) throw new Error("Fixture must have two services and a run");
    input.facts.runs.data = {
      [a.repo]: { sync: [{ ...run, id: 5000 }], template: [], cascade: [], main: [] },
    };
    input.facts.approvals.data = { [b.repo]: [{ ...run, id: 5000 }] };
    const snapshot = projectWatch(input);
    for (const [fork, area] of [
      [a, "runs"],
      [b, "approvals"],
    ] as const) {
      const i = snapshot.services?.findIndex((s) => s.service === fork.id) ?? -1;
      expect(snapshot.services?.[i]?.runs.map((r) => r.id)).toEqual(["run:5000"]);
      expect(snapshot.provenance.find((p) => p.path === `/services/${i}/runs/0`)?.areas).toEqual([
        area,
      ]);
    }
  });
});

function releaseRead(source: string, object: string, observedAt: string): ReadRecord {
  return { source, object, observedAt, completeness: { kind: "complete" } };
}
