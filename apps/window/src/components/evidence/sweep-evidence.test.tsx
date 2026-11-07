// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  AREAS,
  type AreaEnvelope,
  type AreaName,
  type Envelope,
  type InspectResult,
  type ReadRecord,
  type SweepStatus,
} from "@spi-code/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { EnvelopeBadge } from "./EnvelopeBadge.js";
import { SelectionEvidence, SelectionEvidenceChip, SweepEvidence } from "./EvidenceTab.js";
import { expectEvidenceMarks, expectNoEvidenceMarks } from "./marks.test-helper.js";
import { SectionEvidence } from "./SectionEvidence.js";
import { SweepLine, type SweepLineSnapshot } from "./SweepLine.js";
import { AREA_NAMES, clock, freshnessGlyph, sweepLine, sweepSources } from "./words.js";

const now = Date.parse("2026-11-05T12:00:00Z");
const minutes = (n: number) => new Date(now - n * 60_000).toISOString();
const sweptAt = minutes(2);
const nextSyncAt = new Date(now + 3 * 3_600_000).toISOString();

type Change = Partial<Record<AreaName, Partial<Envelope>>>;
const areas = (change: Change = {}, base: Partial<Envelope> = {}): AreaEnvelope[] =>
  AREAS.map((area) => ({
    area,
    envelope: {
      source: area,
      state: "fresh",
      observedAt: sweptAt,
      completeness: { kind: "complete" },
      ...base,
      ...change[area],
    } as Envelope,
  }));
const cut = {
  state: "incomplete",
  completeness: { kind: "cut", reason: "job_log_char_limit", read: 48_000, total: 71_250 },
} as const;
const snapshot = (list: AreaEnvelope[]): SweepLineSnapshot & { reads: ReadRecord[] } => ({
  areas: list,
  provenance: [],
  sweptAt,
  briefing: { nextSyncAt },
  reads: [],
});

