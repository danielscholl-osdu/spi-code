// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { type InspectState, inspectItem, inspectTitle } from "../../src/inspect/item";
import type { FailureClass } from "../../src/model/attribution";
import { buildModel } from "../../src/model/index";
import type { QueueItem } from "../../src/model/queue";
import { fixtureContext } from "../briefing-setup";
import { FIXTURE_NOW, fixtureFacts } from "../harness";

const model = buildModel(fixtureFacts(), FIXTURE_NOW, {}, fixtureContext);
const overrides: Record<FailureClass, Partial<QueueItem>> = {
  ENV: { kind: "lanes" },
  ACCESS: {
    kind: "access",
    cause: [
      { label: "reason", value: 'denied: "ghcr.io/azure/osdu-spi-legal:pr-9" requires auth' },
    ],
  },
  TEST: { kind: "template-red", cause: [{ label: "reason", value: "failed suites: acceptance" }] },
  HALT: {
    kind: "halt",
    rung: 0,
    halt: { fork: "entitlements", code: "UNKNOWN_TOP_LEVEL", entries: ["schemathesis-tests"] },
  },
  TOOLCHAIN: {
    cause: [
      {
        label: "reason",
        value: "RequireJavaVersion: JDK 17.0.20-1 is outside the allowed range [25,)",
      },
    ],
  },
  CONFLICT: { kind: "conflict", rung: 0 },
  POLICY: {},
  INFRA: {},
  BUILD: { kind: "release-red", cause: [{ label: "check", value: "Java Build › Run Java Build" }] },
  UNREAD: {},
};

function item(over: Partial<QueueItem> = {}): QueueItem {
  return {
    id: "x",
    kind: "gate1",
    rung: 1,
    scope: "svc",
    text: "",
    effects: [],
    cause: [],
    incident: true,
    blocks: 1,
    ...over,
  };
}
function inspect(i: QueueItem, state: InspectState = {}) {
  return inspectItem(
    { ...model, queue: { ...model.queue, items: [i] } },
    i,
    FIXTURE_NOW,
    fixtureContext,
    state,
  );
}

interface Oracle {
  title: string;
  header: { status: { label: string; tone: string }; chip: string };
  sections: {
    kind: string;
    title?: string;
    items: {
      text?: string;
      title?: string;
      value?: string;
      fields?: { label: string; value: string; href?: string }[];
    }[];
  }[];
}

describe("inspector class parity", () => {
  test.each(Object.keys(overrides) as FailureClass[])(
    "%s matches the frozen rib inspector",
    (cls) => {
      const oracle: Oracle = JSON.parse(
        readFileSync(
          new URL(`../../../../fixtures/rib-59d6895/oracle/inspect/${cls}.json`, import.meta.url),
          "utf8",
        ),
      );
      const result = inspect(item({ cls, ...overrides[cls] }));
      const lede = oracle.sections.find((s) => s.kind === "rows")?.items[0]?.text;
      const why = oracle.sections.flatMap((s) => s.items).find((c) => c.title === "Why");
      const next = oracle.sections.find((s) => s.title === "Next step")?.items[0]?.title;
      const gap = oracle.sections.find((s) => s.kind === "stats")?.items;
      expect(result.class).toBe(oracle.header.status.label.split(" · ")[1]);
      expect(result.status).toEqual(oracle.header.status);
      expect(result.title).toBe(oracle.title);
      expect(result.chip).toBe(oracle.header.chip);
      expect(result.effect).toBe("Nothing else waits on it.");
      expect(result.gap ? result.effect : `${result.cause} ${result.effect}`).toBe(lede);
      expect(result.lede).toBe(lede);
      expect(result.next).toBe(next);
      expect(result.why).toEqual(why?.fields ?? []);
      expect(result.evidence).toEqual(why?.fields?.filter((f) => f.label === "Source") ?? []);
      if (gap) {
        expect(result.gap).toEqual({ have: gap[0]?.value, need: gap[1]?.value });
        expect(result.cause).toBe(
          `Upstream requires ${gap[1]?.value}; the fork builds on ${gap[0]?.value?.replace("Java ", "")}.`,
        );
      }
    },
  );
});

