// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { PlaceId, ViewSnapshot } from "@spi-code/contracts";
import { placesOf } from "@spi-code/core";
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
    expect(row?.figure).toBe(`${stopped.length} of ${snapshot.stations.length} stopped`);
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
    expect(
      snapshot.stations
        .find(({ service }) => service === "storage")
        ?.stations.find(({ id }) => id === "lane")?.substate,
    ).toBe("stopped");
    const environment = snapshot.briefing.places?.find(({ place }) => place === "environment");
    expect(environment?.figure).toContain("deployable");
    expect(environment?.line).not.toContain("lane");
    expect(environment?.itemIds).not.toContain("lane-deploy:storage");
    expect(line?.itemIds).toContain("lane-deploy:storage");
  });

  it("counts Engineering over the whole fleet, including unread forks", () => {
    const snapshot = projectWatch(unreadForksInput());
    const row = snapshot.briefing.places?.find(({ place }) => place === "engineering");
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
      readings: snapshot.readings,
      areas: snapshot.areas,
      items: items.map((item) => ({
        ...item,
        attention: item.id === folded?.id ? ("interrupt" as const) : ("background" as const),
      })),
    });
    expect(rows[0]?.mark).toBe("stopped");
    expect(rows[0]?.itemIds).toContain(folded?.id);
  });

  it("gives Background items one home without changing their tiers", () => {
    const snapshot = projectWatch(calmInput());
    const items = [...snapshot.briefing.focus, ...snapshot.briefing.rest];
    const ids = snapshot.briefing.places?.flatMap((row) => row.itemIds) ?? [];
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of snapshot.briefing.places ?? []) {
      const reading = readingOf(snapshot, row.place);
      for (const item of reading?.items ?? []) {
        const source = items.find(({ id }) => id === item.id);
        if (source) expect(item.attention).toBe(source.attention);
      }
    }
  });
});
