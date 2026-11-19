// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import recorded from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { setOpenSelection } from "../../app/navigation.js";
import { mixedSnapshot } from "../../store/test-snapshot.js";
import { createWatchStore } from "../../store/watch.js";
import { dateNames } from "../../time.js";
import Environment from "./index.js";
import { WEEK } from "./range.js";

/** Fields that carry no words: ids, states and links the window reads, not draws. Instants keep by shape. */
const KEEP = new Set([
  "id",
  "ids",
  "state",
  "kind",
  "result",
  "inspect",
  "url",
  "urls",
  "subject",
  "deployable",
  "tone",
  "weight",
  "name",
  "section",
  "home",
  "station",
  "rel",
  "areas",
]);
const INSTANT = /^\d{4}-\d{2}-\d{2}(T|$)/;
const MARKER = /⟦\d+⟧/g;
const STACK = "osdu-spi-stack";
/** The shared opened body's own sentence for a counted line, which spicode-8q6.10 moves to core. */
const CAN_WAIT = "Not on Today. Counted under Can wait.";

/** Every string core sent, each distinct one swapped for its own marker. */
function marked<T>(value: T, markers: Map<string, string>, key?: string): T {
  if (typeof value === "string") {
    if ((key && KEEP.has(key)) || INSTANT.test(value)) return value;
    const marker = markers.get(value) ?? `⟦${markers.size}⟧`;
    markers.set(value, marker);
    return marker as T;
  }
  if (Array.isArray(value)) return value.map((item) => marked(item, markers, key)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([field, item]) => [field, marked(item, markers, field)]),
    ) as T;
  return value;
}

const MEMBER = "conflict:entitlements:121";
const ITEM = "rollout";

/**
 * The recorded week with each popover branch present: a Today member and a plain item on the
 * place, a run linked to the member, and stack lines on Today, plain, and counted under Can wait.
 */
function branchedSnapshot(): ViewSnapshot {
  const body = mixedSnapshot(recorded);
  const { briefing } = body;
  const env = briefing.environment;
  const program = body.readings.find(({ anchor }) => anchor.kind === "program")?.content;
  const reading = body.readings.find(({ anchor }) => anchor.kind === "environment")?.content;
  const member = program?.items.find(({ id }) => id === MEMBER);
  const item = briefing.focus.find(({ id }) => id === ITEM);
  if (!reading || !member || !item) throw new Error("The recorded week needs its Today items");
  reading.items = [member, { ...item, group: member.group }];
  const to = Date.parse(env.to);
  const run = env.lanes
    .find(({ id }) => id === "smoke")
    ?.events.find(({ start }) => Date.parse(start) > to - 86_400_000);
  if (!run) throw new Error("The recorded week needs a smoke run in the last day");
  run.inspect = MEMBER;
  const stack = briefing.repositories.rows.find(({ name }) => name === STACK);
  const [section] = stack?.sections ?? [];
  const [today, plain] = section?.lines ?? [];
  const count = briefing.today?.canWait[0]?.counts[0];
  if (!section || !today || !plain || !count) throw new Error("The recorded stack needs two lines");
  today.onToday = { id: MEMBER, rel: "source" };
  const counted = { ...plain, id: `${plain.id}0`, url: `${plain.url}0` };
  section.lines.push(counted);
  count.urls = [...(count.urls ?? []), counted.url];
  const markers = new Map<string, string>();
  briefing.environment = marked(env, markers);
  briefing.lines = marked(briefing.lines, markers);
  briefing.focus = marked(briefing.focus, markers);
  briefing.rest = marked(briefing.rest, markers);
  briefing.repositories.rows = briefing.repositories.rows.map((row) =>
    row.name === STACK ? marked(row, markers) : row,
  );
  body.readings = body.readings.map((one) =>
    one.anchor.kind === "environment" ? marked(one, markers) : one,
  );
  return body;
}

/** Which branch of the popovers an opener reaches. */
function branchOf(body: ViewSnapshot, key: string): string {
  const [kind = "", id = ""] = key.split("~");
  const env = body.briefing.environment;
  const members = new Set(
    (body.briefing.lines ?? []).flatMap(({ members }) => members.flatMap((m) => [m.id, ...m.ids])),
  );
  if (kind === "event") {
    if (id.startsWith("holds:")) return "hold";
    const e = env.lanes.flatMap(({ events }) => events).find((e) => id.endsWith(`:${e.id}`));
    return e?.inspect && members.has(e.inspect) ? "run on Today" : "run";
  }
  if (kind === "activity")
    return `activity ${env.activity?.segments.find(({ start }) => start === id)?.kind}`;
  if (kind === "item") return members.has(id) ? "item on Today" : "item";
  if (kind === "repository-line") {
    const line = body.briefing.repositories.rows
      .flatMap(({ sections }) => sections.flatMap(({ lines }) => lines))
      .find((line) => line.id === id);
    if (line?.onToday) return "repository line on Today";
    const counted = body.briefing.today?.canWait.some(({ counts }) =>
      counts.some(({ urls }) => urls?.includes(line?.url ?? "")),
    );
    return counted ? "repository line counted" : "repository line";
  }
  return kind;
}

