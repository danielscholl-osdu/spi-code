// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import { ProgramSidebar } from "../../components/sidebar/ProgramSidebar.js";
import { SidebarProvider } from "../../components/sidebar/ui-sidebar.js";
import { createSelectionStore } from "../../panels/selection.js";
import { createWatchStore } from "../../store/watch.js";
import { fixtureLoader } from "../../test-utils/harness.js";
import { plainTitle } from "../../text.js";
import { clockTime, timedText } from "../../time.js";
import { AttentionBand } from "./Band.js";

const loadFixture = fixtureLoader(readFixture);
const RECORDED = loadFixture("snapshot-59d6895.json");
const STACK = "stack:38181620856";
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** The recorded sweep: the environment held 9 d 16 h while an upgrade runs, its hold naming the stack Interrupt. */
const recorded = () => structuredClone(RECORDED);

/** The same hold with nothing running to clear it, worded as core words it. */
function noRun() {
  const body = recorded();
  const fact = body.briefing.facts.find(({ label }) => label === "Environment");
  const reading = body.readings.find(({ anchor }) => anchor.kind === "environment")?.content;
  if (!fact || !reading) throw new Error("the recorded sweep carries no Environment fact");
  fact.tone = "bad";
  fact.sub = "held · maintenance set";
  reading.headline = "v0.28.0 in maintenance for 9 d 16 h, with no run in flight.";
  return body;
}

const holds = (body: ViewSnapshot) => {
  const lane = body.briefing.environment.lanes.find(({ id }) => id === "holds");
  const open = lane?.events.find(({ end, state }) => end === undefined && state === "held");
  if (!lane || !open) throw new Error("the recorded sweep holds no open event");
  return { lane, open };
};
const item = (body: ViewSnapshot, id: string) => {
  const found = [...body.briefing.focus, ...body.briefing.rest].find((entry) => entry.id === id);
  if (!found) throw new Error(`no item ${id}`);
  return found;
};
const headline = (body: ViewSnapshot) =>
  body.readings.find(({ anchor }) => anchor.kind === "environment")?.content?.headline;

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

async function band(body: ViewSnapshot) {
  const inspector = createSelectionStore({ postMessage: vi.fn() });
  const onNavigate = vi.fn();
  const container = await render(
    <AttentionBand snapshot={body} inspector={inspector} onNavigate={onNavigate} />,
  );
  return { container, inspector, onNavigate };
}

const needIds = (container: Element) =>
  [...container.querySelectorAll("li.today-need")].map((li) => li.getAttribute("data-item-id"));
const heading = (container: Element) =>
  container.querySelector(".today-needs .today-band-heading")?.textContent;

