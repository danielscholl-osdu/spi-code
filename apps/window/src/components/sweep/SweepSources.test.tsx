// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

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

async function render(progress: SweepProgress, seconds = 130) {
  const container = document.createElement("div");
  document.body.append(container);
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