async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return {
    container,
    rows: (label: string) =>
      [...container.querySelectorAll(`table[aria-label="${label}"] tr`)].map((row) => [
        row.querySelector("th")?.textContent,
        row.querySelector("td[data-state]")?.getAttribute("data-state"),
        row.querySelector("td:last-child")?.textContent,
      ]),
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it.each([
  ["fresh", areas(), "swept 2 min ago · all fresh · next sync in 3 h", "", "fresh"],
  [
    "failed",
    areas({ github: { state: "failed" }, runs: { state: "stale" }, security: cut }),
    "swept 2 min ago · 1 area failed · 1 incomplete · 1 stale · next sync in 3 h",
    " · ⌀ 1 source failed, 1 incomplete, 1 stale",
    "bad",
  ],
  [
    "cut",
    areas({ security: cut }),
    "swept 2 min ago · 1 area incomplete · next sync in 3 h",
    " · ⌀ 1 source incomplete",
    "warn",
  ],
  [
    "stale",
    areas({ radar: { state: "stale" }, upstream: { state: "stale" } }),
    "swept 2 min ago · 2 areas stale · next sync in 3 h",
    " · ⌀ 2 sources stale",
    "warn",
  ],
  [
    "all-inferred",
    areas({}, { inferred: true }),
    "swept 2 min ago · next sync in 3 h · inferred",
    " · inferred",
    "inferred",
  ],
  [
    "one-inferred",
    areas({ fleet: { inferred: true } }),
    "swept 2 min ago · all fresh · next sync in 3 h",
    "",
    "fresh",
  ],
  [
    "stale and all inferred",
    areas({ auth: { state: "stale" } }, { inferred: true }),
    "swept 2 min ago · 1 area stale · next sync in 3 h · inferred",
    " · ⌀ 1 source stale · inferred",
    "warn",
  ],
  [
    "unread",
    areas().filter(({ area }) => area !== "details"),
    "swept 2 min ago · 1 area not read yet · next sync in 3 h",
    "",
    "muted",
  ],
] as const)(
  "says the %s sweep in the Evidence sentence and the title-bar glyph with the worst tone",
  async (_, list, text, glyph, tone) => {
    const sources = sweepSources(snapshot([...list])).map(({ envelope }) => envelope);
    expect(sweepLine({ sources, sweptAt, nextSyncAt, now })).toEqual({ text, tone });
    const swept = `swept ${clock(sweptAt)}${glyph}`;
    expect(freshnessGlyph({ sources, sweptAt })).toEqual({ text: swept, tone });
    const onOpen = vi.fn();
    const view = await render(<SweepLine snapshot={snapshot([...list])} onOpen={onOpen} />);
    try {
      const line = view.container.querySelector<HTMLButtonElement>("[data-sweep-line]");
      expect(line?.textContent).toBe(swept);
      expect(line?.getAttribute("data-tone")).toBe(tone);
      await act(async () => line?.click());
      expect(onOpen).toHaveBeenCalledOnce();
    } finally {
      await view.cleanup();
    }
  },
);

it.each([
  [
    "eleven fresh areas",
    areas(),
    "swept 2 min ago · release lines read failed",
    " · ⌀ 1 source failed",
  ],
  [
    "a stale area",
    areas({ runs: { state: "stale" } }),
    "swept 2 min ago · 1 area stale · release lines read failed",
    " · ⌀ 1 source failed, 1 stale",
  ],
] as const)(
  "names a failed supplemental source apart from the area counts beside %s, worst tone kept",
  async (_, list, text, glyph) => {
    const releases: Envelope = {
      source: "releases",
      state: "failed",
      completeness: { kind: "complete" },
    };
    const body = {
      ...snapshot([...list]),
      briefing: { nextSyncAt: sweptAt },
      provenance: [
        {
          path: "/releases/lines/0",
          areas: ["fleet" as const],
          envelope: { ...releases, state: "fresh", observedAt: sweptAt } as Envelope,
        },
        { path: "/releases/lines/1", areas: ["fleet" as const], envelope: releases },
      ],
    };
    const sources = sweepSources(body);
    expect(sources.at(-1)).toMatchObject({ key: "releases", name: "Release lines" });
    expect(
      sweepLine({
        sources: sources.map(({ envelope }) => envelope),
        sweptAt,
        nextSyncAt: sweptAt,
        now,
      }),
    ).toEqual({ text, tone: "bad" });
    const view = await render(<SweepLine snapshot={body} onOpen={() => {}} />);
    try {
      const line = view.container.querySelector("[data-sweep-line]");
      expect(line?.textContent).toBe(`swept ${clock(sweptAt)}${glyph}`);
      expect(line?.getAttribute("data-tone")).toBe("bad");
    } finally {
      await view.cleanup();
    }
  },
);

it("waits in muted words before the first sweep", async () => {
  const view = await render(<SweepLine snapshot={null} onOpen={() => {}} />);
  try {
    const line = view.container.querySelector("[data-sweep-line]");
    expect(line?.textContent).toBe("waiting for the first sweep");
    expect(line?.getAttribute("data-tone")).toBe("muted");
  } finally {
    await view.cleanup();
  }
});

it("lists every area of the sweep in plain words with state, age and completeness", async () => {
  const sweep: SweepStatus = {
    remaining: 1_234,
    floor: 500,
    resetAt: new Date(now + 40 * 60_000).toISOString(),
    deferredAreas: [{ area: "security", reason: "budget_floor" }],
  };
  const body = {
    ...snapshot(
      areas({
        github: { state: "failed", observedAt: minutes(25) },
        runs: { state: "stale", observedAt: minutes(23) },
        security: { ...cut, observedAt: minutes(5) },
      }).filter(({ area }) => area !== "details"),
    ),
    reads: [
      {
        source: "gitlab",
        object: "osdu/platform/system/partition",
        observedAt: minutes(1),
        completeness: { kind: "complete" },
        failure: "http_502",
        retainedFrom: minutes(30),
      },
      {
        source: "github",
        object: "Azure/osdu-spi-partition",
        observedAt: minutes(1),
        completeness: { kind: "complete" },
      },
    ] satisfies ReadRecord[],
  };
  const view = await render(<SweepEvidence snapshot={body} sweep={sweep} now={now} />);
  try {
    const sweepView = view.container.querySelector('[data-evidence="sweep"]');
    expect(sweepView?.querySelector(".evidence-line")?.textContent).toBe(
      "swept 2 min ago · 1 area failed · 1 incomplete · 1 stale · 1 not read yet · next sync in 3 h",
    );
    const rows = view.rows("Areas");
    expect(rows.map(([name]) => name)).toEqual(AREAS.map((area) => AREA_NAMES[area]));
    expect(rows.map(([name]) => name)).toContain("GitHub issues and PRs");
    const row = (area: AreaName) => rows[AREAS.indexOf(area)];
    expect(row("github")).toEqual([
      "GitHub issues and PRs",
      "read failed",
      "read failed, showing data from 25 min ago",
    ]);
    expect(row("runs")?.slice(1)).toEqual(["stale", "stale, last read 23 min ago, complete"]);
    expect(row("security")?.slice(1)).toEqual([
      "cut",
      "cut, last read 5 min ago, 48,000 of 71,250 · job log char limit",
    ]);
    expect(row("details")?.slice(1)).toEqual(["not read yet", "not read yet"]);
    expect(row("fleet")?.slice(1)).toEqual(["fresh", "fresh, last read 2 min ago, complete"]);
    expect(view.rows("Failed reads")).toEqual([
      [
        "gitlab · osdu/platform/system/partition",
        "read failed",
        "http 502, showing data from 30 min ago",
      ],
    ]);
    expect(sweepView?.querySelector("[data-budget]")?.textContent).toBe(
      "1,234 GitHub requests left, resets in 40 min; reads pause at 500 to keep a reserve.",
    );
    expect(sweepView?.querySelector('[data-deferred="security"]')?.textContent).toBe(
      `${AREA_NAMES.security} waits for the next sweep · budget floor`,
    );
  } finally {
    await view.cleanup();
  }
  const empty = await render(<SweepEvidence snapshot={null} sweep={null} now={now} />);
  try {
    expect(empty.container.textContent).toContain("Waiting for the first sweep.");
    expect(empty.container.textContent).toContain("The API budget has not been read yet.");
  } finally {
    await empty.cleanup();
  }
});

const inspected = (patch: Partial<InspectResult>): InspectResult => ({
  id: "halt:partition",
  title: "partition",
  class: "HALT",
  cause: "",
  effect: "",
  next: "",
  why: "",
  evidence: [],
  related: [],
  approval: null,
  actions: [],
  ...patch,
});
const read = (inferred: boolean): ReadRecord => ({
  source: "github",
  object: "Azure/osdu-spi-partition",
  observedAt: minutes(4),
  completeness: { kind: "cut", reason: "page_limit", read: 40, total: 52 },
  inferred,
});

it.each([
  [true, true],
  [true, false],
  [false, true],
] as const)(
  "lists a selection's provenance areas, then its repository's reads; areas inferred=%s, read inferred=%s",
  async (areasInferred, readInferred) => {
    const result = inspected({
      areas: areas(
        { runs: { state: "stale", observedAt: minutes(23) } },
        { inferred: areasInferred },
      ),
      provenance: [
        { path: "/cause", areas: ["runs"] },
        { path: "/next", areas: ["github", "runs"] },
      ],
      evidence: [read(readInferred)],
    });
    const view = await render(<SelectionEvidence result={result} now={now} />);
    try {
      const article = view.container.querySelector('[data-evidence="selection"]');
      expect(
        [...(article?.querySelectorAll("h3") ?? [])].map((heading) => heading.textContent),
      ).toEqual(["Areas", "Reads for partition"]);
      expect(view.rows("Areas")).toEqual([
        ["GitHub issues and PRs", "fresh", "fresh, last read 2 min ago, complete"],
        ["Workflow runs", "stale", "stale, last read 23 min ago, complete"],
      ]);
      expect(view.rows("Reads for partition")).toEqual([
        [
          "GitHub issues and PRs · Azure/osdu-spi-partition",
          "cut",
          "read 4 min ago, cut, 40 of 52 · page limit",
        ],
      ]);
      const all = areasInferred && readInferred;
      expect(article?.querySelector("h2 [data-inferred]")?.textContent ?? null).toBe(
        all ? "inferred · every source" : null,
      );
      expect(article?.querySelectorAll("[data-inferred]").length).toBe(all ? 1 : 0);
    } finally {
      await view.cleanup();
    }
  },
);

it("lists no area when a selection's provenance names none, and says when it carries no areas", async () => {
  const unnamed = await render(
    <SelectionEvidence result={inspected({ areas: areas(), provenance: [] })} now={now} />,
  );
  try {
    expect(unnamed.rows("Areas")).toEqual([]);
    expect(unnamed.container.textContent).toContain(
      "This selection does not name the areas it is drawn from.",
    );
    expect(unnamed.container.textContent).toContain("No reads recorded for partition.");
  } finally {
    await unnamed.cleanup();
  }
  const bare = await render(<SelectionEvidence result={inspected({})} now={now} />);
  try {
    expect(bare.container.textContent).toContain(
      "This selection does not say which areas it is drawn from.",
    );
  } finally {
    await bare.cleanup();
  }
});

it.each([
  ["fresh", areas(), [read(false)], null],
  [
    "stale",
    areas({ runs: { state: "stale", observedAt: minutes(23) } }),
    [read(false)],
    "stale · 23 min",
  ],
  ["inferred", areas({}, { inferred: true }), [read(true)], "inferred · every source"],
] as const)(
  "shows the selection chip for a %s selection only when it has news",
  async (_, list, evidence, text) => {
    const onOpen = vi.fn();
    const result = inspected({
      areas: [...list],
      provenance: [{ path: "/cause", areas: ["runs"] }],
      evidence: [...evidence],
    });
    const view = await render(<SelectionEvidenceChip result={result} onOpen={onOpen} now={now} />);
    try {
      const chip = view.container.querySelector<HTMLButtonElement>("[data-selection-evidence]");
      expect(chip?.textContent ?? null).toBe(text);
      await act(async () => chip?.click());
      expect(onOpen).toHaveBeenCalledTimes(text === null ? 0 : 1);
    } finally {
      await view.cleanup();
    }
  },
);

it.each([
  ["all fresh", {}, {}, null, undefined],
  ["one inferred", { github: { inferred: true } }, {}, null, undefined],
  ["stale", { github: { state: "stale" } }, {}, "GitHub issues and PRs stale", "warn"],
  [
    "failed",
    { runs: { state: "failed" }, github: { state: "stale" } },
    {},
    "Workflow runs read failed · 1 more",
    "bad",
  ],
  ["cut", { github: cut }, {}, "GitHub issues and PRs cut", "warn"],
  ["all inferred", {}, { inferred: true }, "inferred", "inferred"],
  [
    "stale and all inferred",
    { runs: { state: "stale" } },
    { inferred: true },
    "Workflow runs stale · inferred",
    "warn",
  ],
] as const)("gives a section header one line when %s", async (_, change, base, text, tone) => {
  const list = areas(change as Change, base as Partial<Envelope>);
  const evidence = {
    areas: list,
    provenance: [
      { path: "/briefing/focus/0", areas: ["github", "runs"] as AreaName[] },
      { path: "/briefing/facts/0", areas: ["fleet"] as AreaName[] },
    ],
  };
  const view = await render(
    <SectionEvidence evidence={evidence} prefixes={["/briefing/focus"]} now={now} />,
  );
  try {
    const line = view.container.querySelector('[data-section-evidence="/briefing/focus"]');
    expect(line?.textContent?.trim() ?? null).toBe(text);
    expect(line?.getAttribute("data-tone") ?? undefined).toBe(tone);
    if (line) {
      expect(line.getAttribute("title")).toContain("GitHub issues and PRs ·");
      expect(line.getAttribute("title")).not.toContain("Fleet membership");
    }
  } finally {
    await view.cleanup();
  }
});

it("fails both evidence guards when a value carries an ordinary envelope badge", async () => {
  const fresh = areas()[0]?.envelope;
  if (!fresh || fresh.inferred === true) throw new Error("Expected a plain fresh envelope");
  const view = await render(
    <p data-pointer="/briefing/headline">
      Headline <EnvelopeBadge envelope={fresh} now={now} />
    </p>,
  );
  try {
    expect(view.container.querySelector("[data-inferred]")).toBeNull();
    expect(() => expectNoEvidenceMarks(view.container)).toThrow(/per-value envelope badges/);
    expect(() =>
      expectEvidenceMarks(view.container, { areas: areas(), provenance: [] }, { sections: [] }),
    ).toThrow(/per-value envelope badges/);
  } finally {
    await view.cleanup();
  }
});
