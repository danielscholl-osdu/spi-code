// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import recorded from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import {
  closeSheet,
  type EvidenceRoute,
  openEvidence,
  openSelection,
  openSheet,
  parseRoute,
  setOpenSelection,
} from "../../app/navigation.js";
import { Shell } from "../../app/Shell.js";
import fixtureText from "../../components/place/members-1116.json?raw";
import { selectionStore } from "../../panels/selection.js";
import { watchStore } from "../../store/watch.js";
import { installSpi } from "../../test-utils/harness.js";

const november16 = (): ViewSnapshot => {
  const body = JSON.parse(recorded);
  const fixture = JSON.parse(fixtureText);
  return ViewSnapshotSchema.parse({
    ...body,
    provenance: [],
    stations: fixture.stations,
    briefing: {
      ...body.briefing,
      lines: fixture.lines,
      places: fixture.places,
      focus: fixture.items,
      rest: [],
      repositories: { ...body.briefing.repositories, rows: fixture.repositories },
    },
  });
};

const previousWatch = watchStore.getState();
let harness: ReturnType<typeof installSpi>;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  (
    window as unknown as {
      happyDOM: { setViewport(viewport: { width: number; height: number }): void };
    }
  ).happyDOM.setViewport({ width: 1440, height: 900 });
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Mac OS X)");
  closeSheet();
  localStorage.removeItem("spi-code.line-sheet.pinned");
  window.location.hash = "#today";
  harness = installSpi();
  selectionStore.getState().clear();
  setOpenSelection(null);
  const body = november16();
  watchStore.setState({ snapshot: { cursor: body.cursor, body }, setup: null });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Shell />));
  await act(async () => openSheet());
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  closeSheet();
  setOpenSelection(null);
  watchStore.setState(previousWatch, true);
  harness.restore();
  vi.restoreAllMocks();
});

const sheet = () => container.querySelector<HTMLElement>(".line-sheet");
const popover = () => container.querySelector<HTMLElement>(".line-sheet .popover");
const cell = (id: string) => {
  const found = sheet()?.querySelector<HTMLButtonElement>(`.line-cell[data-cell="${id}"]`);
  if (!found) throw new Error(`Missing cell ${id}`);
  return found;
};
const open = (id: string) => act(async () => cell(id).click());
const press = (key: string) =>
  act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });

it("opens legal Main as its Today row, with the lane re-run first and one gap", async () => {
  await open("legal:main");
  expect(cell("legal:main").getAttribute("aria-expanded")).toBe("true");
  expect(popover()?.querySelector("h3")?.textContent).toBe(
    "legal · release/upstream PR red: its deploy lane failed",
  );
  expect([...(popover()?.querySelectorAll("ol li") ?? [])].map((li) => li.textContent)).toEqual([
    "Re-run the failed jobs once, after the other lanes drain.",
    "Approve the release/upstream PR and merge it with a merge commit, never a squash.",
  ]);
  expect(popover()?.querySelector(".opened-body-evidence")?.textContent).toBe(
    "⌀ 1 not read · Evidence ›",
  );
  expect(popover()?.textContent).not.toMatch(/Other stations|Queue|Copilot/);
  expect(openSelection()).toEqual({ kind: "cell", id: "legal:main" });
  openEvidence();
  const route = parseRoute(window.location.hash) as EvidenceRoute;
  expect(route.selection).toEqual({ kind: "item", id: "gate2:legal" });
  expect(route.open).toEqual({ kind: "cell", id: "legal:main" });
  expect(route.sheet).toEqual({});
});

it("leads crs-conversion Sync with the blocked halt's filter-rule step and names the other member", async () => {
  await open("crs-conversion:sync");
  expect(popover()?.querySelector("h3")?.textContent).toBe(
    "crs-conversion · sync halted: no filter rule for schemathesis-tests",
  );
  const step = popover()?.querySelector(".opened-body-step");
  expect(step?.textContent).toBe(
    "Add a rule for schemathesis-tests to .github/upstream-filter.yml, then dispatch sync.",
  );
  const other = popover()?.querySelector<HTMLButtonElement>(".popover-rows button");
  expect(other?.textContent).toBe("crs-conversion · sync PR to review\u00a0›");
  await act(async () => other?.click());
  expect(popover()?.querySelector("h3")?.textContent).toBe("crs-conversion · sync PR to review");
  expect(cell("crs-conversion:sync").getAttribute("aria-expanded")).toBe("true");
});

