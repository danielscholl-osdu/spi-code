// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { PROTOCOL_VERSION, type Station, type Tone, type ViewSnapshot } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import { closeSheet } from "../../app/navigation.js";
import { Shell } from "../../app/Shell.js";
import { selectionStore } from "../../panels/selection.js";
import { PINS_STORAGE_KEY, readPins } from "../../store/pins.js";
import { watchStore } from "../../store/watch.js";
import { fixtureLoader, installSpi } from "../../test-utils/harness.js";
import { clockTime } from "../../time.js";
import { after, midSweep, SWEEP_START, sweepStatus } from "../sweep/test-helper.js";

const FLEET = [
  "partition",
  "entitlements",
  "legal",
  "schema",
  "file",
  "storage",
  "indexer",
  "search",
  "workflow",
  "indexer-queue",
  "unit",
  "crs-catalog",
  "crs-conversion",
];
const loadFixture = fixtureLoader(readFixture);
const fixture = () => loadFixture("snapshot-1106.json");
const previousWatch = watchStore.getState();
let harness: ReturnType<typeof installSpi>;
let container: HTMLDivElement;
let unmount: (() => Promise<void>) | undefined;

function show(body: ViewSnapshot) {
  watchStore.setState({ snapshot: { cursor: body.cursor, body }, setup: null });
}

async function mount() {
  const style = document.createElement("style");
  style.textContent = [
    readFileSync("apps/window/src/style.css", "utf8"),
    readFileSync("apps/window/src/components/strip/strip.css", "utf8"),
  ].join("\n");
  document.head.append(style);
  container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Shell />));
  unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
    style.remove();
  };
}

const strip = () => container.querySelector<HTMLElement>(".window-strip [data-strip]");
const field = (name: string) => strip()?.querySelector<HTMLElement>(`[data-field="${name}"]`);
const fieldNames = () =>
  [...(strip()?.querySelectorAll<HTMLElement>("[data-field]") ?? [])].map(
    (node) => node.dataset.field,
  );
const states = () =>
  Object.fromEntries(
    ["environment", "template", "forks"].map((name) => {
      const button = field(name);
      const state = button?.querySelector(".strip-state");
      return [
        name,
        [button?.firstChild?.textContent, state?.textContent, state?.getAttribute("data-tone")],
      ];
    }),
  );
const sheet = () => container.querySelector(".line-sheet");

beforeEach(() => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
    "Mozilla/5.0 (Macintosh; Mac OS X) Electron/44.10.0",
  );
  closeSheet();
  window.location.hash = "#today";
  harness = installSpi();
  selectionStore.getState().clear();
  selectionStore.getState().setOpen(false);
  show(fixture());
});

afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  closeSheet();
  watchStore.setState(previousWatch, true);
  harness.restore();
  localStorage.removeItem(PINS_STORAGE_KEY);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("adds only a future next sweep to the freshness hover and accessible name, expiring on time", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(SWEEP_START + 130_000);
  const body = { ...fixture(), sweptAt: after(120) };
  show(body);
  watchStore.setState({ sweep: sweepStatus({ nextSweepAt: after(135) }) });
  await mount();
  const freshness = field("freshness");
  const label = () => document.getElementById(freshness?.getAttribute("aria-labelledby") ?? "");
  const next = `next sweep ${clockTime(after(135), { hint: false })}`;
  expect(freshness?.title).toContain(next);
  expect(label()?.textContent).toBe(freshness?.title);
  expect(freshness?.querySelector("[data-sweep-display]")?.textContent).not.toContain("next sweep");
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(freshness?.title).not.toContain("next sweep");
  expect(label()?.textContent).toBe(freshness?.title);
  await act(async () => watchStore.setState({ sweep: sweepStatus({ nextSweepAt: after(140) }) }));
  expect(freshness?.title).toContain("next sweep");
  await act(async () => watchStore.setState({ sweep: sweepStatus({ nextSweepAt: null }) }));
  expect(freshness?.title).not.toContain("next sweep");
});

