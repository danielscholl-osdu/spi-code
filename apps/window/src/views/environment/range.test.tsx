// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import recorded from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { navigate, parseRoute, setOpenSelection, useOpenSelection } from "../../app/navigation.js";
import { mixedSnapshot } from "../../store/test-snapshot.js";
import { createWatchStore } from "../../store/watch.js";
import { activityView } from "./activity.js";
import Environment from "./index.js";
import { missedIn, rangeOf, within } from "./range.js";
import { fixed, pctOf } from "./timeline.js";

vi.hoisted(() => {
  process.env.TZ = "UTC";
});

const body = mixedSnapshot(recorded);
const env = body.briefing.environment;
const to = Date.parse(env.to);
const DAY = "2026-11-03";
const dayStart = Date.parse(`${DAY}T00:00:00Z`);

function Routed({ store }: { store: ReturnType<typeof createWatchStore> }) {
  useOpenSelection();
  const route = parseRoute(window.location.hash);
  return (
    <Environment store={store} range={route?.kind === "environment" ? route.range : undefined} />
  );
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: to });
  window.location.hash = "#environment";
  const store = createWatchStore(vi.fn());
  store.setState({ snapshot: { cursor: body.cursor, body } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Routed store={store} />));
});

afterEach(async () => {
  await act(async () => setOpenSelection(null));
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const find = <T extends HTMLElement = HTMLButtonElement>(selector: string) => {
  const element = container.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
};
const click = (selector: string) => act(async () => find(selector).click());
const button = (text: string) =>
  act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((element) => element.textContent === text)
      ?.click(),
  );
const title = () => container.querySelector(".env-day h3")?.textContent;

function minutes(text: string) {
  let total = 0;
  for (const [, n, unit] of text.matchAll(/(\d+)\s(d|h|min)/g))
    total += Number(n) * (unit === "d" ? 1440 : unit === "h" ? 60 : 1);
  return total;
}
/** Borrowed, maintenance and idle as the summary line says them, in minutes. */
const summed = () =>
  [...container.querySelectorAll<HTMLElement>(".env-activity-summary [data-part]")]
    .filter(({ dataset }) => ["borrowed", "maintenance", "idle"].includes(dataset.part ?? ""))
    .reduce((sum, part) => sum + minutes(part.textContent?.replaceAll(" ", " ") ?? ""), 0);

const segment = env.activity?.segments.find(
  ({ kind, start }) =>
    kind === "borrowed" && Date.parse(start) > dayStart + 3_600_000 && start.startsWith(DAY),
);
const width = () => find(`[data-opens="activity~${segment?.start}"]`).style.width;
const share = (from: number, end: number) =>
  `${fixed(pctOf(Date.parse(segment?.end ?? ""), from, end) - pctOf(Date.parse(segment?.start ?? ""), from, end))}%`;

it("switches ranges and opens a day, and the summary and bars follow the range", async () => {
  if (!segment) throw new Error("The recorded week needs a borrow on 3 Nov");
  const from = Date.parse(env.from);
  expect(title()).toBe("Last 24 hours");
  expect(summed()).toBe(1440);
  expect(container.querySelector(`[data-opens="activity~${segment.start}"]`)).toBeNull();

  await button("7 days");
  expect(title()).toBe("Last 7 days");
  expect(summed()).toBe(Math.round((to - from) / 60_000));
  expect(width()).toBe(share(from, to));

  await click(`.env-day-heading[data-day="${DAY}"]`);
  expect(title()).toBe("Tuesday 3 Nov");
  expect(summed()).toBe(1440);
  expect(width()).toBe(share(dayStart, dayStart + 86_400_000));
  expect(document.activeElement).toBe(find(".env-back"));

  await click(".env-back");
  expect(title()).toBe("Last 7 days");
  expect(document.activeElement).toBe(find(`.env-day-heading[data-day="${DAY}"]`));

  await click(`.env-pill[data-day="2026-11-01"]`);
  expect(title()).toBe("Sunday 1 Nov");
  expect(summed()).toBe(1440);
  expect(find('[data-lane="refresh"] .env-last').textContent).toBe(
    "‹ v0.33.2 · Fri 30 Oct · green",
  );
});

it("starts at 24 h each time the place opens", async () => {
  await button("7 days");
  await click(`.env-day-heading[data-day="${DAY}"]`);
  await act(async () => navigate({ kind: "today" }));
  await act(async () => navigate({ kind: "environment" }));
  expect(title()).toBe("Last 24 hours");
  expect(find('.env-range button[aria-pressed="true"]').textContent).toBe("24 h");
});

it("shows five forks until all are asked for, and counts only days with borrows", async () => {
  await button("7 days");
  const forks = () => container.querySelectorAll(".env-borrows [data-fork]").length;
  expect(forks()).toBe(5);
  await button("All 13 forks");
  expect(forks()).toBe(13);
  const pills = (day: string) =>
    [...container.querySelectorAll(`.env-pill[data-day="${day}"]`)].reduce(
      (sum, pill) => sum + Number.parseInt(pill.textContent ?? "", 10),
      0,
    );
  expect(find(`.env-day-heading[data-day="${DAY}"] small`).textContent).toBe(String(pills(DAY)));
  expect(pills(DAY)).toBeGreaterThan(0);
  expect(container.querySelector('.env-pill[data-day="2026-11-06"]')).toBeNull();
  expect(container.querySelector('.env-day-heading[data-day="2026-11-06"] small')).toBeNull();
  await button("Fewer forks");
  expect(forks()).toBe(5);
});

it("draws and opens the days core projected, whatever the window's own zone", async () => {
  process.env.TZ = "America/Chicago";
  try {
    await button("7 days");
    const headings = [...container.querySelectorAll<HTMLElement>(".env-day-heading")];
    expect(headings.map(({ dataset }) => [dataset.day, dataset.from])).toEqual(
      env.days?.map(({ day, from }) => [day, from]),
    );
    expect(headings.at(-2)?.firstChild?.textContent).toBe("Thu 5");
    await click('.env-day-heading[data-day="2026-11-05"]');
    expect(title()).toBe("Thursday 5 Nov");
    expect(find('[data-lane="upgrade"] .env-last').textContent).toBe(
      "‹ v0.35.3 · Wed 4 Nov · green",
    );
  } finally {
    process.env.TZ = "UTC";
  }
});

it("gives a day what starts in it, never what starts at the next midnight", () => {
  const nov5 = rangeOf(env, "2026-11-05");
  const nov6 = rangeOf(env, "2026-11-06");
  const midnight = "2026-11-06T00:00:00.000Z";
  expect(within(nov5, midnight, "2026-11-06T00:30:00.000Z", to)).toBe(false);
  expect(within(nov6, midnight, "2026-11-06T00:30:00.000Z", to)).toBe(true);
  expect(within(nov5, "2026-11-05T23:30:00.000Z", midnight, to)).toBe(true);
  expect(within(nov6, "2026-11-05T23:30:00.000Z", midnight, to)).toBe(false);
  expect(within(nov6, env.to, undefined, to)).toBe(true);

  const missed = structuredClone(env);
  const smoke = missed.lanes.find(({ id }) => id === "smoke");
  if (!smoke) throw new Error("The recorded week needs a smoke lane");
  smoke.missed = [midnight];
  const legend = (range: typeof nov5) =>
    activityView(missed, range.from, range.to)?.legend.some(([mark]) => mark === "missed");
  expect([missedIn(smoke, nov5, to), legend(nov5)]).toEqual([[], false]);
  expect([missedIn(smoke, nov6, to), legend(nov6)]).toEqual([[midnight], true]);
});

it("adds the summary's parts up to the range's own rounded minutes", () => {
  const start = to - 75_000;
  const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
  const short = structuredClone(env);
  if (!short.activity) throw new Error("The recorded week needs an activity row");
  short.borrows = [];
  short.activity.segments = [
    { kind: "borrowed", start: at(0), end: at(20), title: "search" },
    { kind: "maintenance", start: at(20), end: at(50) },
    { kind: "idle", start: at(50), end: at(75) },
  ];
  const parts = activityView(short, start, to)
    ?.summary.filter(({ part }) => ["borrowed", "maintenance", "idle"].includes(part))
    .map(({ part, text }) => [part, minutes(text)]);
  expect(parts).toEqual([["maintenance", 1]]);
});