describe("inspector item data", () => {
  test("every recorded queue item has guidance and preserves effects and related navigation", () => {
    for (const i of model.queue.items) {
      const result = inspectItem(model, i, FIXTURE_NOW, fixtureContext);
      expect(result.title.length).toBeGreaterThan(0);
      expect(result.next.length).toBeGreaterThan(0);
      expect(result.effects).toEqual(i.effects);
    }
    const legal = model.queue.items.find((i) => i.id === "gate1:legal");
    if (!legal) throw new Error("fixture has legal sync PR");
    const result = inspectItem(model, legal, FIXTURE_NOW, fixtureContext);
    expect(result.chip).toContain("commits held");
    expect(result.why.map((f) => f.label)).toContain("Failed check");
    expect(result.why.map((f) => f.label)).not.toContain("Held");
    expect(result.related.some((r) => r.inspect)).toBe(true);
    expect(inspectTitle(legal)).toBe("legal · sync PR");
  });

  test("evidence keeps its source unless a fact or next link already carries it", () => {
    const url = "https://github.com/example/repo/issues/1";
    const i = item({
      url,
      kind: "approvals",
      cause: [
        { label: "head", value: "abc123" },
        { label: "held", value: "3 commits" },
      ],
    });
    const source = { label: "Source", value: "runs waiting for approval", href: i.url };
    expect(inspect(i).evidence).toEqual([source]);
    expect(inspect(i).why).toEqual([{ label: "Head", value: "abc123" }, source]);
    expect(inspect({ ...i, cause: [{ label: "PR", value: "#1", url: i.url }] }).evidence).toEqual(
      [],
    );
    const linked = inspect({ ...i, links: [{ label: "Open", url }] });
    expect(linked.evidence).toEqual([]);
    expect(linked.nextLinks).toEqual([{ label: "", value: "Open", href: i.url }]);
  });

  test("same-entry reads are selection-bound, ordered, folded and used in the next step", () => {
    const i = item({ ...overrides.HALT });
    expect(inspect(i).sameEntry).toBeUndefined();
    expect(inspect(i, { reading: i.id }).sameEntry).toEqual({
      state: "reading",
      rows: [{ text: "reading each fork's filter and upstream tree" }],
    });
    const entries = [
      { fork: "legal", entry: "schemathesis-tests", state: "unlisted" as const, reads: [] },
      { fork: "partition", entry: "schemathesis-tests", state: "absent" as const, reads: [] },
      {
        fork: "file",
        entry: "schemathesis-tests",
        state: "listed" as const,
        verdict: "strip",
        reads: [],
        url: "https://github.com/example/file/blob/main/.github/upstream-filter.yml",
      },
      { fork: "unit", entry: "schemathesis-tests", state: "unread" as const, reads: [] },
    ];
    const result = inspect(i, { others: { id: i.id, entries } });
    expect(result.sameEntry?.rows).toEqual([
      {
        text: "file",
        chip: { label: "listed", tone: "ok" },
        trailing: "strip",
        href: entries[2]?.url,
      },
      { text: "legal", chip: { label: "unlisted", tone: "caution" } },
      { text: "unit", chip: { label: "?", tone: "neutral" } },
      { text: "1 fork has no such entry upstream · partition" },
    ]);
    expect(result.next).toContain("file");
    expect(result.next).toContain("strip");
    expect(inspect(i, { others: { id: "old", entries } }).next).toBe(inspect(i).next);
    expect(inspect(i, { others: { id: "old", entries } }).sameEntry).toBeUndefined();
    const several = inspect(
      { ...i, halt: { fork: "svc", code: "UNKNOWN_TOP_LEVEL", entries: ["a", "b"] } },
      {
        others: {
          id: i.id,
          entries: entries.filter((e) => e.state === "absent" || e.state === "listed"),
        },
      },
    );
    expect(several.sameEntry?.rows[0]?.text).toBe("file · schemathesis-tests");
    expect(inspect(i, { others: { id: i.id, entries: [] } }).sameEntry).toBeUndefined();
  });
});