/** The parts of the place the Environment view draws itself, without the shared kit inside them. */
const OWN = "h1[data-place], .env-status, .env-line, .env-day, .env-repository-pill, .popover";
const SHARED = [
  ".section-evidence",
  ".repository-counts",
  ".popover-close",
  ".opened-body-sources",
  ".opened-body-evidence",
].join(", ");

function drawnText(page: HTMLElement): string[] {
  const copy = page.cloneNode(true) as HTMLElement;
  for (const shared of copy.querySelectorAll(SHARED)) shared.remove();
  return [...copy.querySelectorAll<HTMLElement>(OWN)].flatMap((root) => [
    root.textContent ?? "",
    ...[root, ...root.querySelectorAll("*")].flatMap((element) =>
      ["aria-label", "title"].flatMap((name) => element.getAttribute(name) ?? []),
    ),
  ]);
}

let done: (() => Promise<void>) | undefined;
afterEach(async () => {
  await done?.();
  done = undefined;
  vi.unstubAllGlobals();
});

it("draws no word of its own: every word on the place is core's, apart from lengths and times", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const body = branchedSnapshot();
  const days = body.briefing.environment.days ?? [];
  const opened = days.at(-2)?.day;
  if (!opened) throw new Error("The recorded week needs a day before today");
  const store = createWatchStore(vi.fn());
  store.setState({ snapshot: { cursor: body.cursor, body } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  done = async () => {
    await act(async () => setOpenSelection(null));
    await act(async () => root.unmount());
    container.remove();
  };
  const texts: string[] = [];
  let triggers = 0;
  const branches = new Set<string>();
  for (const range of [undefined, WEEK, opened]) {
    await act(async () => root.render(<Environment store={store} range={range} />));
    const page = container.querySelector<HTMLElement>(".environment");
    if (!page) throw new Error("Missing Environment place");
    texts.push(...drawnText(page));
    const more = page.querySelector<HTMLButtonElement>(".env-more");
    if (more) {
      await act(async () => more.click());
      texts.push(...drawnText(page));
    }
    // One popover of each branch: runs, a hold, each activity mark, a borrow, items and lines.
    const openers = new Map<string, HTMLElement>();
    for (const opener of page.querySelectorAll<HTMLElement>("[data-opens]")) {
      const branch = branchOf(body, opener.dataset.opens ?? "");
      if (!openers.has(branch)) openers.set(branch, opener);
    }
    for (const opener of page.querySelectorAll<HTMLElement>(".place [data-selection-id]")) {
      const branch = branchOf(body, `item~${opener.dataset.selectionId}`);
      if (!openers.has(branch)) openers.set(branch, opener);
    }
    for (const [branch, opener] of openers) {
      await act(async () => opener.click());
      const popover = page.querySelector(".popover");
      if (!popover) throw new Error(`${branch} opened no popover`);
      if (popover.querySelector(".env-trigger")) triggers += 1;
      branches.add(branch);
      texts.push(...drawnText(page).map((text) => text.replaceAll(CAN_WAIT, " ")));
      if (branch === "repository") {
        const lines = new Map<string, string>();
        for (const line of popover.querySelectorAll<HTMLElement>("[data-opens]")) {
          const key = line.dataset.opens ?? "";
          const lineBranch = branchOf(body, key);
          if (!lines.has(lineBranch)) lines.set(lineBranch, key);
        }
        for (const [lineBranch, key] of lines) {
          const row = page.querySelector<HTMLButtonElement>(`[data-opens="${key}"]`);
          if (!row) throw new Error(`Missing ${lineBranch} opener`);
          await act(async () => row.click());
          if (!page.querySelector('.popover[data-selection^="repository-line~"]'))
            throw new Error(`${lineBranch} opened no popover`);
          branches.add(lineBranch);
          texts.push(...drawnText(page).map((text) => text.replaceAll(CAN_WAIT, " ")));
          await act(async () => opener.click());
        }
      }
      await act(async () => setOpenSelection(null));
    }
  }
  expect([...branches].sort()).toEqual(
    [
      "activity borrowed",
      "activity estimated",
      "activity overlap",
      "borrow",
      "hold",
      "item",
      "item on Today",
      "repository",
      "repository line",
      "repository line counted",
      "repository line on Today",
      "run",
      "run on Today",
    ].sort(),
  );
  expect(triggers).toBeGreaterThan(0);
  expect(texts.join(" ")).toMatch(MARKER);
  expect(texts.some((text) => text.includes("‹"))).toBe(true);
  const names = days.flatMap(({ day }) => [dateNames(day).long, dateNames(day).short]);
  const own = texts.flatMap((text) => {
    let rest = text.replace(MARKER, " ").replaceAll(STACK, " ");
    for (const name of names) rest = rest.replaceAll(name, " ");
    rest = rest.replace(/\d+ (?:min|h|d)\b/g, " ");
    return rest.match(/[A-Za-z]+/g) ?? [];
  });
  expect(new Set(own)).toEqual(new Set());
});
