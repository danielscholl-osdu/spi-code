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
  "state",
  "kind",
  "result",
  "inspect",
  "url",
  "deployable",
  "tone",
  "weight",
  "name",
]);
const INSTANT = /^\d{4}-\d{2}-\d{2}(T|$)/;
const MARKER = /⟦\d+⟧/g;
const STACK = "osdu-spi-stack";

/** Every string core sent for the place, each distinct one swapped for its own marker. */
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

function markedSnapshot(): ViewSnapshot {
  const body = mixedSnapshot(recorded);
  const markers = new Map<string, string>();
  body.briefing.environment = marked(body.briefing.environment, markers);
  body.briefing.repositories.rows = body.briefing.repositories.rows.map((row) =>
    row.name === STACK ? marked(row, markers) : row,
  );
  return body;
}

/** The parts of the place the Environment view draws itself, without the shared kit inside them. */
const OWN = ".env-status, .env-line, .env-day, .env-part, .popover";
const SHARED = [
  ".section-evidence",
  ".repository-counts",
  '[data-pointer="/briefing/flow"]',
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
  const body = markedSnapshot();
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
    // One popover of each kind: a run, a hold, an activity mark and a borrow.
    const openers = new Map<string, HTMLElement>();
    for (const opener of page.querySelectorAll<HTMLElement>("[data-opens]")) {
      const opens = opener.dataset.opens ?? "";
      const kind = opens.startsWith("event~holds:") ? "hold" : opens.split("~")[0];
      if (!opener.dataset.inspect && kind && /^(event|hold|activity|borrow)$/.test(kind))
        if (!openers.has(kind)) openers.set(kind, opener);
    }
    for (const opener of openers.values()) {
      await act(async () => opener.click());
      const popover = page.querySelector(".popover");
      if (!popover) throw new Error(`${opener.dataset.opens} opened no popover`);
      if (popover.querySelector(".env-trigger")) triggers += 1;
      texts.push(...drawnText(page));
      await act(async () => setOpenSelection(null));
    }
  }
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
