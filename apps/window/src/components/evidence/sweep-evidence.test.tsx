// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import {
  AREAS,
  type AreaEnvelope,
  type AreaName,
  type Envelope,
  type InspectResult,
  type ReadRecord,
  SweepProgressSchema,
  SweepReasonCodeSchema,
  type SweepStatus,
  ViewSnapshotSchema,
} from "@spi-code/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { clockTime } from "../../time.js";
import { applyContainerRules } from "../sweep/container-rules.test-helper.js";
import { after } from "../sweep/test-helper.js";
import { EnvelopeBadge } from "./EnvelopeBadge.js";
import { SelectionEvidence, SelectionEvidenceChip, SweepEvidence } from "./EvidenceTab.js";
import { expectEvidenceMarks, expectNoEvidenceMarks } from "./marks.test-helper.js";
import { SectionEvidence } from "./SectionEvidence.js";
import { SweepLine, type SweepLineSnapshot } from "./SweepLine.js";
import { AREA_NAMES, freshnessGlyph, sweepLine, sweepSources } from "./words.js";

const sweepSchedule = {
  sweepMs: 300_000,
  gitlabMs: 1_800_000,
  securityMs: 1_800_000,
  releasesMs: 3_600_000,
};

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

const sourceRows = (container: Element) =>
  [
    ...container.querySelectorAll(
      '[aria-label="Sources"] .sweep-row, [aria-label="More sources"] .sweep-row',
    ),
  ].map((row) => [
    row.querySelector(".sweep-name")?.textContent,
    row.getAttribute("data-tone"),
    row.querySelector(".sweep-outcome")?.textContent,
  ]);

const failedRows = (container: Element) => [
  ...container.querySelectorAll<HTMLElement>('ul[aria-label="Failed reads"] .evidence-failure'),
];

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
  ["fresh", areas(), "swept 2\u00a0min ago · all fresh · next sync in 3\u00a0h", "fresh"],
  [
    "failed",
    areas({ github: { state: "failed" }, runs: { state: "stale" }, security: cut }),
    "swept 2\u00a0min ago · 1 area failed · 1 incomplete · 1 stale · next sync in 3\u00a0h",
    "bad",
  ],
  [
    "cut",
    areas({ security: cut }),
    "swept 2\u00a0min ago · 1 area incomplete · next sync in 3\u00a0h",
    "warn",
  ],
  [
    "stale",
    areas({ radar: { state: "stale" }, upstream: { state: "stale" } }),
    "swept 2\u00a0min ago · 2 areas stale · next sync in 3\u00a0h",
    "warn",
  ],
  [
    "all-inferred",
    areas({}, { inferred: true }),
    "swept 2\u00a0min ago · next sync in 3\u00a0h · inferred",
    "inferred",
  ],
  [
    "one-inferred",
    areas({ fleet: { inferred: true } }),
    "swept 2\u00a0min ago · all fresh · next sync in 3\u00a0h",
    "fresh",
  ],
  [
    "stale and all inferred",
    areas({ auth: { state: "stale" } }, { inferred: true }),
    "swept 2\u00a0min ago · 1 area stale · next sync in 3\u00a0h · inferred",
    "warn",
  ],
  [
    "unread",
    areas().filter(({ area }) => area !== "details"),
    "swept 2\u00a0min ago · 1 area not read yet · next sync in 3\u00a0h",
    "muted",
  ],
] as const)(
  "says the %s sweep in the Evidence sentence with the worst tone",
  async (_, list, text, tone) => {
    const sources = sweepSources(snapshot([...list])).map(({ envelope }) => envelope);
    expect(sweepLine({ sources, sweptAt, nextSyncAt, now })).toEqual({ text, tone });
  },
);

