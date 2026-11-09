// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { type SweepProgress, SweepProgressSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { closeSheet } from "../../app/navigation.js";
import { Shell } from "../../app/Shell.js";
import { selectionStore } from "../../panels/selection.js";
import { watchStore } from "../../store/watch.js";
import { clockTime } from "../../time.js";
import { applyContainerRules } from "./container-rules.test-helper.js";
import { SweepSources } from "./SweepSources.js";
import { after, midSweep, SWEEP_START } from "./test-helper.js";
import { failedCount } from "./words.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function render(progress: SweepProgress, seconds = 130, host: Element = document.body) {
  const container = document.createElement("div");
  host.append(container);
  const root = createRoot(container);
  const onOpenSettings = vi.fn();
  await act(async () =>
    root.render(
      <SweepSources
        progress={progress}
        now={SWEEP_START + seconds * 1000}
        onOpenSettings={onOpenSettings}
      />,
    ),
  );
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return { container, onOpenSettings };
}

const all = (container: Element, selector: string) =>
  [...container.querySelectorAll(selector)].map((element) => element.textContent);
const row = (container: Element, source: string) =>
  container.querySelector(`.sweep-row[data-source="${source}"]`);
const clock = (at: string) => clockTime(at, { now: SWEEP_START + 130_000, hint: false });

function withSource(source: SweepProgress["sources"][number]): SweepProgress {
  const progress = midSweep();
  return SweepProgressSchema.parse({
    ...progress,
    sources: progress.sources.map((entry) => (entry.source === source.source ? source : entry)),
  });
}

it("draws twelve rows in sweep order in the Evidence names, what each reads and how it went", async () => {
  const { container } = await render(midSweep());
  expect(all(container, ".sweep-name")).toEqual([
    "Sign-in",
    "Fleet membership",
    "GitHub issues and PRs",
    "Workflow runs",
    "Run approvals",
    "Stack lifecycle runs",
    "Template",
    "Run details",
    "Upstream GitLab",
    "Upstream radar",
    "Security alerts",
    "Release lines",
  ]);
  expect(all(container, ".sweep-what")).toEqual([
    "gh and glab",
    "forks, stack and rollout",
    "pull requests and checks",
    "main and cascade on each fork",
    "runs waiting for approval",
    "deploys on the stack repo",
    "template revision per fork",
    "logs of failed checks",
    "GitLab master per fork",
    "open merge requests upstream",
    "code scanning on each fork",
    "release PRs and tags",
  ]);
  expect(all(container, ".sweep-outcome")).toEqual([
    "read · 3 s",
    "read · 9 s",
    "read · 31 s",
    "read · 52 s · 6 run lists cut short; rest read",
    "read · 4 s",
    "read · 12 s",
    "read · 6 s · 2 reads failed",
    `waits for GitHub budget · after ${clock("2026-11-09T09:10:00Z")}`,
    "failed",
    "reading · 14 s",
    "waiting",
    "waiting",
  ]);
  expect(all(container, ".sweep-after")).toEqual([`after ${clock("2026-11-09T09:10:00Z")}`]);
  expect(all(container, ".sweep-mark")).toEqual([
    "✓",
    "✓",
    "✓",
    "⚠",
    "✓",
    "✓",
    "⚠",
    "–",
    "✕",
    "◐",
    "○",
    "○",
  ]);
  expect(row(container, "details")?.querySelector("time")?.getAttribute("datetime")).toBe(
    "2026-11-09T09:10:00Z",
  );
  expect(container.querySelector(".sweep-meta")?.textContent).toBe(
    "2 min 10 s so far · 1 source failed",
  );
});

