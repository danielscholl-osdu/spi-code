// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { PlaceId, ViewSnapshot } from "@spi-code/contracts";
import { buildModel, placesOf, programReading } from "@spi-code/core";
import { describe, expect, it } from "vitest";
import { projectWatch, type WatchInput } from "./project.js";
import {
  badInput,
  busyInput,
  calmInput,
  recordedInput,
  unreadForksInput,
} from "./snapshot-fixture.js";

const sourceOf = (input: WatchInput) => ({
  model: buildModel(input.facts, input.context.clock.now(), {}, input.context),
  facts: input.facts,
  reads: input.reads,
});
const readingOf = (snapshot: ViewSnapshot, place: PlaceId) =>
  snapshot.readings.find(({ anchor }) => anchor.kind === (place === "line" ? "program" : place))
    ?.content;

describe("Today place rows (PS-03, PS-19)", () => {
  for (const [name, fixture] of [
    ["snapshot-1106", recordedInput],
    ["bad", badInput],
  ] as const) {
    it(`${name}: figures use the same count as each place reading`, () => {
      const snapshot = projectWatch(fixture());
      expect(snapshot.briefing.places?.map(({ place }) => place)).toEqual([
        "line",
        "environment",
        "engineering",
        "security",
      ]);
      for (const row of snapshot.briefing.places ?? []) {
        const reading = readingOf(snapshot, row.place);
        expect(reading).toBeTruthy();
        expect(row.figure.startsWith(reading?.tiles[0].value ?? "missing")).toBe(true);
        expect(row.fresh).toEqual({ itemIds: [] });
        expect(row.visual).toBeDefined();
        const refs = new Set(reading?.itemIds);
        for (const id of row.itemIds) {
          const source = [...snapshot.briefing.focus, ...snapshot.briefing.rest].find(
            (item) => item.id === id,
          );
          expect(source && (refs.has(source.id) || source.ids.some((ref) => refs.has(ref)))).toBe(
            true,
          );
        }
      }
    });
  }

  it("names the same stopped stations and failed lanes as the Line sheet", () => {
    const snapshot = projectWatch(recordedInput());
    const row = snapshot.briefing.places?.find(({ place }) => place === "line");
    const stopped = snapshot.stations.filter((line) =>
      line.stations.some((station) => station.substate === "stopped"),
    );
    expect(row?.figure).toMatch(
      new RegExp(`^(?:At least )?${stopped.length} of ${snapshot.stations.length} stopped$`),
    );
    for (const line of snapshot.stations) {
      const stations = line.stations.filter(
        (station) => station.id !== "lane" && station.substate === "stopped",
      );
      if (stations.length)
        expect(row?.line).toContain(`${line.service} (${stations.map(({ id }) => id).join(", ")})`);
      if (
        line.stations.some((station) => station.id === "lane" && station.substate === "stopped")
      ) {
        expect(row?.line.split("Failed lanes: ")[1]).toContain(line.service);
      }
    }
  });

  it("names failed fork lanes on Line while Environment keeps its deployability verdict", () => {
    const input = busyInput();
    const repo = input.context.fleet.forks.find(({ id }) => id === "storage")?.repo;
    const facts = repo ? input.facts.github.data?.repos[repo] : undefined;
    if (!facts) throw new Error("Fixture lacks storage");
    facts.deployments = [{ createdAt: "2026-11-06T13:00:00Z", state: "FAILURE" }];
    const snapshot = projectWatch(input);
    const line = snapshot.briefing.places?.find(({ place }) => place === "line");
    expect(line?.line).toContain("Failed lanes: storage.");
    expect(line?.line.split("Failed lanes:")[0]).not.toMatch(/\blane\b/);
    expect(
      snapshot.stations
        .find(({ service }) => service === "storage")
        ?.stations.find(({ id }) => id === "lane")?.substate,
    ).toBe("stopped");
    const environment = snapshot.briefing.places?.find(({ place }) => place === "environment");
    expect(environment).toMatchObject({ mark: "nothing-due", tone: "neutral" });
    expect(environment?.figure).toContain("deployable");
    expect(environment?.line).not.toContain("lane");
    expect(environment?.itemIds).not.toContain("lane-deploy:storage");
    expect(line?.itemIds).toContain("lane-deploy:storage");
  });

  it("gives Line's reason as its failed lanes, and as stopped stations only when no lane failed", () => {
    const quiet = projectWatch(busyInput());
    expect(readingOf(quiet, "line")?.tiles[1]).toMatchObject({ label: "Lanes", value: "0" });
    expect(quiet.briefing.places?.find(({ place }) => place === "line")).toMatchObject({
      mark: "stopped",
      reason: "stations: sync, main",
    });
    const input = busyInput();
    for (const id of ["indexer", "storage"]) {
      const repo = input.context.fleet.forks.find((fork) => fork.id === id)?.repo;
      const facts = repo ? input.facts.github.data?.repos[repo] : undefined;
      if (!facts) throw new Error(`Fixture lacks ${id}`);
      facts.deployments = [{ createdAt: "2026-11-06T13:00:00Z", state: "FAILURE" }];
    }
    const snapshot = projectWatch(input);
    expect(readingOf(snapshot, "line")?.tiles[1]).toMatchObject({ label: "Lanes", value: "2" });
    expect(snapshot.briefing.places?.find(({ place }) => place === "line")).toMatchObject({
      mark: "stopped",
      reason: "lanes: storage, indexer",
    });
  });

  it("leads with the fork work owed when a calm Line has a Surface item", () => {
    const input = calmInput();
    const repoName = input.context.fleet.forks.find(({ id }) => id === "schema")?.repo;
    const repo = repoName ? input.facts.github.data?.repos[repoName] : undefined;
    if (!repo) throw new Error("Fixture lacks schema");
    repo.issues.push({
      repo: repo.repo,
      number: 700,
      title: "Label Configuration Update Required",
      url: `${repo.url}/issues/700`,
      createdAt: "2026-11-06T14:00:00Z",
      updatedAt: "2026-11-06T14:00:00Z",
      labels: [],
      comments: 0,
    });
    const snapshot = projectWatch(input);
    const line = snapshot.briefing.places?.find(({ place }) => place === "line");
    expect(line).toMatchObject({
      mark: "needs-person",
      reason: "1 needs you",
      line: "Waiting on you: schema.",
    });
    expect(readingOf(snapshot, "line")?.headline).toBe(line?.line);
  });

  it("names an owed lane re-run even after its stations have recovered", () => {
    const input = calmInput();
    const snapshot = projectWatch(input);
    const source = [...snapshot.briefing.focus, ...snapshot.briefing.rest][0];
    if (!source) throw new Error("Fixture lacks items");
    const item = {
      ...source,
      id: "stack:lanes",
      ids: ["stack:lanes"],
      attention: "surface" as const,
    };
    const reading = programReading({
      model: buildModel(input.facts, input.context.clock.now(), {}, input.context),
      facts: input.facts,
      items: [item],
      reads: input.reads,
    });
    const row = placesOf({
      readings: [{ anchor: { kind: "program" }, content: reading }],
      areas: snapshot.areas,
      items: [item],
      source: sourceOf(input),
    })[0];
    expect(row).toMatchObject({
      mark: "needs-person",
      reason: "lane re-run owed",
      line: "A fork lane re-run is owed.",
    });
    expect(reading.headline).toBe(row?.line);
  });

  for (const area of [
    "github",
    "runs",
    "approvals",
    "lifecycle",
    "details",
    "upstream",
    "radar",
    "template",
  ] as const) {
    it(`qualifies the Line count when ${area} is unread`, () => {
      const input = busyInput();
      input.facts[area] = {};
      const snapshot = projectWatch({ ...input, reads: { ...input.reads, [area]: [] } });
      const row = snapshot.briefing.places?.find(({ place }) => place === "line");
      if (area === "github") expect(row?.figure).toBe("not read yet");
      else {
        expect(row?.figure).toMatch(/^At least \d+ of 13 stopped$/);
        expect(readingOf(snapshot, "line")?.tiles[0].value).toMatch(/^At least /);
      }
    });
  }

  for (const state of ["unread", "failed", "incomplete"] as const) {
    it(`qualifies retained Line facts when runs provenance is ${state}`, () => {
      const input = busyInput();
      const record = input.reads.runs?.[0];
      if (!record) throw new Error("Fixture lacks runs provenance");
      const runs =
        state === "unread"
          ? []
          : [
              {
                ...record,
                ...(state === "failed"
                  ? { failure: "Read failed" }
                  : {
                      completeness: {
                        kind: "cut" as const,
                        reason: "Read limit",
                        read: 1,
                        total: 2,
                      },
                    }),
              },
            ];
      const snapshot = projectWatch({ ...input, envelopeReads: { ...input.reads, runs } });
      expect(snapshot.briefing.places?.find(({ place }) => place === "line")?.figure).toMatch(
        /^At least \d+ of 13 stopped$/,
      );
    });
  }

  it("uses the strip's area labels in fallback caveats", () => {
    const input = calmInput();
    const snapshot = projectWatch(input);
    const row = placesOf({
      readings: snapshot.readings,
      items: [],
      source: sourceOf(input),
      areas: snapshot.areas.filter(({ area }) => area !== "approvals" && area !== "radar"),
    })[0];
    expect(row?.caveat).toBe(
      "Run approvals, Upstream radar not fully read; the figure covers only the evidence read.",
    );
  });

  it("counts Engineering over the whole fleet, including unread forks", () => {
    const snapshot = projectWatch(unreadForksInput());
    const row = snapshot.briefing.places?.find(({ place }) => place === "engineering");
    expect(snapshot.briefing.places?.find(({ place }) => place === "line")?.figure).toMatch(
      /^At least \d+ of 13 stopped$/,
    );
    expect(row?.figure).toContain("0 of 13");
    expect(row?.figure).toContain("5 not read yet");
    expect(readingOf(snapshot, "engineering")?.verifiedTemplate).toMatchObject({
      total: 13,
      unread: 5,
    });
  });

  it("keeps Security warn ink and none blocking today at a calm tier", () => {
    const input = busyInput();
    const snapshot = projectWatch(input);
    const row = placesOf({
      readings: snapshot.readings,
      areas: snapshot.areas,
      items: [...snapshot.briefing.focus, ...snapshot.briefing.rest].map((item) => ({
        ...item,
        attention: "background" as const,
      })),
      source: sourceOf(input),
    }).find(({ place }) => place === "security");
    expect(row).toMatchObject({ mark: "nothing-due", tone: "warn" });
    expect(row?.line).toContain("none blocking today");
    expect(Number(readingOf(snapshot, "security")?.tiles[0].value)).toBeGreaterThan(0);
  });

  it("reports unread GitHub only on the three rows that read it", () => {
    const snapshot = projectWatch(badInput());
    for (const row of snapshot.briefing.places ?? []) {
      if (row.place === "security") expect(row.unread).toBeUndefined();
      else {
        expect(row.unread).toEqual({ areas: ["github"], lastGood: "2026-11-06T13:52:00Z" });
        expect(row.mark).not.toBe("nothing-due");
        expect(row.caveat).toBeTruthy();
      }
    }
  });

  it("fails safely with no reads and never gives an unread row a calm mark", () => {
    const input = calmInput();
    const snapshot = projectWatch({ ...input, reads: {} });
    for (const row of snapshot.briefing.places ?? []) {
      expect(row.mark).not.toBe("nothing-due");
      expect(row.unread?.areas).toEqual(row.areas);
      expect(row.unread?.lastGood).toBeUndefined();
    }
  });

  it("uses the oldest last good time and omits it when any unread area has none", () => {
    const input = badInput();
    const snapshot = projectWatch(input);
    const areas = snapshot.areas.map((entry) =>
      entry.area === "template"
        ? {
            area: entry.area,
            envelope: {
              source: "template",
              state: "failed" as const,
              completeness: { kind: "complete" as const },
              observedAt: "2026-11-06T12:00:00Z",
            },
          }
        : entry,
    );
    const project = () =>
      placesOf({
        readings: snapshot.readings,
        items: [...snapshot.briefing.focus, ...snapshot.briefing.rest],
        areas,
        source: sourceOf(input),
      });
    expect(project().find(({ place }) => place === "engineering")?.unread).toEqual({
      areas: ["github", "template"],
      lastGood: "2026-11-06T12:00:00Z",
    });
    areas.splice(
      areas.findIndex(({ area }) => area === "template"),
      1,
      {
        area: "template",
        envelope: { source: "template", state: "unread" },
      },
    );
    expect(
      project().find(({ place }) => place === "engineering")?.unread?.lastGood,
    ).toBeUndefined();
  });

  it("keeps the mark of an Interrupt folded past the reading's five-item cap", () => {
    const input = busyInput();
    const snapshot = projectWatch(input);
    const reading = readingOf(snapshot, "line");
    const refs = new Set(reading?.itemIds);
    const visible = new Set(reading?.items.map(({ id }) => id));
    const items = [...snapshot.briefing.focus, ...snapshot.briefing.rest];
    const folded = items.find((item) => !visible.has(item.id) && refs.has(item.id));
    expect(folded).toBeDefined();
    const rows = placesOf({
      readings: snapshot.readings.map((entry) =>
        entry.anchor.kind === "program" && entry.content
          ? {
              ...entry,
              content: {
                ...entry.content,
                tiles: [
                  { ...entry.content.tiles[0], value: "0 of 13" },
                  entry.content.tiles[1],
                  entry.content.tiles[2],
                ],
              },
            }
          : entry,
      ),
      areas: snapshot.areas,
      items: items.map((item) => ({
        ...item,
        attention: item.id === folded?.id ? ("interrupt" as const) : ("background" as const),
      })),
      source: sourceOf(input),
    });
    expect(rows[0]).toMatchObject({ mark: "stopped", tone: "bad" });
    expect(rows[0]?.itemIds).toContain(folded?.id);
  });

  it("keeps full membership on overlapping places without changing tiers", () => {
    const input = recordedInput();
    const snapshot = projectWatch(input);
    const items = [...snapshot.briefing.focus, ...snapshot.briefing.rest];
    for (const row of snapshot.briefing.places ?? []) {
      const reading = readingOf(snapshot, row.place);
      const refs = new Set(reading?.itemIds);
      const expected = items.filter(
        (item) =>
          (refs.has(item.id) || item.ids.some((id) => refs.has(id))) &&
          !(
            row.place === "environment" &&
            (item.id === "stack:lanes" || item.id.startsWith("lane-deploy:"))
          ),
      );
      expect(row.itemIds).toEqual(expected.map((item) => item.id));
      for (const item of reading?.items ?? []) {
        const source = items.find(({ id }) => id === item.id);
        if (source) expect(item.attention).toBe(source.attention);
      }
    }
    const shared = snapshot.briefing.places?.find(({ place }) => place === "engineering")
      ?.itemIds[0];
    if (!shared) throw new Error("Recorded fixture lacks Engineering work");
    const rows = placesOf({
      readings: snapshot.readings.map((entry) =>
        entry.anchor.kind === "program" && entry.content
          ? {
              ...entry,
              content: { ...entry.content, itemIds: [...(entry.content.itemIds ?? []), shared] },
            }
          : entry,
      ),
      areas: snapshot.areas,
      items,
      source: sourceOf(input),
    });
    expect(rows.find(({ place }) => place === "line")?.itemIds).toContain(shared);
    expect(rows.find(({ place }) => place === "engineering")?.itemIds).toContain(shared);
  });
});