it.each([
  ["fresh", areas(), "", "all areas read", "fresh"],
  [
    "failed, incomplete and stale",
    areas({
      github: { state: "failed" },
      security: { state: "incomplete" },
      runs: { state: "stale" },
    }),
    " · 3",
    "1 failed, 1 incomplete, 1 stale",
    "bad",
  ],
  ["cut", areas({ security: cut }), " · 1", "1 incomplete", "warn"],
  [
    "two failed reads",
    areas({ github: { state: "failed" }, runs: { state: "failed" } }),
    " · 2",
    "2 failed",
    "bad",
  ],
  ["two cut reads", areas({ github: cut, security: cut }), " · 2", "2 incomplete", "warn"],
  [
    "three incomplete reads",
    areas({
      github: { state: "incomplete" },
      runs: { state: "incomplete" },
      security: { state: "incomplete" },
    }),
    " · 3",
    "3 incomplete",
    "warn",
  ],
  [
    "two stale reads",
    areas({ upstream: { state: "stale" }, radar: { state: "stale" } }),
    " · 2",
    "2 stale",
    "warn",
  ],
  [
    "incomplete and stale",
    areas({ security: { state: "incomplete" }, runs: { state: "stale" } }),
    " · 2",
    "1 incomplete, 1 stale",
    "warn",
  ],
  [
    "cut and other incomplete reads counted together",
    areas({
      github: { state: "failed" },
      security: cut,
      upstream: { state: "incomplete" },
      runs: { state: "stale" },
    }),
    " · 4",
    "1 failed, 2 incomplete, 1 stale",
    "bad",
  ],
  [
    "a failed cut read counted once",
    areas({ security: { ...cut, state: "failed" } }),
    " · 1",
    "1 failed",
    "bad",
  ],
  ["unread", areas().filter(({ area }) => area !== "details"), "", "1 not read yet", "muted"],
  [
    "two unread areas",
    areas({ auth: { state: "unread" }, details: { state: "unread" } }),
    "",
    "2 not read yet",
    "muted",
  ],
  [
    "mixed multi-count states",
    areas({
      runs: { state: "failed" },
      approvals: { state: "failed" },
      github: cut,
      security: cut,
      template: { state: "incomplete" },
      upstream: { state: "stale" },
      radar: { state: "stale" },
      auth: { state: "unread" },
      details: { state: "unread" },
    }),
    " · 7",
    "2 failed, 3 incomplete, 2 stale, 2 not read yet",
    "bad",
  ],
  ["all inferred", areas({}, { inferred: true }), "", "all areas read · inferred", "inferred"],
] as const)(
  "shows a compact %s freshness field with a matching worst tone and named counts",
  async (_, list, tail, counts, tone) => {
    const body = snapshot([...list]);
    const sources = sweepSources(body).map(({ envelope }) => envelope);
    const name = `Swept ${clockTime(sweptAt)} · ${counts}`;
    expect(freshnessGlyph({ sources, sweptAt })).toEqual({ text: name, tail, tone });
    const onOpen = vi.fn();
    const view = await render(<SweepLine snapshot={body} onOpen={onOpen} />);
    try {
      const line = view.container.querySelector<HTMLButtonElement>("[data-sweep-line]");
      expect(line?.querySelector("[data-sweep-display]")?.textContent).toBe(
        `${clockTime(sweptAt)}${tail}`,
      );
      expect(line?.getAttribute("data-tone")).toBe(tone);
      expect(
        document.getElementById(line?.getAttribute("aria-labelledby") ?? "")?.textContent,
      ).toBe(name);
      expect(line?.title).toBe(name);
      expect(line?.getAttribute("data-field")).toBe("freshness");
      expect(line?.querySelector(".evidence-dot")?.getAttribute("data-tone")).toBe(tone);
      await act(async () => line?.click());
      expect(onOpen).toHaveBeenCalledOnce();
    } finally {
      await view.cleanup();
    }
  },
);

it.each([
  ["eleven fresh areas", areas(), "swept 2\u00a0min ago · release lines read failed", " · 1"],
  [
    "a stale area",
    areas({ runs: { state: "stale" } }),
    "swept 2\u00a0min ago · 1 area stale · release lines read failed",
    " · 2",
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
      expect(line?.querySelector("[data-sweep-display]")?.textContent).toBe(
        `${clockTime(sweptAt)}${glyph}`,
      );
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
    expect(line?.querySelector("[data-sweep-display]")?.textContent).toBe(
      "waiting for the first sweep",
    );
    expect(line?.getAttribute("data-tone")).toBe("muted");
  } finally {
    await view.cleanup();
  }
});

