// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ViewSnapshot, ViewSnapshotSchema, type WatchItem } from "@spi-code/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import recorded from "../../../../../fixtures/watch/snapshot-59d6895.json?raw";
import november6 from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import bad from "../../../../../fixtures/watch/snapshot-bad.json?raw";
import busy from "../../../../../fixtures/watch/snapshot-busy.json?raw";
import calm from "../../../../../fixtures/watch/snapshot-calm.json?raw";
import { LINE } from "../../app/navigation.js";
import { treeServices } from "../../app/queue.js";
import { createSelectionStore } from "../../panels/selection.js";
import { createWatchStore } from "../../store/watch.js";
import { AttentionBand } from "./Band.js";
import Today from "./index.js";

const MORNINGS = {
  calm: ViewSnapshotSchema.parse(JSON.parse(calm)),
  busy: ViewSnapshotSchema.parse(JSON.parse(busy)),
  "snapshot-1106": ViewSnapshotSchema.parse(JSON.parse(november6)),
  bad: ViewSnapshotSchema.parse(JSON.parse(bad)),
  recorded: ViewSnapshotSchema.parse(JSON.parse(recorded)),
} as const;
const morning = (name: keyof typeof MORNINGS) => structuredClone(MORNINGS[name]);
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return container;
}

async function band(body: ViewSnapshot, horizon = false) {
  const inspector = createSelectionStore({ postMessage: vi.fn() });
  const onNavigate = vi.fn();
  const container = await render(
    <section className="today-frame">
      <AttentionBand snapshot={body} inspector={inspector} onNavigate={onNavigate} />
      {horizon && <div className="today-slot" data-today-slot="horizon" />}
    </section>,
  );
  const click = async (selector: string | Element | null | undefined) => {
    const target = typeof selector === "string" ? container.querySelector(selector) : selector;
    expect(target, String(selector)).toBeInstanceOf(HTMLButtonElement);
    await act(async () => (target as HTMLButtonElement).click());
  };
  return { container, inspector, onNavigate, click };
}

const texts = (root: ParentNode, selector: string) =>
  [...root.querySelectorAll(selector)].map((element) => element.textContent);
const interrupts = (body: ViewSnapshot) =>
  [...body.briefing.focus, ...body.briefing.rest].filter(
    ({ attention }) => attention === "interrupt",
  );
const needs = (container: Element) => [...container.querySelectorAll("li.today-need")];

