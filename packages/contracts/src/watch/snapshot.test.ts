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