it("lists every source of the sweep once in plain words with state, age and completeness", async () => {
  const sweep: SweepStatus = {
    remaining: 1_234,
    floor: 500,
    resetAt: new Date(now + 40 * 60_000).toISOString(),
    deferredAreas: [{ area: "security", reason: "budget_floor" }],
    nextSweepAt: null,
    schedule: sweepSchedule,
    lastSweep: null,
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
      "swept 2\u00a0min ago · 1 area failed · 1 incomplete · 1 stale · 1 not read yet · next sync in 3\u00a0h",
    );
    expect(view.container.querySelector("table[aria-label='Areas']")).toBeNull();
    const rows = sourceRows(view.container);
    expect(rows.map(([name]) => name)).toEqual(AREAS.map((area) => AREA_NAMES[area]));
    expect(rows.map(([name]) => name)).toContain("GitHub issues and PRs");
    const row = (area: AreaName) => rows[AREAS.indexOf(area)];
    expect(row("github")).toEqual([
      "GitHub issues and PRs",
      "bad",
      "read failed, showing data from 25\u00a0min ago",
    ]);
    expect(row("runs")?.slice(1)).toEqual(["warn", "stale, last read 23\u00a0min ago, complete"]);
    expect(row("security")?.slice(1)).toEqual([
      "warn",
      "cut, last read 5\u00a0min ago, 48,000 of 71,250 read",
    ]);
    expect(row("details")?.slice(1)).toEqual(["wait", "not read yet"]);
    expect(row("fleet")?.slice(1)).toEqual(["ok", "fresh, last read 2\u00a0min ago, complete"]);
    expect(failedRows(view.container).map((row) => row.textContent)).toEqual([
      "✕Upstream GitLabGitLab unavailable · partition",
    ]);
    expect(
      failedRows(view.container)[0]?.querySelector("[title]")?.getAttribute("title"),
    ).toContain("http_502");
    expect(sweepView?.textContent).not.toContain("http 502");
    expect(sweepView?.querySelector("[data-budget]")?.textContent).toBe(
      "1,234 GitHub requests left, resets in 40\u00a0min; reads pause at 500 to keep a reserve.",
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

const coreCut = (reason: string, read: number, total: number, at: string): Partial<Envelope> => ({
  state: "incomplete",
  observedAt: at,
  completeness: { kind: "cut", reason, read, total },
});
const firstSweep = () => ({
  ...snapshot(
    areas({
      lifecycle: coreCut("Job log character limit", 64_000, 92_438, minutes(6)),
      radar: coreCut(
        "14 reads cut in entitlements, file, partition: GitLab omitted oversized or collapsed classification hunks",
        1_607,
        1_696,
        minutes(5),
      ),
    }),
  ),
  provenance: [
    {
      path: "/releases/lines/0",
      areas: ["fleet" as const],
      envelope: {
        source: "releases",
        state: "fresh",
        observedAt: minutes(3),
        completeness: { kind: "complete" },
      } as Envelope,
    },
  ],
  reads: [
    {
      source: "gitlab",
      object: "osdu/platform/system/partition",
      observedAt: minutes(4),
      completeness: { kind: "complete" },
      failure: "http_502",
    },
  ] satisfies ReadRecord[],
});
const committed = () =>
  SweepProgressSchema.parse({
    sweep: "sweep-1",
    startedAt: after(0),
    first: true,
    usualMs: null,
    outcome: "committed",
    nextAttemptAt: null,
    sources: [...AREAS, "releases"].map((source, index) =>
      source === "lifecycle" || source === "radar"
        ? {
            source,
            state: "cut",
            startedAt: after(index),
            endedAt: after(index + 1),
            code: "limit",
            reason: "GitLab omitted oversized or collapsed classification hunks",
            incomplete: { count: 2, total: 9 },
          }
        : { source, state: "read", startedAt: after(index), endedAt: after(index + 1) },
    ),
  });
const NAMES = [...AREAS.map((area) => AREA_NAMES[area]), "Release lines"];

it.each([true, false])(
  "keeps last-read hours inseparable in 360 px Evidence with a retained list: %s",
  async (retained) => {
    const body = firstSweep();
    const list = committed();
    const resumeAt = new Date(now + 10 * 60_000).toISOString();
    list.sources = list.sources.map((source) =>
      source.source === "details"
        ? {
            source: "details",
            state: "deferred",
            code: "budget",
            reason: "GitHub budget is low.",
            resumeAt,
          }
        : source,
    );
    const view = await render(
      <SweepEvidence
        snapshot={{
          ...body,
          areas: areas({ details: { observedAt: minutes(60) } }),
        }}
        sweep={null}
        completed={retained ? list : null}
        now={now}
      />,
    );
    view.container.style.width = "360px";
    try {
      const outcome = view.container.querySelector(
        '.sweep-row[data-source="details"] .sweep-outcome',
      )?.textContent;
      expect(outcome).toContain("last read 1\u00a0h ago");
      expect(outcome).not.toMatch(/\d[ \t]+h\b/);
      if (retained)
        expect(outcome).toBe(
          `waits for GitHub budget · after ${clockTime(resumeAt, { now, hint: false })} · last read 1\u00a0h ago`,
        );
    } finally {
      await view.cleanup();
    }
  },
);

it.each([
  ["after the first sweep", committed()],
  ["after a relaunch, with no list kept", null],
] as const)(
  "shows each source once with its last read in window words %s, then failed reads and the budget",
  async (_, list) => {
    const body = firstSweep();
    const sweep: SweepStatus = {
      remaining: 4_800,
      floor: 500,
      resetAt: null,
      deferredAreas: [],
      nextSweepAt: null,
      schedule: sweepSchedule,
      lastSweep: null,
    };
    const view = await render(
      <SweepEvidence snapshot={body} sweep={sweep} completed={list} now={now} />,
    );
    try {
      const article = view.container.querySelector('[data-evidence="sweep"]') as HTMLElement;
      const rows = sourceRows(article);
      expect(rows.map(([name]) => name).sort()).toEqual([...NAMES].sort());
      const sourceSection = article.querySelector('section[aria-label="Sources"]');
      for (const name of NAMES)
        expect(sourceSection?.textContent?.split(name).length, name).toBe(2);
      for (const [name, , outcome] of rows)
        expect(outcome, name ?? "").toMatch(/last read \d+\u00a0min ago/);
      expect(article.textContent).not.toMatch(/GitLab omitted|Job log character limit|hunks/);
      expect(article.querySelector("table[aria-label='Areas']")).toBeNull();
      expect([...article.querySelectorAll("h3")].map((h) => h.textContent)).toEqual([
        "Sources",
        "Failed reads",
        "API budget",
      ]);
      expect(failedRows(article)).toHaveLength(1);
      expect(article.querySelector("[data-budget]")).not.toBeNull();
    } finally {
      await view.cleanup();
    }
  },
);

const recorded1119 = JSON.parse(
  readFileSync("apps/window/src/components/evidence/fixtures/sweep-1119.json", "utf8"),
) as {
  now: string;
  snapshot: unknown;
  progress: unknown;
};
const sweep1119 = () => {
  const view = ViewSnapshotSchema.shape;
  const body = recorded1119.snapshot as SweepLineSnapshot & { reads: ReadRecord[] };
  return {
    body: {
      ...body,
      areas: view.areas.parse(body.areas),
      provenance: view.provenance.parse(body.provenance),
    },
    list: SweepProgressSchema.parse(recorded1119.progress),
    now: Date.parse(recorded1119.now),
  };
};

it("keeps not-due sources neutral and says a read reused older data, in the 11:19 sweep", async () => {
  const { body, list, now: at } = sweep1119();
  const view = await render(
    <SweepEvidence snapshot={body} sweep={null} completed={list} now={at} />,
  );
  try {
    const article = view.container.querySelector('[data-evidence="sweep"]') as HTMLElement;
    expect(article.querySelector(".evidence-line")?.textContent).toBe(
      "swept 3\u00a0min ago · 2 areas incomplete · next sync in 7\u00a0h",
    );
    expect(sourceRows(article)).toEqual([
      ["Sign-in", "ok", "read · 2\u00a0s · last read 3\u00a0min ago"],
      ["Fleet membership", "ok", "read · 0\u00a0s · reuses reads from 14\u00a0min ago"],
      ["GitHub issues and PRs", "ok", "read · 9\u00a0s · last read 3\u00a0min ago"],
      ["Workflow runs", "ok", "read · 14\u00a0s · last read 3\u00a0min ago"],
      ["Run approvals", "ok", "read · 6\u00a0s · last read 3\u00a0min ago"],
      [
        "Stack lifecycle runs",
        "warn",
        "read · 3\u00a0s · 1 job log cut short; rest read · reuses reads from 13\u00a0min ago",
      ],
      ["Template", "ok", "read · 0\u00a0s · last read 3\u00a0min ago"],
      ["Run details", "ok", "read · 0\u00a0s · last read 3\u00a0min ago"],
      ["Upstream GitLab", "idle", "skipped · last read 13\u00a0min ago"],
      [
        "Upstream radar",
        "warn",
        "skipped · 14 diffs cut short; rest read · last read 13\u00a0min ago",
      ],
      ["Security alerts", "idle", "skipped · last read 11\u00a0min ago"],
      ["Release lines", "idle", "skipped · last read 11\u00a0min ago"],
    ]);
    expect(
      [...article.querySelectorAll(".sweep-segment")].map((s) => s.getAttribute("data-tone")),
    ).toEqual(["ok", "ok", "ok", "ok", "ok", "warn", "ok", "ok", "idle", "warn", "idle", "idle"]);
  } finally {
    await view.cleanup();
  }
});

it.each([
  ["failed", "bad", "skipped · last read failed · showing data from 13\u00a0min ago"],
  ["incomplete", "warn", "skipped · last read cut short · last read 13\u00a0min ago"],
  ["stale", "warn", "skipped · stale, last read 13\u00a0min ago"],
] as const)(
  "tones a not-due source by its last read when that read %s",
  async (state, tone, outcome) => {
    const { body, list, now: at } = sweep1119();
    const areas = body.areas.map((entry) =>
      entry.area === "upstream"
        ? { ...entry, envelope: { ...entry.envelope, state } as Envelope }
        : entry,
    );
    const view = await render(
      <SweepEvidence snapshot={{ ...body, areas }} sweep={null} completed={list} now={at} />,
    );
    try {
      const upstream = sourceRows(view.container).find(([name]) => name === "Upstream GitLab");
      expect(upstream?.slice(1)).toEqual([tone, outcome]);
    } finally {
      await view.cleanup();
    }
  },
);

it("adds no last read to a listed source whose area has not been read yet", async () => {
  const body = firstSweep();
  const view = await render(
    <SweepEvidence
      snapshot={{ ...body, areas: body.areas.filter(({ area }) => area !== "approvals") }}
      sweep={null}
      completed={committed()}
      now={now}
    />,
  );
  try {
    const outcome = view.container.querySelector(
      '.sweep-row[data-source="approvals"] .sweep-outcome',
    )?.textContent;
    expect(outcome).toMatch(/^read · \d+\u00a0s$/);
  } finally {
    await view.cleanup();
  }
});

it("keeps every source name on one line in a 360 px panel, two columns and no table", async () => {
  const style = document.createElement("style");
  style.textContent = [
    "apps/window/src/components/sweep/sweep.css",
    "apps/window/src/components/evidence/evidence.css",
  ]
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  document.head.append(style);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    let node: HTMLElement | null = this;
    while (node && !node.style.width) node = node.parentElement;
    const w = Number.parseFloat(node?.style.width ?? "") || 0;
    return { x: 0, y: 0, left: 0, top: 0, right: w, bottom: 0, width: w, height: 0 } as DOMRect;
  });
  const frame = document.createElement("div");
  frame.style.cssText = "container-type: inline-size; width: 1440px";
  const panel = document.createElement("aside");
  panel.style.width = "360px";
  frame.append(panel);
  document.body.append(frame);
  const root = createRoot(panel);
  try {
    for (const list of [committed(), null]) {
      await act(async () =>
        root.render(
          <SweepEvidence
            snapshot={{
              ...firstSweep(),
              reads: ["storage", "indexer", "search", "workflow", "indexer-queue"].map((service) =>
                failedRead(`Azure/osdu-spi-${service}`),
              ),
            }}
            sweep={null}
            completed={list}
            now={now}
          />,
        ),
      );
      applyContainerRules(style.sheet as CSSStyleSheet);
      expect(panel.querySelectorAll(".sweep-row")).toHaveLength(NAMES.length);
      const rows = [...panel.querySelectorAll<HTMLElement>(".sweep-row, .evidence-failure")];
      expect(rows).toHaveLength(NAMES.length + 1);
      for (const row of rows) {
        expect(getComputedStyle(row).gridTemplateColumns).toBe("16px minmax(0, 1fr)");
        const what = row.querySelector(".sweep-what");
        if (what) expect(getComputedStyle(what).display).toBe("none");
      }
      expect(panel.querySelector('table[aria-label="Failed reads"]')).toBeNull();
      expect(
        getComputedStyle(failedRows(panel)[0]?.querySelector(".sweep-outcome") as Element)
          .gridColumn,
      ).toBe("2");
      for (const table of panel.querySelectorAll("table"))
        for (const name of NAMES) expect(table.textContent).not.toContain(name);
    }
  } finally {
    await act(async () => root.unmount());
    frame.remove();
    style.remove();
    vi.restoreAllMocks();
  }
});

const gatewayFailure =
  "gh api graphql: GitHub answered HTTP 504 twice (54881 bytes of HTML, a gateway error rather than a GraphQL reply)";
const failedRead = (object: string, failure = gatewayFailure, source = "github"): ReadRecord => ({
  source,
  object,
  observedAt: minutes(1),
  completeness: { kind: "complete" },
  failure,
});

// Literal read sources in core's collect/* and sweep/{areas,sweeper}, plus repo-backed reads.
it.each([
  ...AREAS.map((source) => [source, AREA_NAMES[source], ""]),
  ["releases", "Release lines", ""],
  ["gh", "Sign-in", ""],
  ["glab", "Sign-in", ""],
  ["gitlab", "Upstream GitLab", ""],
  ["file", "Fleet membership", ""],
  ["github-releases", "Release lines", ""],
  ["github-created", "Release lines", ""],
  ["github-pins", "Release lines", ""],
  ["persist", "Local state", ""],
  ["ledger-state", "Local state", ""],
  ["release-state", "Local state", ""],
  ["Azure/osdu-spi-unit", "GitHub issues and PRs", "unit"],
  ["osdu/platform/system/indexer-service", "Upstream GitLab", "indexer"],
  ["osdu/platform/system/lib/core/os-core-common", "Upstream GitLab", ""],
  ["osdu/platform/system/lib/cloud/azure/os-core-lib-azure", "Upstream GitLab", ""],
  ["osdu/platform", "Upstream GitLab", ""],
  ["a-future-source", "Other reads", ""],
  ["future/source/cache", "Other reads", ""],
])("maps recorded source %s to the window's %s row", async (source, name, service) => {
  const view = await render(
    <SweepEvidence
      snapshot={{ ...snapshot(areas()), reads: [failedRead("load", "other", source)] }}
      sweep={null}
      now={now}
    />,
  );
  try {
    const row = failedRows(view.container)[0];
    expect(row?.querySelector(".sweep-name")?.textContent).toBe(name);
    expect(row?.querySelector(".sweep-outcome")?.textContent).toBe(
      service ? `read failed · ${service}` : "read failed",
    );
  } finally {
    await view.cleanup();
  }
});

it("keeps local saves and dropped caches out of forge groups and service lists", async () => {
  const fixture = ViewSnapshotSchema.parse(
    JSON.parse(readFileSync("fixtures/watch/snapshot-1106.json", "utf8")),
  );
  const view = await render(
    <SweepEvidence
      snapshot={{
        ...snapshot(areas()),
        reads: [
          ...fixture.reads.filter((record) => record.failure),
          failedRead("save", "other", "persist"),
          failedRead("load", "other", "ledger-state"),
          failedRead("load", "other", "release-state"),
          ...[
            "pr-files-cache",
            "template",
            "detail-cache",
            "lifecycle-cache",
            "repos/Azure/osdu-spi/compare/base...head",
          ].map((key) => failedRead(key, "other", "persist")),
        ],
      }}
      sweep={null}
      now={now}
    />,
  );
  try {
    expect(
      failedRows(view.container).map((row) => [
        row.querySelector(".sweep-name")?.textContent,
        row.querySelector(".sweep-outcome")?.textContent,
      ]),
    ).toEqual([
      ["GitHub issues and PRs", "read failed · unit, crs-catalog, crs-conversion"],
      ["Local state", "read failed"],
      ["Saved reads", "read failed"],
    ]);
  } finally {
    await view.cleanup();
  }
});

it("groups release reads under Release lines and strips the pin version from fleet ids", async () => {
  const view = await render(
    <SweepEvidence
      snapshot={{
        ...snapshot(areas()),
        reads: [
          failedRead("Azure/osdu-spi-unit", "timeout", "github-releases"),
          failedRead("Azure/osdu-spi-unit", "timeout", "github-created"),
          failedRead("Azure/osdu-spi-unit@v0.28.0", "timeout", "github-pins"),
          failedRead("Azure/osdu-spi-stack", "timeout", "github-releases"),
          failedRead("Azure/osdu-spi-core-lib-azure", "timeout", "github-releases"),
        ],
      }}
      sweep={null}
      now={now}
    />,
  );
  try {
    const rows = failedRows(view.container);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute("aria-label")).toBe("Release lines · GitHub timed out · unit");
    expect(rows[0]?.textContent).not.toContain("@");
  } finally {
    await view.cleanup();
  }
});