it.each([
  {
    source: "lifecycle",
    cutKind: "job-log",
    count: 1,
    total: 69,
    reason: "Job log character limit: 64,000 of 92,438 characters read.",
    outcome: "read · 12 s · 1 job log cut short; rest read",
    detail: "68 of 69 reads complete. Job log character limit: 64,000 of 92,438 characters read.",
  },
  {
    source: "radar",
    cutKind: "diff",
    count: 14,
    total: 200,
    reason: "Oversized or collapsed diffs: 1,607 of 1,696 files read.",
    outcome: "read · 12 s · 14 diffs cut short; rest read",
    detail: "186 of 200 reads complete. Oversized or collapsed diffs: 1,607 of 1,696 files read.",
  },
  {
    source: "lifecycle",
    cutKind: "job-log",
    count: 2,
    total: 2,
    reason: "Job log character limit: 128,000 of 184,876 characters read.",
    outcome: "read · 12 s · 2 job logs cut short",
    detail: "0 of 2 reads complete. Job log character limit: 128,000 of 184,876 characters read.",
  },
  {
    source: "lifecycle",
    cutKind: "job-log",
    count: 1,
    total: 1,
    reason: "Job log character limit: 64,000 of 92,438 characters read.",
    outcome: "read · 12 s · 1 job log cut short",
    detail: "0 of 1 read complete. Job log character limit: 64,000 of 92,438 characters read.",
  },
] as const)(
  "names the cut reads and what was read for $count of $total $cutKind cuts",
  async (example) => {
    const { container } = await render(
      withSource({
        source: example.source,
        state: "cut",
        startedAt: after(0),
        endedAt: after(12),
        code: "limit",
        reason: example.reason,
        cutKind: example.cutKind,
        incomplete: { count: example.count, total: example.total },
      }),
    );
    const outcome = row(container, example.source)?.querySelector(".sweep-outcome");
    expect(outcome?.textContent).toBe(example.outcome);
    expect(outcome?.getAttribute("title")).toBe(example.detail);
    expect(outcome?.getAttribute("aria-description")).toBe(example.detail);
    expect(container.textContent).not.toContain("incomplete");
  },
);

it.each([
  {
    name: "the recorded radar sweep",
    source: "radar",
    cut: {
      code: "limit",
      cutKind: "diff",
      reason: "Oversized or collapsed diffs: 1,607 of 1,696 files read.",
    },
    incomplete: { count: 14, total: 361, failed: 3 },
    failure: "Reads failed for 3 services: unit, crs-catalog, crs-conversion.",
    outcome: "read · 12 s · 14 diffs cut short; 3 reads failed",
    detail: "344 of 361 reads complete. Oversized or collapsed diffs: 1,607 of 1,696 files read.",
  },
  {
    name: "one failed read and no cut",
    source: "template",
    cut: {},
    incomplete: { count: 0, total: 24, failed: 1 },
    failure: "Reads failed for 1 service: unit.",
    outcome: "read · 12 s · 1 read failed",
    detail: "23 of 24 reads complete.",
  },
] as const)(
  "marks a partly failed source as partial and names what failed: $name",
  async (example) => {
    const progress = withSource({
      source: example.source,
      state: "cut",
      startedAt: after(0),
      endedAt: after(12),
      ...example.cut,
      incomplete: example.incomplete,
      failure: example.failure,
    });
    const { container } = await render(progress);
    const line = row(container, example.source);
    const outcome = line?.querySelector(".sweep-outcome");
    expect(line?.querySelector(".sweep-mark")?.textContent).toBe("⚠");
    expect(line?.getAttribute("data-tone")).toBe("warn");
    expect(outcome?.textContent).toBe(example.outcome);
    expect(outcome?.getAttribute("aria-description")).toBe(example.detail);
    expect(line?.querySelector(".sweep-why")?.textContent).toBe(example.failure);
    expect(line?.textContent).not.toMatch(/rest read|Today will say|could not complete/);
    expect(failedCount(progress)).toBe(1);
    expect(container.querySelector(".sweep-meta")?.textContent).toMatch(/· 1 source failed$/);
  },
);

it("tones one bar segment per source like its row, with no percentage or countdown", async () => {
  const { container } = await render(midSweep());
  const bar = container.querySelector(".sweep-bar");
  expect(bar?.getAttribute("aria-hidden")).toBe("true");
  expect([...(bar?.children ?? [])].map((segment) => segment.getAttribute("data-tone"))).toEqual([
    "ok",
    "ok",
    "ok",
    "warn",
    "ok",
    "ok",
    "warn",
    "warn",
    "bad",
    "run",
    "wait",
    "wait",
  ]);
  expect(bar?.textContent).toBe("");
  expect(container.textContent).not.toMatch(/%|left|remaining/);
});

