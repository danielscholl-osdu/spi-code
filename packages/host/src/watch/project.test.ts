// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { ViewSnapshotSchema } from "@spi-code/contracts";
import { buildBriefing, buildModel, detectCampaigns } from "@spi-code/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as attention from "./attention.js";
import { projectWatch, type WatchInput } from "./project.js";
import { readingFor } from "./readings.js";
import * as seen from "./seen.js";
import {
  fixtureInput,
  mixedFixtureInput,
  mixedSnapshotPath,
  oracle,
  recordedInput,
  recordedSnapshotPath,
  snapshotPath,
} from "./snapshot-fixture.js";

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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Watch projection", () => {
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
      focus: legacy.briefing.focus.map(({ origin: _o, age: _a, blocks: _b, ...item }) => item),
      rest: legacy.briefing.rest.map(({ origin: _o, age: _a, blocks: _b, ...item }) => item),
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

  it("reads the clock once for the projection, then per item and per reading, in that order", () => {
    const input = recordedInput();
    const start = input.context.clock.now().getTime();
    const reads: string[] = [];
    let reader: string | undefined;
    const within =
      <A extends unknown[], R>(label: (...args: A) => string, fn: (...args: A) => R) =>
      (...args: A): R => {
        reader = label(...args);
        try {
          return fn(...args);
        } finally {
          reader = undefined;
        }
      };
    const realAttention = attention.itemAttention;
    vi.spyOn(attention, "itemAttention").mockImplementation(
      within((item) => `item ${item.id}`, realAttention),
    );
    for (const kind of ["environment", "service"] as const) {
      const real = readingFor[kind];
      vi.spyOn(readingFor, kind).mockImplementation(
        within((anchor) => (anchor.kind === "service" ? `service ${anchor.id}` : kind), real),
      );
    }
    const now = () => {
      const caller = /^\s*at (\S+)/.exec(new Error().stack?.split("\n")[2] ?? "")?.[1];
      reads.push(`+${reads.length}s ${reader ?? caller}`);
      return new Date(start + 1000 * (reads.length - 1));
    };
    const snapshot = projectWatch({ ...input, context: { ...input.context, clock: { now } } });
    expect(snapshot).toEqual(JSON.parse(readFileSync(recordedSnapshotPath, "utf8")));
    expect(reads).toEqual([
      "+0s projectWatch",
      "+1s item conflict:entitlements:121",
      "+2s item rollout",
      "+3s item release-red:Azure/osdu-spi-entitlements#89",
      "+4s item radar:indexer",
      "+5s item radar:legal",
      "+6s item radar:schema",
      "+7s item radar:storage",
      "+8s item radar:partition",
      "+9s item radar:unit",
      "+10s item radar:workflow",
      "+11s item radar:search",
      "+12s item radar:file",
      "+13s item radar:crs-conversion",
      "+14s item gate1:indexer",
      "+15s item gate1:storage",
      "+16s item gate1:indexer-queue",
      "+17s item port:entitlements",
      "+18s environment",
      "+19s service partition",
      "+20s service entitlements",
      "+21s service legal",
      "+22s service schema",
      "+23s service file",
      "+24s service storage",
      "+25s service indexer",
      "+26s service search",
      "+27s service workflow",
      "+28s service indexer-queue",
      "+29s service unit",
      "+30s service crs-catalog",
      "+31s service crs-conversion",
    ]);
  });
});
