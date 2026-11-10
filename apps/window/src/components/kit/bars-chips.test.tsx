// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import {
  AgeChip,
  Chip,
  type ChipTone,
  INBOUND_GLYPH,
  PrBadge,
  ServiceChip,
  UpstreamChip,
} from "./Chip.js";
import { ProgressCells } from "./ProgressCells.js";
import { SegmentedBar } from "./SegmentedBar.js";
import { StackedBar, type StackSegment } from "./StackedBar.js";

const cleanups: (() => Promise<void>)[] = [];

async function mount(content: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (next: ReactNode) => act(async () => root.render(next));
  await render(content);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return { container, render };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const css = readFileSync("apps/window/src/components/kit/kit.css", "utf8");
const rule = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
};

function expectNamed(element: Element | null, text: string) {
  expect(element?.getAttribute("aria-label")).toBe(text);
  expect(element?.getAttribute("title")).toBe(text);
}

it("ProgressCells fills the first cells, outlines the rest, and renders its figure", async () => {
  const text = "Template rollout to d3ddff5: 7 of 13 merged.";
  const { container, render } = await mount(
    <ProgressCells filled={7} total={13} figure="7/13" text={text} />,
  );
  const progress = container.querySelector(".kit-progress");
  expect(progress?.getAttribute("role")).toBe("img");
  expectNamed(progress, text);
  const cells = [...container.querySelectorAll(".kit-cells > .kit-cell")];
  expect(cells).toHaveLength(13);
  expect(cells.map((cell) => cell.classList.contains("kit-cell--filled"))).toEqual(
    Array.from({ length: 13 }, (_, index) => index < 7),
  );
  expect(container.querySelectorAll(".kit-cell--outlined")).toHaveLength(6);
  expect(container.querySelector(".kit-cells")?.getAttribute("aria-hidden")).toBe("true");
  expect(container.querySelector(".kit-progress > .kit-bar-figure")?.textContent).toBe("7/13");
  await render(<ProgressCells filled={20} total={3} figure="3/3" text="All merged" />);
  expect(container.querySelectorAll(".kit-cell--filled")).toHaveLength(3);
  expect(container.querySelectorAll(".kit-cell--outlined")).toHaveLength(0);
  expect(rule(".kit-cell")).toMatch(/border: 1\.4px solid/);
});

it("SegmentedBar sizes one segment per service by count, names each on hover, and renders its figure", async () => {
  const text = "23 upstream provider changes not ported, on 12 forks.";
  const segments = [
    { id: "entitlements", label: "entitlements", count: 4 },
    { id: "unit", label: "unit", count: 3 },
    { id: "empty", label: "empty", count: 0 },
    { id: "storage", label: "storage", count: 1 },
  ];
  const { container, render } = await mount(
    <SegmentedBar segments={segments} figure="23 · 12 forks" text={text} />,
  );
  const bar = container.querySelector(".kit-segmented");
  expect(bar?.getAttribute("role")).toBe("img");
  expect(bar?.classList.contains("kit-segmented--upstream")).toBe(false);
  expectNamed(bar, text);
  const drawn = [...container.querySelectorAll<HTMLElement>(".kit-bar > .kit-segment")];
  expect(
    drawn.map((segment) => [
      segment.getAttribute("title"),
      segment.getAttribute("data-count"),
      segment.style.flexGrow,
    ]),
  ).toEqual([
    ["entitlements 4", "4", "4"],
    ["unit 3", "3", "3"],
    ["storage 1", "1", "1"],
  ]);
  expect(container.querySelector(".kit-segmented > .kit-bar-figure")?.textContent).toBe(
    "23 · 12 forks",
  );
  await render(<SegmentedBar segments={segments} figure="23" text={text} tint="upstream" />);
  expect(container.querySelector(".kit-segmented--upstream")).not.toBeNull();
  expect(rule(".kit-segmented--upstream .kit-segment")).toMatch(/var\(--upstream\)/);
});

