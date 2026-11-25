// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  AREAS,
  type AreaEnvelope,
  type AreaName,
  type ReadRecord,
  type SweepProgress,
  SweepProgressSchema,
  type TodayLine,
  type TodayMember,
} from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
  type EvidenceRoute,
  openEvidence,
  openSelection,
  parseRoute,
  setOpenSelection,
} from "../../app/navigation.js";
import { clockTime } from "../../time.js";
import { EvidencePage, type EvidenceSnapshot } from "./EvidencePage.js";
import { AREA_NAMES } from "./words.js";

const now = Date.parse("2026-11-17T01:10:00Z");
const previousZone = process.env.TZ;
process.env.TZ = "UTC";
vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(now);
afterAll(() => {
  vi.useRealTimers();
  if (previousZone === undefined) delete process.env.TZ;
  else process.env.TZ = previousZone;
});

const sweptAt = "2026-11-17T01:06:12Z";
const at = (minutes: number) => new Date(Date.parse(sweptAt) - minutes * 60_000).toISOString();

const areas: AreaEnvelope[] = AREAS.map((area) => ({
  area,
  envelope: {
    source: area,
    state: "fresh",
    observedAt: at(area === "details" ? 14 : 1),
    completeness: { kind: "complete" },
  },
}));

const member = (
  id: string,
  fork: string,
  evidence: Partial<TodayMember["evidence"]> = {},
): TodayMember => ({
  id,
  ids: [id],
  fork,
  cause: "",
  effect: "",
  steps: [],
  evidence: { areas: ["github", "details"], attributed: "item", notRead: [], ...evidence },
});

const line = (id: string, subject: string, members: TodayMember[]): TodayLine => ({
  id,
  section: "waiting",
  subject,
  headline: `${subject} headline`,
  cause: "",
  effect: "",
  steps: [],
  members,
});

const LINES: TodayLine[] = [
  line("waiting:gate2:storage", "storage", [
    member("gate2:storage", "storage", { notRead: ["Validation Summary job"] }),
  ]),
  line("waiting:upgrade:os-core-common", "2 forks", [
    member("gate1:storage", "storage", { areas: ["github", "upstream"] }),
    member("gate1:indexer", "indexer", {
      areas: ["github", "upstream"],
      notRead: ["Whether the other lanes have drained"],
    }),
  ]),
  line("waiting:radar:partition", "partition", [
    member("radar:partition", "partition", { attributed: "sweep", areas: [...AREAS] }),
  ]),
];

const readRecord = (source: string, object: string, minutes = 2): ReadRecord => ({
  source,
  object,
  observedAt: at(minutes),
  completeness: { kind: "complete" },
});

const READS: ReadRecord[] = [
  readRecord("Azure/osdu-spi-storage", "port PRs"),
  readRecord("Azure/osdu-spi-storage", "main:pom.xml", 3),
  readRecord("osdu/platform/system/storage", "merged MRs"),
  readRecord("Azure/osdu-spi-indexer", "port PRs"),
  readRecord("osdu/platform/system/indexer-service", "merged MRs"),
  readRecord("osdu/platform/system/indexer-service", "merge_requests/1248/diffs", 4),
  readRecord("Azure/osdu-spi-partition", ".github/upstream-filter.yml"),
  readRecord("osdu/platform/system/partition", "repository/tree?ref=master"),
  readRecord("Azure/osdu-spi-legal", "port PRs"),
];

const snapshot: EvidenceSnapshot = {
  sweptAt,
  areas,
  provenance: [],
  reads: READS,
  briefing: { lines: LINES },
};

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  setOpenSelection(null);
  window.location.hash = "";
});

async function render(
  route: EvidenceRoute,
  body = snapshot,
  completed: SweepProgress | null = null,
) {
  await cleanup?.();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const draw = (shown: EvidenceRoute) =>
    act(async () =>
      root.render(
        <EvidencePage route={shown} snapshot={body} sweep={null} completed={completed} now={now} />,
      ),
    );
  await draw(route);
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  const page = container.querySelector<HTMLElement>("[data-evidence-page]");
  return {
    page,
    /** Renders the route the location hash names now, as the window does after navigating. */
    follow: () => draw(parseRoute(window.location.hash) as EvidenceRoute),
    parts: () =>
      [...(page?.querySelectorAll("[data-evidence-part]") ?? [])].map((part) =>
        part.getAttribute("data-evidence-part"),
      ),
    headings: () => [...(page?.querySelectorAll("h3") ?? [])].map((h) => h.textContent),
    names: (label: string) =>
      [
        ...(page?.querySelectorAll(
          `table[aria-label="${label}"] th, ul[aria-label="${label}"] .evidence-read-object`,
        ) ?? []),
      ].map((name) => name.textContent),
    click: (selector: string) =>
      act(async () => page?.querySelector<HTMLButtonElement>(selector)?.click()),
  };
}

