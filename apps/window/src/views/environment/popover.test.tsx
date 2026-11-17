// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeSheet, openSelection, setOpenSelection } from "../../app/navigation.js";
import { selectionStore } from "../../panels/selection.js";
import { createWatchStore } from "../../store/watch.js";
import sweep from "../today/snapshot-1116.json?raw";
import Environment from "./index.js";

const SMOKE = "smoke:43831504653";
const RUN = "https://github.com/Azure/osdu-spi-stack/actions/runs/43831504653";

const november16 = (): ViewSnapshot => ViewSnapshotSchema.parse(JSON.parse(sweep));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  setOpenSelection(null);
  selectionStore.getState().clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => setOpenSelection(null));
  await act(async () => root.unmount());
  container.remove();
  closeSheet();
  vi.restoreAllMocks();
});

async function render(body = november16()) {
  const store = createWatchStore(vi.fn());
  store.setState({ snapshot: { cursor: body.cursor, body } });
  await act(async () => root.render(<Environment store={store} />));
  return body;
}

const bar = (key: string) => {
  const element = container.querySelector<HTMLButtonElement>(`[data-event="${key}"]`);
  if (!element) throw new Error(`Missing event ${key}`);
  return element;
};

const popover = () => container.querySelector<HTMLElement>(".popover");

const text = (element: Element | null | undefined) => element?.textContent?.replace(/\u00a0/g, " ");

const read = () => {
  const body = popover()?.querySelector(".opened-body");
  return {
    title: text(body?.querySelector("h3")),
    lines: [...(body?.querySelectorAll(":scope > p") ?? [])].map(text),
    effect: text(body?.querySelector(".opened-body-effect")),
    pills: [...(body?.querySelectorAll<HTMLAnchorElement>(".opened-body-sources a") ?? [])].map(
      (a) => [a.textContent?.replace("↗", "").trim(), a.getAttribute("href")],
    ),
    onToday: body?.querySelector(".opened-body-place")?.textContent,
    buttons: [...(popover()?.querySelectorAll("button") ?? [])].map((b) => b.className),
  };
};

it("says a failed smoke run left the running environment ready and nothing on Today waiting", async () => {
  await render();
  await act(async () => bar(SMOKE).click());
  expect(openSelection()).toEqual({ kind: "event", id: SMOKE });
  expect(bar(SMOKE).getAttribute("aria-expanded")).toBe("true");
  const shown = read();
  expect(shown.title).toBe("Smoke");
  expect(shown.lines[0]).toMatch(/^failed after 4 min · \d\d:\d\d to \d\d:\d\d$/);
  expect(shown.effect).toBe(
    "A smoke run on a fresh cluster failed. The running environment stayed ready; nothing on Today waits on it.",
  );
  expect(shown.pills).toEqual([["Run", RUN]]);
  expect(shown.onToday).toBeUndefined();
  expect(shown.buttons).toEqual(["popover-close"]);
  expect(selectionStore.getState().selected).toBeNull();
});

it.each([
  "a hold over the run",
  "a refresh failing during the run",
  "readiness unknown",
  "the Held lane unread",
  "the Held lane's provenance missing",
  "the lifecycle read failed",
  "the lifecycle history cut",
])("does not claim the environment stayed ready with %s", async (change) => {
  const body = november16();
  const env = body.briefing.environment;
  const smoke = env.lanes.find(({ id }) => id === "smoke")?.events[0];
  if (!smoke?.end) throw new Error("16 Nov needs its first smoke run");
  if (change === "a hold over the run")
    env.lanes
      .find(({ id }) => id === "holds")
      ?.events.push({
        id: "1",
        start: smoke.start,
        end: smoke.end,
        state: "held",
        label: "4 min",
        detail: "in maintenance for 4 min",
      });
  if (change === "a refresh failing during the run")
    env.lanes
      .find(({ id }) => id === "refresh")
      ?.events.push({
        id: "2",
        start: smoke.start,
        end: smoke.end,
        state: "failed",
        label: "v0.35.5",
        detail: "failed after 4 min",
      });
  if (change === "readiness unknown") env.deployable = "unknown";
  const lifecycle = body.areas.find(({ area }) => area === "lifecycle");
  if (change === "the Held lane unread" && lifecycle)
    lifecycle.envelope = { source: "lifecycle", state: "unread" };
  if (change === "the Held lane's provenance missing") {
    const held = `/briefing/environment/lanes/${env.lanes.findIndex(({ id }) => id === "holds")}`;
    body.provenance = body.provenance.filter(({ path }) => path !== held);
  }
  if (change === "the lifecycle read failed" && lifecycle)
    lifecycle.envelope = {
      source: "lifecycle",
      state: "failed",
      completeness: { kind: "complete" },
    };
  if (change === "the lifecycle history cut" && lifecycle?.envelope.state === "fresh")
    lifecycle.envelope = {
      ...lifecycle.envelope,
      state: "incomplete",
      completeness: { kind: "cut", reason: "page-limit", read: 20, total: 40 },
    };
  await render(body);
  await act(async () => bar(SMOKE).click());
  expect(read().effect).toBe(
    "A smoke run on a fresh cluster failed. Nothing on Today waits on it.",
  );
});

