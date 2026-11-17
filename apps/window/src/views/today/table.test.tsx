// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  FocusItemSchema,
  TodayLineSchema,
  type TodaySummary,
  type ViewSnapshot,
  ViewSnapshotSchema,
} from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import {
  closeSheet,
  parseRoute,
  setOpenSelection,
  useLineSheetRequest,
} from "../../app/navigation.js";
import recorded from "../../components/opened-body/sweep-1116.json?raw";
import { fixtureLoader, installSpi } from "../../test-utils/harness.js";
import { clockTime } from "../../time.js";
import snapshot1116 from "./snapshot-1116.json?raw";
import { ageInOneUnit, TodayTable } from "./Table.js";

const sweep = JSON.parse(recorded);
const lines = TodayLineSchema.array().parse(sweep.lines);
const items = FocusItemSchema.array().parse(sweep.items);
const summary1116 = ViewSnapshotSchema.parse(JSON.parse(snapshot1116)).briefing.today;
const loadFixture = fixtureLoader(readFixture);

/** The 16 Nov lines and summary over a recorded snapshot's forks; the table reads nothing else from it. */
function nov16(): ViewSnapshot {
  const body = loadFixture("snapshot-busy.json");
  body.briefing.lines = lines;
  body.briefing.today = structuredClone(summary1116);
  body.briefing.focus = items.map((item) => ({ ...item, attention: "surface", owned: true }));
  body.briefing.rest = [];
  return body;
}

/** How many times the Line sheet was asked to open. */
function SheetRequests() {
  return <i hidden data-sheet-requests={useLineSheetRequest().id} />;
}
const sheetRequests = () =>
  Number(container.querySelector<HTMLElement>("[data-sheet-requests]")?.dataset.sheetRequests);

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
  closeSheet();
  harness.restore();
  window.location.hash = "";
});

async function render(snapshot: ViewSnapshot = nov16()) {
  container = document.createElement("div");
  container.className = "today";
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <>
        <TodayTable snapshot={snapshot} />
        <SheetRequests />
      </>,
    ),
  );
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
  expect(
    container.querySelectorAll("tr.today-row:not(.today-row--sub, .today-row--place)"),
  ).toHaveLength(10);
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
  const spans = (tr: Element) => [...tr.children].map((td) => (td as HTMLTableCellElement).colSpan);
  for (const tr of container.querySelectorAll("tr.today-row:not(.today-row--place)"))
    expect(spans(tr)).toEqual([1, 1, 1, 1]);
  const lower = container.querySelectorAll("tr.today-row--place");
  expect(lower.length).toBeGreaterThan(0);
  for (const tr of lower) expect(spans(tr)).toEqual([1, 2, 1]);
  await click(row("waiting:upgrade:os-core-common").querySelector(".today-row-what button"));
  const [body] = opened();
  expect([...(body?.children ?? [])].map((td) => (td as HTMLTableCellElement).colSpan)).toEqual([
    1, 3,
  ]);
});

it("says nothing is yours on a morning with no lines, and draws nothing without them", async () => {
  const calm = nov16();
  calm.briefing.lines = [];
  delete calm.briefing.today;
  await render(calm);
  expect(container.textContent).toBe("Nothing is yours to move today.");
  await unmount();
  container.remove();
  const older = nov16();
  delete older.briefing.lines;
  await render(older);
  expect(container.textContent).toBe("");
});

const sections = () =>
  [...container.querySelectorAll<HTMLElement>(".today-section")].map(
    ({ dataset }) => dataset.section,
  );
const lowerRow = (section: string, id: string) => {
  const found = container.querySelector(`[data-section=${section}] tr[data-row="${id}"]`);
  if (!found) throw new Error(`Missing ${section} row ${id}`);
  return found;
};
const what = (tr: Element) => tr.querySelector(".today-row-what")?.textContent;
const count = (tr: Element, kind: string) => tr.querySelector(`.today-count[data-kind="${kind}"]`);

it("ends 16 Nov with Can wait, Moving without you and Last 24 hours as counts", async () => {
  await render();
  expect(sections()).toEqual(["blocked", "waiting", "can-wait", "moving", "history"]);
  const head = (id: string) =>
    container.querySelector(`[data-section=${id}] .today-section-head`)?.textContent;
  expect(["can-wait", "moving", "history"].map(head)).toEqual([
    "Can wait",
    "Moving without you",
    "Last 24 hours",
  ]);
  const releases = lowerRow("can-wait", "releases");
  expect(what(releases)).toBe("14 open · 1 ready to merge · 13 waiting for review");
  expect(count(releases, "ready")?.getAttribute("title")).toBe("osdu-spi-stack #474");
  expect(what(lowerRow("can-wait", "repositories"))).toBe(
    "8 human-required issues · 7 chore PRs · 27 Dependabot bumps",
  );
  expect(what(lowerRow("can-wait", "security"))).toBe("6 critical or high · 22 code scanning");
  expect(container.querySelectorAll("[data-section=moving] tr")).toHaveLength(3);
  expect(what(lowerRow("moving", "lanes"))).toBe("Now · 1 lane busy: partition");
  expect(what(lowerRow("moving", "template"))).toBe(
    `${clockTime("2026-11-17T08:00:00.000Z", { hint: false })} · opens PRs on 7 forks`,
  );
  const sync = lowerRow("history", "sync");
  expect(what(sync)).toBe("13 forks · 1 new PRs · 3 failed · 9 not read");
  expect(count(sync, "failed")?.getAttribute("title")).toBe("indexer, search, crs-conversion");
  expect(count(sync, "failed")?.getAttribute("data-tone")).toBe("bad");
  expect(what(lowerRow("history", "template"))).toBe("13 forks · 6 merged · 7 not read");
  for (const tr of container.querySelectorAll("tr.today-row--place"))
    expect(tr.querySelector(".today-row-open, .kit-link")).toBeNull();
});