const item = (id: string): EvidenceRoute => ({
  kind: "evidence",
  from: { kind: "today" },
  selection: { kind: "item", id },
});

it("lists an item's not-read first, then its fork's reads with times, then its areas", async () => {
  const view = await render(item("gate2:storage"));
  expect(view.parts()).toEqual(["not-read", "reads", "areas"]);
  expect(view.headings()).toEqual(["Not read", "Reads of Azure/osdu-spi-storage", "Areas"]);
  expect(view.page?.querySelector(".evidence-not-read")?.textContent).toBe(
    "⌀ Validation Summary job",
  );
  expect(view.names("Reads of Azure/osdu-spi-storage")).toEqual(["port PRs", "main · pom.xml"]);
  expect(view.names("Areas")).toEqual([AREA_NAMES.github, AREA_NAMES.details]);
  expect(
    view.page?.querySelector('tr[data-source="details"] td[title]')?.getAttribute("title"),
  ).toContain("14 min before the sweep ended");
  expect(view.page?.textContent).toContain("SPI Code read this item from these areas.");
  expect(view.page?.textContent).not.toMatch(/GitLab|indexer|partition/);
});

it("lists a group's not-read, the reads of each member fork, then GitLab's for upstream work", async () => {
  const view = await render({
    kind: "evidence",
    selection: { kind: "line", id: "waiting:upgrade:os-core-common" },
  });
  expect(view.parts()).toEqual(["not-read", "reads", "gitlab-reads", "gitlab-reads", "areas"]);
  expect(view.headings()).toEqual([
    "Not read",
    "Reads of the forks in this row",
    "Reads of GitLab osdu/platform/system/storage",
    "Reads of GitLab osdu/platform/system/indexer-service",
    "Areas",
  ]);
  expect(view.names("Reads of the forks in this row")).toEqual([
    "storage · port PRs",
    "storage · main · pom.xml",
    "indexer · port PRs",
  ]);
  expect(view.names("Reads of GitLab osdu/platform/system/indexer-service")).toEqual(["2 reads"]);
  expect(view.names("Areas")).toEqual([AREA_NAMES.github, AREA_NAMES.upstream]);
});

it("lists an upstream item's fork reads, then its GitLab project's, then the sweep's areas", async () => {
  const view = await render(item("radar:partition"));
  expect(view.parts()).toEqual(["reads", "gitlab-reads", "areas"]);
  expect(view.headings()).toEqual([
    "Reads of Azure/osdu-spi-partition",
    "Reads of GitLab osdu/platform/system/partition",
    "Areas",
  ]);
  expect(view.names("Areas")).toEqual(AREAS.map((area) => AREA_NAMES[area]));
  expect(view.page?.textContent).toContain("so this is the sweep's list");
});

it("says a fork has no reads rather than borrowing another fork's", async () => {
  const bare = { ...snapshot, reads: READS.filter(({ source }) => !source.endsWith("storage")) };
  const view = await render(item("gate2:storage"), bare);
  expect(view.parts()).toEqual(["not-read", "reads", "areas"]);
  expect(view.page?.querySelector("[aria-label^='Reads of']")).toBeNull();
  expect(view.page?.textContent).toContain("No reads recorded for storage.");
});

it("goes back to the page and selection it came from, through Whole sweep", async () => {
  window.location.hash = "#service/storage";
  openEvidence({ kind: "item", id: "gate2:storage" });
  const view = await render(parseRoute(window.location.hash) as EvidenceRoute);
  expect(view.page?.querySelector("[data-evidence-back]")?.textContent).toBe("‹ storage");
  await view.click("[data-evidence-whole]");
  await view.follow();
  expect(view.page?.querySelector("[data-evidence-whole]")).toBeNull();
  expect(view.page?.querySelector('[data-evidence="sweep"]')).not.toBeNull();
  await view.click("[data-evidence-back]");
  expect(window.location.hash).toBe("#service/storage");
  expect(openSelection()).toEqual({ kind: "item", id: "gate2:storage" });
});

