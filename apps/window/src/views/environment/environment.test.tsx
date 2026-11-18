// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROTOCOL_VERSION } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import briefing from "../../../../../fixtures/rib-59d6895/oracle/briefing.json?raw";
import consoleHtml from "../../../../../fixtures/rib-59d6895/oracle/console.html?raw";
import placement from "../../../../../fixtures/rib-59d6895/oracle/environment-place.json?raw";
import releases from "../../../../../fixtures/rib-59d6895/oracle/releases.json?raw";
import recorded from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import { openSelection, setOpenSelection } from "../../app/navigation.js";
import {
  expectEvidenceMarks,
  expectNoEvidenceMarks,
} from "../../components/evidence/marks.test-helper.js";
import { mixedSnapshot, testSnapshot } from "../../store/test-snapshot.js";
import { createWatchStore } from "../../store/watch.js";
import { watchFixtureText } from "../../test-utils/watch-fixtures.test-helper.js";
import { timedText } from "../../time.js";
import Environment from "./index.js";
import { eventWhen, hourTicks, place } from "./timeline.js";

const mixed = watchFixtureText("snapshot-mixed-59d6895.json", readFixture);

const snapshot = testSnapshot(briefing, releases);
const environmentStyles = readFileSync(
  resolve("apps/window/src/views/environment/environment.css"),
  "utf8",
);
const environment = snapshot.briefing.environment;
const from = Date.parse(environment.to) - 86_400_000;
const to = Date.parse(environment.to);
const first = environment.lanes[0]?.events[0];
if (!first) throw new Error("Oracle must contain an event");

it("places every frozen event exactly as the rib oracle", () => {
  expect({
    from: new Date(from).toISOString(),
    to: environment.to,
    lanes: environment.lanes.map((lane) => ({
      id: lane.id,
      placed: place(lane.events, from, to),
    })),
  }).toEqual(JSON.parse(placement));
});

it("sorts without mutation, clips open events and bounds overlapping tiers at six", () => {
  const event = first;
  const events = Array.from({ length: 8 }, (_, id) => ({
    ...event,
    id: String(id),
    start: new Date(500).toISOString(),
    end: new Date(500).toISOString(),
    label: "a",
    state: "ok" as const,
  }));
  expect(
    place(events, 0, 1000).map(({ left, width, tier, flip }) => [left, width, tier, flip]),
  ).toEqual([0, 1, 2, 3, 4, 5, 0, 0].map((tier) => [50, 0, tier, false]));
  const early = { ...event, start: new Date(-500).toISOString() };
  const late = { ...event, start: new Date(1500).toISOString() };
  const unsorted = [late, early];
  expect(
    place(unsorted, 0, 1000).map(({ e, left, width, flip }) => [e.start, left, width, flip]),
  ).toEqual([
    [early.start, 0, 100, true],
    [late.start, 100, 0, true],
  ]);
  expect(unsorted).toEqual([late, early]);
});

it("reuses cleared tiers and reserves space for a flipped label", () => {
  const events = [10, 11, 50, 95].map((at, id) => ({
    ...first,
    id: String(id),
    label: "a",
    state: "ok" as const,
    start: new Date(at).toISOString(),
    end: new Date(at + 5).toISOString(),
  }));
  expect(
    place(events, 0, 100).map(({ left, width, tier, flip }) => [left, width, tier, flip]),
  ).toEqual([
    [10, expect.closeTo(5), 0, false],
    [11, expect.closeTo(5), 1, false],
    [50, expect.closeTo(5), 0, false],
    [95, expect.closeTo(5), 0, true],
  ]);
});

it("uses the track clock for event duration", () => {
  expect(eventWhen({ ...first, start: new Date(0).toISOString() }, new Date(3_600_000))).toContain(
    "to now \u00b7 1\u00a0h",
  );
});

it.each([
  [2 * 24, "2\u00a0d"],
  [9 * 24 + 16, "9\u00a0d 16\u00a0h"],
])("keeps day and hour units bound in a %i-hour timeline event", (hours, expected) => {
  const end = new Date(hours * 3_600_000);
  expect(
    eventWhen({ ...first, start: new Date(0).toISOString(), end: end.toISOString() }, end),
  ).toContain(` \u00b7 ${expected}`);
});

