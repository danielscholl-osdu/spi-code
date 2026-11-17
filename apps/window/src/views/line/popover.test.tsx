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
import { placeMembers } from "../../components/place/members.js";
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
  expect(popover()?.textContent).toContain("On Today · Waiting on you ›");
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
  expect(popover()?.textContent).toContain("On Today · Blocked ›");
  const other = popover()?.querySelector<HTMLButtonElement>(".popover-rows button");
  expect(other?.textContent).toBe("crs-conversion · sync PR to review\u00a0›");
  await act(async () => other?.click());
  expect(popover()?.querySelector("h3")?.textContent).toBe("crs-conversion · sync PR to review");
  expect(cell("crs-conversion:sync").getAttribute("aria-expanded")).toBe("true");
});

it.each([
  ["legal:upstream", "legal · Upstream", "Nothing waits here."],
  [
    "crs-conversion:upstream",
    "crs-conversion · Upstream",
    "Held by the blocked sync: crs-conversion sync halted.",
  ],
  [
    "storage:lane",
    "storage · Lane",
    "Not on Today. SPI Code has no item for this and didn't read the run.",
  ],
])("says what an itemless cell %s holds, with no Evidence subject", async (id, title, sentence) => {
  await open(id);
  expect(popover()?.querySelector("h3")?.textContent).toBe(title);
  expect(popover()?.querySelector(".opened-body p")?.textContent).toBe(sentence);
  expect(popover()?.textContent).not.toMatch(/On Today|⌀/);
  openEvidence();
  const route = parseRoute(window.location.hash) as EvidenceRoute;
  expect(route.selection).toBeUndefined();
  expect(route.open).toEqual({ kind: "cell", id });
});

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

it("steps each Line member onto its cell's popover", async () => {
  const snapshot = watchStore.getState().snapshot?.body;
  const next = sheet()?.querySelector<HTMLButtonElement>('[aria-label="Next of yours"]');
  for (const { member } of placeMembers(snapshot, "line")) {
    await act(async () => next?.click());
    expect(openSelection()?.id).toBe(member.id);
    const expanded = sheet()?.querySelector('.line-cell[aria-expanded="true"]');
    expect(expanded?.closest("[data-service]")?.getAttribute("data-service"), member.id).toBe(
      member.fork,
    );
    expect(popover()?.querySelector("h3")?.textContent, member.id).toMatch(
      new RegExp(`^${member.fork} · `),
    );
  }
});

it("On Today goes to Today with the member's row open", async () => {
  await open("legal:main");
  const link = [...(popover()?.querySelectorAll("a") ?? [])].find((a) =>
    a.textContent?.startsWith("On Today"),
  );
  await act(async () => link?.click());
  expect(sheet()).toBeNull();
  expect(window.location.hash).toBe("#today");
  expect(openSelection()).toEqual({ kind: "item", id: "gate2:legal" });
  expect(container.querySelector('tr[data-item-id="gate2:legal"]')?.hasAttribute("data-open")).toBe(
    true,
  );
});