it("shows every area on the whole sweep and goes back to Today when it came from nowhere", async () => {
  const whole = await render({ kind: "evidence" });
  expect(whole.page?.querySelector("[data-evidence-back]")?.textContent).toBe("‹ Today");
  expect(whole.page?.querySelector("[data-evidence-whole]")).toBeNull();
  const sources = [
    ...(whole.page?.querySelectorAll('[aria-label="Sources"] .sweep-row .sweep-name') ?? []),
  ].map((name) => name.textContent);
  expect(sources).toEqual(AREAS.map((area: AreaName) => AREA_NAMES[area]));
});

const clock = (minutes: number) => clockTime(at(minutes), { now, hint: false });
/** details failed but kept a read from 18 minutes before; github failed and kept nothing. */
const failing: EvidenceSnapshot = {
  ...snapshot,
  areas: areas.map((entry) =>
    entry.area === "details"
      ? {
          area: "details",
          envelope: {
            source: "details",
            state: "failed",
            observedAt: at(18),
            completeness: { kind: "cut", reason: "limit", read: 3, total: 9 },
          },
        }
      : entry.area === "github"
        ? {
            area: "github",
            envelope: { source: "github", state: "failed", completeness: { kind: "complete" } },
          }
        : entry.area === "auth"
          ? { area: "auth", envelope: { source: "auth", state: "unread" } }
          : entry,
  ),
};

it("gives a selection's failed areas their observed time and completeness, or says none was observed", async () => {
  const view = await render(item("gate2:storage"), failing);
  const fact = (area: AreaName) =>
    view.page
      ?.querySelector(`table[aria-label="Areas"] tr[data-source="${area}"] td:last-child`)
      ?.textContent?.trim();
  expect(fact("details")).toBe(`failed · showing ${clock(18)}`);
  expect(fact("github")).toBe("failed · nothing kept");
});

const START = at(3);
const after = (seconds: number) => new Date(Date.parse(START) + seconds * 1000).toISOString();
const SERVICES = ["storage", "indexer", "search", "workflow", "indexer-queue"];
const read = (source: string) => ({ source, state: "read", startedAt: START, endedAt: after(4) });
const partly = {
  source: "github",
  state: "cut",
  startedAt: START,
  endedAt: after(22),
  incomplete: { count: 0, total: 14, failed: 5 },
  failure: `Reads failed for 5 services: ${SERVICES.join(", ")}.`,
};
const sweepOf = (sources: readonly object[]) =>
  SweepProgressSchema.parse({
    sweep: "sweep-2",
    startedAt: START,
    first: false,
    usualMs: null,
    outcome: "committed",
    nextAttemptAt: null,
    sources,
  });
const timedOut = (service: string): ReadRecord => ({
  ...readRecord(`Azure/osdu-spi-${service}`, "pull requests", 1),
  failure: "gh api graphql: HTTP 504 gateway timeout",
  retainedFrom: at(40),
});
const envelopes = (values: Partial<Record<AreaName, Partial<AreaEnvelope["envelope"]>>>) =>
  areas.map(
    (entry): AreaEnvelope =>
      values[entry.area]
        ? {
            area: entry.area,
            envelope: { ...entry.envelope, ...values[entry.area] } as AreaEnvelope["envelope"],
          }
        : entry,
  );
/** The 17 Nov sweep: GitHub read but five services timed out, keeping data from 40 min before. */
const partial: EvidenceSnapshot = {
  ...snapshot,
  areas: envelopes({ github: { state: "failed", observedAt: at(40) } }),
  reads: SERVICES.map(timedOut),
};
const partialSweep = sweepOf(AREAS.map((source) => (source === "github" ? partly : read(source))));

const rowOf = (page: HTMLElement | null, source: string) => {
  const row = page?.querySelector(`.sweep-row[data-source="${source}"]`);
  return {
    tone: row?.getAttribute("data-tone"),
    phrase: row?.querySelector(".sweep-outcome")?.textContent,
    line: row?.querySelector(".sweep-why")?.textContent,
    title: row?.querySelector(".sweep-outcome")?.getAttribute("title"),
    name: row?.getAttribute("aria-label"),
  };
};
const UNSAID = /\bcomplete\b|skipped|before the sweep ended/;

