// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { LineGlyph, type LineStation } from "./LineGlyph.js";
import { Mark, type MarkTier } from "./Mark.js";
import { SLOT_STATES, Slot, type SlotState } from "./Slot.js";
import { SlotRow } from "./SlotRow.js";

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

it.each([
  ["empty", "hollow-circle", 'circle[fill="none"]', 1],
  ["occupied", "filled-circle", 'circle[fill="currentColor"]', 1],
  ["done", "checked-circle", ".kit-slot-check", 1],
  ["waiting", "triangle", 'path[d="M6 1 12 11H0Z"]', 0],
  ["broken", "diamond", 'path[d="m6 0 6 6-6 6-6-6Z"]', 0],
  ["unknown", "dotted-circle", 'circle[fill="none"]', 2],
] as const)(
  "Slot draws %s as %s with the supplied sentence",
  async (state, shape, path, circles) => {
    const text = `Example service: ${state}`;
    const { container } = await mount(<Slot state={state} text={text} />);
    const slot = container.querySelector(".kit-slot");
    expect(slot?.classList.contains(`kit-slot--${state}`)).toBe(true);
    expect(slot?.getAttribute("data-shape")).toBe(shape);
    expect(slot?.getAttribute("role")).toBe("img");
    expect(slot?.getAttribute("aria-label")).toBe(text);
    expect(slot?.getAttribute("title")).toBe(text);
    expect(slot?.querySelector(path)).not.toBeNull();
    expect(slot?.querySelectorAll("circle")).toHaveLength(circles);
    expect(slot?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(slot?.hasAttribute("tabindex")).toBe(false);
  },
);

it.each(SLOT_STATES)("only upstream waits use the upstream colour (%s)", async (state) => {
  const { container } = await mount(<Slot state={state} origin="upstream" text="Core sentence" />);
  expect(container.querySelector(".kit-slot--upstream") !== null).toBe(state === "waiting");
  const css = readFileSync("apps/window/src/components/kit/kit.css", "utf8");
  expect(css).toMatch(/\.kit-slot--upstream\s*\{\s*color: var\(--upstream\)/);
});

it("SlotRow preserves order and count text, and legends only the states actually drawn", async () => {
  const entries = [
    { id: "one", state: "done" as SlotState, text: "One merged" },
    { id: "two", state: "empty" as SlotState, text: "Two had nothing to bring" },
    { id: "three", state: "done" as SlotState, text: "Three merged" },
  ];
  const { container, render } = await mount(
    <SlotRow label="Sync Template" count="2/3 merged" text="Two forks merged" entries={entries} />,
  );
  const row = container.querySelector(".kit-slot-row");
  expect(row?.getAttribute("aria-label")).toBe("Two forks merged");
  expect(row?.getAttribute("title")).toBe("Two forks merged");
  expect(container.querySelector(".kit-slot-row-heading")?.textContent).toBe(
    "Sync Template2/3 merged",
  );
  expect(
    [...container.querySelectorAll(".kit-slots > .kit-slot")].map((slot) => [
      slot.getAttribute("aria-label"),
      slot.getAttribute("title"),
    ]),
  ).toEqual(entries.map(({ text }) => [text, text]));
  const legendStates = () =>
    [...container.querySelectorAll(".kit-slot-legend [data-state]")].map((entry) =>
      entry.getAttribute("data-state"),
    );
  expect(legendStates()).toEqual(["empty", "done"]);
  await render(
    <SlotRow
      label="Sync Upstream"
      count="1/3 ran ok"
      text="Effect not known"
      entries={[{ id: "one", state: "unknown", text: "One ran, effect unknown" }]}
    />,
  );
  expect(legendStates()).toEqual(["unknown"]);
  expect(container.querySelector(".kit-slot-legend")?.textContent).toBe("ran, effect unknown");
  await render(<SlotRow label="Sync" count="0 ran" text="No runs" entries={[]} />);
  expect(container.querySelector(".kit-slot-legend")).toBeNull();
  await render(
    <SlotRow
      label="Sync"
      count="2 merged"
      text="Two merged"
      entries={entries}
      showLegend={false}
    />,
  );
  expect(container.querySelector(".kit-slot-legend")).toBeNull();
});

it.each([
  ["interrupt", "✕", "Interrupt"],
  ["surface", "!", "Surface"],
  ["ambient", "◐", "Ambient"],
  ["background", "○", "Background"],
] satisfies [MarkTier, string, string][])(
  "Mark names %s on hover and to assistive tools",
  async (tier, glyph, name) => {
    const { container } = await mount(<Mark tier={tier} />);
    const mark = container.querySelector(".kit-mark");
    expect(mark?.classList.contains(`kit-mark--${tier}`)).toBe(true);
    expect(mark?.textContent).toBe(glyph);
    expect(mark?.getAttribute("aria-label")).toBe(name);
    expect(mark?.getAttribute("title")).toBe(name);
    expect(mark?.getAttribute("role")).toBe("img");
  },
);

it.each([
  ["sync-pr", 0],
  ["release-upstream-pr", 1],
  ["main", 2],
  ["release", 3],
] satisfies [LineStation, number][])(
  "LineGlyph draws passed segments before %s and a single station slot",
  async (station, at) => {
    const text = `Example service is broken at ${station}`;
    const { container } = await mount(<LineGlyph station={station} state="broken" text={text} />);
    const glyph = container.querySelector(".kit-line-glyph");
    expect(glyph?.getAttribute("aria-label")).toBe(text);
    expect(glyph?.getAttribute("title")).toBe(text);
    expect(glyph?.getAttribute("role")).toBe("img");
    expect(glyph?.querySelectorAll(".kit-slot")).toHaveLength(1);
    expect(glyph?.querySelector(`[data-station="${station}"] .kit-slot--broken`)).not.toBeNull();
    expect(glyph?.querySelector(".kit-slot")?.getAttribute("data-shape")).toBe("diamond");
    expect(glyph?.querySelector(".kit-slot")?.getAttribute("title")).toBe(text);
    expect(glyph?.querySelectorAll("[data-station] > .kit-line-passed")).toHaveLength(at);
    expect(glyph?.querySelectorAll(".kit-line-connector.kit-line-passed")).toHaveLength(at);
    expect(glyph?.querySelectorAll(".kit-line-future")).toHaveLength(3 - at);
    expect(glyph?.querySelectorAll("circle")).toHaveLength(0);
    expect(container.querySelector(".kit-line-legend")).toBeNull();
  },
);

it("LineGlyph draws upstream waits and optionally supplies the one-line station legend", async () => {
  const { container } = await mount(
    <LineGlyph
      station="sync-pr"
      state="waiting"
      origin="upstream"
      text="Example waits for an upstream decision"
      showLegend
    />,
  );
  expect(container.querySelector(".kit-slot--waiting.kit-slot--upstream")).not.toBeNull();
  expect(container.querySelector(".kit-slot")?.getAttribute("data-shape")).toBe("triangle");
  expect(container.querySelector(".kit-line-legend")?.textContent).toBe(
    "sync PR → release/upstream PR → main → release",
  );
});