it("groups repo-backed pom failures under a window source name with the three fleet ids", async () => {
  const fixture = ViewSnapshotSchema.parse(
    JSON.parse(readFileSync("fixtures/watch/snapshot-1106.json", "utf8")),
  );
  const view = await render(
    <SweepEvidence
      snapshot={{ ...snapshot(areas()), reads: fixture.reads.filter((record) => record.failure) }}
      sweep={null}
      now={now}
    />,
  );
  try {
    const rows = failedRows(view.container);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.querySelector(".sweep-name")?.textContent).toBe("GitHub issues and PRs");
    expect(rows[0]?.querySelector(".sweep-outcome")?.textContent).toBe(
      "read failed · unit, crs-catalog, crs-conversion",
    );
    expect(rows[0]?.textContent).not.toContain("Azure/");
  } finally {
    await view.cleanup();
  }
});

it("names GitLab repo-backed failures by fleet id rather than upstream project name", async () => {
  const view = await render(
    <SweepEvidence
      snapshot={{
        ...snapshot(areas()),
        reads: [
          "osdu/platform/system/indexer-service",
          "osdu/platform/system/search-service",
          "osdu/platform/data-flow/ingestion/ingestion-workflow",
          "osdu/platform/system/reference/crs-catalog-service",
        ].map((source) => failedRead("master", "timeout", source)),
      }}
      sweep={null}
      now={now}
    />,
  );
  try {
    const rows = failedRows(view.container);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.querySelector(".sweep-name")?.textContent).toBe("Upstream GitLab");
    expect(rows[0]?.querySelector(".sweep-outcome")?.textContent).toBe(
      "GitLab timed out · indexer, search, workflow, crs-catalog",
    );
    expect(rows[0]?.textContent).not.toMatch(/osdu\/|indexer-service|crs-catalog-service/);
  } finally {
    await view.cleanup();
  }
});