it("says the 17 Nov partial GitHub failure once, in amber, with no Failed reads section", async () => {
  const view = await render({ kind: "evidence" }, partial, partialSweep);
  const github = rowOf(view.page, "github");
  expect(github.phrase).toBe("read · 22 s · 5 reads failed");
  expect(github.line).toBe(
    `GitHub timed out: ${SERVICES.join(", ")}. Showing data from ${clock(40)}.`,
  );
  expect(github.tone).toBe("warn");
  const text = view.page?.textContent ?? "";
  expect(text.split(SERVICES.join(", ")).length - 1).toBe(1);
  expect(text.split("timed out").length - 1).toBe(1);
  expect(view.headings()).toEqual(["Read this sweep"]);
  expect(view.page?.querySelector(".evidence-failures")).toBeNull();
  expect(view.page?.querySelector(".evidence-band")?.getAttribute("data-tone")).toBe("warn");
  expect(view.page?.querySelectorAll('[data-tone="bad"]')).toHaveLength(0);
  expect(github.title).toContain(`Read failed, kept data observed ${clock(40)}`);
  expect(text).not.toMatch(UNSAID);
});

it("keeps a failure no source row shows in Failed reads", async () => {
  const saving: ReadRecord = { ...readRecord("persist", "save", 1), failure: "disk full" };
  const view = await render(
    { kind: "evidence" },
    { ...partial, reads: [...partial.reads, saving] },
    partialSweep,
  );
  expect(view.headings()).toEqual(["Read this sweep", "Failed reads"]);
  expect(
    [...(view.page?.querySelectorAll(".evidence-failure") ?? [])].map((row) =>
      row.getAttribute("aria-label"),
    ),
  ).toEqual(["Local state · read failed"]);
  expect(rowOf(view.page, "github").line).toContain("GitHub timed out");
});

/** One area per row kind, beside a sweep that read the rest in 4 s. */
const kinds: EvidenceSnapshot = {
  ...snapshot,
  areas: envelopes({
    upstream: { state: "failed", observedAt: at(20) },
    radar: { state: "failed", observedAt: undefined },
    security: {
      state: "incomplete",
      completeness: { kind: "cut", reason: "page_limit", read: 40, total: 52 },
    },
  }),
};
const failedSource = (source: string, reason: string) => ({
  source,
  state: "failed",
  startedAt: START,
  endedAt: after(1),
  code: "timeout",
  reason,
});
const cutSource = (source: string, incomplete: { count: number; total: number }) => ({
  source,
  state: "cut",
  startedAt: START,
  endedAt: after(4),
  incomplete,
  code: "limit",
  reason: "Some reads reached a page or size limit.",
});
const kindsSweep = sweepOf(
  AREAS.map((source) =>
    source === "details"
      ? { source, state: "skipped" }
      : source === "upstream"
        ? failedSource(source, "GitLab did not answer in time.")
        : source === "radar"
          ? failedSource(source, "GitLab did not answer in time.")
          : source === "security"
            ? cutSource(source, { count: 1, total: 1 })
            : read(source),
  ),
);

it.each([
  [
    "read this sweep, complete",
    "fleet",
    "ok",
    "read · 4 s",
    `Fresh, observed ${clock(1)}, 1 min before the sweep ended, complete.`,
  ],
  [
    "not due this sweep",
    "details",
    "idle",
    `last read ${clock(14)}`,
    `Fresh, observed ${clock(14)}, 14 min before the sweep ended, complete.`,
  ],
  [
    "read this sweep, cut",
    "security",
    "warn",
    "read · 4 s · 40 of 52 read",
    `0 of 1 read complete. Some reads reached a page or size limit. Cut, observed ${clock(1)}, 1 min before the sweep ended, 40 of 52 read.`,
  ],
  [
    "failed, data kept",
    "upstream",
    "bad",
    `failed · showing ${clock(20)}`,
    `Read failed, kept data observed ${clock(20)}, 20 min before the sweep ended, complete.`,
  ],
  [
    "failed, nothing kept",
    "radar",
    "bad",
    "failed · nothing kept",
    "Read failed, nothing kept, not observed, complete.",
  ],
] as const)(
  "says a source %s in one phrase, with Ruling J in its title",
  async (_, source, tone, phrase, title) => {
    const view = await render({ kind: "evidence" }, kinds, kindsSweep);
    const row = rowOf(view.page, source);
    expect(row.tone).toBe(tone);
    expect(row.phrase).toBe(phrase);
    expect(row.title).toBe(title);
    expect(row.name).toBe(`${AREA_NAMES[source]} · ${phrase}. ${title}`);
    if (tone === "bad") expect(row.line).toBe("GitLab did not answer in time.");
    expect(view.page?.textContent).not.toMatch(UNSAID);
  },
);

