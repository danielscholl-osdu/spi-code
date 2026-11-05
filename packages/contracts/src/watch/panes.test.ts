// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type ReleaseDoc,
  ReleaseDocSchema,
  ReleaseLineSchema,
  RepositoriesSchema,
  RolloutWordsSchema,
  UpstreamViewSchema,
} from "./panes.js";

function oracle(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../../../../fixtures/rib-59d6895/oracle/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
}

const briefing = oracle("briefing");
const releases = oracle("releases");
function section(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) {
    throw new Error(`Missing oracle section: ${key}`);
  }
  return Reflect.get(value, key);
}
const repositories = RepositoriesSchema.parse(section(briefing, "repositories"));
const flow = UpstreamViewSchema.parse(section(briefing, "flow"));
const releaseLines = ReleaseLineSchema.array().parse(section(releases, "lines"));
const line = releaseLines[0];
if (!line) throw new Error("The releases oracle must include a release line");

// The oracle freezes release summaries, not full documents or rollout words (spicode-t1k.74).
const doc = {
  ...line,
  eyebrow: ["SPI releases"],
  headlineWritten: true,
  required: [{ level: "required", title: "Upgrade", owner: "operators", when: "now" }],
  info: [{ level: "info", title: "Notes", body: "Read the release notes.", ifSkipped: "None" }],
  highlights: [
    {
      title: "Coverage",
      visual: { kind: "coverage", tiles: [{ id: "legal", version: "1", fresh: true }] },
    },
    {
      title: "Library",
      visual: { kind: "library", shares: [{ version: "8", services: ["legal"] }] },
    },
    {
      title: "Commands",
      visual: { kind: "commands", items: [{ text: "upgrade", sub: "all services" }] },
    },
    { title: "Steps", visual: { kind: "steps", items: [{ text: "Review" }] } },
  ],
  issues: [{ state: "open", title: "Known issue", body: "Workaround" }],
  openIssues: 1,
  changelog: [{ area: "Services", items: [{ type: "fixed", text: "A fix" }] }],
  computedChangelog: true,
  deps: 1,
  chips: [{ id: "legal", from: "0", to: "1", platform: false }],
  rows: [
    {
      id: "legal",
      group: "Services",
      version: "1",
      releases: 1,
      state: "released",
      lib: null,
      java: "25",
    },
    { id: "stack", group: "Platform", version: "?", releases: null, state: "unread" },
  ],
  unchanged: ["schema"],
  links: [{ label: "Release", url: "https://github.com/Azure/osdu-spi-legal/releases" }],
  unread: ["stack"],
  built: "Oct 21, 2026",
} satisfies ReleaseDoc;
const words = {
  title: "Rollout",
  sub: "In progress",
  cause: "Template changed",
  effect: "Forks wait",
  next: "Merge",
  verb: "Merge",
  plan: "One wave",
  watch: "Next sync",
  reaches: "workflows",
};

describe("Watch pane schemas", () => {
  it("round-trips the frozen repositories section without dropping nested fields", () => {
    expect(RepositoriesSchema.parse(section(briefing, "repositories"))).toEqual(
      section(briefing, "repositories"),
    );
  });
  it("round-trips the frozen upstream section and its independently frozen lanes", () => {
    expect(UpstreamViewSchema.parse(section(briefing, "flow"))).toEqual(section(briefing, "flow"));
    expect(flow.rows.map(({ fork, line }) => ({ fork, line }))).toEqual(
      section(oracle("lines"), "flow"),
    );
  });
  it("round-trips every frozen release summary", () => {
    expect(ReleaseLineSchema.array().parse(section(releases, "lines"))).toEqual(
      section(releases, "lines"),
    );
  });
  it("validates a full release document including all four visual variants", () => {
    expect(ReleaseDocSchema.parse(doc)).toEqual(doc);
  });
  it("validates rollout words and rejects missing or extra fields", () => {
    expect(RolloutWordsSchema.parse(words)).toEqual(words);
    expect(RolloutWordsSchema.safeParse({ ...words, cause: undefined }).success).toBe(false);
    expect(RolloutWordsSchema.safeParse({ ...words, extra: true }).success).toBe(false);
  });
  it("rejects a bad tone deep in a release summary or document", () => {
    const invalid = { ...line, stats: [{ ...line.stats[0], tone: "ok" }] };
    expect(ReleaseLineSchema.safeParse(invalid).success).toBe(false);
    expect(ReleaseDocSchema.safeParse({ ...doc, stats: invalid.stats }).success).toBe(false);
  });
  it("rejects a missing field in an upstream lane", () => {
    const row = flow.rows[0];
    if (!row) throw new Error("The flow oracle must include an upstream row");
    const invalid = { ...row, line: [{ text: "running" }] };
    expect(UpstreamViewSchema.safeParse({ ...flow, rows: [invalid] }).success).toBe(false);
  });
  it("rejects extra keys at depth in repositories and upstream plans", () => {
    const row = repositories.rows[0];
    if (!row) throw new Error("The repositories oracle must include a row");
    expect(
      RepositoriesSchema.safeParse({
        ...repositories,
        rows: [{ ...row, cells: { ...row.cells, changes: { ...row.cells.changes, extra: true } } }],
      }).success,
    ).toBe(false);
    expect(
      UpstreamViewSchema.safeParse({
        ...flow,
        plan: { ...flow.plan, lines: [{ label: "Wave", text: "legal", extra: true }] },
      }).success,
    ).toBe(false);
  });
  it("rejects extra keys in every release visual variant", () => {
    for (const highlight of doc.highlights) {
      expect(
        ReleaseDocSchema.safeParse({
          ...doc,
          highlights: [{ ...highlight, visual: { ...highlight.visual, extra: true } }],
        }).success,
      ).toBe(false);
    }
    expect(
      ReleaseDocSchema.safeParse({
        ...doc,
        highlights: [
          {
            title: "Library",
            visual: {
              kind: "library",
              shares: [{ version: "8", services: ["legal"], extra: true }],
            },
          },
        ],
      }).success,
    ).toBe(false);
  });
  it("rejects invalid manifest states, nullability and changelog kinds", () => {
    expect(
      ReleaseDocSchema.safeParse({ ...doc, rows: [{ ...doc.rows[0], state: "unknown" }] }).success,
    ).toBe(false);
    expect(
      ReleaseDocSchema.safeParse({ ...doc, rows: [{ ...doc.rows[0], version: null }] }).success,
    ).toBe(false);
    expect(
      ReleaseDocSchema.safeParse({
        ...doc,
        changelog: [{ area: "Services", items: [{ type: "other", text: "A change" }] }],
      }).success,
    ).toBe(false);
  });
});