it("keeps core diagnostics out of the row's accessible name and description", async () => {
  const view = await render(
    <SweepEvidence
      snapshot={{ ...snapshot(areas()), reads: [failedRead("Azure/osdu-spi-storage")] }}
      sweep={null}
      now={now}
    />,
  );
  try {
    const row = failedRows(view.container)[0];
    expect(row?.getAttribute("aria-label")).toBe(
      "GitHub issues and PRs · GitHub timed out · storage",
    );
    expect(row?.hasAttribute("title")).toBe(false);
    expect(row?.hasAttribute("aria-description")).toBe(false);
    const diagnostics = [...(row?.querySelectorAll("[title]") ?? [])];
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.getAttribute("title")).toContain(gatewayFailure);
    for (const diagnostic of diagnostics)
      expect(diagnostic.closest('[aria-hidden="true"]')).not.toBeNull();
  } finally {
    await view.cleanup();
  }
});

it("groups five gateway failures by source and cause, naming services once without core text inline", async () => {
  const services = ["storage", "indexer", "search", "workflow", "indexer-queue"];
  const reads = services.map((service, index) =>
    failedRead(`Azure/osdu-spi-${service}`, gatewayFailure.replace("54881", String(54881 + index))),
  );
  const list = committed();
  list.sources = list.sources.map((source) =>
    source.source === "github"
      ? {
          source: "github",
          state: "cut",
          incomplete: { count: 0, total: 14, failed: 5 },
          failure: `Reads failed for 5 services: ${services.join(", ")}.`,
        }
      : source,
  );
  const view = await render(
    <SweepEvidence
      snapshot={{ ...snapshot(areas()), reads: [...reads, ...reads] }}
      completed={list}
      sweep={null}
      now={now}
    />,
  );
  try {
    const rows = failedRows(view.container);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.querySelector(".sweep-name")?.textContent).toBe("GitHub issues and PRs");
    expect(rows[0]?.querySelector(".sweep-outcome")?.textContent).toBe(
      `GitHub timed out · ${services.join(", ")}`,
    );
    expect(rows[0]?.getAttribute("data-tone")).toBe("bad");
    expect(rows[0]?.querySelector("[title]")?.getAttribute("title")).toContain(gatewayFailure);
    expect(view.container.textContent).not.toMatch(
      /gh api graphql|HTTP 504|bytes of HTML|gateway error/,
    );
    expect(view.container.querySelector('[data-source="github"] .sweep-why')?.textContent).toBe(
      `Reads failed for 5 services: ${services.join(", ")}.`,
    );
  } finally {
    await view.cleanup();
  }
});

