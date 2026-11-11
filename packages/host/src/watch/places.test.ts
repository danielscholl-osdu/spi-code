// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { PlaceId, ViewSnapshot } from "@spi-code/contracts";
import { buildModel, placesOf, programReading } from "@spi-code/core";
import { describe, expect, it } from "vitest";
import { projectWatch } from "./project.js";
import {
  badInput,
  busyInput,
  calmInput,
  recordedInput,
  unreadForksInput,
} from "./snapshot-fixture.js";

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
        if (row.place === "environment")
          expect(row.figure).toBe(reading?.headline.replace(/\.$/, ""));
        else expect(row.figure.startsWith(reading?.tiles[0].value ?? "missing")).toBe(true);
        expect(row.fresh).toEqual({ itemIds: [] });
        expect(row.visual).toBeUndefined();
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
    expect(line).toMatchObject({ mark: "needs-person", reason: "Waiting on you: schema." });
    expect(readingOf(snapshot, "line")?.headline).toBe(line?.reason);
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
    })[0];
    expect(row).toMatchObject({ mark: "needs-person", reason: "A fork lane re-run is owed." });
    expect(reading.headline).toBe(row?.reason);
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
    const snapshot = projectWatch(calmInput());
    const row = placesOf({
      readings: snapshot.readings,
      items: [],
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
    const snapshot = projectWatch(badInput());
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
    const snapshot = projectWatch(busyInput());
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
    });
    expect(rows[0]).toMatchObject({ mark: "stopped", tone: "bad" });
    expect(rows[0]?.itemIds).toContain(folded?.id);
  });

  it("keeps full membership on overlapping places without changing tiers", () => {
    const snapshot = projectWatch(recordedInput());
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
    });
    expect(rows.find(({ place }) => place === "line")?.itemIds).toContain(shared);
    expect(rows.find(({ place }) => place === "engineering")?.itemIds).toContain(shared);
  });
});
