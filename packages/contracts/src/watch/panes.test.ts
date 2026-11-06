// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ReleaseDocSchema,
  ReleaseLineSchema,
  RepoLineSchema,
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

const documents = oracle("release-doc");
const docs = ReleaseDocSchema.array().parse(documents);
const doc = docs[0];
if (!doc) throw new Error("The release document oracle must include a document");
const rolloutWords = oracle("rollout-words");
const words = RolloutWordsSchema.parse(rolloutWords);

// The pinned facts and notes produce only coverage visuals.
const supplementalHighlights = [
  {
    title: "Library",
    visual: { kind: "library", shares: [{ version: "8", services: ["legal"] }] },
  },
  {
    title: "Commands",
    visual: { kind: "commands", items: [{ text: "upgrade", sub: "all services" }] },
  },
  { title: "Steps", visual: { kind: "steps", items: [{ text: "Review" }] } },
];

describe("Watch pane schemas", () => {
  it("round-trips optional repository-line identity without weakening the schema", () => {
    const line = { tag: "fix", tone: "ok", text: "A fix", sub: "ready" };
    const identified = { ...line, id: "pr:org/repo:7", url: "https://github.com/org/repo/pull/7" };
    expect(RepoLineSchema.parse(line)).toEqual(line);
    expect(RepoLineSchema.parse(identified)).toEqual(identified);
    expect(RepoLineSchema.safeParse({ ...identified, id: "" }).success).toBe(false);
    expect(RepoLineSchema.safeParse({ ...identified, url: "file:///tmp/x" }).success).toBe(false);
    expect(RepoLineSchema.safeParse({ ...identified, extra: true }).success).toBe(false);
  });
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
  it("round-trips every frozen release document without dropping nested fields", () => {
    expect(docs.length).toBeGreaterThan(0);
    expect(ReleaseDocSchema.array().parse(documents)).toEqual(documents);
    expect(
      docs.map(({ id, month, name, open, stateText, notes, headline, stats, keyChanges }) => ({
        id,
        month,
        name,
        open,
        stateText,
        notes,
        headline,
        stats,
        keyChanges,
      })),
    ).toEqual(releaseLines);
  });
  it("round-trips frozen rollout words and rejects missing or extra fields", () => {
    expect(RolloutWordsSchema.parse(rolloutWords)).toEqual(rolloutWords);
    expect(RolloutWordsSchema.safeParse({ ...words, cause: undefined }).success).toBe(false);
    expect(RolloutWordsSchema.safeParse({ ...words, extra: true }).success).toBe(false);
  });
  it.each(supplementalHighlights)(
    "round-trips the supplemental $visual.kind visual and rejects extra keys",
    (highlight) => {
      const document = { ...doc, highlights: [highlight] };
      expect(ReleaseDocSchema.parse(document)).toEqual(document);
      expect(
        ReleaseDocSchema.safeParse({
          ...document,
          highlights: [{ ...highlight, visual: { ...highlight.visual, extra: true } }],
        }).success,
      ).toBe(false);
    },
  );
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
  it("rejects extra keys in frozen release visuals", () => {
    expect(doc.highlights.some((highlight) => highlight.visual)).toBe(true);
    for (const highlight of doc.highlights) {
      if (!highlight.visual) continue;
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