const failureWords = {
  signin: "signed out",
  budget: "waits for GitHub budget",
  throttled: "GitHub asked to slow down",
  cadence: "not due this sweep",
  limit: "read limit reached",
  unavailable: "GitHub unavailable",
  timeout: "GitHub timed out",
  save: "could not save the sweep",
  other: "read failed",
};

it.each([
  ...SweepReasonCodeSchema.options.map((code) => [code, failureWords[code]]),
  ["NOT_FOUND", "not found"],
  ["http_401", "signed out"],
  ["http_403", "access denied"],
  ["gh: HTTP 403: You have exceeded a secondary rate limit.", "GitHub asked to slow down"],
  ["http_404", "not found"],
  ["http_429", "GitHub asked to slow down"],
  ["http_503", "GitHub unavailable"],
  ["a future failure code", "read failed"],
])("uses window words for failure %s", async (failure, words) => {
  const view = await render(
    <SweepEvidence
      snapshot={{ ...snapshot(areas()), reads: [failedRead("Azure/osdu-spi-storage", failure)] }}
      sweep={null}
      now={now}
    />,
  );
  try {
    expect(failedRows(view.container)[0]?.querySelector(".sweep-outcome")?.textContent).toBe(
      `${words} · storage`,
    );
  } finally {
    await view.cleanup();
  }
});

