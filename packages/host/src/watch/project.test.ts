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
  buildBriefing,
  buildModel,
  detectCampaigns,
  RELEASES_EVERY_MS,
  type ReadRecord,
  repositoriesOf,
  TEMPLATE_REPO,
} from "@spi-code/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as attention from "./attention.js";
import * as campaigns from "./campaigns.js";
import { appActions, projectReleases, projectWatch, type WatchInput } from "./project.js";
import { briefingProvenance, releaseProvenance, stationAreas } from "./provenance.js";
import { readingFor } from "./readings.js";
import { runProvenance } from "./recorded-runs.js";
import { repositoryLines } from "./repository-lines.js";
import * as seen from "./seen.js";
import {
  fixtureInput,
  fixtureRoot,
  mixedFixtureInput,
  mixedSnapshotPath,
  oracle,
  recordedInput,
  snapshotPath,
} from "./snapshot-fixture.js";
import { stationSubstate } from "./substate.js";

process.env.TZ = "UTC";

// The rib reaches a code finding that names no file as shipped code; SPI Code reaches it as
// repository settings, so osdu-spi's Branch-Protection and Code-Review leave the shipped tallies.
function settingsReach(briefing: unknown): unknown {
  const text = JSON.stringify(briefing)
    .replace("and 13 high code-scanning alerts.", "and 11 high code-scanning alerts.")
    .replace(
      "critical or high in shipped code · 3 rules",
      "critical or high in shipped code · 1 rule",
    )
    .replace(
      "1 alert in SPI-owned shipped code at repository settings, found by Scorecard.",
      "1 alert in SPI-owned repository settings, found by Scorecard.",
    )
    .replaceAll("SPI · shipped · repository settings", "SPI · repository settings");
  const out = JSON.parse(text);
  const fact = out.repositories.facts.find(
    (f: { label: string }) => f.label === "Code scanning · ours",
  );
  fact.figure = "11";
  const row = out.repositories.rows.find((r: { id: string }) => r.id === "repo:osdu-spi");
  row.cells.codeScanning = { ...row.cells.codeScanning, text: "0", tone: "neutral" };
  return out;
}