const menu = (service: string) =>
  document.querySelector<HTMLElement>(`[data-pin-menu="${service}"]`);
const keydown = (target: Element | null | undefined, init: KeyboardEventInit) =>
  act(async () => {
    target?.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  });

it("holds the fields and panel controls beside the native window controls in one 44 px row, with no pips", async () => {
  await mount();
  const row = container.querySelector<HTMLElement>(".title-bar");
  const status = strip();
  if (!row || !status) throw new Error("Missing top row");
  expect(row?.contains(strip() ?? null)).toBe(true);
  expect(row?.querySelectorAll(".panel-controls")).toHaveLength(1);
  expect(row?.querySelector("[data-sweep-line]")).not.toBeNull();
  expect(row?.querySelector("[data-place]")).toBeNull();
  expect(container.querySelector("main .place-header [data-place]")?.textContent).toBe("Today");
  expect(document.title).toBe("SPI Code · Today");
  expect(getComputedStyle(row).height).toBe("44px");
  const rowStyle = getComputedStyle(row);
  const contentHeight =
    Number.parseFloat(rowStyle.height) -
    Number.parseFloat(rowStyle.borderTopWidth || "0") -
    Number.parseFloat(rowStyle.borderBottomWidth || "0");
  expect(getComputedStyle(status).height).toBe(`${contentHeight}px`);
  for (const target of status.querySelectorAll<HTMLElement>(":scope > button")) {
    expect(getComputedStyle(target).height).toBe(`${contentHeight}px`);
  }
  expect(container.querySelector(".shell")?.getAttribute("data-window-controls")).toBe("inset");
  expect(getComputedStyle(row).paddingLeft).toBe("84px");
  expect(row?.querySelector(".strip-line")).toBeNull();
  expect(getComputedStyle(status).flexWrap).toBe("nowrap");
  expect(container.querySelector(".strip-pips, .strip-pip-target, [data-pip]")).toBeNull();
  expect(status.querySelector("[data-service]")).toBeNull();
});

it("renders the fields from the November 6 sweep in PS-18 order", async () => {
  const body = fixture();
  await mount();
  const nextSync = body.briefing.nextSyncAt as string;
  expect(fieldNames()).toEqual(["environment", "template", "forks", "next-sync", "freshness"]);
  expect(states()).toEqual({
    environment: ["Environment", "Ready", "ok"],
    template: ["Templates", "13 pending", "warn"],
    forks: ["Forks", "1 stopped", "bad"],
  });
  expect(field("forks")?.title).toBe("Forks: 1 stopped. Stopped: entitlements.");
  expect(field("environment")?.title).toBe("Environment: Ready. v0.35.3 is ready.");
  expect(field("template")?.title).toBe(
    `Templates: 13 pending. Template 7d269b5 is pending on ${FLEET.join(", ")}.`,
  );
  expect(field("due")).toBeNull();
  expect(field("next-sync")?.textContent).toBe(`next sync ${clockTime(nextSync)}`);
});

type Body = ReturnType<typeof fixture>;
type SlotState = "empty" | "occupied" | "done" | "waiting" | "broken" | "unknown";

function environment(
  body: Body,
  fact: { tone: Tone; sub: string; figure?: string },
  hold?: string,
) {
  body.briefing.facts = body.briefing.facts.map((entry) =>
    entry.label === "Environment" ? { ...entry, ...fact } : entry,
  );
  const lane = body.briefing.environment.lanes.find(({ id }) => id === "holds");
  if (lane && hold !== undefined)
    lane.events.push({
      id: "hold-open",
      start: "2026-11-04T15:00:00.000Z",
      state: "held",
      label: hold,
      detail: `in maintenance for ${hold} so far`,
    });
  return body;
}

