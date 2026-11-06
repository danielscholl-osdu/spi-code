// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AREAS, resolvePointer } from "./evidence.js";
import { type ViewSnapshot, ViewSnapshotSchema } from "./snapshot.js";

const snapshot: ViewSnapshot = ViewSnapshotSchema.parse(
  JSON.parse(
    readFileSync(
      new URL("../../../../fixtures/watch/snapshot-59d6895.json", import.meta.url),
      "utf8",
    ),
  ),
);

function messages(value: unknown): string[] {
  const result = ViewSnapshotSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe("ViewSnapshot areas and provenance", () => {
  it("accepts the host-generated fixture with one envelope per area", () => {
    expect(snapshot.areas.map(({ area }) => area)).toEqual([...AREAS]);
    expect(snapshot.provenance.length).toBeGreaterThan(0);
  });

  it("rejects a missing area", () => {
    const areas = snapshot.areas.filter(({ area }) => area !== "auth");
    expect(messages({ ...snapshot, areas })).toContain("Area auth has no envelope");
  });

  it("rejects a duplicated area", () => {
    const areas = [...snapshot.areas, snapshot.areas[0]];
    expect(messages({ ...snapshot, areas })).toContain("Area fleet repeats");
  });

  it("rejects an envelope whose source is another area", () => {
    const areas = snapshot.areas.map((entry) =>
      entry.area === "runs" ? { ...entry, envelope: { source: "github", state: "unread" } } : entry,
    );
    expect(messages({ ...snapshot, areas })).toContain("Envelope source github is not area runs");
  });

  it("rejects a provenance path that does not resolve", () => {
    for (const path of ["/briefing/facts/99/figure", "/stations/01", "/briefing/nothing"]) {
      const provenance = [...snapshot.provenance, { path, areas: ["github"] }];
      expect(messages({ ...snapshot, provenance })).toContain(
        `Provenance path ${path} does not resolve`,
      );
    }
  });

  it("rejects a provenance area that has no envelope", () => {
    const areas = snapshot.areas.filter(({ area }) => area !== "radar");
    const provenance = [{ path: "/briefing/headline", areas: ["radar"] }];
    expect(messages({ ...snapshot, areas, provenance })).toContain(
      "Provenance names area radar with no envelope",
    );
  });

  it("carries a non-area collector envelope alongside a value's Facts areas", () => {
    const entry = {
      path: "/releases/lines/0",
      areas: ["fleet"],
      envelope: {
        source: "releases",
        state: "failed",
        observedAt: snapshot.sweptAt,
        completeness: { kind: "complete" },
        inferred: true,
      },
    };
    const withEnvelope = { ...snapshot, provenance: [entry] };
    expect(ViewSnapshotSchema.parse(withEnvelope)).toEqual(withEnvelope);
    for (const envelope of [
      { ...entry.envelope, extra: true },
      { ...entry.envelope, state: "fresh", observedAt: undefined },
      { ...entry.envelope, inferred: "yes" },
    ]) {
      expect(messages({ ...snapshot, provenance: [{ ...entry, envelope }] })).not.toEqual([]);
    }
  });

  it("rejects repeated paths, repeated areas, unknown areas and malformed pointers", () => {
    const at = (entry: unknown) => ({ ...snapshot, provenance: [entry] });
    const valid = { path: "/briefing/headline", areas: ["github"] };
    expect(messages({ ...snapshot, provenance: [valid, valid] })).toContain(
      "Provenance repeats /briefing/headline",
    );
    expect(messages(at({ ...valid, areas: ["github", "github"] }))).toContain("Areas repeat");
    expect(messages(at({ ...valid, areas: [] }))).not.toEqual([]);
    expect(messages(at({ ...valid, areas: ["releases"] }))).not.toEqual([]);
    for (const path of ["", "briefing", "/briefing/~2"]) {
      expect(messages(at({ ...valid, path }))).not.toEqual([]);
    }
  });
});

describe("window reading contract", () => {
  const populated = structuredClone(snapshot);
  const item = populated.briefing.focus[0];
  if (!item) throw new Error("Fixture needs a focus item");
  item.due = { at: snapshot.sweptAt, before: "next sync" };
  populated.campaigns = [
    { id: "boot", kind: "toolchain", fact: "Boot 4", forks: ["legal", "file"] },
  ];
  populated.readings = [
    {
      anchor: { kind: "upstream" },
      content: {
        headline: "Two forks carry Boot 4",
        qualifier: "The radar read was cut",
        tiles: [
          { label: "Incoming", value: "2", counts: "forks" },
          { label: "Toolchain", value: "1", counts: "moves" },
          { label: "Largest", value: "3", counts: "commits" },
        ],
        items: [{ ...item, group: "Before the next sync" }],
        folded: "One more item",
      },
    },
  ];
  const fields: [string, unknown][] = [
    ["/stations/0/stations/0/substate", "unknown"],
    ["/briefing/focus/0/attention", "loud"],
    ["/briefing/focus/0/owned", "false"],
    ["/briefing/focus/0/due/at", "tomorrow"],
    ["/briefing/focus/0/due/before", 1],
    ["/campaigns", {}],
    ["/campaigns/0/id", 1],
    ["/campaigns/0/kind", "other"],
    ["/campaigns/0/fact", 1],
    ["/campaigns/0/forks", "legal"],
    ["/readings", {}],
    ["/readings/0/anchor", { kind: "elsewhere" }],
    ["/readings/0/content", {}],
    ["/readings/0/content/headline", 1],
    ["/readings/0/content/tiles", []],
    ["/readings/0/content/tiles/0/label", 1],
    ["/readings/0/content/tiles/0/value", 1],
    ["/readings/0/content/tiles/0/counts", 1],
    ["/readings/0/content/items", {}],
    ["/readings/0/content/items/0/id", 1],
    ["/readings/0/content/items/0/group", 1],
    ["/readings/0/content/items/0/attention", "loud"],
    ["/readings/0/content/items/0/owned", 1],
    ["/readings/0/content/folded", 1],
    ["/seen", 1],
    ["/seen/cursor", -1],
  ];
  it("accepts computed content and absent optional due times and qualifiers", () => {
    expect(ViewSnapshotSchema.parse(populated)).toEqual(populated);
    expect(ViewSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    const withoutQualifier = structuredClone(populated);
    if (withoutQualifier.readings[0]?.content)
      delete withoutQualifier.readings[0].content.qualifier;
    expect(ViewSnapshotSchema.parse(withoutQualifier)).toEqual(withoutQualifier);
  });
  it.each(fields)("rejects missing and mistyped %s", (path, invalid) => {
    for (const value of [undefined, invalid]) {
      const bad = structuredClone(populated);
      const offset = path.lastIndexOf("/");
      const parent = resolvePointer(bad, path.slice(0, offset));
      if (!parent.found || typeof parent.value !== "object" || parent.value === null)
        throw new Error(`Missing mutation parent: ${path}`);
      const key = path.slice(offset + 1);
      if (value === undefined) Reflect.deleteProperty(parent.value, key);
      else Reflect.set(parent.value, key, value);
      expect(ViewSnapshotSchema.safeParse(bad).success).toBe(false);
    }
  });
  it("rejects malformed optional fields, extra keys, excess items and non-three tile counts", () => {
    const reading = populated.readings[0];
    if (!reading?.content) throw new Error("Missing populated reading");
    const content = reading.content;
    for (const bad of [
      { ...populated, briefing: { ...populated.briefing, focus: [{ ...item, due: null }] } },
      ...[
        { ...content, qualifier: 1 },
        { ...content, extra: true },
        { ...content, tiles: content.tiles.slice(1) },
        { ...content, tiles: [...content.tiles, content.tiles[0]] },
        { ...content, items: Array(6).fill(content.items[0]) },
      ].map((content) => ({ ...populated, readings: [{ ...reading, content }] })),
    ])
      expect(ViewSnapshotSchema.safeParse(bad).success).toBe(false);
  });
});

describe("resolvePointer", () => {
  it("follows RFC 6901 escapes and canonical array indices", () => {
    const document = { "a/b": { "m~n": [10, 20] } };
    expect(resolvePointer(document, "/a~1b/m~0n/1")).toEqual({ found: true, value: 20 });
    expect(resolvePointer(document, "/a~1b/m~0n/2").found).toBe(false);
    expect(resolvePointer(document, "/a~1b/m~0n/-").found).toBe(false);
    expect(resolvePointer(document, "/a~1b/m~0n/01").found).toBe(false);
    expect(resolvePointer({}, "/toString").found).toBe(false);
  });
});