it("ticks at local hours strictly inside the window", () => {
  const start = new Date(2026, 9, 21, 10, 30).getTime();
  const end = new Date(2026, 9, 21, 13).getTime();
  expect(hourTicks(start, end).map(({ text }) => text)).toEqual(["11:00", "12:00"]);
  expect(hourTicks(new Date(2026, 9, 21, 11).getTime(), end).map(({ text }) => text)).toEqual([
    "12:00",
  ]);
});

it("uses the rib's unknown timestamp marker for malformed dates", () => {
  const now = new Date(to);
  expect(eventWhen({ ...first, start: "invalid", end: undefined }, now)).toBe("? to now");
  expect(eventWhen({ ...first, start: "invalid", end: "invalid" }, now)).toBe("? to ?");
  expect(eventWhen({ ...first, end: "invalid" }, now)).toMatch(/ to \?$/);
});

it("keeps timeline affordances, and the empty lane's words clear of the sticky lane label", async () => {
  const store = createWatchStore(vi.fn());
  store.setState({
    snapshot: {
      cursor: 1,
      body: {
        ...snapshot,
        briefing: {
          ...snapshot.briefing,
          environment: {
            ...environment,
            lanes: [
              { id: "upgrade", label: "Upgrade", events: [first] },
              { id: "refresh", label: "Refresh", events: [] },
            ],
          },
        },
      },
    },
  });
  const container = document.createElement("div");
  container.style.color = "rgb(10, 20, 30)";
  container.style.setProperty("--error-text", "rgb(100, 0, 0)");
  container.style.setProperty("--warning-text", "rgb(100, 80, 0)");
  container.style.setProperty("--success-text", "rgb(0, 100, 0)");
  document.body.append(container);
  const root = createRoot(container);
  const style = document.createElement("style");
  style.textContent = environmentStyles;
  document.head.append(style);
  try {
    await act(async () => root.render(<Environment store={store} />));
    const bar = container.querySelector(".env-event");
    const empty = container.querySelector(".env-none");
    if (!bar || !empty) throw new Error("Missing environment elements");
    expect(container.querySelector(".env-detail, [aria-label='Event details']")).toBeNull();
    expect(container.querySelector(".env-inspect")).toBeNull();
    expect(getComputedStyle(bar).cursor).toBe("pointer");
    const label = container.querySelector(".env-lane-label");
    const row = container.querySelector(".env-row:not(.env-axis)");
    if (!label || !row) throw new Error("Missing lane row");
    const column = Number.parseFloat(getComputedStyle(row).gridTemplateColumns);
    expect(getComputedStyle(label).position).toBe("sticky");
    expect(getComputedStyle(label).left).toBe("0px");
    expect(getComputedStyle(empty).position).toBe("sticky");
    expect(Number.parseFloat(getComputedStyle(empty).left)).toBeGreaterThan(column);
  } finally {
    await act(async () => root.unmount());
    style.remove();
    container.remove();
  }
});

