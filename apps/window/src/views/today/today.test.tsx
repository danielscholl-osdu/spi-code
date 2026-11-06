// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION, type ViewSnapshot } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import briefing from "../../../../../fixtures/rib-59d6895/oracle/briefing.json?raw";
import releases from "../../../../../fixtures/rib-59d6895/oracle/releases.json?raw";
import mixed from "../../../../../fixtures/watch/snapshot-mixed-59d6895.json?raw";
import {
  expectEvidenceMarks,
  expectNoEvidenceMarks,
} from "../../components/evidence/marks.test-helper.js";
import { RightPanel } from "../../panels/RightPanel.js";
import { createSelectionStore } from "../../panels/selection.js";
import { mixedSnapshot, testSnapshot } from "../../store/test-snapshot.js";
import { createWatchStore } from "../../store/watch.js";
import Today from "./index.js";

const oracle = testSnapshot(briefing, releases);

async function mount(body: ViewSnapshot | null = oracle) {
  const port = { postMessage: vi.fn() };
  const inspector = createSelectionStore(port);
  const store = createWatchStore(vi.fn(), inspector);
  const receive = (payload: ViewSnapshot) =>
    store.getState().receive({
      version: PROTOCOL_VERSION,
      id: "today-test",
      kind: "event",
      type: "view.snapshot",
      payload,
    });
  if (body) receive(body);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <>
        <Today store={store} />
        <RightPanel store={inspector} />
      </>,
    ),
  );
  return {
    container,
    store,
    port,
    inspector,
    receive,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const text = (container: Element, selector: string) =>
  [...container.querySelectorAll(selector)].map((element) => element.textContent);

it("renders the schema-validated oracle's headline, summary, facts, focus, ready and overflow", async () => {
  const { container, cleanup } = await mount();
  const brief = oracle.briefing;
  try {
    expect(container.querySelector("h1")?.textContent).toBe(brief.headline);
    expect(container.querySelector(".today-summary")?.textContent).toBe(brief.summary);
    expect(text(container, ".today-fact-label")).toEqual(brief.facts.map((fact) => fact.label));
    expect(text(container, ".today-figure")).toEqual(brief.facts.map((fact) => fact.figure));
    expect(text(container, ".today-fact-sub")).toEqual(brief.facts.map((fact) => fact.sub));
    expect(text(container, ".today-focus > button .today-item-title")).toEqual(
      brief.focus.map((item) => item.title),
    );
    expect(text(container, ".today-focus > button .today-priority")).toEqual(
      brief.focus.map((item) => `P${item.rung}`),
    );
    expect(text(container, ".today-ready button")).toEqual(brief.ready.map((item) => item.text));
    expect(container.querySelector("summary")?.textContent).toBe(`${brief.more} more in the queue`);
    expect(text(container, "details .today-item-title")).toEqual(
      brief.rest.map((item) => item.title),
    );
    expect(text(container, ".today-theme h3")).toEqual(brief.themes.map((theme) => theme.title));
    expect(text(container, ".today-theme-sub")).toEqual(brief.themes.map((theme) => theme.sub));
    expect(text(container, ".today-theme-next")).toEqual(brief.themes.map((theme) => theme.next));
    expect(text(container, ".today-theme time")).toEqual(brief.themes.map((theme) => theme.when));
    for (const theme of brief.themes) {
      const card = container.querySelector(`[data-theme-id="${theme.id}"]`);
      if (!card) throw new Error(`Missing theme ${theme.id}`);
      expect(text(card, ".today-certain li")).toEqual(
        theme.certain.map((fork) => `${fork.fork} · ${fork.state}`),
      );
      expect(text(card, ".today-possible li")).toEqual(
        theme.possible.map((fork) => `${fork.fork} · ${fork.state}`),
      );
      if (theme.exposed.length) expect(card?.textContent).toContain(theme.exposed.join(", "));
    }
  } finally {
    await cleanup();
  }
});

it("selects focus, overflow, ready and theme targets in the watch store", async () => {
  const { container, store, cleanup } = await mount();
  try {
    for (const button of container.querySelectorAll<HTMLButtonElement>("[data-selection-id]")) {
      await act(async () => button.click());
      expect(store.getState().selection?.id).toBe(button.dataset.selectionId);
      if (button.classList.contains("today-row"))
        expect(button.getAttribute("aria-pressed")).toBe("true");
    }
    await act(async () => store.getState().clear());
    expect(
      container.querySelector('.today-row[aria-pressed="true"]')?.getAttribute("data-selection-id"),
    ).toBe(oracle.briefing.focus[0]?.id);
  } finally {
    await cleanup();
  }
});

it("seeds the one selection with the first focus, as the rib console does, so row and inspector agree", async () => {
  const { container, store, port, cleanup } = await mount();
  const first = oracle.briefing.focus[0];
  if (!first) throw new Error("Oracle must contain a focus item");
  try {
    expect(store.getState().selection).toEqual({ id: first.id });
    expect(port.postMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: "inspect.request", payload: { id: first.id } }),
    );
    expect(text(container, '.today-row[aria-pressed="true"] .today-item-title')).toEqual([
      first.title,
    ]);
    expect(container.querySelector('[aria-label="Detail"]')?.textContent).toContain(
      `Reading ${first.id}`,
    );
    const target = oracle.briefing.rest[0];
    if (!target) throw new Error("Oracle must contain an overflow item");
    await act(async () => store.getState().select(target.id));
    expect(text(container, '.today-row[aria-pressed="true"] .today-item-title')).toEqual([
      target.title,
    ]);
    await act(async () => store.getState().select("another-view"));
    expect(container.querySelector('.today-row[aria-pressed="true"]')).toBeNull();
    expect(container.querySelector('[aria-label="Detail"]')?.textContent).toContain(
      "Reading another-view",
    );
  } finally {
    await cleanup();
  }
});