it.each([
  ["security", "unavailable", "unavailable"],
  ["runs", "timeout", "timed out"],
  ["gitlab", "budget", "waits for GitLab budget"],
])("uses window wording for %s failure %s", async (source, failure, words) => {
  const view = await render(
    <SweepEvidence
      snapshot={{
        ...snapshot(areas()),
        reads: [failedRead("Azure/osdu-spi-storage", failure, source)],
      }}
      sweep={null}
      now={now}
    />,
  );
  try {
    expect(failedRows(view.container)[0]?.querySelector(".sweep-outcome")?.textContent).toBe(
      `${words} · storage`,
    );
  } finally {
    await view.cleanup();
  }
});

it("keeps distinct sources and causes separate and two-column even in a wide panel", async () => {
  const style = document.createElement("style");
  style.textContent = readFileSync("apps/window/src/components/evidence/evidence.css", "utf8");
  document.head.append(style);
  const view = await render(
    <SweepEvidence
      snapshot={{
        ...snapshot(areas()),
        reads: [
          failedRead("Azure/osdu-spi-storage"),
          failedRead("Azure/osdu-spi-indexer", "NOT_FOUND"),
          failedRead("osdu/platform/system/search", "timeout", "gitlab"),
        ],
      }}
      sweep={null}
      now={now}
    />,
  );
  try {
    const rows = failedRows(view.container);
    expect(rows.map((row) => row.querySelector(".sweep-outcome")?.textContent)).toEqual([
      "GitHub timed out · storage",
      "not found · indexer",
      "GitLab timed out · search",
    ]);
    for (const row of rows)
      expect(getComputedStyle(row).gridTemplateColumns).toBe("16px minmax(0, 1fr)");
  } finally {
    await view.cleanup();
    style.remove();
  }
});