it("says a cut read's n of m from the sweep when the snapshot holds the previous read", async () => {
  const later = SweepProgressSchema.parse({
    ...sweepOf(
      AREAS.map((source) =>
        source === "runs"
          ? { ...cutSource(source, { count: 6, total: 13 }), cutKind: "run-list" }
          : read(source),
      ),
    ),
    startedAt: new Date(Date.parse(sweptAt) + 60_000).toISOString(),
  });
  const view = await render({ kind: "evidence" }, kinds, later);
  expect(rowOf(view.page, "runs").phrase).toBe("read · 4 s · 7 of 13 read");
  expect(view.page?.textContent).not.toMatch(/cut short/);
});

const unreadable = (service: string): ReadRecord => ({
  ...readRecord(`Azure/osdu-spi-${service}`, `main:provider/${service}-azure/pom.xml`, 1),
  failure: `main:provider/${service}-azure/pom.xml is not readable`,
});

it("says Template's failed reads once, on its row, and keeps an unrelated GitHub failure", async () => {
  const forked = ["unit", "crs-catalog", "crs-conversion"];
  const denied: ReadRecord = {
    ...readRecord("Azure/osdu-spi-legal", "pull requests", 1),
    failure: "HTTP 403 forbidden",
  };
  const view = await render(
    { kind: "evidence" },
    { ...snapshot, reads: [...forked.map(unreadable), denied] },
    sweepOf(
      AREAS.map((source) =>
        source === "template"
          ? {
              ...partly,
              source,
              incomplete: { count: 0, total: 24, failed: 3 },
              failure: `Reads failed for 3 services: ${forked.join(", ")}.`,
            }
          : read(source),
      ),
    ),
  );
  const template = rowOf(view.page, "template");
  expect(template.tone).toBe("warn");
  expect(template.line).toBe(`Read failed: ${forked.join(", ")}.`);
  const text = view.page?.textContent ?? "";
  expect(text.split(forked.join(", ")).length - 1).toBe(1);
  expect(
    [...(view.page?.querySelectorAll(".evidence-failure") ?? [])].map((row) =>
      row.getAttribute("aria-label"),
    ),
  ).toEqual(["GitHub issues and PRs · access denied · legal"]);
});

it("says every cause of a failed source's reads on its row, beside its own reason", async () => {
  const mixed = [
    timedOut("storage"),
    { ...timedOut("indexer"), failure: "HTTP 403 access denied" },
  ];
  const failed = sweepOf(
    AREAS.map((source) =>
      source === "github" ? failedSource(source, "GitHub did not answer in time.") : read(source),
    ),
  );
  const view = await render({ kind: "evidence" }, { ...partial, reads: mixed }, failed);
  expect(rowOf(view.page, "github").line).toBe(
    "GitHub timed out: storage; access denied: indexer.",
  );
  expect(view.page?.querySelector(".evidence-failures")).toBeNull();
  const text = view.page?.textContent ?? "";
  expect(text.split("access denied").length - 1).toBe(1);
  expect(text.split("timed out").length - 1).toBe(1);

  const other = await render(
    { kind: "evidence" },
    { ...partial, reads: [mixed[1] as ReadRecord] },
    failed,
  );
  expect(rowOf(other.page, "github").line).toBe(
    "GitHub did not answer in time. Access denied: indexer.",
  );
  expect(other.page?.querySelector(".evidence-failures")).toBeNull();
});