describe("Today place cards speak compactly (draft 7, Words and visuals)", () => {
  const reasons = {
    calm: { engineering: "verification pending" },
    busy: {
      line: "stations: sync, main",
      engineering: "verification pending",
      security: "1 needs you",
    },
    bad: {
      line: "stations: sync, main",
      environment: "Place reading is incomplete.",
      engineering: "verification pending",
      security: "1 needs you",
    },
  } as const;
  for (const [name, fixture] of [
    ["calm", calmInput],
    ["busy", busyInput],
    ["bad", badInput],
  ] as const) {
    it(`${name}: figures and reasons are compact and the full sentence stays the line`, () => {
      const snapshot = projectWatch(fixture());
      const rows = snapshot.briefing.places ?? [];
      expect(
        Object.fromEntries(rows.flatMap(({ place, reason }) => (reason ? [[place, reason]] : []))),
      ).toEqual(reasons[name]);
      for (const row of rows) {
        const reading = readingOf(snapshot, row.place);
        if (row.reason === "Place reading is incomplete.") expect(row.line).toBe(row.reason);
        else if (row.place === "security" && row.mark === "nothing-due")
          expect(row.line).toBe("In SPI-owned shipped code, none blocking today.");
        else {
          expect(row.line).toBe(reading?.headline);
          if (row.reason) expect(row.line).not.toContain(row.reason);
        }
      }
      const environment = rows.find(({ place }) => place === "environment");
      expect(environment?.figure).toBe(
        `${readingOf(snapshot, "environment")?.tiles[0].value} deployable`,
      );
      const security = rows.find(({ place }) => place === "security");
      const high = readingOf(snapshot, "security")?.tiles[0].value ?? "missing";
      expect(security?.figure).toBe(`${high} high or critical`);
      expect(security?.reason ?? "").not.toMatch(new RegExp(`\\b${high}\\b`));
      const line = rows.find(({ place }) => place === "line");
      const stopped = line?.visual?.kind === "pips" ? line.visual.stopped : [];
      if (name !== "calm") expect(stopped.length).toBeGreaterThan(0);
      for (const fork of stopped) expect(line?.reason ?? "").not.toContain(fork);
    });
  }

  it("builds the compact fields from core state, never from a reading's sentence", () => {
    const input = busyInput();
    const snapshot = projectWatch(input);
    const base = {
      items: [...snapshot.briefing.focus, ...snapshot.briefing.rest],
      areas: snapshot.areas,
      source: sourceOf(input),
    };
    const compact = (rows: ReturnType<typeof placesOf>) =>
      rows.map(({ place, figure, reason }) => ({ place, figure, reason }));
    const told = placesOf({ ...base, readings: snapshot.readings });
    const reworded = placesOf({
      ...base,
      readings: snapshot.readings.map((entry) =>
        entry.content ? { ...entry, content: { ...entry.content, headline: "Reworded." } } : entry,
      ),
    });
    expect(compact(reworded)).toEqual(compact(told));
    expect(reworded.map(({ line }) => line)).toEqual([
      "Reworded.",
      "Reworded.",
      "Reworded.",
      "Reworded.",
    ]);
  });

  for (const place of ["line", "environment", "engineering", "security"] as const) {
    it(`keeps ${place} at not read yet when its areas are unread or its reading is missing`, () => {
      const input = busyInput();
      const snapshot = projectWatch(input);
      const areas = snapshot.briefing.places?.find((row) => row.place === place)?.areas ?? [];
      expect(areas.length).toBeGreaterThan(0);
      const items = [...snapshot.briefing.focus, ...snapshot.briefing.rest];
      const kind = place === "line" ? "program" : place;
      const unread = placesOf({
        readings: snapshot.readings,
        items,
        areas: snapshot.areas.map((entry) =>
          areas.includes(entry.area)
            ? { area: entry.area, envelope: { source: entry.area, state: "unread" as const } }
            : entry,
        ),
        source: sourceOf(input),
      });
      const missing = placesOf({
        readings: snapshot.readings.filter(({ anchor }) => anchor.kind !== kind),
        items,
        areas: snapshot.areas,
        source: sourceOf(input),
      });
      for (const rows of [unread, missing]) {
        const row = rows.find((entry) => entry.place === place);
        expect(row).toMatchObject({
          figure: "not read yet",
          reason: "Place reading is incomplete.",
        });
        expect(row?.mark).not.toBe("nothing-due");
      }
    });
  }
});