it("renders oracle lane order, labels and bars; a bar opens its popover", async () => {
  const store = createWatchStore(vi.fn());
  const receive = (body: typeof snapshot) =>
    store.getState().receive({
      version: PROTOCOL_VERSION,
      id: "snapshot",
      kind: "event",
      type: "view.snapshot",
      payload: body,
    });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Environment store={store} />));
    expect(container.querySelector(".place h1")?.textContent).toBe("Environment");
    expect(container.querySelector(".place-reading")).toBeNull();
    expect(container.querySelector("details")).toBeNull();
    await act(async () => receive(snapshot));
    expect(container.querySelector(".env-lead")?.textContent).toBe(environment.headline);
    const labels = [...consoleHtml.matchAll(/<div class="tl-lab">([^<]+)<\/div>/g)].map(
      (match) => match[1],
    );
    expect(
      [...container.querySelectorAll("[data-lane] .env-lane-label")].map((el) => el.textContent),
    ).toEqual(labels);
    expect(
      [...container.querySelectorAll("[data-lane]")].map((el) => el.getAttribute("data-lane")),
    ).toEqual(JSON.parse(placement).lanes.map((lane: { id: string }) => lane.id));
    expect(container.querySelectorAll(".env-none")).toHaveLength(2);
    for (const lane of JSON.parse(placement).lanes) {
      for (const p of lane.placed) {
        const bar = container.querySelector<HTMLButtonElement>(
          `[data-event="${lane.id}:${p.e.id}"]`,
        );
        expect(bar?.style.left).toBe(`${p.left}%`);
        expect(bar?.style.width).toBe(`${p.width}%`);
        expect(bar?.style.top).toBe(`${p.tier * 22 + 10}px`);
        expect(bar?.querySelector(".env-event-label")?.classList.contains("flip")).toBe(p.flip);
      }
    }
    const bars = container.querySelectorAll<HTMLButtonElement>("[data-event]");
    await act(async () => bars[1]?.click());
    expect(bars[1]?.getAttribute("aria-expanded")).toBe("true");
    expect(openSelection()).toEqual({ kind: "event", id: bars[1]?.dataset.event });
    expect(container.querySelector(".popover")).not.toBeNull();
    expect(container.querySelector(".env-detail")).toBeNull();

    const failed = { ...first, id: "failure", state: "failed" as const };
    await act(async () =>
      receive({
        ...snapshot,
        cursor: 2,
        briefing: {
          ...snapshot.briefing,
          environment: {
            ...environment,
            lanes: [{ id: "upgrade", label: "Upgrade", events: [failed] }],
          },
        },
      }),
    );
    expect(container.querySelector("[data-event]")?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".popover")).toBeNull();
    expect(container.querySelector(".env-detail")).toBeNull();
    await act(async () =>
      receive({
        ...snapshot,
        cursor: 3,
        briefing: {
          ...snapshot.briefing,
          environment: { ...environment, lanes: [], borrows: [], forksNote: undefined },
        },
      }),
    );
    expect(container.querySelector(".env-timeline")).toBeNull();
    expect(container.querySelector(".env-detail")).toBeNull();
  } finally {
    await act(async () => setOpenSelection(null));
    await act(async () => root.unmount());
    container.remove();
  }
});

it.each([
  ["mixed", mixedSnapshot(mixed)],
  ["plain", snapshot],
] as const)(
  "gives the %s fixture's environment sections one evidence line each, never per value",
  async (name, body) => {
    const store = createWatchStore(vi.fn());
    store.setState({ snapshot: { cursor: 1, body } });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Environment store={store} />));
      if (name === "plain") {
        expectNoEvidenceMarks(container);
        return;
      }
      expectEvidenceMarks(container, body, {
        sections: [
          ["/briefing/environment/headline"],
          ...(body.briefing.environment.line ? [["/briefing/environment/line"]] : []),
          ["/briefing/environment/lanes"],
          [
            `/briefing/repositories/rows/${body.briefing.repositories.rows.findIndex((row) => row.name === "osdu-spi-stack")}`,
          ],
        ],
      });
      expect(container.querySelector("[data-pointer] [data-inferred]")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  },
);

it.each(["identified", "unidentified"])(
  "keys repeated %s repository lines by position",
  async (identity) => {
    const body = mixedSnapshot(mixed);
    const section = body.briefing.repositories.rows.find((row) => row.name === "osdu-spi-stack")
      ?.sections[0];
    const line = section?.lines[0];
    if (!section || !line?.id) throw new Error("Missing recorded stack repository line");
    if (identity === "unidentified") {
      delete line.id;
      delete line.url;
    }
    section.lines = [line, { ...line }];
    const store = createWatchStore(vi.fn());
    store.setState({ snapshot: { cursor: body.cursor, body } });
    const errors = vi.spyOn(console, "error");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Environment store={store} />));
      expect(
        [...container.querySelectorAll(".env-repo-line")].filter((element) =>
          element.textContent?.includes(line.text),
        ),
      ).toHaveLength(2);
      expect(
        errors.mock.calls.filter((args) => args.some((arg) => String(arg).includes("same key"))),
      ).toHaveLength(0);
    } finally {
      await act(async () => root.unmount());
      errors.mockRestore();
      container.remove();
    }
  },
);