describe("the attention band", () => {
  it("is not drawn on the calm morning, and Today keeps no band slot", async () => {
    const body = morning("calm");
    const { container } = await band(body);
    expect(container.querySelector(".today-band")).toBeNull();
    const store = createWatchStore(vi.fn(), createSelectionStore({ postMessage: vi.fn() }));
    store.setState({ snapshot: { cursor: body.cursor, body } });
    const today = await render(<Today store={store} />);
    expect(today.querySelector(".today-frame")).not.toBeNull();
    expect(today.querySelector('[data-today-slot="band"], .today-band')).toBeNull();
  });

  it("is not drawn when only upstream work asks for you, whatever the horizon counts", async () => {
    const body = morning("busy");
    for (const item of [...body.briefing.focus, ...body.briefing.rest])
      if (item.attention === "interrupt") item.attention = "surface";
    if (!body.briefing.decisions || !body.briefing.ambient) throw new Error("busy is incomplete");
    body.briefing.decisions = { items: 0, text: "", groups: [] };
    body.briefing.ambient.failing = { items: 0, text: "", lines: [] };
    expect(body.briefing.horizon.counts?.needYouCards).toBeGreaterThan(0);
    const { container } = await band(body);
    expect(container.querySelector(".today-band")).toBeNull();
  });

  it("sits in Today's band slot, after the head and caveat, on the busy morning", async () => {
    const body = morning("busy");
    const store = createWatchStore(vi.fn(), createSelectionStore({ postMessage: vi.fn() }));
    store.setState({ snapshot: { cursor: body.cursor, body } });
    const today = await render(<Today store={store} />);
    const slot = today.querySelector('.today-frame > [data-today-slot="band"]');
    expect(slot?.firstElementChild?.classList.contains("today-band")).toBe(true);
    expect(slot?.previousElementSibling?.className).toBe("today-head");
  });

  it("draws Needs you, Decisions waiting and Failing from core on the busy morning, in that order", async () => {
    const body = morning("busy");
    const { briefing } = body;
    const { container } = await band(body);
    const groups = [...container.querySelectorAll(".today-band-group")];
    expect(groups.map((group) => group.getAttribute("data-group"))).toEqual([
      "needs",
      "decisions",
      "failing",
    ]);
    expect(container.querySelector(".today-band")?.classList.contains("card")).toBe(true);
    expect(container.querySelectorAll(".today-band section")).toHaveLength(0);

    const [storage] = interrupts(body);
    if (!storage?.age) throw new Error("busy's Interrupt carries no age");
    expect(texts(container, ".today-needs .today-band-heading")).toEqual(["Needs you · 1"]);
    const card = needs(container)[0];
    expect(card?.getAttribute("data-item-id")).toBe(storage.id);
    expect(card?.querySelector(".today-need-title")?.textContent).toBe(storage.title);
    expect(card?.querySelector(".today-need-scope")?.textContent).toBe(storage.scope);
    expect(card?.querySelector(".kit-chip--age")?.textContent).toBe(storage.age);
    expect(card?.querySelector(".kit-chip--age")?.getAttribute("title")).toBe(storage.sub);
    expect(card?.querySelector(".today-verb")?.textContent).toBe(`${storage.verb} ›`);
    expect(storage.blocks).toBeUndefined();
    expect(card?.querySelector(".today-need-blocks")).toBeNull();

    const decisions = briefing.decisions;
    if (!decisions) throw new Error("busy carries no decisions");
    expect(texts(container, ".today-decisions .today-band-heading")).toEqual([
      `Decisions waiting · ${decisions.text}`,
    ]);
    const rows = [...container.querySelectorAll("li.today-decision")];
    expect(rows.map((row) => row.getAttribute("data-decision-id"))).toEqual(
      decisions.groups.map(({ id }) => id),
    );
    decisions.groups.forEach((group, index) => {
      const row = rows[index];
      expect(row?.getAttribute("title")).toBe(group.text);
      expect(row?.querySelector(".today-decision-cause")?.textContent).toBe(
        group.token ?? group.text,
      );
      expect(texts(row as Element, ".kit-chip--service")).toEqual(
        group.scope.map(({ service }) => service),
      );
      expect(row?.querySelector(".today-verb")?.textContent).toBe(
        group.verb ? `${group.verb} ›` : undefined,
      );
    });

    const failing = briefing.ambient?.failing;
    const [line] = failing?.lines ?? [];
    if (!failing || !line?.pr || !line.state || !line.age) throw new Error("busy fails nothing");
    expect(texts(container, ".today-failing .today-band-heading")).toEqual([
      `Failing · ${failing.text}`,
    ]);
    const row = container.querySelector("li.today-item-row");
    expect(row?.getAttribute("title")).toBe(line.text);
    expect(row?.querySelector(".today-item-service")?.textContent).toBe(line.service);
    expect(row?.querySelector(".kit-line-glyph")?.getAttribute("aria-label")).toBe(line.text);
    expect(row?.querySelector('[data-station="release-upstream-pr"] .kit-slot')).not.toBeNull();
    expect(row?.querySelector(".kit-pr")?.textContent).toBe(`#${line.pr.number}`);
    expect(row?.querySelector(".kit-chip--bad")?.textContent).toBe(line.state.text);
    expect(row?.querySelector(".kit-chip--age")?.textContent).toBe(line.age);
    expect(container.querySelectorAll(".today-failing .kit-line-legend")).toHaveLength(1);
  });

  it("carries the four place marks and the upstream chip in its heading row", async () => {
    const body = morning("busy");
    const counts = body.briefing.horizon.counts;
    if (!counts) throw new Error("busy carries no horizon counts");
    const { container } = await band(body);
    const marks = [...container.querySelectorAll(".today-band-top .today-band-mark")];
    expect(marks.map((mark) => mark.getAttribute("data-place"))).toEqual(
      body.briefing.places?.map(({ place }) => place),
    );
    expect(marks.map((mark) => mark.getAttribute("data-mark"))).toEqual(
      body.briefing.places?.map(({ mark }) => mark),
    );
    expect(marks.map((mark) => mark.getAttribute("title"))).toEqual(
      body.briefing.places?.map(({ line }) => line),
    );
    const chip = container.querySelector(".today-band-top .kit-chip--upstream");
    expect(chip?.textContent).toBe(`⇣${counts.needYouCards} upstream need you first`);
    expect(chip?.getAttribute("title")).toBe(counts.text);

    const quiet = morning("busy");
    if (!quiet.briefing.horizon.counts) throw new Error("busy carries no horizon counts");
    quiet.briefing.horizon.counts.needYouCards = 0;
    const none = await band(quiet);
    expect(none.container.querySelector(".today-band-top .kit-chip--upstream")).toBeNull();
  });

  it("shows all three Interrupts on the bad morning, P0 first, with the upstream one in Needs you", async () => {
    const body = morning("bad");
    const { container } = await band(body);
    const cards = needs(container);
    expect(texts(container, ".today-needs .today-band-heading")).toEqual(["Needs you · 3"]);
    expect(cards.map((card) => card.getAttribute("data-rung"))).toEqual(["0", "1", "1"]);
    expect(cards.map((card) => card.getAttribute("data-item-id"))).toEqual(
      [...interrupts(body)].sort((a, b) => a.rung - b.rung).map(({ id }) => id),
    );
    const upstream = interrupts(body).find(({ origin }) => origin === "upstream");
    if (!upstream) throw new Error("bad carries no upstream Interrupt");
    const card = container.querySelector(`li.today-need[data-item-id="${upstream.id}"]`);
    expect(card?.getAttribute("data-origin")).toBe("upstream");
    expect(card?.querySelector(".kit-chip--upstream")).not.toBeNull();
    for (const other of cards.filter((c) => c !== card)) {
      expect(other.getAttribute("data-origin")).toBe("system");
      expect(other.querySelector(".kit-chip--upstream")).toBeNull();
    }
    expect(interrupts(body).some(({ blocks }) => blocks)).toBe(false);
    expect(container.querySelector(".today-need-blocks")).toBeNull();
  });

  it("draws a blocks chip only on the Interrupt core says open work waits on", async () => {
    const body = morning("recorded");
    const { container } = await band(body);
    const stack = interrupts(body).find(({ blocks }) => blocks);
    const rest = interrupts(body).filter((item) => item !== stack);
    if (!stack?.blocks) throw new Error("the recorded sweep carries no Interrupt that blocks");
    const chips = [...container.querySelectorAll(".today-need-blocks .kit-chip")];
    expect(chips).toHaveLength(1);
    expect(chips[0]?.closest("li.today-need")?.getAttribute("data-item-id")).toBe(stack.id);
    expect(chips[0]?.textContent).toBe(stack.blocks.text);
    expect(chips[0]?.getAttribute("title")).toBe(stack.effect);
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.every(({ blocks }) => !blocks)).toBe(true);
  });

  it("never folds Needs you, and leaves out a chip core cannot prove", async () => {
    const body = morning("busy");
    const items = [...body.briefing.focus, ...body.briefing.rest];
    for (const item of items) {
      item.attention = "interrupt";
      delete item.age;
      delete item.blocks;
    }
    const services = new Set(treeServices(body.tree));
    const scoped = items.find(({ scope }) => !services.has(scope));
    const { container } = await band(body);
    expect(needs(container)).toHaveLength(new Set(items.map(({ id }) => id)).size);
    expect(container.textContent).not.toMatch(/\d+ more\b/);
    expect(container.querySelector(".today-need .kit-chip--age, .today-need-blocks")).toBeNull();
    expect(scoped).toBeDefined();
    if (scoped) {
      const scope = container.querySelector(
        `li.today-need[data-item-id="${scoped.id}"] .today-need-scope`,
      );
      expect(scope?.tagName).toBe("SPAN");
    }
  });
});