it("opens a clicked Today focus row in the inspector through inspect.request on the port", async () => {
  const { container, store, port, cleanup } = await mount();
  const target = oracle.briefing.focus[1];
  if (!target) throw new Error("Oracle must contain a second focus item");
  try {
    port.postMessage.mockClear();
    const row = container.querySelector<HTMLButtonElement>(
      `.today-row[data-selection-id="${target.id}"]`,
    );
    await act(async () => row?.click());
    expect(port.postMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: "request",
        type: "inspect.request",
        payload: { id: target.id },
      }),
    );
    expect(store.getState().selection).toEqual({ id: target.id });
    expect(row?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelectorAll('.today-row[aria-pressed="true"]')).toHaveLength(1);
    expect(container.querySelector('[aria-label="Detail"]')?.textContent).toContain(
      `Reading ${target.id}`,
    );
  } finally {
    await cleanup();
  }
});

it("omits empty summary, facts and focus for the unmeasured briefing shape", async () => {
  const headline = "The first sweep has not finished.";
  const { container, receive, store, port, cleanup } = await mount({
    ...oracle,
    briefing: {
      ...oracle.briefing,
      doctor: { state: "waiting", problems: [] },
      headline,
      summary: "",
      facts: [],
      focus: [],
      rest: [],
      more: 0,
      ready: [],
      themes: [],
    },
  });
  try {
    expect(container.querySelector("h1")?.textContent).toBe(headline);
    expect(container.querySelector(".today-summary")).toBeNull();
    expect(container.querySelector(".today-facts")).toBeNull();
    expect(container.querySelector(".today-focus")).toBeNull();
    expect(container.querySelector(".today-ready")).toBeNull();
    expect(store.getState().selection).toBeNull();
    expect(port.postMessage).not.toHaveBeenCalled();
    await act(async () => receive({ ...oracle, cursor: 2 }));
    expect(container.querySelector(".today-facts")).not.toBeNull();
    expect(container.querySelector(".today-focus")).not.toBeNull();
    expect(
      container.querySelector('.today-row[aria-pressed="true"]')?.getAttribute("data-selection-id"),
    ).toBe(oracle.briefing.focus[0]?.id);
    expect(store.getState().selection?.id).toBe(oracle.briefing.focus[0]?.id);
  } finally {
    await cleanup();
  }
});

