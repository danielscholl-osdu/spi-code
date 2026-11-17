// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { FocusItemSchema, TodayLineSchema, type ViewSnapshot } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import { parseRoute, setOpenSelection } from "../../app/navigation.js";
import recorded from "../../components/opened-body/sweep-1116.json?raw";
import { fixtureLoader, installSpi } from "../../test-utils/harness.js";
import { ageInOneUnit, TodayTable } from "./Table.js";

const sweep = JSON.parse(recorded);
const lines = TodayLineSchema.array().parse(sweep.lines);
const items = FocusItemSchema.array().parse(sweep.items);
const loadFixture = fixtureLoader(readFixture);

/** The 16 Nov lines over a recorded snapshot's forks; the table reads nothing else from it. */
function nov16(): ViewSnapshot {
  const body = loadFixture("snapshot-busy.json");
  body.briefing.lines = lines;
  body.briefing.focus = items.map((item) => ({ ...item, attention: "surface", owned: true }));
  body.briefing.rest = [];
  return body;
}

let harness: ReturnType<typeof installSpi>;
let container: HTMLDivElement;
let unmount: () => Promise<void>;
beforeEach(() => {
  harness = installSpi();
  window.location.hash = "#today";
});
afterEach(async () => {
  await unmount();
  container.remove();
  setOpenSelection(null);
  harness.restore();
  window.location.hash = "";
});

async function render(snapshot: ViewSnapshot = nov16()) {
  container = document.createElement("div");
  container.className = "today";
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<TodayTable snapshot={snapshot} />));
  unmount = () => act(async () => root.unmount());
}

const section = (id: string) => container.querySelector(`[data-section=${id}]`);
const row = (lineId: string, itemId?: string) => {
  const found = [...container.querySelectorAll<HTMLTableRowElement>("tr.today-row")].find(
    (tr) =>
      tr.dataset.lineId === lineId &&
      (itemId === undefined
        ? !tr.classList.contains("today-row--sub")
        : tr.dataset.itemId === itemId && tr.classList.contains("today-row--sub")),
  );
  if (!found) throw new Error(`Missing row ${lineId} ${itemId ?? ""}`);
  return found;
};
const click = (element: Element | null | undefined) =>
  act(async () => {
    element?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    (element as HTMLElement).click();
  });
const press = (key: string, init: KeyboardEventInit = {}) =>
  act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, cancelable: true, ...init }));
  });
const opened = () => [...container.querySelectorAll("tr.today-row-body")];
const bodyAfter = (tr: Element) =>
  tr.nextElementSibling?.classList.contains("today-row-body") ? tr.nextElementSibling : null;

it("draws 16 Nov as 2 Blocked and 16 Waiting on you in 10 rows, with no verb", async () => {
  await render();
  expect(section("blocked")?.querySelector(".today-section-count")?.textContent).toBe("2");
  expect(section("waiting")?.querySelector(".today-section-count")?.textContent).toBe("16");
  expect(container.querySelectorAll("tr.today-row:not(.today-row--sub)")).toHaveLength(10);
  expect(container.querySelectorAll("tr.today-row--sub")).toHaveLength(
    lines.filter((line) => line.members.length > 1).reduce((n, l) => n + l.members.length, 0),
  );
  const verbs = new Set(items.map(({ verb }) => verb).filter(Boolean));
  expect(verbs.size).toBeGreaterThan(3);
  for (const verb of verbs) expect(container.textContent).not.toContain(verb);
});

