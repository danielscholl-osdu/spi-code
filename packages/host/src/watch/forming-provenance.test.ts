// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { AreaName, Envelope, ViewSnapshot } from "@spi-code/contracts";
import { describe, expect, it } from "vitest";
import { projectWatch } from "./project.js";
import { busyInput } from "./snapshot-fixture.js";

const formingPath = "/releases/forming";

function sourcesAt(snapshot: ViewSnapshot, prefix: string): Envelope[] {
  const contains = (parent: string, child: string) =>
    child === parent || child.startsWith(`${parent}/`);
  const bindings = snapshot.provenance.filter(
    ({ path }) => contains(prefix, path) || contains(path, prefix),
  );
  const areas = new Set(bindings.flatMap(({ areas }) => areas));
  return [
    ...snapshot.areas.filter(({ area }) => areas.has(area)).map(({ envelope }) => envelope),
    ...bindings.flatMap(({ envelope }) => (envelope ? [envelope] : [])),
  ];
}

describe("forming release provenance", () => {
  it.each<AreaName>(["github", "fleet"])(
    "qualifies retained changes when only the %s read fails",
    (area) => {
      const input = { ...busyInput() };
      input.reads = {
        ...input.reads,
        [area]: (input.reads[area] ?? []).map((read) => ({ ...read, failure: "read failed" })),
      };
      const snapshot = projectWatch(input);
      expect(snapshot.releases.forming?.state).toBe("read");
      expect(snapshot.provenance.find(({ path }) => path === formingPath)).toMatchObject({
        areas: ["fleet", "github"],
        envelope: { source: "releases", state: "fresh" },
      });
      expect(sourcesAt(snapshot, formingPath).map(({ source, state }) => [source, state])).toEqual([
        ["fleet", area === "fleet" ? "failed" : "fresh"],
        ["github", area === "github" ? "failed" : "fresh"],
        ["releases", "fresh"],
      ]);
    },
  );

  it("keeps an unread GitHub inventory visible beside successfully read bodies", () => {
    const input = { ...busyInput() };
    input.reads = { ...input.reads, github: [] };
    const snapshot = projectWatch(input);
    expect(sourcesAt(snapshot, formingPath)).toContainEqual({ source: "github", state: "unread" });
    expect(
      sourcesAt(snapshot, formingPath).find(({ source }) => source === "releases")?.state,
    ).toBe("fresh");
  });

  it("qualifies a cut GitHub inventory even when every retained body is read", () => {
    const input = { ...busyInput() };
    input.reads = {
      ...input.reads,
      github: (input.reads.github ?? []).map((read) => ({
        ...read,
        completeness: { kind: "cut", reason: "page limit", read: 1, total: 2 },
      })),
    };
    const snapshot = projectWatch(input);
    expect(sourcesAt(snapshot, formingPath)).toContainEqual(
      expect.objectContaining({ source: "github", state: "incomplete" }),
    );
  });

  it("preserves the release reader's failed envelope alongside both areas", () => {
    const input = { ...busyInput() };
    input.releaseRecords = input.releaseRecords.map((read) => ({
      ...read,
      failure: "read failed",
    }));
    const snapshot = projectWatch(input);
    expect(sourcesAt(snapshot, formingPath).map(({ source, state }) => [source, state])).toEqual([
      ["fleet", "fresh"],
      ["github", "fresh"],
      ["releases", "failed"],
    ]);
  });

  it("keeps the Releases and ledger caveats unchanged by forming's GitHub dependency", () => {
    const input = { ...busyInput() };
    input.reads = {
      ...input.reads,
      github: (input.reads.github ?? []).map((read) => ({ ...read, failure: "read failed" })),
    };
    const snapshot = projectWatch(input);
    const legacy = {
      ...snapshot,
      provenance: snapshot.provenance.map((binding) =>
        binding.path === formingPath ? { ...binding, areas: ["fleet" as const] } : binding,
      ),
    };
    expect(snapshot.provenance.find(({ path }) => path === formingPath)?.areas).toEqual([
      "fleet",
      "github",
    ]);
    for (const prefix of ["/releases", "/releases/lines"]) {
      expect(sourcesAt(snapshot, prefix), prefix).toEqual(sourcesAt(legacy, prefix));
    }
    expect(sourcesAt(snapshot, "/releases/lines").every(({ state }) => state === "fresh")).toBe(
      true,
    );
    expect(sourcesAt(snapshot, "/releases/lines").map(({ source }) => source)).not.toContain(
      "github",
    );
  });
});