describe("Stops the line", () => {
  it.each([
    ["with a run in flight", recorded, "warn"],
    ["with nothing running to clear it", noRun, "bad"],
  ] as const)("leads the band %s, from the open hold and its Interrupt", async (_, make, tone) => {
    const body = make();
    const { open } = holds(body);
    const stack = item(body, STACK);
    if (!stack.blocks || !open.inspect) throw new Error("the stack Interrupt blocks nothing");
    const { container } = await band(body);
    const block = container.querySelector(".today-band > .today-stop");
    expect(block?.getAttribute("data-item-id")).toBe(stack.id);
    expect(block?.getAttribute("data-tone")).toBe(tone);
    expect(block?.nextElementSibling?.classList.contains("today-band-grid")).toBe(true);
    expect(block?.querySelector(".today-stop-label")?.textContent).toBe(
      "Stops the line · the shared CI/CD stack every prove borrows",
    );
    expect(block?.querySelector(".today-stop-title")?.textContent).toBe(headline(body));
    expect(block?.querySelector(".today-stop-length")?.textContent).toBe(
      `${open.label} since ${clockTime(open.start, { hint: false })}`,
    );
    expect(block?.querySelector(".today-stop-length time")?.getAttribute("dateTime")).toBe(
      open.start,
    );
    const facts = [...(block?.querySelectorAll(".today-stop-facts > div") ?? [])].map((row) => [
      row.querySelector("dt")?.textContent,
      row.querySelector("dd")?.textContent,
    ]);
    expect(facts).toEqual([
      ["Why", timedText(plainTitle(stack.cause), { hint: false })],
      ["Next", timedText(plainTitle(stack.next), { hint: false })],
      ["Holds up", stack.blocks.text],
    ]);
    expect(block?.querySelector(".today-stop-blocks .kit-chip")?.getAttribute("title")).toBe(
      timedText(plainTitle(stack.effect), { hint: false }),
    );
    expect(block?.querySelector(".today-verb")?.textContent).toBe(`${stack.verb} ›`);
    expect(container.querySelectorAll(`[data-item-id="${STACK}"]`)).toHaveLength(1);
  });

  const withoutFact = () => {
    const body = recorded();
    body.briefing.facts = body.briefing.facts.filter(({ label }) => label !== "Environment");
    return body;
  };
  const unreadFact = () => {
    const body = recorded();
    const fact = body.briefing.facts.find(({ label }) => label === "Environment");
    if (!fact) throw new Error("the recorded sweep carries no Environment fact");
    Object.assign(fact, { figure: "?", sub: "deployability unread", tone: "neutral" });
    return body;
  };

  it.each([
    ["a run is in flight", recorded, "warn"],
    ["no run is in flight", noRun, "bad"],
    ["the Environment fact is missing", withoutFact, "plain"],
    ["the Environment fact was not read", unreadFact, "plain"],
  ] as const)("takes its tone from the evidence: %s", async (_, make, tone) => {
    const { container } = await band(make());
    const block = container.querySelector(".today-stop");
    expect(block?.getAttribute("data-item-id")).toBe(STACK);
    expect(block?.getAttribute("data-tone")).toBe(tone);
  });

  it.each([
    ["missing", withoutFact],
    ["not read", unreadFact],
  ] as const)(
    "never says nothing is running while its title names a run, with the fact %s",
    async (_, make) => {
      const body = make();
      const { container } = await band(body);
      const block = container.querySelector(".today-stop");
      expect(block?.querySelector(".today-stop-title")?.textContent).toMatch(/\bruns\b/);
      expect(block?.getAttribute("data-tone")).toBe("plain");
      expect(block?.textContent).not.toMatch(/nothing is running|no run in flight/);
    },
  );

  it("selects the item in Detail from its verb, and opens the Environment place from its title", async () => {
    const { container, inspector, onNavigate } = await band(recorded());
    const block = container.querySelector(".today-stop");
    await act(async () => block?.querySelector<HTMLButtonElement>(".today-verb")?.click());
    expect(inspector.getState().selected).toBe(STACK);
    expect(inspector.getState().row?.kind).toBe("queue");
    expect(inspector.getState().tab).toBe("detail");
    expect(block?.getAttribute("aria-current")).toBe("true");
    await act(async () => block?.querySelector<HTMLButtonElement>(".today-stop-title")?.click());
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "environment" });
  });

  it("draws the blocks chip only when the item carries one, and no length core could not word", async () => {
    const body = recorded();
    delete item(body, STACK).blocks;
    holds(body).open.label = "?";
    const { container } = await band(body);
    const block = container.querySelector(".today-stop");
    expect(block).not.toBeNull();
    expect(block?.querySelector(".today-stop-blocks, .kit-chip")).toBeNull();
    expect(
      [...(block?.querySelectorAll(".today-stop-facts dt") ?? [])].map((dt) => dt.textContent),
    ).toEqual(["Why", "Next"]);
    expect(block?.querySelector(".today-stop-length strong")).toBeNull();
    expect(block?.querySelector(".today-stop-length")?.textContent).toMatch(/^ since \d/);
  });

  it("leaves the rest in Needs you, headed for services only when every one is a service's", async () => {
    const body = recorded();
    const { container } = await band(body);
    expect(needIds(container)).toEqual(["halt:entitlements"]);
    expect(heading(container)).toBe("Needs you · services · 1");
    const mixed = recorded();
    item(mixed, "halt:entitlements").scope = "Environment";
    expect(heading((await band(mixed)).container)).toBe("Needs you · 1");
  });

  it("keeps the sidebar's Today count on every Interrupt, the one in the block included", async () => {
    const body = recorded();
    const store = createWatchStore(vi.fn());
    store.setState({ snapshot: { cursor: body.cursor, body } });
    const sidebar = await render(
      <SidebarProvider>
        <ProgramSidebar store={store} route={{ kind: "today" }} onNavigate={vi.fn()} />
      </SidebarProvider>,
    );
    const { container } = await band(body);
    expect(container.querySelectorAll(".today-stop")).toHaveLength(1);
    expect(needIds(container)).toHaveLength(1);
    expect(sidebar.querySelector('ul[aria-label="Today"] .sidebar-pip')?.textContent).toBe("2");
  });

  it.each([
    [
      "the hold has ended",
      (body: ViewSnapshot) => {
        const { open } = holds(body);
        open.end = "2026-10-21T15:00:00.000Z";
      },
    ],
    [
      "the hold names no item",
      (body: ViewSnapshot) => {
        delete holds(body).open.inspect;
      },
    ],
    [
      "the hold names an item that is not an Interrupt",
      (body: ViewSnapshot) => {
        const other = [...body.briefing.focus, ...body.briefing.rest].find(
          ({ attention }) => attention !== "interrupt",
        );
        if (!other) throw new Error("the recorded sweep holds only Interrupts");
        holds(body).open.inspect = other.id;
      },
    ],
    [
      "the hold names an id no item carries",
      (body: ViewSnapshot) => {
        holds(body).open.inspect = "stack:0";
      },
    ],
    [
      "the Held lane was not read",
      (body: ViewSnapshot) => {
        body.briefing.environment.lanes = body.briefing.environment.lanes.filter(
          ({ id }) => id !== "holds",
        );
      },
    ],
  ] as const)("draws no block when %s, and the item stays in Needs you", async (_, change) => {
    const body = recorded();
    change(body);
    const { container } = await band(body);
    expect(container.querySelector(".today-stop")).toBeNull();
    expect(needIds(container)).toEqual([STACK, "halt:entitlements"]);
    expect(heading(container)).toBe("Needs you · 2");
  });
});