it("a calm morning says nothing is yours, then shows the three sections", async () => {
  const calm = nov16();
  calm.briefing.lines = [];
  await render(calm);
  expect(container.querySelector(".today-table-calm")?.textContent).toBe(
    "Nothing is yours to move today.",
  );
  expect(sections()).toEqual(["can-wait", "moving", "history"]);
  expect(container.querySelectorAll("tr.today-row:not(.today-row--place)")).toHaveLength(0);
});

it.each([
  ["can-wait", "releases", "releases"],
  ["can-wait", "repositories", "engineering-system"],
  ["can-wait", "security", "security"],
  ["moving", "lanes", "line"],
  ["moving", "template", "engineering-system"],
  ["moving", "sync", "upstream"],
  ["history", "sync", "line"],
  ["history", "template", "engineering-system"],
])("the %s row %s opens its place, %s", async (section, id, place) => {
  await render();
  const tr = lowerRow(section, id);
  for (const target of [".today-row-what", ".today-row-fork button"]) {
    window.location.hash = "#today";
    const before = sheetRequests();
    await click(tr.querySelector(target));
    if (place === "line") expect(sheetRequests()).toBe(before + 1);
    else expect(parseRoute(window.location.hash)).toEqual({ kind: place });
    expect(opened()).toHaveLength(0);
  }
});

it("a pile or workflow core did not read shows as not read, never as zero", async () => {
  const body = nov16();
  const today = body.briefing.today as TodaySummary;
  const [releases, , security] = today.canWait;
  if (!releases || !security) throw new Error("16 Nov has its piles");
  for (const c of security.counts) c.count = 0;
  security.notRead = ["osdu-spi: vulnerabilities", "osdu-spi: code scanning"];
  for (const c of releases.counts) if (c.kind !== "open") c.count = 0;
  releases.notRead = ["indexer: release PRs"];
  const [sync] = today.history.rows;
  if (!sync) throw new Error("16 Nov has its history");
  sync.counts = [
    { kind: "not-read", label: "not read", count: 13, tone: "neutral", names: [], urls: [] },
  ];
  await render(body);
  const unread = lowerRow("can-wait", "security");
  expect(what(unread)).toBe("not read");
  expect(unread.querySelector(".today-row-gaps")?.textContent).toBe("⌀ 2");
  const partly = lowerRow("can-wait", "releases");
  expect(what(partly)).toBe("14 open");
  expect(partly.querySelector(".today-row-gaps")?.textContent).toBe("⌀ 1");
  expect(what(lowerRow("history", "sync"))).toBe("13 forks · 13 not read");
  for (const tr of container.querySelectorAll("tr.today-row--place"))
    expect(what(tr)).not.toMatch(/(^|· )0 /);
  await click(unread.querySelector(".today-row-gaps"));
  expect(parseRoute(window.location.hash)).toMatchObject({ kind: "evidence" });
  expect(parseRoute(window.location.hash)).not.toHaveProperty("selection");

  await unmount();
  container.remove();
  const read = nov16();
  const pile = (read.briefing.today as TodaySummary).canWait[2];
  if (!pile) throw new Error("16 Nov has its security pile");
  for (const c of pile.counts) c.count = 0;
  await render(read);
  expect(what(lowerRow("can-wait", "security"))).toBe("none");
  expect(lowerRow("can-wait", "security").querySelector(".today-row-gaps")).toBeNull();
});

it.each([
  ["fallback", undefined, "Last 24 hours"],
  ["seen", undefined, "Since you last looked, {from}"],
  ["history-short", undefined, "Since {from}"],
  ["stale", "2026-11-16T22:00:00.000Z", "24 hours to {asOf}"],
] as const)("names a %s history window only as far as core vouches", async (basis, asOf, text) => {
  const body = nov16();
  const history = (body.briefing.today as TodaySummary).history;
  history.basis = basis;
  history.from = "2026-11-16T20:00:00.000Z";
  if (asOf) history.asOf = asOf;
  else delete history.asOf;
  await render(body);
  const time = (at: string) => clockTime(at, { hint: false });
  expect(container.querySelector("[data-section=history] .today-section-head")?.textContent).toBe(
    text.replace("{from}", time(history.from)).replace("{asOf}", time(asOf ?? "")),
  );
});