it("puts a sign-in failure's reason on the next line with Open Settings, branching on the code", async () => {
  const { container, onOpenSettings } = await render(midSweep());
  const upstream = row(container, "upstream");
  expect(upstream?.querySelector(".sweep-why")?.textContent).toBe(
    "glab is not signed in to community.opengroup.org.Open Settings",
  );
  await act(async () => upstream?.querySelector("button")?.click());
  expect(onOpenSettings).toHaveBeenCalledOnce();
  const other = await render(
    withSource({
      source: "upstream",
      state: "failed",
      startedAt: after(117),
      endedAt: after(118),
      code: "unavailable",
      reason: "glab is not signed in, says GitLab",
    }),
  );
  const failed = row(other.container, "upstream");
  expect(failed?.querySelector("button")).toBeNull();
  expect(failed?.querySelector(".sweep-why")?.textContent).toBe(
    "glab is not signed in, says GitLab. Today will say what is missing.",
  );
});

it.each(["upstream", "radar"] as const)(
  "offers Readiness on the failed %s row when core reports missing or signed-out glab as signin",
  async (source) => {
    const { container, onOpenSettings } = await render(
      withSource({
        source,
        state: "failed",
        startedAt: after(117),
        endedAt: after(118),
        code: "signin",
        reason: "A tool needs sign-in or access. Open Settings to check Readiness.",
      }),
    );
    const failed = row(container, source);
    const button = failed?.querySelector("button");
    expect(button?.textContent).toBe("Open Settings");
    await act(async () => button?.click());
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(failed?.textContent).not.toMatch(/ENOENT|Today will say/);
  },
);

it("says still reading past a minute and counts the meta line's sources failed", async () => {
  const progress = midSweep();
  const { container } = await render(
    SweepProgressSchema.parse({
      ...progress,
      sources: progress.sources.map((source) =>
        source.source === "auth"
          ? { ...source, state: "failed", code: "timeout", reason: "gh did not answer" }
          : source,
      ),
    }),
    186,
  );
  expect(row(container, "radar")?.querySelector(".sweep-outcome")?.textContent).toBe(
    "still reading · 1 min 10 s",
  );
  expect(container.querySelector(".sweep-meta")?.textContent).toBe(
    "3 min 6 s so far · 2 sources failed",
  );
});

it("tells a throttled source to wait for its resume time under the meta line", async () => {
  const { container } = await render(
    withSource({
      source: "radar",
      state: "throttled",
      startedAt: after(116),
      code: "throttled",
      reason: "Rate limited.",
      resumeAt: "2026-11-09T08:04:00Z",
    }),
  );
  expect(row(container, "radar")?.querySelector(".sweep-outcome")?.textContent).toBe(
    "reading · 14 s",
  );
  expect(container.querySelector(".sweep-throttled")?.textContent).toBe(
    `GitLab asked SPI Code to slow down. Resumes at ${clock("2026-11-09T08:04:00Z")}.`,
  );
  const github = await render(
    withSource({
      source: "security",
      state: "throttled",
      startedAt: after(120),
      code: "throttled",
      reason: "Rate limited.",
      resumeAt: "2026-11-09T08:04:00Z",
    }),
  );
  expect(github.container.querySelector(".sweep-throttled")?.textContent).toBe(
    `GitHub asked SPI Code to slow down. Resumes at ${clock("2026-11-09T08:04:00Z")}.`,
  );
});

it("marks skipped and put-off sources, with a put-off reason on the next line", async () => {
  const progress = midSweep();
  const { container } = await render(
    SweepProgressSchema.parse({
      ...progress,
      sources: [
        { source: "auth", state: "skipped" },
        {
          source: "fleet",
          state: "deferred",
          code: "cadence",
          reason: "Read less often",
          resumeAt: "2026-11-09T09:30:00Z",
        },
        { source: "github", state: "reading", startedAt: after(125) },
      ],
    }),
  );
  expect(all(container, ".sweep-outcome")).toEqual([
    "skipped",
    `put off · after ${clock("2026-11-09T09:30:00Z")}`,
    "reading · 5 s",
  ]);
  expect(all(container, ".sweep-mark")).toEqual(["–", "–", "◐"]);
  expect(row(container, "fleet")?.querySelector(".sweep-why")?.textContent).toBe(
    "Read less often.",
  );
  expect(container.querySelector(".sweep-meta")?.textContent).toBe("2 min 10 s so far");
});