it("orders the place, stack runs and stack repository", async () => {
  const body = mixedSnapshot(mixed);
  const store = createWatchStore(vi.fn());
  store.setState({ snapshot: { cursor: body.cursor, body } });
  const repo = body.briefing.repositories.rows.find((row) => row.name === "osdu-spi-stack");
  if (!repo) throw new Error("Recorded snapshot needs the stack repository");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Environment store={store} />));
    const page = container.querySelector(".environment");
    if (!page) throw new Error("Missing Environment page");
    expect(
      [...page.children].map(
        (child) => child.getAttribute("data-part") ?? child.getAttribute("aria-label"),
      ),
    ).toEqual(["Environment", "runs", "repository"]);
    expect(page.textContent).not.toContain("not available yet");
    expect(page.textContent).not.toMatch(/\bM[0-9]\b/);
    for (const section of repo.sections) {
      expect(page.textContent).toContain(section.title);
      expect(page.textContent).toContain(section.count);
      if (section.rest) expect(page.textContent).toContain(section.rest);
      for (const entry of section.lines) {
        expect(page.textContent).toContain(entry.tag);
        expect(page.textContent).toContain(entry.text);
        expect(page.textContent).toContain(entry.sub);
      }
    }
    expect(page.textContent).toContain(repo.title);
    expect(page.textContent).toContain(repo.sub);
    expect(page.querySelector(".env-detail, .inspector, aside")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("omits absent snapshot parts and leaves unidentifiable lines as text, not fake selections", async () => {
  const body = mixedSnapshot(mixed);
  const store = createWatchStore(vi.fn());
  const repo = body.briefing.repositories.rows.find((row) => row.name === "osdu-spi-stack");
  const line = repo?.sections[0]?.lines[0];
  if (!repo || !line) throw new Error("Missing recorded stack line");
  delete line.id;
  delete line.url;
  repo.note = "Recorded repository note";
  store.setState({ snapshot: { cursor: 1, body } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Environment store={store} />));
    const textLine = [...container.querySelectorAll(".env-repo-line")].find((element) =>
      element.textContent?.includes(line.text),
    );
    expect(textLine).toBeDefined();
    expect(textLine?.hasAttribute("data-opens")).toBe(false);
    expect(textLine?.tagName).not.toBe("BUTTON");
    expect(container.textContent).toContain(repo.note);
    const bare = structuredClone(body);
    bare.briefing.environment.facts = [];
    bare.briefing.environment.lanes = [];
    delete bare.briefing.environment.forksNote;
    bare.briefing.environment.borrows = [];
    bare.briefing.repositories.rows = bare.briefing.repositories.rows.filter(
      (row) => row.name !== "osdu-spi-stack",
    );
    await act(async () => store.setState({ snapshot: { cursor: 2, body: bare } }));
    expect(container.querySelector(".env-part-body > .env-facts")).toBeNull();
    expect(container.querySelector(".env-day")).toBeNull();
    expect(container.querySelector("[data-part='repository']")).toBeNull();
    expect(container.textContent).not.toContain(repo.note);
    expect(container.querySelector("[data-part='runs'] .env-lead")?.textContent).toBe(
      bare.briefing.environment.headline,
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

async function renderRecorded(body = mixedSnapshot(recorded)) {
  const store = createWatchStore(vi.fn());
  store.setState({ snapshot: { cursor: body.cursor, body } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Environment store={store} />));
  const page = container.querySelector<HTMLElement>(".environment");
  if (!page) throw new Error("Missing Environment place");
  return {
    body,
    container,
    page,
    done: async () => {
      await act(async () => setOpenSelection(null));
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("draws the last 24 hours open between status and the items, an open hold apart from an ended one", async () => {
  const body = mixedSnapshot(mixed);
  const environment = body.briefing.environment;
  const holds = environment.lanes.find(({ id }) => id === "holds");
  const [open] = holds?.events ?? [];
  if (!holds || !open || open.end) throw new Error("Mixed snapshot needs an open hold");
  const from = Date.parse(environment.to) - 86_400_000;
  const ended = {
    id: String(from + 3_600_000),
    start: new Date(from + 3_600_000).toISOString(),
    end: new Date(from + 7_200_000).toISOString(),
    state: "held" as const,
    label: "1 h",
    detail: "in maintenance for 1 h",
  };
  holds.events.unshift(ended);
  const view = await renderRecorded(body);
  try {
    const day = view.page.querySelector(".place-reading .env-day");
    const status = view.page.querySelector(".env-status");
    const groups = view.page.querySelector(".place-groups");
    if (!day || !status || !groups)
      throw new Error("Missing the place's status, timeline or items");
    expect(day.closest("details")).toBeNull();
    expect(day.querySelector("h3")?.textContent).toBe("Last 24 hours");
    expect(status.compareDocumentPosition(day)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(day.compareDocumentPosition(groups)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    const holds = [...day.querySelectorAll<HTMLElement>('[data-lane="holds"] [data-event]')];
    expect(holds.map((bar) => [bar.dataset.event, bar.classList.contains("open")])).toEqual([
      [`holds:${open.id}`, true],
      [`holds:${ended.id}`, false],
    ]);
    for (const bar of day.querySelectorAll<HTMLElement>("[data-event]")) {
      const [lane, id] = bar.dataset.event?.split(":") ?? [];
      const event = environment.lanes
        .find((other) => other.id === lane)
        ?.events.find((e) => e.id === id);
      expect(bar.classList.contains("open"), bar.dataset.event).toBe(event?.end === undefined);
    }
  } finally {
    await view.done();
  }
});

it.each([
  ["1106", recorded],
  ["mixed", mixed],
] as const)(
  "reads no Lane label and no Stopped about fork deploys on the %s place",
  async (_, raw) => {
    const view = await renderRecorded(mixedSnapshot(raw));
    try {
      const place = view.page.querySelector<HTMLElement>("section.place");
      if (!place) throw new Error("Missing the Environment place");
      const labels = [
        ...[...place.querySelectorAll("dt, h2, h3, .env-lane-label")].map(
          (element) => element.textContent ?? "",
        ),
        ...[...place.querySelectorAll("[aria-label]")].map(
          (element) => element.getAttribute("aria-label") ?? "",
        ),
      ];
      expect(labels.filter((label) => /\bLanes?\b/.test(label))).toEqual([]);
      expect(place.textContent).not.toMatch(/\bStopped\b/);
    } finally {
      await view.done();
    }
  },
);

it.each([
  ["1106", recorded],
  ["mixed", mixed],
] as const)("keeps %s Stack runs to the flow context and the run headline", async (_, raw) => {
  const view = await renderRecorded(mixedSnapshot(raw));
  try {
    const runs = view.page.querySelector<HTMLDetailsElement>('[data-part="runs"]');
    if (!runs) throw new Error("Missing Stack runs disclosure");
    expect(runs.open).toBe(false);
    expect(runs.querySelector(".env-lead")?.textContent).toBe(
      timedText(view.body.briefing.environment.headline, { hint: false }),
    );
    expect(runs.querySelector("[aria-label='Upstream syncs']")).not.toBeNull();
    expect(runs.querySelector("[data-lane], .place-tile, [data-pointer*='/facts/']")).toBeNull();
    expect(view.page.querySelectorAll(".env-day [data-lane]")).toHaveLength(
      view.body.briefing.environment.lanes.length,
    );
  } finally {
    await view.done();
  }
});

type FormerField = {
  field: string;
  find: (page: HTMLElement) => Element | undefined;
  text: string;
};

function formerFields(body: ReturnType<typeof mixedSnapshot>): FormerField[] {
  const env = body.briefing.environment;
  const now = new Date(Date.parse(env.to));
  const repo = body.briefing.repositories.rows.find(({ name }) => name === "osdu-spi-stack");
  if (!repo) throw new Error("Recorded snapshot needs the stack row");
  const all = (page: HTMLElement, selector: string) => [...page.querySelectorAll(selector)];
  const holding = (selector: string, text: string) => (page: HTMLElement) =>
    all(page, selector).find((element) =>
      element.textContent?.includes(timedText(text, { hint: false })),
    );
  return [
    { field: "headline", find: holding(".env-lead", env.headline), text: env.headline },
    ...env.lanes.flatMap((lane) => [
      {
        field: `lane ${lane.id}`,
        find: (page: HTMLElement) =>
          page.querySelector(`[data-lane='${lane.id}'] .env-lane-label`) ?? undefined,
        text: lane.label,
      },
      ...(lane.events.every(({ end }) => end && Date.parse(end) < now.getTime() - 86_400_000)
        ? [
            {
              field: `lane ${lane.id} empty`,
              find: (page: HTMLElement) =>
                page.querySelector(`[data-lane='${lane.id}'] .env-none`) ?? undefined,
              text: "none in the last day",
            },
          ]
        : lane.events
            .filter(({ end }) => !end || Date.parse(end) >= now.getTime() - 86_400_000)
            .map((event) => ({
              field: `lane ${lane.id} event ${event.id}`,
              find: (page: HTMLElement) =>
                all(page, `[data-lane='${lane.id}'] [data-event]`).find((element) =>
                  element.getAttribute("aria-label")?.includes(eventWhen(event, now)),
                ),
              text: event.label,
            }))),
    ]),
    {
      field: "repository title",
      find: holding("[data-part='repository'] p", repo.title),
      text: repo.title,
    },
    { field: "repository sub", find: holding(".env-muted", repo.sub), text: repo.sub },
    ...repo.sections.flatMap((section) => [
      {
        field: `section ${section.title}`,
        find: holding(".env-repo-section h3", section.title),
        text: `${section.title} ${section.count}`,
      },
      ...section.lines.flatMap((line) =>
        [line.tag, line.text, line.sub].map((text) => ({
          field: `line ${line.id} ${text}`,
          find: (page: HTMLElement) =>
            all(page, ".env-repo-line").find(
              (element) => element.getAttribute("data-opens") === `repository-line~${line.id}`,
            ),
          text,
        })),
      ),
    ]),
  ];
}

it("keeps every former Environment page field within one click", async () => {
  const view = await renderRecorded();
  const fields = formerFields(view.body);
  try {
    expect(fields.length).toBeGreaterThan(15);
    for (const { field, find, text } of fields) {
      const element = find(view.page);
      expect(element, field).toBeDefined();
      const shown = `${element?.textContent ?? ""} ${element?.getAttribute("aria-label") ?? ""}`;
      expect(shown, field).toContain(timedText(text, { hint: false }));
      const closed: HTMLDetailsElement[] = [];
      for (let node = element?.parentElement; node && node !== view.page; node = node.parentElement)
        if (node instanceof HTMLDetailsElement && !node.open) closed.push(node);
      expect(closed.length, field).toBeLessThanOrEqual(1);
      const [fold] = closed;
      if (!fold) continue;
      await act(async () => fold.querySelector<HTMLElement>(":scope > summary")?.click());
      expect(fold.open, field).toBe(true);
      await act(async () => fold.querySelector<HTMLElement>(":scope > summary")?.click());
    }
    const event = fields
      .find(({ field }) => field.startsWith("lane refresh event"))
      ?.find(view.page);
    if (!(event instanceof HTMLButtonElement))
      throw new Error("Recorded refresh event is a button");
    await act(async () => event.click());
    expect(view.container.querySelector(".popover h3")?.textContent).toBe("Refresh · v0.35.3");
  } finally {
    await view.done();
  }
});

it("opens an environment reading item in a popover under it", async () => {
  const view = await renderRecorded(mixedSnapshot(mixed));
  const reading = view.body.readings.find(({ anchor }) => anchor.kind === "environment");
  const [item] = reading?.content?.items ?? [];
  if (!item) throw new Error("Mixed snapshot needs an environment reading item");
  try {
    const button = view.page.querySelector<HTMLButtonElement>(
      `.place-item[data-item-id='${item.id}'] button.place-item-content`,
    );
    if (!button) throw new Error("Missing selectable reading item");
    await act(async () => button.click());
    expect(openSelection()).toEqual({ kind: "item", id: item.id });
    expect(button.closest(".place-item")?.hasAttribute("data-selected")).toBe(true);
    expect(view.page.querySelector(".popover")?.getAttribute("data-selection")).toBe(
      `item~${item.id}`,
    );
    await act(async () => button.click());
    expect(openSelection()).toBeNull();
    expect(view.page.querySelector(".popover")).toBeNull();
  } finally {
    await view.done();
  }
});