it("StackedBar draws toned segments with their numbers and a legend listing each drawn segment", async () => {
  const text =
    "Unreleased, in 9 open release PRs: 1 breaking, 9 new, 31 fixed, 4 security, 6 other.";
  const segments: StackSegment[] = [
    { id: "breaking", label: "breaking", count: 1, tone: "bad" },
    { id: "new", label: "new", count: 9, tone: "accent" },
    { id: "deprecated", label: "deprecated", count: 0, tone: "warn" },
    { id: "fixed", label: "fixed", count: 31, tone: "ok" },
    { id: "security", label: "security", count: 4, tone: "warn" },
    { id: "other", label: "other", count: 6, tone: "neutral" },
  ];
  const { container, render } = await mount(<StackedBar segments={segments} text={text} />);
  const bar = container.querySelector(".kit-stacked-bar");
  expect(bar?.getAttribute("role")).toBe("img");
  expectNamed(bar, text);
  const drawn = segments.filter((segment) => segment.count > 0);
  expect(
    [...container.querySelectorAll<HTMLElement>(".kit-stacked-bar .kit-segment")].map((s) => [
      s.className,
      s.getAttribute("title"),
      s.style.flexGrow,
    ]),
  ).toEqual(
    drawn.map(({ tone, count, label }) => [
      `kit-segment kit-segment--${tone}`,
      `${count} ${label}`,
      String(count),
    ]),
  );
  const legend = [...container.querySelectorAll(".kit-legend > li")];
  expect(legend.map((entry) => entry.getAttribute("data-segment"))).toEqual(
    drawn.map(({ id }) => id),
  );
  expect(legend.map((entry) => entry.textContent)).toEqual(
    drawn.map(({ count, label }) => `${count} ${label}`),
  );
  expect(legend.map((entry) => entry.querySelector("b")?.textContent)).toEqual(
    drawn.map(({ count }) => String(count)),
  );
  expect(legend.map((entry) => entry.querySelector(".kit-swatch")?.className)).toEqual(
    drawn.map(({ tone }) => `kit-swatch kit-segment--${tone}`),
  );
  expect(container.querySelector(".kit-legend")?.closest('[role="img"]')).toBeNull();
  expect(container.querySelector(".kit-stacked-bar .kit-bar-figure")).toBeNull();

  await render(
    <StackedBar
      segments={[
        { id: "held", label: "in sync PRs", count: 67, tone: "upstream" },
        { id: "queued", label: "at the 18:00 sync", count: 4, tone: "neutral" },
      ]}
      figure="71"
      text="67 in 4 open sync PRs, 4 at the 18:00 sync."
    />,
  );
  expect(container.querySelector(".kit-stacked-bar .kit-bar-figure")?.textContent).toBe("71");
  expect([...container.querySelectorAll(".kit-legend > li")].map((li) => li.textContent)).toEqual([
    "67 in sync PRs",
    "4 at the 18:00 sync",
  ]);
  await render(
    <StackedBar
      segments={[{ id: "none", label: "none", count: 0, tone: "neutral" }]}
      text="Nothing"
    />,
  );
  expect(container.querySelector(".kit-legend")).toBeNull();
});

it.each([
  ["neutral", "24 h"],
  ["plain", "⟲ after drain"],
  ["bad", "Deploy and Test"],
  ["warn", "review"],
  ["ok", "none blocking"],
  ["accent", "indexer"],
] satisfies [ChipTone, string][])(
  "Chip draws the %s tone with its sentence",
  async (tone, label) => {
    const text = `Core sentence for ${label}`;
    const { container } = await mount(<Chip tone={tone} label={label} text={text} />);
    const chip = container.querySelector(".kit-chip");
    expect(chip?.classList.contains(`kit-chip--${tone}`)).toBe(true);
    expect(chip?.textContent).toBe(label);
    expect(chip?.getAttribute("role")).toBe("img");
    expectNamed(chip, text);
  },
);

it("Chip defaults to the neutral tone", async () => {
  const { container } = await mount(<Chip label="24 h" text="The last 24 hours" />);
  expect(container.querySelector(".kit-chip")?.className).toBe("kit-chip kit-chip--neutral");
});

it("AgeChip shows core's age and names the sentence", async () => {
  const { container } = await mount(<AgeChip age="14 h" text="Opened 14 h ago" />);
  const chip = container.querySelector(".kit-chip--age");
  expect(chip?.textContent).toBe("14 h");
  expect(chip?.getAttribute("role")).toBe("img");
  expectNamed(chip, "Opened 14 h ago");
  expect(rule(".kit-chip--age")).toMatch(/tabular-nums/);
});