function rollout(body: Body, slots: (service: string, index: number) => SlotState) {
  for (const place of body.briefing.places ?? []) {
    if (place.visual?.kind !== "rollout") continue;
    place.visual.slots = place.visual.slots.map((slot, index) => ({
      ...slot,
      state: slots(slot.service, index),
    }));
  }
  return body;
}

function forks(body: Body, station: (service: string, id: Station["id"]) => Partial<Station>) {
  for (const row of body.stations) {
    row.stations = row.stations.map((entry) => ({
      ...entry,
      substate: "ready",
      state: "idle",
      ...station(row.service, entry.id),
    })) as typeof row.stations;
  }
  return body;
}

const flowing = (body: Body) => forks(body, () => ({}));
const current = (body: Body) => rollout(body, () => "done");
const STOPPED = new Set(["storage", "indexer", "search", "workflow"]);
const WAITING = new Set(["legal", "schema"]);

it.each([
  [
    "environment ready",
    (body: Body) => body,
    "environment",
    ["Ready", "ok", "Environment: Ready. v0.35.3 is ready."],
  ],
  [
    "environment in maintenance with nothing running",
    (body: Body) =>
      environment(
        body,
        { tone: "bad", sub: "held · The environment is in maintenance." },
        "2 d 13 h",
      ),
    "environment",
    [
      "Maintenance 2 d 13 h",
      "bad",
      "Environment: Maintenance 2 d 13 h. v0.35.3 has been in maintenance for 2 d 13 h, and nothing is running to clear it.",
    ],
  ],
  [
    "environment in maintenance while a refresh runs",
    (body: Body) =>
      environment(body, { tone: "warn", sub: "refresh running · at deploy" }, "2 d 13 h"),
    "environment",
    [
      "Maintenance · refresh running",
      "warn",
      "Environment: Maintenance · refresh running. v0.35.3 has been in maintenance for 2 d 13 h; refresh running.",
    ],
  ],
  [
    "templates current",
    current,
    "template",
    ["Current", "ok", "Templates: Current. Every fork is on template 7d269b5."],
  ],
  [
    "templates pending",
    (body: Body) =>
      rollout(body, (service) =>
        service === "legal"
          ? "empty"
          : service === "file"
            ? "waiting"
            : service === "unit"
              ? "occupied"
              : "done",
      ),
    "template",
    [
      "3 pending",
      "warn",
      "Templates: 3 pending. Template 7d269b5 is pending on legal, file, unit.",
    ],
  ],
  [
    "templates failed",
    (body: Body) =>
      rollout(body, (service) =>
        service === "storage"
          ? "broken"
          : service === "legal" || service === "unit"
            ? "occupied"
            : "done",
      ),
    "template",
    [
      "1 failed · 2 pending",
      "bad",
      "Templates: 1 failed · 2 pending. Template 7d269b5 failed on storage; pending on legal, unit.",
    ],
  ],
  [
    "forks flowing",
    flowing,
    "forks",
    ["Flowing", "ok", "Forks: Flowing. All 13 forks are flowing."],
  ],
  [
    "forks stopped",
    (body: Body) =>
      forks(body, (service, id) =>
        STOPPED.has(service) && id === "cascade"
          ? { substate: "stopped", state: "stopped" }
          : WAITING.has(service) && id === "sync"
            ? { substate: "waiting-on-person", state: "waiting" }
            : {},
      ),
    "forks",
    ["4 stopped", "bad", "Forks: 4 stopped. Stopped: storage, indexer, search, workflow."],
  ],
  [
    "forks waiting on a person",
    (body: Body) =>
      forks(body, (service, id) =>
        WAITING.has(service) && id === "sync"
          ? { substate: "waiting-on-person", state: "waiting" }
          : {},
      ),
    "forks",
    ["2 waiting", "warn", "Forks: 2 waiting. Waiting on a person: legal, schema."],
  ],
] as const)("words the %s", async (_case, change, name, [text, tone, label]) => {
  show(change(fixture()));
  await mount();
  const button = field(name);
  expect(button?.querySelector(".strip-state")?.textContent).toBe(text);
  expect(button?.querySelector(".strip-state")?.getAttribute("data-tone")).toBe(tone);
  expect(button?.title).toBe(label);
  expect(button?.getAttribute("aria-label")).toBe(label);
  expect(fieldNames().slice(0, 3)).toEqual(["environment", "template", "forks"]);
  for (const state of strip()?.querySelectorAll(".strip-state") ?? [])
    expect(state.textContent).not.toMatch(/ of |\//);
});

it.each([
  [
    "environment whose figure is not read",
    (body: Body) => environment(body, { tone: "ok", sub: "deployable", figure: "?" }),
    "environment",
  ],
  [
    "environment whose deployability is unread",
    (body: Body) => environment(body, { tone: "neutral", sub: "deployability unread" }),
    "environment",
  ],
  [
    "environment fact that is absent",
    (body: Body) => {
      body.briefing.facts = body.briefing.facts.filter(({ label }) => label !== "Environment");
      return body;
    },
    "environment",
  ],
  ["rollout whose slots are unknown", (body: Body) => rollout(body, () => "unknown"), "template"],
  [
    "rollout with one fork unknown and the rest done",
    (body: Body) => rollout(body, (_s, index) => (index === 4 ? "unknown" : "done")),
    "template",
  ],
  [
    "rollout that is absent",
    (body: Body) => {
      body.briefing.places = body.briefing.places?.filter(({ place }) => place !== "engineering");
      return body;
    },
    "template",
  ],
  [
    "rollout with no slots",
    (body: Body) => {
      for (const place of body.briefing.places ?? [])
        if (place.visual?.kind === "rollout") place.visual.slots = [];
      return body;
    },
    "template",
  ],
  [
    "fork whose stations were not read",
    (body: Body) =>
      forks(body, (service, id) =>
        service === "file" && id !== "lane" ? { state: "unknown" } : {},
      ),
    "forks",
  ],
  [
    "fleet with no stations",
    (body: Body) => {
      body.stations = [];
      return body;
    },
    "forks",
    ["template"],
  ],
] as const)(
  "reads not read yet in the plain tone for an %s",
  async (_case, change, name, quiet: readonly string[] = []) => {
    show(change(current(flowing(fixture()))));
    await mount();
    const state = field(name)?.querySelector(".strip-state");
    expect(state?.textContent).toBe("not read yet");
    expect(state?.getAttribute("data-tone")).toBe("plain");
    expect(field(name)?.title).not.toMatch(/Ready|Current|Flowing/);
    const others = ["environment", "template", "forks"].filter(
      (other) => other !== name && !quiet.includes(other),
    );
    expect(others.map((other) => field(other)?.querySelector(".strip-state")?.textContent)).toEqual(
      others.map(
        (other) => ({ environment: "Ready", template: "Current", forks: "Flowing" })[other],
      ),
    );
  },
);

it("names the forks not read beside a count, and keeps a stopped fork in the count", async () => {
  const body = forks(fixture(), (service, id) =>
    service === "storage" && id === "main"
      ? { substate: "stopped", state: "stopped" }
      : service === "file" && id === "sync"
        ? { state: "unknown" }
        : {},
  );
  show(
    rollout(body, (service) =>
      service === "legal" ? "occupied" : service === "unit" ? "unknown" : "done",
    ),
  );
  await mount();
  expect(field("forks")?.title).toBe("Forks: 1 stopped. Stopped: storage. Not read yet: file.");
  expect(field("template")?.title).toBe(
    "Templates: 1 pending. Template 7d269b5 is pending on legal. Not read yet on unit.",
  );
});

it("reads a fork with no rollout slot as not read, never Current", async () => {
  const body = current(flowing(fixture()));
  expect(body.stations).toHaveLength(13);
  for (const place of body.briefing.places ?? [])
    if (place.visual?.kind === "rollout")
      place.visual.slots = place.visual.slots.filter(({ service }) => service !== "unit");
  show(body);
  await mount();
  const state = field("template")?.querySelector(".strip-state");
  expect(state?.textContent).toBe("not read yet");
  expect(state?.getAttribute("data-tone")).toBe("plain");
  expect(field("template")?.title).toBe(
    "Templates: not read yet. Template 7d269b5 was not read on unit.",
  );
});

it("names a fork with no rollout slot beside a pending count", async () => {
  const body = rollout(flowing(fixture()), (service) => (service === "legal" ? "empty" : "done"));
  for (const place of body.briefing.places ?? [])
    if (place.visual?.kind === "rollout")
      place.visual.slots = place.visual.slots.filter(({ service }) => service !== "unit");
  show(body);
  await mount();
  expect(field("template")?.title).toBe(
    "Templates: 1 pending. Template 7d269b5 is pending on legal. Not read yet on unit.",
  );
});

it.each([
  ["done", "Current", "ok"],
  ["empty", "1 pending", "warn"],
] as const)("counts a %s slot for a service outside the fleet", async (slot, text, tone) => {
  const body = current(flowing(fixture()));
  for (const place of body.briefing.places ?? [])
    if (place.visual?.kind === "rollout")
      place.visual.slots = [
        ...place.visual.slots,
        { service: "retired", state: slot, text: `retired ${slot}` },
      ];
  show(body);
  await mount();
  const state = field("template")?.querySelector(".strip-state");
  expect(state?.textContent).toBe(text);
  expect(state?.getAttribute("data-tone")).toBe(tone);
});

it("reads Templates not read yet when the fleet is empty, though every slot is done", async () => {
  const body = current(flowing(fixture()));
  body.stations = [];
  show(body);
  await mount();
  const state = field("template")?.querySelector(".strip-state");
  expect(state?.textContent).toBe("not read yet");
  expect(state?.getAttribute("data-tone")).toBe("plain");
  expect(field("template")?.title).not.toMatch(/Current/);
});

it("draws the three state fields with no next sync when the snapshot has none", async () => {
  const body = fixture();
  delete body.briefing.nextSyncAt;
  show(body);
  await mount();
  expect(fieldNames()).toEqual(["environment", "template", "forks", "freshness"]);
});

it.each([
  ["environment", "#environment"],
  ["template", "#engineering-system"],
] as const)("opens the place behind the %s field", async (name, hash) => {
  await mount();
  const button = field(name);
  expect(button?.tagName).toBe("BUTTON");
  await act(async () => button?.click());
  expect(window.location.hash).toBe(hash);
  expect(sheet()).toBeNull();
});

it.each(["forks", "next-sync"])("opens the Line sheet from the %s field", async (name) => {
  await mount();
  const button = field(name);
  expect(button?.tagName).toBe("BUTTON");
  expect(sheet()).toBeNull();
  await act(async () => button?.click());
  expect(sheet()).not.toBeNull();
});

it("gives the Forks field the Line sheet's shortcut and the services it counts", async () => {
  await mount();
  const forks = field("forks");
  expect(forks?.getAttribute("aria-keyshortcuts")).toBe("Meta+L");
  expect(forks?.getAttribute("aria-controls")).toBe("app-line-sheet");
  expect(forks?.dataset.services).toBe(String(FLEET.length));
  await act(async () => forks?.focus());
  await act(async () => forks?.click());
  expect(sheet()?.id).toBe("app-line-sheet");
  await keydown(document.activeElement, { key: "Escape" });
  expect(sheet()).toBeNull();
  expect(document.activeElement).toBe(forks);
});

it("keeps each pip menu action on its service row in the Line sheet for the keyboard path", async () => {
  await mount();
  await keydown(document.body, { key: "l", metaKey: true });
  const service = sheet()?.querySelector<HTMLButtonElement>(
    '[data-service="entitlements"] th button',
  );
  expect(service).not.toBeNull();
  await act(async () => service?.focus());
  await keydown(service, { key: "F10", shiftKey: true });
  expect(menu("entitlements")).not.toBeNull();
  expect(menu("entitlements")?.textContent).toBe("Pin entitlements");
  await act(async () =>
    menu("entitlements")?.querySelector<HTMLElement>("[role='menuitem']")?.click(),
  );
  expect(readPins()).toEqual(["entitlements"]);
  await keydown(service, { key: "ContextMenu" });
  expect(menu("entitlements")?.textContent).toBe("Unpin entitlements");
  await keydown(document.activeElement, { key: "Escape" });
  expect(menu("entitlements")).toBeNull();
  expect(sheet()).not.toBeNull();
});

it("shows the freshness glyph in the title bar and opens the sweep Evidence from it", async () => {
  const body = fixture();
  await mount();
  const glyph = container.querySelector<HTMLButtonElement>("header [data-sweep-line]");
  expect(glyph?.querySelector("[data-sweep-display]")?.textContent).toBe(
    `${clockTime(body.sweptAt)} · 1`,
  );
  expect(document.getElementById(glyph?.getAttribute("aria-labelledby") ?? "")?.textContent).toBe(
    `Swept ${clockTime(body.sweptAt)} · 1 failed, 3 not read yet`,
  );
  expect(glyph?.getAttribute("data-tone")).toBe("bad");
  expect(container.querySelector('#app-right-panel [data-evidence="sweep"]')).toBeNull();
  await act(async () => glyph?.click());
  expect(container.querySelector('#app-right-panel [data-evidence="sweep"]')).not.toBeNull();
});

const glyph = () => container.querySelector<HTMLButtonElement>("header [data-sweep-line]");
const display = () => glyph()?.querySelector("[data-sweep-display]")?.textContent;
const glyphName = () =>
  document.getElementById(glyph()?.getAttribute("aria-labelledby") ?? "")?.textContent;
const receive = (type: string, payload: unknown) =>
  act(async () =>
    watchStore
      .getState()
      .receive({ version: PROTOCOL_VERSION, id: "host", kind: "event", type, payload }),
  );

it("carries the first sweep's count and scrolls the list into view", async () => {
  const scrolled: Element[] = [];
  const scrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  vi.stubGlobal("requestAnimationFrame", (step: FrameRequestCallback) =>
    setTimeout(() => step(0), 0),
  );
  try {
    window.location.hash = "#security";
    watchStore.setState({ snapshot: null, setup: null });
    await mount();
    expect(display()).toBe("waiting for the first sweep");
    await receive("sweep.progress", midSweep());
    expect(display()).toBe("sweeping · 9 of 12");
    expect(glyphName()).toBe("First sweep · 9 of 12 sources done");
    expect(glyph()?.title).toBe("First sweep · 9 of 12 sources done");
    expect(glyph()?.dataset.tone).toBe("run");
    expect(glyph()?.querySelector(".evidence-dot")?.getAttribute("data-tone")).toBe("run");
    await act(async () => glyph()?.click());
    await act(() => new Promise((done) => setTimeout(done, 20)));
    expect(window.location.hash).toBe("#today");
    expect(scrolled).toEqual([container.querySelector(".today-first .sweep-sources")]);
    expect(container.querySelector('#app-right-panel [data-evidence="sweep"]')).toBeNull();
    await receive("sweep.progress", { ...midSweep(), outcome: "cancelled" });
    expect(display()).toBe("first sweep stopped");
  } finally {
    Element.prototype.scrollIntoView = scrollIntoView;
  }
});

it.each(["failed", "cancelled"] as const)(
  "names a %s first sweep as stopped, reveals its panel, and resumes on retry",
  async (outcome) => {
    const scrolled: Element[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      scrolled.push(this);
    });
    vi.stubGlobal("requestAnimationFrame", (step: FrameRequestCallback) =>
      setTimeout(() => step(0), 0),
    );
    window.location.hash = "#security";
    watchStore.setState({ snapshot: null, setup: null });
    await mount();
    await receive(
      "sweep.progress",
      outcome === "cancelled"
        ? {
            ...midSweep(),
            outcome,
          }
        : {
            ...midSweep(),
            outcome: "failed",
            code: "timeout",
            failure: "GitHub did not answer in time.",
            source: "radar",
            nextAttemptAt: null,
          },
    );
    expect(display()).toBe("first sweep stopped");
    expect(glyphName()).toBe("first sweep stopped");
    expect(glyph()?.title).toBe("first sweep stopped");
    expect(glyph()?.dataset.tone).toBe("bad");
    expect(glyph()?.querySelector(".evidence-dot")?.getAttribute("data-tone")).toBe("bad");
    await act(async () => glyph()?.click());
    await act(() => new Promise((done) => setTimeout(done, 20)));
    expect(window.location.hash).toBe("#today");
    expect(scrolled).toEqual([container.querySelector(".today-first")]);
    expect(container.querySelector('#app-right-panel [data-evidence="sweep"]')).toBeNull();
    const retry = container.querySelector<HTMLButtonElement>(".today-first-actions button");
    expect(retry?.textContent).toBe("Try again");
    await act(async () => retry?.click());
    expect(window.spi.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sweep.request", payload: {} }),
    );
    await receive("sweep.progress", midSweep({ sweep: "sweep-2" }));
    expect(display()).toBe("sweeping · 9 of 12");
    expect(glyph()?.dataset.tone).toBe("run");
  },
);