const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

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

  it("projects window defaults for every queue item and place anchor", () => {
    const snapshot = projectWatch(fixtureInput());
    const items = [...snapshot.briefing.focus, ...snapshot.briefing.rest];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item).toMatchObject({
        attention: item.rung === 0 ? "interrupt" : "surface",
        owned: false,
      });
    }
    expect(Object.fromEntries(items.filter((i) => i.due).map((i) => [i.id, i.due]))).toEqual({
      "halt:entitlements": { at: snapshot.briefing.nextSyncAt, before: "next sync" },
    });
    const input = fixtureInput();
    expect(snapshot.campaigns).toEqual(
      detectCampaigns(buildModel(input.facts, input.context.clock.now(), {}, input.context)),
    );
    expect(snapshot.seen).toEqual({ cursor: null, since: [] });
    expect(snapshot.readings.map(({ anchor }) => anchor)).toEqual([
      ...["program", "upstream", "environment", "engineering", "releases", "security"].map(
        (kind) => ({ kind }),
      ),
      ...snapshot.stations.map(({ service }) => ({ kind: "service", id: service })),
      ...snapshot.releases.lines.map(({ month }) => ({ kind: "release-month", month })),
      ...snapshot.campaigns.map(({ id }) => ({ kind: "campaign", id })),
    ]);
    for (const { anchor, content } of snapshot.readings) {
      if (
        anchor.kind === "program" ||
        anchor.kind === "upstream" ||
        anchor.kind === "environment" ||
        anchor.kind === "service" ||
        anchor.kind === "releases" ||
        anchor.kind === "release-month" ||
        anchor.kind === "engineering" ||
        anchor.kind === "security"
      ) {
        expect(content?.tiles).toHaveLength(3);
        expect(content?.items.length).toBeLessThanOrEqual(5);
      } else expect(content).toBeNull();
    }
  });

  describe("current release tile without a whole release read", () => {
    const observedAt = "2026-11-06T12:00:00.000Z";
    const record = (over: Partial<ReadRecord> = {}): ReadRecord => ({
      source: "github-releases",
      object: "Azure/osdu-spi-file",
      observedAt,
      completeness: { kind: "complete" },
      ...over,
    });
    const currentRelease = (releaseRecords: ReadRecord[]) => {
      const input: WatchInput = {
        ...fixtureInput(),
        releases: { releases: {}, created: {}, pins: {}, errors: {} },
        releaseRecords,
      };
      const releases = projectWatch(input).readings.find(
        ({ anchor }) => anchor.kind === "releases",
      );
      return releases?.content?.tiles[2];
    };
    const unread = { label: "Current release", value: "not read yet" };

    it.each([
      ["no release reads", []],
      [
        "only a cut read",
        [record({ completeness: { kind: "cut", reason: "page limit", read: 100, total: 140 } })],
      ],
      ["only a failed read", [record({ failure: "HTTP 502" })]],
    ])("reads not read yet with %s", (_case, records) => {
      expect(currentRelease(records)).toMatchObject(unread);
    });

    it("reads the months when a failed read kept an earlier one", () => {
      expect(
        currentRelease([record({ failure: "HTTP 502", retainedFrom: "2026-11-05T12:00:00.000Z" })]),
      ).toMatchObject({ label: "Current release", value: "2026.10" });
    });
  });

  it("maps a moving station to in-progress even when the pinned fleet has none", () => {
    const input = fixtureInput();
    const line = buildModel(input.facts, input.context.clock.now(), {}, input.context).lines[0];
    const station = line?.stations[0];
    if (!line || !station) throw new Error("Missing fixture station");
    expect(stationSubstate({ ...station, state: "moving" }, line, input)).toBe("in-progress");
  });

  it("does not qualify engineering adoption on a failed radar read from a fork", () => {
    const input = fixtureInput();
    const snapshot = projectWatch({
      ...input,
      reads: {
        ...input.reads,
        radar: [
          {
            source: "Azure/osdu-spi-partition",
            object: "main:provider/partition-azure/pom.xml",
            observedAt: input.context.clock.now().toISOString(),
            completeness: { kind: "complete" },
            failure: "unavailable",
          },
        ],
      },
    });
    expect(
      snapshot.readings.find(({ anchor }) => anchor.kind === "engineering")?.content,
    ).not.toHaveProperty("qualifier");
  });

  it("preserves typed template verification through the host snapshot projection", () => {
    const input = recordedInput();
    const repo = input.facts.github.data?.repos["Azure/osdu-spi-partition"];
    if (!repo) throw new Error("Missing partition");
    delete repo.marker;
    const snapshot = projectWatch(input);
    const model = buildModel(input.facts, input.context.clock.now(), {}, input.context);
    expect(
      snapshot.readings.find(({ anchor }) => anchor.kind === "engineering")?.content
        ?.verifiedTemplate,
    ).toEqual({
      verified: 0,
      total: 13,
      unread: 1,
      target: model.rollout?.target.sha ?? model.template.head?.sha,
    });
    expect(ViewSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it.each(["template", "runs"] as const)(
    "names failed %s reads in the engineering qualifier",
    (area) => {
      const input = fixtureInput();
      const snapshot = projectWatch({
        ...input,
        reads: {
          ...input.reads,
          [area]: [
            {
              source: area === "template" ? TEMPLATE_REPO : "Azure/osdu-spi-partition",
              object: area === "template" ? "compare" : "actions/runs",
              observedAt: input.context.clock.now().toISOString(),
              completeness: { kind: "complete" },
              failure: "unavailable",
            },
          ],
        },
      });
      const source = area === "template" ? "GitHub template" : "GitHub Actions";
      expect(
        snapshot.readings.find(({ anchor }) => anchor.kind === "engineering")?.content?.qualifier,
      ).toBe(`${source} reads failed, so adoption or template changes could be missing.`);
    },
  );

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

  it("passes settings, previous states, baseline and projected tiers through the feature seams", () => {
    const previous = projectWatch(fixtureInput()).briefing;
    const items = [...previous.focus, ...previous.rest];
    const first = items[0];
    if (!first) throw new Error("Missing fixture item");
    const input: WatchInput = {
      ...fixtureInput(),
      cursor: 20,
      attention: { leadTimeMs: 60_000, previous: items },
      baseline: { cursor: 3, items },
    };
    const tier = vi
      .spyOn(attention, "itemAttention")
      .mockReturnValue({ attention: "interrupt", owned: false });
    const baseline = vi.spyOn(seen, "seenState").mockReturnValue({ cursor: 3, since: [first.id] });
    const snapshot = projectWatch(input);
    expect(tier).toHaveBeenCalledWith(
      expect.objectContaining({ id: first.id }),
      expect.anything(),
      input,
      input.attention,
    );
    expect(baseline).toHaveBeenCalledWith(expect.anything(), input, snapshot.briefing);
    expect(snapshot.briefing.focus.every((item) => item.attention === "interrupt")).toBe(true);
    expect(snapshot.seen).toEqual({ cursor: 3, since: [first.id] });
  });

  it("dispatches every reading to its own anchor-kind handler with the full context", () => {
    const input = fixtureInput();
    const detected = [
      {
        id: "boot",
        kind: "toolchain" as const,
        fact: "Boot 4",
        forks: ["legal", "file"],
      },
    ];
    vi.spyOn(campaigns, "detectedCampaigns").mockReturnValue(detected);
    const handlers = (
      [
        "program",
        "upstream",
        "environment",
        "engineering",
        "releases",
        "security",
        "service",
        "release-month",
        "campaign",
      ] as const
    ).map((kind) => ({ kind, spy: vi.spyOn(readingFor, kind) }));
    const snapshot = projectWatch(input);
    for (const { kind, spy } of handlers) {
      const entries = snapshot.readings.filter(({ anchor }) => anchor.kind === kind);
      expect(entries.length).toBeGreaterThan(0);
      expect(spy).toHaveBeenCalledTimes(entries.length);
      for (const { anchor } of entries)
        expect(spy).toHaveBeenCalledWith(
          anchor,
          expect.objectContaining({ input, briefing: snapshot.briefing, campaigns: detected }),
        );
    }
  });

  it("matches the frozen briefing, Releases pane, flow rows and six service stations", () => {
    const snapshot = projectWatch(fixtureInput());
    const legacy = withoutAdditions(snapshot);
    // The rib's 17-word flow headline breaks the 12-word rule; its pilot sentence leads sub instead.
    const frozen = settingsReach(oracle("briefing")) as {
      flow: { headline: string; sub: string };
      themes: { id: string; next: string }[];
    };
    const frozenFields = {
      ...legacy.briefing,
      horizon: { headline: legacy.briefing.horizon.headline },
      focus: legacy.briefing.focus.map(({ origin: _origin, ...item }) => item),
      rest: legacy.briefing.rest.map(({ origin: _origin, ...item }) => item),
    };
    // Bound time units change typography, not the frozen rib's words.
    const ribBriefing = {
      ...frozenFields,
      themes: legacy.briefing.themes.filter((theme) => !theme.title.startsWith("os-core-common ")),
    };
    expect(
      snapshot.briefing.themes
        .filter((theme) => theme.title.startsWith("os-core-common "))
        .map((theme) => theme.title),
    ).toEqual(["os-core-common 9.2.0", "os-core-common 8.2.0"]);
    expect(JSON.parse(JSON.stringify(ribBriefing).replaceAll("\u00a0", " "))).toEqual({
      ...frozen,
      themes: frozen.themes.map((theme) =>
        theme.id === "toolchain:Java 25"
          ? { ...theme, next: "Move one fork's Java pin to 25 and repeat it for the others." }
          : theme,
      ),
      horizon: { headline: "Nothing lands at the next sync; 6 commits won't land." },
      flow: {
        ...frozen.flow,
        headline: "6 upstream commits wait across 2 forks.",
        sub: "2 forks move their toolchain, so start with one pilot. 1 sync PR is prepared. Nothing syncs until you merge one.",
      },
    });
    // The rib's horizon sentence names one theme; the stage sentence replaces it.
    expect(frozen).toMatchObject({
      horizon: { headline: "One filter entry would stop 4 future halts." },
    });
    expect(frozen.flow.headline).toBe(
      "6 upstream commits wait across 2 forks. 2 forks move their toolchain, so start with one pilot.",
    );
    const { today: _today, forming: _forming, ...ledger } = snapshot.releases;
    expect(ledger).toEqual(oracle("releases"));
    const lines = oracle("lines");
    expect({
      columns: ["Sync PR", "Cascade", "Sync to Main", "Main run"],
      flow: snapshot.briefing.flow.rows.map(({ fork, line }) => ({ fork, line })),
      services: legacy.stations.map(({ service, stations }) => ({ fork: service, stations })),
    }).toEqual(lines);
  });

  it("adds only host metadata, preserving the core briefing and every station field", () => {
    const input = fixtureInput();
    const now = input.context.clock.now();
    const model = buildModel(input.facts, now, {}, input.context);
    const original = JSON.stringify(buildBriefing(model, input.doctor, now, input.context));
    const snapshot = projectWatch(input);
    expect(withoutAdditions(snapshot).briefing).toEqual(JSON.parse(original));
    expect(withoutAdditions(snapshot).stations).toEqual(
      model.lines.map((line) => ({ service: line.fork.id, stations: line.stations })),
    );
    expect(snapshot.stations.every((row) => row.stations.every((s) => !!s.inspect))).toBe(true);
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

  it("keeps distinct alert groups identifiable even when their displayed text is identical", () => {
    const input = fixtureInput();
    const now = input.context.clock.now();
    const model = buildModel(input.facts, now, {}, input.context);
    const repo = model.repositories.rows[0];
    const alert = model.repositories.rows.flatMap((r) => r.alerts).find((g) => g.source === "code");
    if (!repo || !alert) throw new Error("Fixture must have alert groups");
    repo.alerts = ["rule-a", "rule-b"].map((rule) => ({
      ...alert,
      id: `code:tool:${rule}:src`,
      rule,
      count: 2,
      owner: "spi",
      reach: "shipped",
    }));
    const projected = repositoryLines(repositoriesOf(model, now), model, now);
    const lines = projected.rows[0]?.sections.find((s) => s.title === "Code scanning")?.lines;
    expect(lines?.map((line) => line.id)).toEqual([
      `alert:${repo.repo}:code:tool:rule-a:src`,
      `alert:${repo.repo}:code:tool:rule-b:src`,
    ]);
    expect(new Set(lines?.map((line) => line.url)).size).toBe(2);
  });

  it("omits the optional id and url of a repository line it cannot match", () => {
    const input = fixtureInput();
    const now = input.context.clock.now();
    const model = buildModel(input.facts, now, {}, input.context);
    const repositories = repositoriesOf(model, now);
    const [row] = repositories.rows;
    const [section] = row?.sections ?? [];
    if (!row || !section) throw new Error("Fixture must have repository lines");
    const unmatched = {
      tag: "?",
      tone: "neutral",
      text: "Wording core has not shipped yet",
      sub: "",
    } as const;
    const projected = repositoryLines(
      {
        ...repositories,
        rows: [
          { ...row, sections: [{ ...section, lines: [...section.lines, unmatched] }] },
          { ...row, id: "repo:unknown" },
        ],
      },
      model,
      now,
    );
    expect(projected.rows[0]?.sections[0]?.lines.at(-1)).toEqual(unmatched);
    expect(projected.rows[0]?.sections[0]?.lines.slice(0, -1).every((l) => l.id && l.url)).toBe(
      true,
    );
    expect(projected.rows[1]).toEqual({ ...row, id: "repo:unknown" });
  });

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

  it.each([
    ["recorded", fixtureInput],
    ["mixed", mixedFixtureInput],
  ])("identifies every repository line and service run on the %s fixture", (_, input) => {
    const snapshot = projectWatch(input());
    const lines = snapshot.briefing.repositories.rows.flatMap((r) =>
      r.sections.flatMap((s) => s.lines),
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((line) => !line.id || !line.url)).toEqual([]);
    const runs = (snapshot.services ?? []).flatMap((s, i) =>
      s.runs.map((_, k) => `/services/${i}/runs/${k}`),
    );
    expect(runs.length).toBeGreaterThan(0);
    const paths = new Set(snapshot.provenance.map(({ path }) => path));
    expect(runs.filter((path) => !paths.has(path))).toEqual([]);
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

  function withoutAdditions(snapshot: ReturnType<typeof projectWatch>) {
    const { services: _services, ...legacy } = snapshot;
    const {
      since: _since,
      places: _places,
      decisions: _decisions,
      ambient: _ambient,
      canWait: _canWait,
      verdict: _verdict,
      ...briefing
    } = snapshot.briefing;
    const { cards: _cards, counts: _counts, owed, ...restHorizon } = snapshot.briefing.horizon;
    const { itemIds: _owedItems, ...owedFacts } = owed ?? {};
    const horizon = { ...restHorizon, ...(owed ? { owed: owedFacts } : {}) };
    return {
      ...legacy,
      briefing: {
        ...briefing,
        horizon,
        focus: snapshot.briefing.focus.map(
          ({ attention: _a, due: _d, owned: _o, ...item }) => item,
        ),
        rest: snapshot.briefing.rest.map(({ attention: _a, due: _d, owned: _o, ...item }) => item),
        repositories: {
          ...snapshot.briefing.repositories,
          rows: snapshot.briefing.repositories.rows.map((row) => ({
            ...row,
            sections: row.sections.map((section) => ({
              ...section,
              lines: section.lines.map(({ id: _id, url: _url, ...line }) => line),
            })),
          })),
        },
      },
      stations: snapshot.stations.map(({ service, stations }) => ({
        service,
        stations: stations.map(({ inspect: _inspect, substate: _substate, ...station }) => station),
      })),
    };
  }

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
    const snapshot = projectWatch({ ...onlyInferred(AREAS), releaseRecords: [] });
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

  it.each(["fresh", "stale", "incomplete", "failed"] as const)(
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
        completeness:
          state === "incomplete"
            ? { kind: "cut", reason: "Template commit page limit", read: 100, total: 250 }
            : { kind: "complete" },
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

  it.each(["fresh", "stale", "incomplete", "failed"] as const)(
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
        completeness:
          state === "incomplete"
            ? { kind: "cut", reason: "Template commit page limit", read: 100, total: 250 }
            : { kind: "complete" },
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

function releaseRead(source: string, object: string, observedAt: string): ReadRecord {
  return { source, object, observedAt, completeness: { kind: "complete" } };
}

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

  it("judges each tree dot's records against their own area's sweep interval", () => {
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
    const at = (ms: number, intervals?: Partial<Record<AreaName, number>>) => {
      now = start + ms;
      const { tree } = projectWatch({
        ...input,
        context,
        intervalMs: 600_000,
        ...(intervals === undefined ? {} : { intervals }),
        reads: { runs: [read("runs")], github: [read("github")] },
      });
      return Object.fromEntries(
        tree
          .filter(({ id }) => ["runs", "repositories", "services"].includes(id))
          .map(({ id, status }) => [id, status]),
      );
    };
    const perArea = { runs: 60_000 };
    expect(at(0, perArea)).toEqual({ runs: "fresh", repositories: "fresh", services: "fresh" });
    expect(at(120_000, perArea)).toEqual({
      runs: "fresh",
      repositories: "fresh",
      services: "fresh",
    });
    expect(at(120_001, perArea)).toEqual({
      runs: "stale",
      repositories: "fresh",
      services: "stale",
    });
    expect(at(120_001)).toEqual({ runs: "fresh", repositories: "fresh", services: "fresh" });
    expect(at(1_200_000, perArea)).toMatchObject({ repositories: "fresh" });
    expect(at(1_200_001, perArea)).toMatchObject({ repositories: "stale" });
    expect(at(1_200_001)).toEqual({ runs: "stale", repositories: "stale", services: "stale" });
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
      reason: "SPI Code has no durable ops here",
      confirm: { subject: "legal #1", body: "Wait for a deployable stack" },
    };
    expect(appActions([offer])).toEqual([
      expect.objectContaining({
        label: "Re-run when deployable",
        disabledReason: "writes arrive at M4",
        eligibilityReason: "SPI Code has no durable ops here",
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