it("PrBadge shows the number, and opens only when it can", async () => {
  const text = "storage release/upstream PR #75";
  const { container, render } = await mount(<PrBadge number={75} text={text} />);
  const badge = container.querySelector(".kit-pr");
  expect(badge?.tagName).toBe("SPAN");
  expect(badge?.textContent).toBe("#75");
  expect(badge?.getAttribute("role")).toBe("img");
  expectNamed(badge, text);
  const onOpen = vi.fn();
  await render(<PrBadge number={75} text={text} onOpen={onOpen} />);
  const button = container.querySelector("button.kit-pr");
  expect(button?.getAttribute("type")).toBe("button");
  expect(button?.hasAttribute("role")).toBe(false);
  expectNamed(button, text);
  await act(async () => (button as HTMLButtonElement).click());
  expect(onOpen).toHaveBeenCalledOnce();
});

it("ServiceChip is a button that opens the service, joined to its PR badge as a second target", async () => {
  const openService = vi.fn();
  const openPr = vi.fn();
  const { container, render } = await mount(
    <ServiceChip service="storage" text="storage: open its place" onOpen={openService} />,
  );
  const chip = container.querySelector("button.kit-chip--service");
  expect(chip?.classList.contains("kit-chip")).toBe(true);
  expect(chip?.getAttribute("type")).toBe("button");
  expect(chip?.textContent).toBe("storage");
  expectNamed(chip, "storage: open its place");
  expect(container.querySelector(".kit-service")).toBeNull();
  await act(async () => (chip as HTMLButtonElement).click());
  expect(openService).toHaveBeenCalledOnce();

  await render(
    <ServiceChip
      service="indexer"
      text="indexer: open its place"
      onOpen={openService}
      pr={{ number: 58, text: "indexer sync PR #58", onOpen: openPr }}
    />,
  );
  const joined = container.querySelector(".kit-service");
  const buttons = [...(joined?.querySelectorAll("button") ?? [])];
  expect(buttons.map((button) => [button.className, button.textContent])).toEqual([
    ["kit-chip kit-chip--service", "indexer"],
    ["kit-pr", "#58"],
  ]);
  expect(joined?.querySelector("button button")).toBeNull();
  await act(async () => buttons[1]?.click());
  expect(openPr).toHaveBeenCalledOnce();
  expect(openService).toHaveBeenCalledOnce();
  expect(rule(".kit-chip--service")).toMatch(/cursor: pointer/);
});

it("UpstreamChip draws the inbound glyph in the upstream tokens, alone or with words", async () => {
  expect(INBOUND_GLYPH).toBe("⇣");
  const text = "Its content is upstream: counted on the horizon's sync-PR stage";
  const { container, render } = await mount(<UpstreamChip text={text} />);
  const chip = container.querySelector(".kit-chip--upstream");
  expect(chip?.tagName).toBe("SPAN");
  expect(chip?.getAttribute("role")).toBe("img");
  expectNamed(chip, text);
  expect(chip?.textContent).toBe("⇣");
  expect(chip?.querySelector(".kit-inbound")?.getAttribute("aria-hidden")).toBe("true");

  const onOpen = vi.fn();
  const sentence = "6 forks whose wait comes from upstream. Go to On the horizon";
  await render(<UpstreamChip label="6 on the horizon" text={sentence} onOpen={onOpen} />);
  const button = container.querySelector("button.kit-chip--upstream");
  expect(button?.getAttribute("type")).toBe("button");
  expect(button?.textContent).toBe("⇣6 on the horizon");
  expect(button?.querySelector(".kit-inbound")?.textContent).toBe("⇣");
  expectNamed(button, sentence);
  await act(async () => (button as HTMLButtonElement).click());
  expect(onOpen).toHaveBeenCalledOnce();

  const upstream = rule(".kit-chip--upstream");
  expect(upstream).toMatch(/background: var\(--upstream-surface\)/);
  expect(upstream).toMatch(/color: var\(--upstream-text\)/);
  expect(upstream).not.toMatch(/--agent/);
});