it("keeps the sweep time over an older snapshot while a later sweep runs and opens its live list", async () => {
  const body = fixture();
  await mount();
  const later = midSweep({ first: false, sweep: "sweep-2" });
  await receive("sweep.progress", later);
  expect(display()).toBe(`${clockTime(body.sweptAt)} · sweeping 9 of 12`);
  expect(glyphName()).toBe(`Swept ${clockTime(body.sweptAt)} · sweeping, 9 of 12 sources done`);
  expect(glyph()?.dataset.tone).toBe("run");
  await act(async () => glyph()?.click());
  const evidence = () => container.querySelector('#app-right-panel [data-evidence="sweep"]');
  expect(evidence()?.querySelector("[data-sweep-list]")?.getAttribute("data-sweep-list")).toBe(
    "live",
  );
  expect(evidence()?.querySelectorAll(".sweep-row")).toHaveLength(12);
  expect(evidence()?.querySelector(".sweep-row .evidence-fact")?.textContent).toMatch(/last read/);
  await receive("sweep.progress", {
    ...later,
    outcome: "committed",
    sources: later.sources.map((source) =>
      source.state === "reading" || source.state === "waiting"
        ? { source: source.source, state: "read", startedAt: after(120), endedAt: after(128) }
        : source,
    ),
  });
  expect(display()).toBe(`${clockTime(body.sweptAt)} · 1`);
  expect(evidence()?.querySelector("[data-sweep-list]")?.getAttribute("data-sweep-list")).toBe(
    "completed",
  );
  expect(evidence()?.querySelectorAll(".sweep-row")).toHaveLength(12);
  expect(evidence()?.querySelector(".sweep-meta")).toBeNull();
});

