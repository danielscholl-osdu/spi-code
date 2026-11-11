// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import oldRaw from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import badRaw from "../../../../../fixtures/watch/snapshot-bad.json?raw";
import busyRaw from "../../../../../fixtures/watch/snapshot-busy.json?raw";
import calmRaw from "../../../../../fixtures/watch/snapshot-calm.json?raw";
import { createSelectionStore } from "../../panels/selection.js";
import { createWatchStore } from "../../store/watch.js";
import { clockTime } from "../../time.js";
import Today from "./index.js";

const bodies = { busy: busyRaw, calm: calmRaw, bad: badRaw, owed: oldRaw };
const morning = (name: keyof typeof bodies) => ViewSnapshotSchema.parse(JSON.parse(bodies[name]));
const cleanups: (() => Promise<void>)[] = [];
async function mount(body: ViewSnapshot) {
  const port = { postMessage: vi.fn() };
  const inspector = createSelectionStore(port);
  const store = createWatchStore(vi.fn(), inspector);
  store.setState({ snapshot: { cursor: body.cursor, body } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const evidence = vi.fn();
  await act(async () => root.render(<Today store={store} onOpenEvidence={evidence} />));
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return { container, inspector, port, evidence };
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  window.location.hash = "";
  vi.useRealTimers();
});
async function click(container: Element, selector: string) {
  const button = container.querySelector<HTMLButtonElement>(selector);
  expect(button, selector).not.toBeNull();
  await act(async () => button?.click());
}

it.each(["busy", "calm", "bad", "owed"] as const)(
  "renders core's horizon on %s, without recalculating counts or tiers",
  async (name) => {
    const body = morning(name);
    const h = body.briefing.horizon;
    const { container } = await mount(body);
    const block = container.querySelector(".today-horizon");
    expect(block?.querySelector("h2")?.textContent).toBe("⇣ On the horizon · from upstream GitLab");
    expect(block?.querySelector(".horizon-counts")?.textContent).toBe(h.counts?.text);
    expect(block?.querySelectorAll(".horizon-card")).toHaveLength(h.cards?.length ?? 0);
    for (const [index, card] of (h.cards ?? []).entries()) {
      const drawn = block?.querySelectorAll(".horizon-card")[index];
      expect(drawn?.querySelector(".horizon-token")?.textContent).toBe(card.token);
      expect(drawn?.getAttribute("title")).toBe(card.text);
      expect(drawn?.querySelector(".horizon-verb")?.textContent).toBe(
        card.needsYou && card.verb ? `${card.verb} ›` : undefined,
      );
      expect(drawn?.querySelectorAll(".kit-chip--service")).toHaveLength(card.services.length);
    }
    const s = h.stages;
    expect(block?.querySelector(".horizon-stage--nextSync strong")?.textContent).toBe(
      String(s?.nextSync.count),
    );
    expect(block?.querySelector(".horizon-stage--held strong")?.textContent).toBe(
      String(s?.held.count),
    );
    expect(block?.querySelectorAll(".horizon-wont-land .kit-slot--broken")).toHaveLength(
      s?.wontLand.length ?? 0,
    );
    expect(block?.querySelectorAll(".horizon-stage--forks .kit-slot")).toHaveLength(0);
    for (const stopped of s?.wontLand ?? [])
      expect(s?.nextSync.services).not.toContain(stopped.service);
    const owed = block?.querySelector(".horizon-owed");
    if (h.owed?.count) {
      expect(owed?.querySelector(".kit-bar-figure")?.textContent).toBe(h.owed.text);
      expect(owed?.querySelectorAll(".kit-segment")).toHaveLength(h.owed.services.length);
      expect(
        [...(owed?.querySelectorAll(".kit-segment") ?? [])].map((x) =>
          Number(x.getAttribute("data-count")),
        ),
      ).toEqual(h.owed.services.map((x) => x.count));
    } else expect(owed).toBeNull();
  },
);

it("uses core's words even when card counts and items cannot prove calm", async () => {
  const body = morning("calm");
  body.briefing.horizon.counts = {
    needYouCards: 37,
    toWatchCards: 8,
    surfaceItems: 94,
    text: "Core has not proved what lands.",
  };
  const { container } = await mount(body);
  expect(container.querySelector(".horizon-counts")?.textContent).toBe(
    "Core has not proved what lands.",
  );
  expect(container.textContent).not.toContain("Nothing needs you before it lands");
  delete body.briefing.horizon.counts;
  delete body.briefing.horizon.stages;
  const unknown = await mount(body);
  expect(unknown.container.querySelector(".horizon-counts, .horizon-conveyor")).toBeNull();
  expect(unknown.container.textContent).not.toContain("Nothing needs you");
});

it("opens the heading, every card and verb, fork chip and PR badge at their own destinations", async () => {
  const body = morning("bad");
  const { container, inspector } = await mount(body);
  await click(container, ".horizon-heading");
  expect(window.location.hash).toBe("#upstream");
  for (const [index, card] of (body.briefing.horizon.cards ?? []).entries()) {
    const selector = `.horizon-card:nth-child(${index + 1})`;
    const id = card.kind === "sync" ? card.itemIds[0] : `theme:${card.id}`;
    for (const opener of [".horizon-token", ".horizon-verb"]) {
      await click(container, `${selector} ${opener}`);
      expect(inspector.getState().selected).toBe(id);
    }
    for (const [forkIndex, fork] of card.services.entries()) {
      await click(
        container,
        `${selector} .horizon-fork:nth-child(${forkIndex + 1}) .kit-chip--service`,
      );
      expect(window.location.hash).toBe(`#service/${fork.service}`);
      if (fork.pr) {
        await click(container, `${selector} .horizon-fork:nth-child(${forkIndex + 1}) .kit-pr`);
        expect(inspector.getState().selected).toBe(fork.pr.inspect);
      }
    }
  }
  for (const [index, ref] of (body.briefing.horizon.stages?.held.prs ?? []).entries()) {
    await click(
      container,
      `.horizon-stage--held [data-pointer="/briefing/horizon/stages/held/prs/${index}"] .kit-pr`,
    );
    expect(inspector.getState().selected).toBe(ref.pr.inspect);
  }
  for (const chip of container.querySelectorAll<HTMLButtonElement>(
    ".horizon-stages .kit-chip--service",
  )) {
    await act(async () => chip.click());
    expect(window.location.hash).toBe(`#service/${chip.textContent}`);
  }
});

it("opens an unthemed upstream card's item from its token and verb", async () => {
  const body = morning("busy");
  const card = body.briefing.horizon.cards?.[0];
  if (!card?.itemIds[0]) throw new Error("missing upstream card item");
  card.id = `toolchain:${card.token}:partition`;
  expect(body.briefing.themes.some(({ id }) => id === card.id)).toBe(false);
  const { container, inspector } = await mount(body);
  for (const opener of [".horizon-token", ".horizon-verb"]) {
    await click(container, `.horizon-card:first-child ${opener}`);
    expect(inspector.getState().selected).toBe(card.itemIds[0]);
  }
});

it("names each owed Detail button for its own item", async () => {
  const body = morning("owed");
  const owed = body.briefing.horizon.owed;
  const items = [...body.briefing.focus, ...body.briefing.rest].slice(0, 2);
  if (!owed || items.length !== 2) throw new Error("missing owed items");
  owed.itemIds = items.map(({ id }) => id);
  const { container, inspector } = await mount(body);
  const buttons = container.querySelectorAll<HTMLButtonElement>(".horizon-owed-open");
  expect([...buttons].map((button) => button.getAttribute("aria-label"))).toEqual(
    items.map(({ title }) => `Open Detail for ${title}`),
  );
  for (const [index, button] of [...buttons].entries()) {
    await act(async () => button.click());
    expect(inspector.getState().selected).toBe(items[index]?.id);
  }
});

it("opens the owed item, and leaves an unproven sync destination quiet", async () => {
  const body = morning("owed");
  const { container, inspector } = await mount(body);
  await click(container, ".horizon-owed button");
  expect(inspector.getState().selected).toBe(body.briefing.horizon.owed?.itemIds?.[0]);
  const sync = body.briefing.horizon.cards?.find((card) => card.kind === "sync");
  if (!sync) throw new Error("missing sync card");
  sync.itemIds = [];
  const unknown = await mount(body);
  const drawn = unknown.container.querySelector('.horizon-card[data-kind="sync"]');
  expect(drawn?.querySelector("button.horizon-token, button.horizon-verb")).toBeNull();
});

it("shows only a provenance-backed cut-radar caveat, with an Evidence opener", async () => {
  const body = morning("owed");
  const { container, evidence } = await mount(body);
  expect(container.querySelector(".horizon-caveat")?.textContent).toBe("⌀");
  expect(container.querySelector(".horizon-caveat")?.getAttribute("title")).toContain(
    "Upstream radar",
  );
  await click(container, ".horizon-caveat");
  expect(evidence).toHaveBeenCalledOnce();
  body.provenance = body.provenance.filter((p) => !p.path.startsWith("/briefing/horizon"));
  const unproven = await mount(body);
  expect(unproven.container.querySelector(".horizon-caveat")).toBeNull();
});

it("has a compact 740 conveyor that expands and collapses, with the strip's exact sync instant", async () => {
  const body = morning("busy");
  if (!body.briefing.nextSyncAt) throw new Error("missing next sync");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse(body.briefing.nextSyncAt) - 60 * 60 * 1000);
  expect(clockTime(body.briefing.nextSyncAt)).toContain("(in ");
  const { container } = await mount(body);
  const toggle = container.querySelector<HTMLButtonElement>(".horizon-compact");
  expect(toggle?.getAttribute("aria-expanded")).toBe("false");
  const instant = container.querySelector(".horizon-compact time");
  expect(instant?.getAttribute("dateTime")).toBe(body.briefing.nextSyncAt);
  if (!body.briefing.nextSyncAt) throw new Error("missing next sync");
  expect(instant?.textContent).toBe(clockTime(body.briefing.nextSyncAt, { hint: false }));
  await click(container, ".horizon-compact");
  expect(toggle?.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector(".horizon-conveyor")?.getAttribute("data-expanded")).toBe("true");
  await click(container, ".horizon-compact");
  expect(toggle?.getAttribute("aria-expanded")).toBe("false");
});
