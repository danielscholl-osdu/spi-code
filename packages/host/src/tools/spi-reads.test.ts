// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import type { InspectResult, ViewSnapshot } from "@spi-code/contracts";
import { describe, expect, it } from "vitest";
import { detailFeedPath, recordedSnapshotPath } from "../../test/watch/snapshot-fixture.js";
import { FakeSession } from "../testing/fake-session.js";
import type { ModelRedactor } from "../threads/context/seams.js";
import type { SavedSweep } from "../threads/context/sweep.js";
import { estimateTokens } from "../threads/context/tokens.js";
import { buildPermissionGate } from "./permission-gate.js";
import { SPI_RESULT_TOKEN_BUDGET, spiReadTools, spiToolProvider } from "./spi-reads.js";

const view: ViewSnapshot = JSON.parse(readFileSync(recordedSnapshotPath, "utf8"));
const feed: InspectResult[] = JSON.parse(readFileSync(detailFeedPath, "utf8"));
const plain: ModelRedactor = { text: (text) => text, value: (value) => value };
const saved = (snapshot: ViewSnapshot = view): SavedSweep => ({
  view: snapshot,
  inspect: async (id) => {
    const result = feed.find((entry) => entry.id === id);
    return result && { kind: "queue item", result };
  },
});

function session(sweep: SavedSweep | undefined, redactor = plain) {
  const tools = spiToolProvider(spiReadTools(() => sweep, redactor)).offer();
  return new FakeSession({
    tools,
    availableTools: tools.map(({ name }) => `custom:${name}`),
    onPermissionRequest: buildPermissionGate(),
  });
}
async function call(name: string, args: object = {}, ...sweep: [SavedSweep | undefined] | []) {
  const output = await session(sweep.length ? sweep[0] : saved()).callTool(name, args);
  if (typeof output !== "string") throw new Error(`${name} answered ${typeof output}`);
  return JSON.parse(output);
}

const reading = (kind: string) => view.readings.find(({ anchor }) => anchor.kind === kind)?.content;
const legal = view.services?.find(({ service }) => service === "legal");
const ALL = [
  "spi_brief",
  "spi_line",
  "spi_radar",
  "spi_template",
  "spi_stack",
  "spi_release_notes",
  "spi_security",
  "spi_inspect",
  "spi_evidence",
];
const ARGS: Record<string, object> = {
  spi_line: { service: "legal" },
  spi_inspect: { id: "radar:partition" },
  spi_evidence: { path: "/services/2/home" },
};

describe("SPI read tools over the saved sweep", () => {
  it.each([
    ["spi_brief", (out: never) => expect(out).toMatchObject({ headline: view.briefing.headline })],
    ["spi_line", (out: never) => expect(out).toMatchObject({ home: legal?.home })],
    ["spi_radar", (out: never) => expect(out).toMatchObject({ reading: reading("upstream") })],
    [
      "spi_template",
      (out: never) => expect(out).toMatchObject({ reading: reading("engineering") }),
    ],
    [
      "spi_stack",
      (out: never) => expect(out).toMatchObject({ facts: view.briefing.environment.facts }),
    ],
    [
      "spi_release_notes",
      (out: never) => expect(out).toMatchObject({ lines: view.releases.lines }),
    ],
    [
      "spi_inspect",
      (out: never) =>
        expect(out).toMatchObject({ item: feed.find(({ id }) => id === "radar:partition") }),
    ],
  ])("%s answers with the snapshot's value and its sweep time", async (name, check) => {
    const out = await call(name, ARGS[name]);
    expect(out.sweptAt).toBe(view.sweptAt);
    check(out as never);
  });

  it("says 'not read' for an area the sweep did not read, never zero or empty", async () => {
    const security = await call("spi_security");
    expect(security).toEqual({
      place: "Security",
      sweptAt: view.sweptAt,
      at: "/readings/5",
      read: "not read",
      areas: [{ area: "security", state: "unread" }],
      notRead: ["security"],
    });
    expect(await call("spi_release_notes")).toMatchObject({
      read: "partly read",
      notRead: ["releases"],
    });
    expect(await call("spi_radar")).toMatchObject({ read: "partly read", failed: ["radar"] });

    const index = view.services?.findIndex(({ service }) => service === "legal") ?? -1;
    const unreadWork = structuredClone(view);
    const entry = unreadWork.services?.[index];
    if (!entry?.work) throw new Error("Fixture legal has no work");
    entry.work.pulls = { ...entry.work.pulls, read: false, count: null, rows: [] };
    const line = await call("spi_line", { service: "legal" }, saved(unreadWork));
    expect(line.pulls).toBe("not read");
    delete entry.home;
    const homeless = await call("spi_line", { service: "legal" }, saved(unreadWork));
    expect(homeless).toMatchObject({ read: "not read", sweptAt: view.sweptAt });
    expect(homeless).not.toHaveProperty("home");
  });

  it.each(ALL)("%s says 'not read', with no time, when no sweep has been saved", async (name) => {
    expect(await call(name, ARGS[name], undefined)).toEqual({
      read: "not read",
      reason: "No sweep has been saved.",
    });
  });

  it.each([
    ["spi_line", { service: "nope" }],
    ["spi_inspect", { id: "nope:1" }],
    ["spi_evidence", { path: "/services/99" }],
    ["spi_evidence", { path: "/readings/0" }],
  ])("%s answers %j as not found rather than empty", async (name, args) => {
    expect(await call(name, args)).toMatchObject({ sweptAt: view.sweptAt, found: false });
  });

  it("names the areas and reads behind one value", async () => {
    const out = await call("spi_evidence", { path: "/services/2/home/stations/0" });
    const source = view.provenance.find(({ path }) => path === "/services/2/home");
    expect(out).toMatchObject({ at: "/services/2/home/stations/0", recordedAt: source?.path });
    expect(out.areas.map(({ area }: { area: string }) => area)).toEqual(source?.areas);
    expect(out.reads.length).toBeGreaterThan(0);
    for (const read of out.reads) expect(source?.areas).toContain(read.source);
  });

  it("bounds a result by whole items and names what it left out", async () => {
    const output = await session(saved()).callTool("spi_line", { service: "legal" });
    const out = JSON.parse(String(output));
    expect(estimateTokens(String(output))).toBeLessThanOrEqual(SPI_RESULT_TOKEN_BUDGET);
    const rows = legal?.work?.pulls.rows ?? [];
    expect(out.leftOut["pulls.rows"]).toBe(rows.length - out.pulls.rows.length);
    expect(out.pulls.rows).toEqual(rows.slice(0, out.pulls.rows.length));
  });

  it.each(ALL)("%s returns what the model redactor returned", async (name) => {
    const marked: ModelRedactor = { text: () => "marked", value: () => ({ marked: name }) };
    expect(await session(saved(), marked).callTool(name, ARGS[name] ?? {})).toBe(
      JSON.stringify({ marked: name }),
    );
  });
});