const commandEnter = () =>
  act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
const pills = () =>
  [...(popover()?.querySelectorAll<HTMLAnchorElement>("[aria-label=Sources] a") ?? [])].map((a) => [
    a.textContent?.replace("↗", "").trim(),
    a.getAttribute("href"),
  ]);

it.each([
  [
    "legal:upstream",
    "legal · Upstream",
    "Nothing waits here.",
    ["Sync Upstream run", "https://github.com/Azure/osdu-spi-legal/actions/runs/42134144237"],
  ],
  [
    "crs-conversion:upstream",
    "crs-conversion · Upstream",
    "Held by the blocked sync: crs-conversion sync halted.",
    [
      "Sync Upstream run",
      "https://github.com/Azure/osdu-spi-crs-conversion/actions/runs/42134640759",
    ],
  ],
  [
    "storage:lane",
    "storage · Lane",
    "Not on Today. SPI Code has no item for this and didn't read the run.",
    ["Deployments", "https://github.com/Azure/osdu-spi-storage/deployments"],
  ],
])(
  "says what an itemless cell %s holds, with no Evidence subject, and opens its own source",
  async (id, title, sentence, source) => {
    await open(id);
    expect(popover()?.querySelector("h3")?.textContent).toBe(title);
    expect(popover()?.querySelector(".opened-body p")?.textContent).toBe(sentence);
    expect(popover()?.textContent).not.toMatch(/On Today|⌀/);
    expect(pills()).toEqual([source]);
    await commandEnter();
    expect(harness.spi.openExternal).toHaveBeenCalledExactlyOnceWith(source[1]);
    openEvidence();
    const route = parseRoute(window.location.hash) as EvidenceRoute;
    expect(route.selection).toBeUndefined();
    expect(route.open).toEqual({ kind: "cell", id });
  },
);

it.each(["legal:upstream", "storage:lane"])(
  "gives %s no source and no ⌘↵ when the sweep read no run for its fork",
  async (id) => {
    const body = watchStore.getState().snapshot?.body as ViewSnapshot;
    const fork = id.split(":")[0];
    const unread = {
      ...body,
      services: body.services?.filter(({ service }) => service !== fork),
    };
    await act(async () =>
      watchStore.setState({ snapshot: { cursor: unread.cursor, body: unread } }),
    );
    await open(id);
    expect(popover()).not.toBeNull();
    expect(popover()?.querySelector("[aria-label=Sources]")).toBeNull();
    await commandEnter();
    expect(harness.spi.openExternal).not.toHaveBeenCalled();
  },
);

it("Escape and an outside click close the popover and leave the sheet open", async () => {
  await open("legal:main");
  await press("Escape");
  expect(popover()).toBeNull();
  expect(sheet()).not.toBeNull();
  expect(document.activeElement).toBe(cell("legal:main"));
  expect(openSelection()).toBeNull();
  await open("legal:main");
  await act(async () => sheet()?.querySelector<HTMLElement>(".line-legend")?.click());
  expect(popover()).toBeNull();
  expect(sheet()).not.toBeNull();
  await open("legal:main");
  await open("legal:main");
  expect(popover()).toBeNull();
});

it("closes on a click in the window's chrome, but not on the Swept capsule, which opens Evidence for the cell", async () => {
  await open("legal:main");
  await act(async () =>
    container.querySelector<HTMLElement>("[data-slot=sidebar-content]")?.click(),
  );
  expect(popover()).toBeNull();
  await open("legal:main");
  const capsule = container.querySelector<HTMLElement>(
    "[data-slot=sidebar-footer] [data-sweep-line]",
  );
  await act(async () => capsule?.click());
  expect(popover()).not.toBeNull();
  await act(async () =>
    document.querySelector<HTMLElement>("[data-sweep-popover] .capsule-pop-head")?.click(),
  );
  expect(popover()).not.toBeNull();
  const evidence = document.querySelector<HTMLElement>("[data-sweep-popover] .capsule-evidence");
  await act(async () => evidence?.click());
  const route = parseRoute(window.location.hash) as EvidenceRoute;
  expect(route.selection).toEqual({ kind: "item", id: "gate2:legal" });
  expect(route.open).toEqual({ kind: "cell", id: "legal:main" });
});