describe("the attention band's openers", () => {
  it("opens an Interrupt in Detail from its title and verb, and its fork's place from its scope", async () => {
    const body = morning("bad");
    const { container, inspector, onNavigate, click } = await band(body);
    for (const item of interrupts(body)) {
      const card = container.querySelector(`li.today-need[data-item-id="${item.id}"]`);
      inspector.getState().clear();
      await click(card?.querySelector(".today-need-title"));
      expect(inspector.getState().selected).toBe(item.id);
      expect(inspector.getState().row?.kind).toBe("queue");
      expect(inspector.getState().tab).toBe("detail");
      expect(card?.getAttribute("aria-current")).toBe("true");
      inspector.getState().clear();
      await click(card?.querySelector(".today-verb"));
      expect(inspector.getState().selected).toBe(item.id);
      await click(card?.querySelector(".today-need-scope"));
      expect(onNavigate).toHaveBeenLastCalledWith({ kind: "service", id: item.scope });
    }
  });

  it("opens a decision's item in Detail, its forks' places and its PR", async () => {
    const body = morning("snapshot-1106");
    const groups = body.briefing.decisions?.groups ?? [];
    const withPr = groups.find(({ scope }) => scope.some(({ pr }) => pr?.inspect));
    const scoped = withPr?.scope.find(({ pr }) => pr?.inspect);
    if (!withPr || !scoped?.pr?.inspect) throw new Error("1106 carries no decision with a PR");
    const { container, inspector, onNavigate, click } = await band(body);
    for (const group of groups) {
      const row = container.querySelector(`li[data-decision-id="${group.id}"]`);
      inspector.getState().clear();
      await click(row?.querySelector(".today-decision-cause"));
      expect(inspector.getState().selected).toBe(group.itemIds[0]);
      if (group.verb) {
        inspector.getState().clear();
        await click(row?.querySelector(".today-verb"));
        expect(inspector.getState().selected).toBe(group.itemIds[0]);
      }
    }
    const row = container.querySelector(`li[data-decision-id="${withPr.id}"]`);
    await click(row?.querySelector("button.kit-chip--service"));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "service", id: scoped.service });
    inspector.getState().clear();
    await click(row?.querySelector("button.kit-pr"));
    expect(inspector.getState().selected).toBe(scoped.pr.inspect);
  });

  it("opens a theme's Detail for a decision that holds several of its items", async () => {
    const body = morning("busy");
    const [theme] = body.briefing.themes;
    const group = body.briefing.decisions?.groups[0];
    if (!theme || !group) throw new Error("busy carries no theme or decision");
    group.theme = theme.id;
    group.itemIds = [...group.itemIds, "x:second"];
    if (body.briefing.decisions) body.briefing.decisions.items += 1;
    const { container, inspector, click } = await band(body);
    await click(
      container.querySelector(`li[data-decision-id="${group.id}"] .today-decision-cause`),
    );
    expect(inspector.getState().selected).toBe(`theme:${theme.id}`);
    expect(inspector.getState().row?.kind).toBe("theme");
  });

  it("opens a Failing line's item, its fork's place and its PR", async () => {
    const body = morning("busy");
    const [line] = body.briefing.ambient?.failing.lines ?? [];
    if (!line?.pr?.inspect || !line.service) throw new Error("busy fails nothing");
    const { container, inspector, onNavigate, click } = await band(body);
    const row = container.querySelector(`li[data-line-id="${line.id}"]`);
    await click(row?.querySelector(".today-item-open"));
    expect(inspector.getState().selected).toBe(line.itemIds[0]);
    expect(row?.getAttribute("aria-current")).toBe("true");
    await click(row?.querySelector(".today-item-service"));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "service", id: line.service });
    inspector.getState().clear();
    await click(row?.querySelector("button.kit-pr"));
    expect(inspector.getState().selected).toBe(line.pr.inspect);
  });

  it("opens each place from its mark", async () => {
    const body = morning("busy");
    const { onNavigate, click } = await band(body);
    const to = {
      line: LINE,
      environment: { kind: "environment" },
      engineering: { kind: "engineering-system" },
      security: { kind: "security" },
    };
    for (const { place } of body.briefing.places ?? []) {
      await click(`.today-band-mark[data-place="${place}"]`);
      expect(onNavigate).toHaveBeenLastCalledWith(to[place]);
    }
  });

  it("scrolls to the horizon slot from the upstream chip, and does nothing before it is drawn", async () => {
    const body = morning("busy");
    const drawn = await band(body, true);
    const horizon = drawn.container.querySelector<HTMLElement>('[data-today-slot="horizon"]');
    if (!horizon) throw new Error("no horizon slot");
    const scroll = vi.fn();
    horizon.scrollIntoView = scroll;
    await drawn.click(".today-band-top .kit-chip--upstream");
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
    const bare = await band(body);
    await bare.click(".today-band-top .kit-chip--upstream");
    expect(bare.inspector.getState().selected).toBeNull();
  });
});

it("keeps every item it draws in its tier's home: Interrupts only, never a Surface or Ambient item", async () => {
  for (const name of ["busy", "bad", "snapshot-1106"] as const) {
    const body = morning(name);
    const { container } = await band(body);
    const items: WatchItem[] = [...body.briefing.focus, ...body.briefing.rest];
    for (const item of items)
      expect(container.querySelectorAll(`[data-item-id="${item.id}"]`)).toHaveLength(
        item.attention === "interrupt" ? 1 : 0,
      );
  }
});