function sweepStyle() {
  const style = document.createElement("style");
  style.textContent = readFileSync("apps/window/src/components/sweep/sweep.css", "utf8");
  document.head.append(style);
  cleanups.push(async () => style.remove());
  return style.sheet as CSSStyleSheet;
}

function stubWidths(width: (element: HTMLElement) => number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const w = width(this);
    return { x: 0, y: 0, left: 0, top: 0, right: w, bottom: 0, width: w, height: 0 } as DOMRect;
  });
  cleanups.push(async () => {
    vi.restoreAllMocks();
  });
}

const columns = (list: Element) =>
  getComputedStyle(list.querySelector(".sweep-row") as Element).gridTemplateColumns;
const shown = (list: Element, part: string) =>
  getComputedStyle(list.querySelector(part) as Element).display;
const FOUR_COLUMNS = "16px minmax(0, 11rem) minmax(0, 1fr) minmax(0, 1.2fr)";
const TWO_COLUMNS = "16px minmax(0, 1fr)";

it("lays the rows out by the list's own width, two columns in a narrow panel inside a wide frame", async () => {
  const sheet = sweepStyle();
  stubWidths((element) => {
    let node: HTMLElement | null = element;
    while (node && !node.style.width) node = node.parentElement;
    return Number.parseFloat(node?.style.width ?? "") || 0;
  });
  const frame = document.createElement("div");
  frame.style.cssText = "container-type: inline-size; width: 1000px";
  const panel = document.createElement("aside");
  panel.style.width = "360px";
  frame.append(panel);
  document.body.append(frame);
  cleanups.push(async () => frame.remove());
  const { container: narrow } = await render(midSweep(), 130, panel);
  const { container: wide } = await render(midSweep(), 130, frame);
  applyContainerRules(sheet);

  expect(columns(narrow)).toBe(TWO_COLUMNS);
  expect(shown(narrow, ".sweep-what")).toBe("none");
  expect(columns(wide)).toBe(FOUR_COLUMNS);
  expect(shown(wide, ".sweep-what")).not.toBe("none");
});

it("drops Today's middle column in the 740 px layout, where the list is wider than at 900", async () => {
  const previousWatch = watchStore.getState();
  const previousSpi = window.spi;
  const previousWidth = window.innerWidth;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  cleanups.push(async () => {
    closeSheet();
    watchStore.setState(previousWatch, true);
    window.spi = previousSpi;
    window.innerWidth = previousWidth;
    vi.unstubAllGlobals();
  });
  closeSheet();
  window.location.hash = "#today";
  window.spi = {
    proof: false,
    openExternal: vi.fn(),
    setAppearance: vi.fn(async () => true),
    postMessage: vi.fn(),
    onMessage: () => () => {},
  };
  selectionStore.getState().clear();
  selectionStore.getState().setOpen(false);
  watchStore.setState({ snapshot: null, progress: midSweep() });
  const sheet = sweepStyle();
  // The list fills the middle column less Today's 24 px padding on each side.
  stubWidths((element) => {
    const shell = element.closest<HTMLElement>(".shell");
    if (!element.matches(".sweep-sources") || !shell) return 0;
    const column = (name: string) => Number.parseFloat(shell.style.getPropertyValue(name)) || 0;
    return window.innerWidth - column("--sidebar-col") - column("--panel-col") - 48;
  });

  const today = async (width: number) => {
    window.innerWidth = width;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<Shell />));
    cleanups.push(async () => {
      await act(async () => root.unmount());
      host.remove();
    });
    const list = host.querySelector<HTMLElement>(".today-first .sweep-sources");
    if (!list) throw new Error(`No first-sweep list at ${width} px`);
    applyContainerRules(sheet);
    return { list, wide: list.getBoundingClientRect().width };
  };

  const at740 = await today(740);
  const at900 = await today(900);
  expect(at740.wide).toBeGreaterThan(at900.wide);
  expect(columns(at740.list)).toBe(TWO_COLUMNS);
  expect(shown(at740.list, ".sweep-what")).toBe("none");
  expect(columns(at900.list)).toBe(FOUR_COLUMNS);
  expect(shown(at900.list, ".sweep-what")).not.toBe("none");
});