it("uses the rib's bad, neutral PORT and warning tones on both rung and class", async () => {
  const port = oracle.briefing.rest.find((item) => item.cls === "PORT");
  const seed = oracle.briefing.focus[0];
  if (!port || !seed) throw new Error("Oracle must contain PORT and focus items");
  const { container, cleanup } = await mount({
    ...oracle,
    briefing: {
      ...oracle.briefing,
      rest: [
        ...oracle.briefing.rest,
        { ...port, id: "port:p0", rung: 0 },
        { ...port, id: "port:p2", rung: 2 },
        { ...seed, id: "other:p2", rung: 2 },
      ],
    },
  });
  try {
    for (const [id, tone] of [
      [seed.id, "bad"],
      [oracle.briefing.focus[2]?.id, "warn"],
      [port.id, "neutral"],
      ["port:p0", "bad"],
      ["port:p2", "neutral"],
      ["other:p2", "warn"],
    ]) {
      const row = container.querySelector(`[data-selection-id="${id}"]`);
      expect(row?.querySelector(".today-priority")?.getAttribute("data-tone")).toBe(tone);
      expect(row?.querySelector(".today-class")?.getAttribute("data-tone")).toBe(tone);
    }
  } finally {
    await cleanup();
  }
});

it("orders priorities stably without mutating the snapshot", async () => {
  const seed = oracle.briefing.focus[0];
  if (!seed) throw new Error("Oracle must contain a focus item");
  const focus = ([2, 0, 1, 0] as const).map((rung, index) => ({
    ...seed,
    id: `item:${index}`,
    title: `Item ${index}`,
    rung,
  }));
  const { container, cleanup } = await mount({
    ...oracle,
    briefing: { ...oracle.briefing, focus },
  });
  try {
    expect(text(container, ".today-focus > button .today-item-title")).toEqual([
      "Item 1",
      "Item 3",
      "Item 2",
      "Item 0",
    ]);
    expect(focus.map((item) => item.rung)).toEqual([2, 0, 1, 0]);
  } finally {
    await cleanup();
  }
});

it("waits for a snapshot and updates reactively without inventing empty content", async () => {
  const { container, receive, cleanup } = await mount(null);
  try {
    expect(container.textContent).toContain("Waiting for the first sweep.");
    await act(async () => receive(oracle));
    expect(container.querySelector("h1")?.textContent).toBe(oracle.briefing.headline);
    await act(async () =>
      receive({
        ...oracle,
        cursor: 2,
        briefing: { ...oracle.briefing, focus: [], rest: [], more: 0, ready: [], themes: [] },
      }),
    );
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector(".today-ready")).toBeNull();
    expect(container.querySelector(".today-themes")).toBeNull();
    expect(container.querySelector(".today-row")).toBeNull();
  } finally {
    await cleanup();
  }
});

it("gives each Today section one evidence line and marks no value", async () => {
  const body = mixedSnapshot(mixed);
  const view = await mount(body);
  try {
    const today = view.container.querySelector('[aria-label="Today"]');
    if (!today) throw new Error("Today did not render");
    expectEvidenceMarks(today, body, {
      sections: [
        ["/briefing/headline", "/briefing/summary"],
        ["/briefing/facts"],
        ["/briefing/focus", "/briefing/rest", "/briefing/more"],
        ["/briefing/ready"],
        ["/briefing/themes"],
      ],
    });
    expect(
      today.querySelector('[data-pointer="/briefing/facts/0/figure"] [data-inferred]'),
    ).toBeNull();
  } finally {
    await view.cleanup();
  }
  const plain = await mount();
  try {
    const today = plain.container.querySelector('[aria-label="Today"]');
    if (!today) throw new Error("Today did not render");
    expectNoEvidenceMarks(today);
  } finally {
    await plain.cleanup();
  }
});
