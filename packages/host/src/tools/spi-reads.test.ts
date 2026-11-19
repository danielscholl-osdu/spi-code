// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import type { InspectResult, ViewSnapshot } from "@spi-code/contracts";
import { emptyFacts } from "@spi-code/core";
import { describe, expect, it } from "vitest";
import {
  appStyle,
  detailFeedPath,
  mixedFixtureInput,
  recordedInput,
  recordedSnapshotPath,
} from "../../test/watch/snapshot-fixture.js";
import { FakeSession } from "../testing/fake-session.js";
import type { ModelRedactor } from "../threads/context/seams.js";
import type { CollectorReads, SavedSweep } from "../threads/context/sweep.js";
import { estimateTokens } from "../threads/context/tokens.js";
import { projectWatch, type WatchInput } from "../watch/project.js";
import { buildPermissionGate } from "./permission-gate.js";
import type { TierCheck } from "./registry.js";
import { SPI_RESULT_TOKEN_BUDGET, spiReadTools, spiToolProvider } from "./spi-reads.js";

const view: ViewSnapshot = JSON.parse(readFileSync(recordedSnapshotPath, "utf8"));
const feed: InspectResult[] = JSON.parse(readFileSync(detailFeedPath, "utf8"));
const plain: ModelRedactor = { text: (text) => text, value: (value) => value };
const recorded = appStyle(recordedInput());
const collected = ({ reads, releaseRecords }: WatchInput): CollectorReads => ({
  ...reads,
  releases: releaseRecords,
});
const saved = (snapshot: ViewSnapshot = view, reads = collected(recorded)): SavedSweep => ({
  view: snapshot,
  reads,
  inspect: async (id) => {
    const result = feed.find((entry) => entry.id === id);
    return result && { kind: "queue item", result };
  },
});
const projected = (input: WatchInput) => saved(projectWatch(input), collected(input));

function session(sweep: SavedSweep | undefined, redactor = plain, check?: TierCheck) {
  const tools = spiToolProvider(spiReadTools(() => sweep, redactor, check)).offer();
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

const releasesRead = structuredClone(view);
for (const source of releasesRead.provenance) {
  if (source.envelope?.source === "releases") {
    source.envelope = {
      source: "releases",
      state: "fresh",
      observedAt: view.sweptAt,
      completeness: { kind: "complete" },
    };
  }
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
      read: "not read",
      areas: [{ area: "security", state: "unread" }],
      notRead: ["security"],
    });
    const releases = await call("spi_release_notes");
    expect(releases).toMatchObject({ read: "not read", notRead: ["releases"] });
    expect(releases).not.toHaveProperty("lines");
    const month = await call("spi_release_notes", { month: "1999-01" }, saved(releasesRead));
    expect(month).toMatchObject({ read: "read", lines: view.releases.lines, month: "not read" });
    const radar = await call("spi_radar");
    expect(radar).toMatchObject({ read: "partly read", failed: ["radar"] });
    expect(radar.areas.find(({ area }: { area: string }) => area === "radar").records).toEqual({
      read: (recorded.reads.radar?.length ?? 0) - 3,
      retained: [],
      lost: 3,
    });

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

  it("masks what an unread area would have said, and keeps what was read", async () => {
    const { radar: _radar, ...reads } = recorded.reads;
    const sweep = projected({
      ...recorded,
      facts: { ...recorded.facts, radar: emptyFacts().radar },
      reads,
    });
    const upstream = await call("spi_radar", {}, sweep);
    expect(upstream).toMatchObject({ read: "partly read", notRead: ["radar"] });
    const tiles = Object.fromEntries(
      upstream.reading.tiles.map(({ label, value }: { label: string; value: string }) => [
        label,
        value,
      ]),
    );
    expect(tiles).toEqual({ Incoming: "110", Toolchain: "not read", Largest: "not read" });
    expect(upstream.reading.folded).toBe("not read");

    const lineless = structuredClone(view);
    delete lineless.briefing.lines;
    expect((await call("spi_brief", {}, saved(lineless))).lines).toBe("not read");
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

  it.each(ALL.filter((name) => name !== "spi_inspect"))(
    "%s gives an at that spi_evidence can answer",
    async (name) => {
      const out = await call(name, ARGS[name], saved(releasesRead));
      if (out.at === undefined) return;
      expect(await call("spi_evidence", { path: out.at })).toMatchObject({ place: "Evidence" });
    },
  );

  it("names the areas and each collector's reads behind one value", async () => {
    const out = await call("spi_evidence", { path: "/services/2/home/stations/0" });
    const source = view.provenance.find(({ path }) => path === "/services/2/home");
    expect(out).toMatchObject({ at: "/services/2/home/stations/0", recordedAt: source?.path });
    expect(out.areas.map(({ area }: { area: string }) => area)).toEqual(source?.areas);
    const github = out.reads.filter(
      ({ collector }: { collector: string }) => collector === "github",
    );
    expect(github.map(({ collector: _c, ...read }: { collector: string }) => read)).toEqual(
      recorded.reads.github,
    );
    for (const read of out.reads) expect(source?.areas).toContain(read.collector);
  });

  it("names the Releases reader's own records with its state, read or not", async () => {
    const mixed = appStyle(mixedFixtureInput());
    const out = await call("spi_evidence", { path: "/releases/lines" }, projected(mixed));
    expect(out.collectors).toContainEqual({ collector: "releases", state: "fresh", reads: 2 });
    expect(out.reads).toContainEqual(
      expect.objectContaining({ collector: "releases", source: "github-releases" }),
    );

    const unread = await call("spi_evidence", { path: "/releases/lines" });
    expect(unread).toMatchObject({ read: "not read" });
    expect(unread.collectors).toContainEqual({ collector: "releases", state: "unread", reads: 0 });
  });

  it("bounds a result by whole items and names what it left out", async () => {
    const output = await session(saved()).callTool("spi_line", { service: "legal" });
    const out = JSON.parse(String(output));
    expect(estimateTokens(String(output))).toBeLessThanOrEqual(SPI_RESULT_TOKEN_BUDGET);
    const rows = legal?.work?.pulls.rows ?? [];
    expect(out.leftOut["pulls.rows"]).toBe(rows.length - out.pulls.rows.length);
    expect(out.pulls.rows).toEqual(rows.slice(0, out.pulls.rows.length));
  });

  const fake = ["gh", "p_", "FAKE".repeat(9)].join("");
  const masking: ModelRedactor = {
    text: (text) => text.replaceAll(fake, "[redacted]"),
    value: (value) => value,
  };
  const failing: SavedSweep = {
    ...saved(),
    inspect: () => Promise.reject(new Error(`token ${fake} leaked`)),
  };
  const refusing: TierCheck = () => ({ allowed: false, reason: `held ${fake}` });
  it.each([
    ["an inspection error", failing, undefined, "token [redacted] leaked"],
    ["a policy refusal", saved(), refusing, "spi_inspect: refused: held [redacted]"],
  ] as const)("sends %s through the model redactor", async (_name, sweep, check, message) => {
    const run = session(sweep, masking, check).callTool("spi_inspect", { id: "rollout" });
    await expect(run).rejects.toThrow(message);
  });

  it.each(ALL)("%s returns what the model redactor returned", async (name) => {
    const marked: ModelRedactor = { text: () => "marked", value: () => ({ marked: name }) };
    expect(await session(saved(), marked).callTool(name, ARGS[name] ?? {})).toBe(
      JSON.stringify({ marked: name }),
    );
  });
});