it("shows a newer sweep that stopped over the last completed list, with its reason and retry", async () => {
  vi.useFakeTimers({ now: Date.parse(after(130)), toFake: ["Date"] });
  await mount();
  const done = midSweep({ first: false, sweep: "sweep-2" });
  await receive("sweep.progress", {
    ...done,
    outcome: "committed",
    sources: done.sources.map((source) =>
      source.state === "reading" || source.state === "waiting"
        ? { source: source.source, state: "read", startedAt: after(120), endedAt: after(128) }
        : source,
    ),
  });
  await act(async () => glyph()?.click());
  const list = () =>
    container.querySelector<HTMLElement>(
      '#app-right-panel [data-evidence="sweep"] [data-sweep-list]',
    );
  expect(list()?.dataset.sweepList).toBe("completed");
  const later = midSweep({ first: false, sweep: "sweep-3" });
  await receive("sweep.progress", later);
  expect(list()?.dataset.sweepList).toBe("live");
  await receive("sweep.progress", {
    ...later,
    outcome: "failed",
    code: "timeout",
    failure: "GitLab did not answer in time.",
    source: "radar",
    nextAttemptAt: "2026-11-09T08:07:00Z",
  });
  expect(list()?.dataset.sweepList).toBe("stopped");
  const outcome = list()?.querySelector('[data-sweep-outcome="failed"]');
  expect(outcome?.textContent).toMatch(
    /^This sweep stopped\. It stopped while reading .+: GitLab did not answer in time\. SPI Code tries again at /,
  );
  expect(outcome?.querySelector("time")?.getAttribute("dateTime")).toBe("2026-11-09T08:07:00Z");
  expect(list()?.querySelector<HTMLElement>('.sweep-row[data-source="radar"]')?.dataset.tone).toBe(
    "bad",
  );
  expect(list()?.querySelectorAll(".sweep-row")).toHaveLength(12);
});