it("a group header opens the group's body, a sub-row's fork opens that member, one at a time", async () => {
  await render();
  const group = lines.find(({ id }) => id.includes("blocker:"));
  const member = group?.members[1];
  if (!group || !member) throw new Error("The red PRs are a group");
  const header = row(group.id);
  await click(header.querySelector(".today-row-what button"));
  expect(opened()).toHaveLength(1);
  const body = bodyAfter(header);
  expect([...(body?.querySelectorAll("li") ?? [])].map((li) => li.textContent)).toEqual(
    group.steps,
  );
  expect(body?.textContent).not.toContain(member.fork);
  expect(header.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");

  const sub = row(group.id, member.id);
  await click(sub.querySelector(".today-row-fork button"));
  expect(opened()).toHaveLength(1);
  expect(bodyAfter(header)).toBeNull();
  expect(bodyAfter(sub)?.querySelector(".opened-body-place")?.textContent).toBe(
    `Line › ${member.fork} › Main ›`,
  );

  await click(sub.querySelector(".today-row-fork button"));
  expect(opened()).toHaveLength(0);
});

it("Esc closes the open row and a click elsewhere on Today closes it", async () => {
  await render();
  const halt = row("blocked:halt:crs-conversion");
  await click(halt.querySelector(".today-row-fork button"));
  expect(opened()).toHaveLength(1);
  await press("Escape");
  expect(opened()).toHaveLength(0);
  expect(document.activeElement).toBe(halt.querySelector(".today-row-fork button"));

  await click(halt.querySelector(".today-row-what button"));
  await act(async () => {
    section("waiting")?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  });
  expect(opened()).toHaveLength(0);
});

it("an opened row never repeats its own pill, and ⌘↵ opens the row's pill only when it has one", async () => {
  await render();
  const halt = lines.find(({ id }) => id === "blocked:halt:crs-conversion");
  const pill = halt?.members[0]?.primary;
  if (!halt || !pill) throw new Error("The halt row has its issue");
  const tr = row(halt.id);
  expect(tr.querySelector(".today-row-open a")?.getAttribute("href")).toBe(pill.url);
  await click(tr.querySelector(".today-row-fork button"));
  const sources = [...(bodyAfter(tr)?.querySelectorAll(".opened-body-sources a") ?? [])];
  expect(sources.map((a) => a.getAttribute("href"))).not.toContain(pill.url);
  await press("Enter", { metaKey: true });
  expect(harness.spi.openExternal).toHaveBeenCalledExactlyOnceWith(pill.url);

  harness.spi.openExternal.mockClear();
  const group = row("waiting:blocker:stack:lanes:gate2");
  expect(group.querySelector(".today-row-open a")).toBeNull();
  await click(group.querySelector(".today-row-what button"));
  await press("Enter", { metaKey: true });
  expect(harness.spi.openExternal).not.toHaveBeenCalled();
});

it("⌀ n opens Evidence for its row; a member marks only a gap its group doesn't", async () => {
  await render();
  const storage = row("waiting:gate2:storage");
  expect(storage.querySelector(".today-row-gaps")?.textContent).toBe("⌀ 1");
  await click(storage.querySelector(".today-row-gaps"));
  expect(opened()).toHaveLength(0);
  expect(parseRoute(window.location.hash)).toMatchObject({
    kind: "evidence",
    from: { kind: "today" },
    selection: { kind: "item", id: "gate2:storage" },
  });

  window.location.hash = "#today";
  const group = row("waiting:blocker:stack:lanes:gate2");
  expect(group.querySelector(".today-row-gaps")?.textContent).toBe("⌀ 1");
  const subs = container.querySelectorAll(
    'tr.today-row--sub[data-line-id="waiting:blocker:stack:lanes:gate2"]',
  );
  expect(subs).toHaveLength(5);
  for (const sub of subs) expect(sub.querySelector(".today-row-gaps")).toBeNull();
  await click(group.querySelector(".today-row-gaps"));
  expect(parseRoute(window.location.hash)).toMatchObject({
    kind: "evidence",
    selection: { kind: "line", id: "waiting:blocker:stack:lanes:gate2" },
  });
});

it("a member's age is the age of its object, in one unit", async () => {
  await render();
  const unit = row("waiting:upgrade:os-core-common", "gate1:unit");
  expect(unit.querySelector(".today-row-age")?.textContent).toBe("10d");
  expect(container.querySelector("table")?.textContent).not.toContain("59d");
  expect(row("waiting:release-approval").querySelector(".today-row-age")?.textContent).toBe("7d");
  expect([ageInOneUnit("1d 2h"), ageInOneUnit("33m"), ageInOneUnit("6d 22h")]).toEqual([
    "26h",
    "33m",
    "7d",
  ]);
});

it("a deadline is a clock by the age carrying its reason", async () => {
  await render();
  const clock = row("blocked:halt:crs-conversion").querySelector(".today-row-clock");
  expect(clock?.getAttribute("aria-label")).toBe(
    lines.find(({ id }) => id === "blocked:halt:crs-conversion")?.deadline?.reason,
  );
  expect(clock?.getAttribute("tabindex")).toBe("0");
  expect(row("blocked:sync-run:indexer").querySelector(".today-row-clock")).toBeNull();
});

it("keeps every row and the opened body in the four shared columns", async () => {
  await render();
  for (const table of container.querySelectorAll("table"))
    expect(table.querySelectorAll("colgroup col")).toHaveLength(4);
  for (const tr of container.querySelectorAll("tr.today-row"))
    expect([...tr.children].map((td) => (td as HTMLTableCellElement).colSpan)).toEqual([
      1, 1, 1, 1,
    ]);
  await click(row("waiting:upgrade:os-core-common").querySelector(".today-row-what button"));
  const [body] = opened();
  expect([...(body?.children ?? [])].map((td) => (td as HTMLTableCellElement).colSpan)).toEqual([
    1, 3,
  ]);
});

it("says nothing is yours on a morning with no lines, and draws nothing without them", async () => {
  const calm = nov16();
  calm.briefing.lines = [];
  await render(calm);
  expect(container.textContent).toBe("Nothing is yours to move today.");
  await unmount();
  container.remove();
  const older = nov16();
  delete older.briefing.lines;
  await render(older);
  expect(container.textContent).toBe("");
});