it.each([
  [
    "fresh this sweep",
    "fleet",
    "fresh",
    `Fresh, observed ${clock(1)}, 1 min before the sweep ended, complete.`,
  ],
  [
    "fresh before it",
    "details",
    `fresh · from ${clock(14)}`,
    `Fresh, observed ${clock(14)}, 14 min before the sweep ended, complete.`,
  ],
  [
    "failed, data kept",
    "details",
    `failed · showing ${clock(18)}`,
    `Read failed, kept data observed ${clock(18)}, 18 min before the sweep ended, 3 of 9 read.`,
  ],
  [
    "failed, nothing kept",
    "github",
    "failed · nothing kept",
    "Read failed, nothing kept, not observed, complete.",
  ],
  [
    "cut",
    "security",
    "cut · 40 of 52 read",
    `Cut, observed ${clock(1)}, 1 min before the sweep ended, 40 of 52 read.`,
  ],
  ["not read", "auth", "not read yet", "Not read yet, not observed."],
] as const)(
  "says an area %s in one phrase on sweep and selection pages without the sweep's list",
  async (label, area, phrase, title) => {
    const body =
      label.startsWith("failed") || label === "not read"
        ? failing
        : label === "cut"
          ? kinds
          : snapshot;
    for (const route of [{ kind: "evidence" } as EvidenceRoute, item("radar:partition")]) {
      const view = await render(route, body);
      const row = view.page?.querySelector(`[data-source="${area}"]`);
      const outcome = row?.querySelector(route.selection ? "td[data-state]" : ".sweep-outcome");
      expect(outcome?.textContent?.trim()).toBe(phrase);
      expect(outcome?.getAttribute("title")).toBe(title);
      expect(row?.getAttribute("aria-label")).toBe(`${AREA_NAMES[area]} · ${phrase}. ${title}`);
      expect(view.page?.textContent).not.toMatch(UNSAID);
    }
  },
);

it("keeps a logged read with no observation in the snapshot as read, not as unread", async () => {
  const view = await render(
    { kind: "evidence" },
    failing,
    sweepOf(AREAS.map((source) => read(source))),
  );
  const row = rowOf(view.page, "auth");
  expect(row.phrase).toBe("read · 4 s · no observation recorded in this snapshot");
  expect(row.title).toBe("No observation recorded in this snapshot.");
});

it("says a selection the briefing no longer holds is gone and keeps Whole sweep", async () => {
  const view = await render(item("gate2:gone"));
  expect(view.page?.querySelector(".evidence-lede")?.textContent).toContain(
    "This selection is no longer on Today",
  );
  expect(view.parts()).toEqual([]);
  expect(view.page?.querySelector("[data-evidence-whole]")).not.toBeNull();
});

const pageVariants = [
  ["fresh", snapshot, null],
  ["failed", failing, null],
  ["cut", kinds, kindsSweep],
  ["cut without sweep list", kinds, null],
  ["not due", snapshot, kindsSweep],
  ["partial failure", partial, partialSweep],
] as const;
const routes: readonly (readonly [string, EvidenceRoute])[] = [
  ["whole sweep", { kind: "evidence" }],
  ["item", item("radar:partition")],
  [
    "group",
    { kind: "evidence", selection: { kind: "line", id: "waiting:upgrade:os-core-common" } },
  ],
];

it.each(
  routes.flatMap(([scope, route]) =>
    pageVariants.map(([state, body, completed]) => ({ scope, route, state, body, completed })),
  ),
)(
  "keeps old row verbiage off the $scope Evidence page, $state",
  async ({ route, body, completed }) => {
    const view = await render(route, body, completed);
    expect(view.page).not.toBeNull();
    expect(view.page?.textContent).not.toMatch(UNSAID);
  },
);

it.each(["read", "cut", "skipped"] as const)(
  "selected Evidence distinguishes logged areas from unread areas (%s)",
  async (state) => {
    const body = structuredClone(snapshot);
    body.areas = body.areas.map((area) =>
      area.area === "details"
        ? { area: "details", envelope: { state: "unread", source: "details" } }
        : area,
    );
    const completed = sweepOf([
      {
        source: "details",
        state,
        ...(state === "cut" ? { incomplete: { count: 1, total: 2 } } : {}),

        startedAt: START,
        endedAt: after(4),
      },
    ]);
    const view = await render(
      { kind: "evidence", selection: { kind: "item", id: "gate2:storage" } },
      body,
      completed,
    );
    expect(view.page?.querySelector('[data-source="details"] td')?.getAttribute("title")).toBe(
      state === "skipped"
        ? "Not read yet, not observed."
        : "No observation recorded in this snapshot.",
    );
  },
);