it("opens each place and the Line with one line before the first snapshot, its sidebar row muted", async () => {
  window.location.hash = "#upstream";
  watchStore.setState({ snapshot: null, setup: null, progress: midSweep() });
  await mount();
  const main = () => container.querySelector("[data-before-sweep] .place-before-sweep");
  expect(container.querySelector("[data-before-sweep] h1")?.textContent).toBe("Upstream");
  expect(main()?.textContent).toBe("Upstream opens after the first sweep. It is read 9th of 12.");
  const row = (key: string) =>
    container.querySelector<HTMLElement>(`.app-sidebar [data-sidebar-row="${key}"]`);
  expect(row("upstream")?.hasAttribute("data-before-sweep")).toBe(true);
  expect(row("today")?.hasAttribute("data-before-sweep")).toBe(false);
  await act(async () => {
    window.location.hash = "#security";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  expect(main()?.textContent).toBe("Security opens after the first sweep. It is read 11th of 12.");
  await act(async () => container.querySelector<HTMLElement>('[data-sidebar-row="line"]')?.click());
  expect(sheet()?.querySelector(".line-before-sweep")?.textContent).toBe(
    "Service rows appear after the first sweep.",
  );
  await act(async () => show(fixture()));
  expect(container.querySelector("[data-before-sweep]")).toBeNull();
  expect(sheet()?.querySelector(".line-before-sweep")).toBeNull();
  expect(row("upstream")?.hasAttribute("data-before-sweep")).toBe(false);
});

it("opens the first sweep's retained list in Evidence after hand-over", async () => {
  const body = fixture();
  watchStore.setState({ snapshot: null, setup: null });
  await mount();
  const first = midSweep();
  await receive("sweep.progress", first);
  await receive("sweep.progress", {
    ...first,
    outcome: "committed",
    sources: first.sources.map((source) =>
      source.state === "reading" || source.state === "waiting"
        ? { source: source.source, state: "read", startedAt: after(120), endedAt: after(128) }
        : source,
    ),
  });
  await receive("view.snapshot", body);
  expect(display()).toBe(`${clockTime(body.sweptAt)} · 1`);
  await act(async () => glyph()?.click());
  const list = container.querySelector(
    '#app-right-panel [data-evidence="sweep"] [data-sweep-list]',
  );
  expect(list?.getAttribute("data-sweep-list")).toBe("completed");
  expect(list?.querySelectorAll(".sweep-row")).toHaveLength(12);
  expect(list?.querySelector('.sweep-row[data-source="upstream"]')?.textContent).toMatch(/failed/i);
});
