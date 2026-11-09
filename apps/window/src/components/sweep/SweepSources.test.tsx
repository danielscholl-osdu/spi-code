// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { type SweepProgress, SweepProgressSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { clockTime } from "../../time.js";
import { SweepSources } from "./SweepSources.js";
import { after, midSweep, SWEEP_START } from "./test-helper.js";

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
    "read · 52 s · 6 of 13 incomplete",
    "read · 4 s",
    "read · 12 s",
    "read · 6 s",
    `waits for GitHub budget · after ${clock("2026-11-09T09:10:00Z")}`,
    "failed",
    "reading · 14 s",
    "waiting",
    "waiting",
  ]);
  expect(all(container, ".sweep-mark")).toEqual([
    "✓",
    "✓",
    "✓",
    "⚠",
    "✓",
    "✓",
    "✓",
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
    "ok",
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

/** The nearest ancestor a container query with this name would query, as the browser picks it. */
function queryContainer(element: Element, name: string | undefined) {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    const [names, type] = style.getPropertyValue("container").includes("/")
      ? style.getPropertyValue("container").split("/")
      : [style.getPropertyValue("container-name"), style.getPropertyValue("container-type")];
    if (!/\b(inline-size|size)\b/.test(type ?? "")) continue;
    if (name === undefined || (names ?? "").trim().split(/\s+/).includes(name)) return node;
  }
  return null;
}

/** happy-dom skips @container rules, so this applies the stylesheet's own ones inline. */
function applyContainerRules(sheet: CSSStyleSheet) {
  for (const rule of sheet.cssRules) {
    if (!rule.cssText.startsWith("@container")) continue;
    const { conditionText, cssRules } = rule as CSSConditionRule;
    const query = /^(?:([\w-]+)\s+)?\(max-width:\s*(\d+)px\)$/.exec(conditionText.trim());
    if (!query) throw new Error(`Unhandled container query: ${conditionText}`);
    const [, name, max] = query;
    for (const inner of cssRules) {
      const { selectorText, style } = inner as CSSStyleRule;
      for (const element of document.querySelectorAll<HTMLElement>(selectorText)) {
        const container = queryContainer(element, name);
        if (!container || container.getBoundingClientRect().width > Number(max)) continue;
        for (let index = 0; index < style.length; index++) {
          const property = style.item(index);
          element.style.setProperty(property, style.getPropertyValue(property));
        }
      }
    }
  }
}

it("lays the rows out by the list's own width, two columns in a narrow panel inside a wide frame", async () => {
  const style = document.createElement("style");
  style.textContent = readFileSync("apps/window/src/components/sweep/sweep.css", "utf8");
  document.head.append(style);
  cleanups.push(async () => style.remove());
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    let node: HTMLElement | null = this;
    while (node && !node.style.width) node = node.parentElement;
    const width = Number.parseFloat(node?.style.width ?? "") || 0;
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: 0, width, height: 0 } as DOMRect;
  });
  cleanups.push(async () => {
    vi.restoreAllMocks();
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
  applyContainerRules(style.sheet as CSSStyleSheet);

  const columns = (list: Element) =>
    getComputedStyle(list.querySelector(".sweep-row") as Element).gridTemplateColumns;
  const shown = (list: Element, part: string) =>
    getComputedStyle(list.querySelector(part) as Element).display;
  expect(columns(narrow)).toBe("16px minmax(0, 1fr)");
  expect(shown(narrow, ".sweep-what")).toBe("none");
  expect(columns(wide)).toBe("16px minmax(0, 11rem) minmax(0, 1fr) minmax(0, 1.2fr)");
  expect(shown(wide, ".sweep-what")).not.toBe("none");
});