it("has no run pill when the sweep read no line on the stack repository", async () => {
  const body = november16();
  const stack = body.briefing.repositories.rows.find(({ name }) => name === "osdu-spi-stack");
  if (!stack) throw new Error("16 Nov needs the stack repository");
  stack.sections = [];
  await render(body);
  await act(async () => bar(SMOKE).click());
  expect(read().title).toBe("Smoke");
  expect(read().pills).toEqual([]);
});

it("lists the runs a hold held over, and each opens its own popover", async () => {
  const body = await render();
  const hold = body.briefing.environment.lanes.find(({ id }) => id === "holds")?.events[0];
  if (!hold) throw new Error("16 Nov needs a hold");
  await act(async () => bar(`holds:${hold.id}`).click());
  expect(read().title).toBe("Held · 5 min");
  expect(read().effect).toBe("The stack was in maintenance; fork lanes queued behind it.");
  expect(read().pills).toEqual([]);
  const rows = [...(popover()?.querySelectorAll<HTMLButtonElement>(".popover-rows button") ?? [])];
  expect(rows.map(text)).toEqual(["Refresh · v0.35.5 · green in 7 min ›"]);
  await act(async () => rows[0]?.click());
  expect(openSelection()).toEqual({ kind: "event", id: "refresh:43801995078" });
  expect(read().title).toBe("Refresh · v0.35.5");
  expect(read().effect).toBe("The environment deployed v0.35.5 and went green.");
  expect(bar("refresh:43801995078").getAttribute("aria-expanded")).toBe("true");
});

it("opens a run's Today member when core folds the run into one", async () => {
  const body = november16();
  const smoke = body.briefing.environment.lanes.find(({ id }) => id === "smoke")?.events[0];
  if (!smoke) throw new Error("16 Nov needs its first smoke run");
  smoke.inspect = "halt:crs-conversion";
  await render(body);
  await act(async () => bar(SMOKE).click());
  const shown = read();
  expect(shown.onToday).toBe("On Today · Blocked ›");
  expect(shown.pills).toContainEqual(["Run", RUN]);
  expect(openSelection()).toEqual({ kind: "event", id: SMOKE });
});

it("opens every Environment selection in a popover or at its source, never in the panel", async () => {
  const body = await render();
  const runs = container.querySelector<HTMLDetailsElement>('[data-part="runs"]');
  const repository = container.querySelector<HTMLDetailsElement>('[data-part="repository"]');
  if (!runs || !repository) throw new Error("Missing the Stack runs and Stack repository folds");
  runs.open = true;
  repository.open = true;
  const openers = [
    ...container.querySelectorAll<HTMLElement>("[data-opens], .place [data-selection-id]"),
  ];
  expect(openers.length).toBe(
    body.briefing.environment.lanes.flatMap(({ events }) => events).length + 2,
  );
  for (const opener of openers) {
    await act(async () => opener.click());
    expect(popover(), opener.dataset.opens ?? opener.dataset.selectionId).not.toBeNull();
    expect(popover()?.querySelector(".opened-body h3")?.textContent).toBeTruthy();
    await act(async () => opener.click());
    expect(popover()).toBeNull();
  }
  const also = [
    ...runs.querySelectorAll<HTMLButtonElement>("ul[aria-label='Also waiting'] button"),
  ];
  expect(also.map((button) => button.textContent)).toEqual([
    "Review partition's Sync to Main PR on GitHub",
  ]);
  await act(async () => also[0]?.click());
  expect(openSelection()).toEqual({ kind: "cell", id: "partition:main" });
  expect(selectionStore.getState().selected).toBeNull();
});