it("tones the freshness dot of the first sweep by its worst source: cut is warn, failed is bad, all fresh is green", () => {
  const glyph = (body: ReturnType<typeof firstSweep>) =>
    freshnessGlyph({
      sources: sweepSources(body).map(({ envelope }) => envelope),
      sweptAt,
    });
  const cutOnly = firstSweep();
  expect(glyph(cutOnly)).toMatchObject({ tail: " · 2", tone: "warn" });
  const failed = {
    ...cutOnly,
    areas: cutOnly.areas.map((entry) =>
      entry.area === "github"
        ? (areas({ github: { state: "failed" } }).find(({ area }) => area === "github") ?? entry)
        : entry,
    ),
  };
  expect(glyph(failed)).toMatchObject({ tail: " · 3", tone: "bad" });
  expect(glyph({ ...cutOnly, areas: areas() })).toMatchObject({ tail: "", tone: "fresh" });
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
        ["GitHub issues and PRs", "fresh", "fresh, last read 2\u00a0min ago, complete"],
        ["Workflow runs", "stale", "stale, last read 23\u00a0min ago, complete"],
      ]);
      expect(view.rows("Reads for partition")).toEqual([
        [
          "GitHub issues and PRs · Azure/osdu-spi-partition",
          "cut",
          "read 4\u00a0min ago, cut, 40 of 52 · page limit",
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
    "stale · 23\u00a0min",
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
