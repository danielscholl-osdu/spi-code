// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type TodaySummary, type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import {
  closeSheet,
  navigate,
  openSelection,
  parseRoute,
  setOpenSelection,
  useLineSheetRequest,
  useOpenSelection,
} from "../../app/navigation.js";
import { fixtureLoader, installSpi } from "../../test-utils/harness.js";
import { clockTime, timedText } from "../../time.js";
import { TodayHome } from "./Home.js";
import snapshot1116 from "./snapshot-1116.json?raw";
import { ageInOneUnit } from "./Table.js";

const recorded = ViewSnapshotSchema.parse(JSON.parse(snapshot1116)).briefing;
const lines = recorded.lines ?? [];
const items = [...recorded.focus, ...recorded.rest];
const summary1116 = recorded.today;
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

/** The whole 16 Nov snapshot, whose services and fleet the flow and Can wait read. */
const whole = (): ViewSnapshot => ViewSnapshotSchema.parse(JSON.parse(snapshot1116));

/** Today at the route in the hash, following navigation the way the shell does. */
function Routed({ snapshot }: { snapshot: ViewSnapshot }) {
  useOpenSelection();
  const route = parseRoute(window.location.hash);
  if (route?.kind !== "today") return null;
  return <TodayHome snapshot={snapshot} tab={route.tab} station={route.station} />;
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

async function render(snapshot: ViewSnapshot = nov16(), hash = "#today") {
  window.location.hash = hash;
  container = document.createElement("div");
  container.className = "today";
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <>
        <Routed snapshot={snapshot} />
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

const yoursRows = () =>
  container.querySelectorAll(
    "tr.today-row:not(.today-row--sub, .today-row--place, .today-row--cause)",
  );
const memberIds = () =>
  [...container.querySelectorAll<HTMLElement>("[data-section] tr.today-row[data-item-id]")].map(
    ({ dataset }) => dataset.itemId,
  );
const station = (id: string) => container.querySelector<HTMLElement>(`[data-station=${id}]`);
const door = (id: string) => container.querySelector<HTMLElement>(`[data-door=${id}]`);
const tab = (id: string) => container.querySelector<HTMLElement>(`[data-today-tab=${id}]`);
const route = () => parseRoute(window.location.hash);

it("draws 16 Nov as 3 Blocked and 16 Waiting on you in 11 rows, with no verb", async () => {
  await render();
  expect(section("blocked")?.querySelector(".today-section-count")?.textContent).toBe("3");
  expect(section("waiting")?.querySelector(".today-section-count")?.textContent).toBe("16");
  expect(yoursRows()).toHaveLength(11);
  expect(container.querySelectorAll("tr.today-row--sub")).toHaveLength(
    lines.filter((line) => line.members.length > 1).reduce((n, l) => n + l.members.length, 0),
  );
  const verbs = new Set(items.map(({ verb }) => verb).filter(Boolean));
  expect(verbs.size).toBeGreaterThan(3);
  for (const verb of verbs) expect(container.textContent).not.toContain(verb);
});

it("a group's headline opens the group's body, a member's expander opens that member, one at a time", async () => {
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
  expect(header.querySelector(".today-row-what button")?.getAttribute("aria-expanded")).toBe(
    "true",
  );

  const sub = row(group.id, member.id);
  await click(sub.querySelector(".today-row-what button"));
  expect(opened()).toHaveLength(1);
  expect(bodyAfter(header)).toBeNull();
  expect(bodyAfter(sub)?.querySelector(".opened-body")).not.toBeNull();
  expect(bodyAfter(sub)?.querySelector("a[href='#today'], a[href^='#service']")).toBeNull();

  await click(sub.querySelector(".today-row-what button"));
  expect(opened()).toHaveLength(0);
});

it("a fork's name opens its service page and opens no row; a subject that is no fork is words", async () => {
  await render();
  const halt = row("blocked:halt:crs-conversion");
  await click(halt.querySelector(".today-row-fork button"));
  expect(route()).toEqual({ kind: "service", id: "crs-conversion" });
  expect(opened()).toHaveLength(0);
  await act(async () => navigate({ kind: "today" }));
  const sub = row("waiting:blocker:stack:lanes:gate2", "gate2:legal");
  await click(sub.querySelector(".today-row-fork button"));
  expect(route()).toEqual({ kind: "service", id: "legal" });
  await act(async () => navigate({ kind: "today" }));
  for (const id of ["waiting:rollout", "waiting:blocker:stack:lanes:gate2"]) {
    const fork = row(id).querySelector(".today-row-fork");
    expect(fork?.querySelector("button")).toBeNull();
    expect(fork?.querySelector("span.today-fork-name")).not.toBeNull();
  }
});

it("Esc closes the open row and a click elsewhere on Today closes it", async () => {
  await render();
  const halt = row("blocked:halt:crs-conversion");
  await click(halt.querySelector(".today-row-what button"));
  expect(opened()).toHaveLength(1);
  await press("Escape");
  expect(opened()).toHaveLength(0);
  expect(document.activeElement).toBe(halt.querySelector(".today-row-what button"));

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
  await click(tr.querySelector(".today-row-what button"));
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
  expect(route()).toMatchObject({
    kind: "evidence",
    from: { kind: "today" },
    selection: { kind: "item", id: "gate2:storage" },
  });

  await act(async () => navigate({ kind: "today" }));
  const group = row("waiting:blocker:stack:lanes:gate2");
  expect(group.querySelector(".today-row-gaps")?.textContent).toBe("⌀ 1");
  const subs = container.querySelectorAll(
    'tr.today-row--sub[data-line-id="waiting:blocker:stack:lanes:gate2"]',
  );
  expect(subs).toHaveLength(5);
  for (const sub of subs) expect(sub.querySelector(".today-row-gaps")).toBeNull();
  await click(group.querySelector(".today-row-gaps"));
  expect(route()).toMatchObject({
    kind: "evidence",
    selection: { kind: "line", id: "waiting:blocker:stack:lanes:gate2" },
  });
});

it("a member's age is the age of its object, in one unit", async () => {
  await render();
  const unit = row("waiting:upgrade:os-core-common", "gate1:unit");
  expect(unit.querySelector(".today-row-age")?.textContent).toBe("10d");
  expect(
    [...container.querySelectorAll("table")].map((table) => table.textContent).join(" "),
  ).not.toContain("59d");
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
    timedText(
      lines.find(({ id }) => id === "blocked:halt:crs-conversion")?.deadline?.reason ?? "",
      { hint: false },
    ),
  );
  expect(clock?.getAttribute("tabindex")).toBe("0");
  expect(row("blocked:sync-run:indexer").querySelector(".today-row-clock")).toBeNull();
});

it("keeps every row and the opened body in the four shared columns, on Yours and Activity", async () => {
  await render();
  const spans = (tr: Element) => [...tr.children].map((td) => (td as HTMLTableCellElement).colSpan);
  const check = () => {
    for (const table of container.querySelectorAll("table"))
      expect(table.querySelectorAll("colgroup col")).toHaveLength(4);
    for (const tr of container.querySelectorAll("tr.today-row:not(.today-row--place)"))
      expect(spans(tr)).toEqual([1, 1, 1, 1]);
  };
  check();
  await click(row("waiting:upgrade:os-core-common").querySelector(".today-row-what button"));
  const [body] = opened();
  expect([...(body?.children ?? [])].map((td) => (td as HTMLTableCellElement).colSpan)).toEqual([
    1, 3,
  ]);
  await click(tab("activity"));
  check();
  const lower = container.querySelectorAll("tr.today-row--place");
  expect(lower.length).toBeGreaterThan(0);
  for (const tr of lower) expect(spans(tr)).toEqual([1, 2, 1]);
});

it("says nothing is yours on a morning with no lines, and draws no table without them", async () => {
  const calm = nov16();
  calm.briefing.lines = [];
  delete calm.briefing.today;
  await render(calm);
  expect(container.querySelector(".today-table")?.textContent).toBe(
    "Nothing is yours to move today.",
  );
  expect(tab("yours")?.querySelector(".today-tab-count")).toBeNull();
  await unmount();
  container.remove();
  const older = nov16();
  delete older.briefing.lines;
  await render(older);
  expect(container.querySelector("[role=tabpanel]")?.textContent).toBe("");
});

it("counts Yours by the shared member count, and Activity holds Moving without you and Last 24 hours", async () => {
  await render();
  expect(tab("yours")?.querySelector(".today-tab-count")?.textContent).toBe("19");
  expect(sections()).toEqual(["blocked", "waiting", "can-wait"]);
  await click(tab("activity"));
  expect(route()).toEqual({ kind: "today", tab: "activity" });
  expect(tab("activity")?.getAttribute("aria-selected")).toBe("true");
  expect(sections()).toEqual(["moving", "history"]);
  expect(container.querySelectorAll("[data-section=moving] tr")).toHaveLength(3);
  expect(what(lowerRow("moving", "lanes"))).toBe("Now · 1 lane busy: partition");
  const sync = lowerRow("history", "sync");
  expect(count(sync, "failed")?.getAttribute("title")).toBe("indexer, search, crs-conversion");
  await click(tab("yours"));
  expect(route()).toEqual({ kind: "today" });
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

it("a calm morning says nothing is yours, then shows Can wait", async () => {
  const calm = nov16();
  calm.briefing.lines = [];
  await render(calm);
  expect(container.querySelector(".today-table-calm")?.textContent).toBe(
    "Nothing is yours to move today.",
  );
  expect(sections()).toEqual(["can-wait"]);
  expect(yoursRows()).toHaveLength(0);
});

it.each([
  ["moving", "lanes", "line"],
  ["moving", "template", "engineering-system"],
  ["moving", "sync", "upstream"],
  ["history", "sync", "line"],
  ["history", "template", "engineering-system"],
])("the %s row %s opens its place, %s", async (section, id, place) => {
  await render(nov16(), "#today/activity");
  for (const target of [".today-row-what", ".today-row-fork button"]) {
    await act(async () => navigate({ kind: "today", tab: "activity" }));
    const before = sheetRequests();
    await click(lowerRow(section, id).querySelector(target));
    if (place === "line") expect(sheetRequests()).toBe(before + 1);
    else expect(route()).toEqual({ kind: place });
    expect(opened()).toHaveLength(0);
  }
});

it("a workflow core did not read shows as not read, never as zero", async () => {
  const body = nov16();
  const [sync] = (body.briefing.today as TodaySummary).history.rows;
  if (!sync) throw new Error("16 Nov has its history");
  sync.counts = [
    { kind: "not-read", label: "not read", count: 13, tone: "neutral", names: [], urls: [] },
  ];
  await render(body, "#today/activity");
  expect(what(lowerRow("history", "sync"))).toBe("13 forks · 13 not read");
  for (const tr of container.querySelectorAll("tr.today-row--place"))
    expect(what(tr)).not.toMatch(/(^|· )0 /);
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
  await render(body, "#today/activity");
  const time = (at: string) => clockTime(at, { hint: false });
  expect(container.querySelector("[data-section=history] .today-section-head")?.textContent).toBe(
    text.replace("{from}", time(history.from)).replace("{asOf}", time(asOf ?? "")),
  );
});

describe("the fleet flow filters Yours", () => {
  const atStation = (body: ViewSnapshot, id: string) =>
    (body.briefing.lines ?? []).flatMap(({ members }) =>
      members.filter((member) => member.station === id).map((member) => member.id),
    );

  it.each(["upstream", "sync", "integration", "template"])(
    "pressing %s shows exactly its members, Show all restores every row, and pressing again clears it",
    async (id) => {
      const body = whole();
      await render(body);
      const all = memberIds();
      const target = id === "template" ? door(id) : station(id);
      expect(target?.tagName).toBe("BUTTON");
      await click(target);
      expect(route()).toEqual({ kind: "today", station: id });
      expect(target?.getAttribute("aria-pressed")).toBe("true");
      expect(memberIds().sort()).toEqual(atStation(body, id).sort());
      expect(memberIds().length).toBeGreaterThan(0);
      expect(section("can-wait")).toBeNull();
      expect(container.querySelector(".today-filter")?.textContent).toMatch(
        /^Showing .+Show all ✕$/,
      );
      await click(container.querySelector(".today-filter button"));
      expect(route()).toEqual({ kind: "today" });
      expect(memberIds()).toEqual(all);
      expect(section("can-wait")).not.toBeNull();
      await click(target);
      await click(id === "template" ? door(id) : station(id));
      expect(route()).toEqual({ kind: "today" });
      expect(memberIds()).toEqual(all);
    },
  );

  it("pressing Sync PR keeps only a group's sync members", async () => {
    const body = whole();
    const group = body.briefing.lines?.find(({ id }) => id === "waiting:upgrade:os-core-common");
    const moved = group?.members[0];
    if (!group || !moved) throw new Error("16 Nov has the os-core-common group");
    moved.station = "integration";
    await render(body, "#today/yours/sync");
    const kept = group.members.slice(1).map(({ id }) => id);
    expect(memberIds()).toEqual(expect.arrayContaining(kept));
    expect(memberIds()).not.toContain(moved.id);
    expect(memberIds().sort()).toEqual(atStation(body, "sync").sort());
    expect(
      container.querySelectorAll(
        'tr.today-row--sub[data-line-id="waiting:upgrade:os-core-common"]',
      ),
    ).toHaveLength(kept.length);
  });

  it("a group filtered to one fork is named for it and opens its service; to several, counts them", async () => {
    const id = "waiting:upgrade:os-core-common";
    for (const kept of [1, 2]) {
      const body = whole();
      const group = body.briefing.lines?.find((line) => line.id === id);
      if (!group) throw new Error("16 Nov has the os-core-common group");
      for (const member of group.members.slice(kept)) member.station = "integration";
      await render(body, "#today/yours/sync");
      const head = container.querySelector(`tr.today-row[data-line-id="${id}"] .today-fork-name`);
      if (kept === 1) {
        expect(head?.tagName).toBe("BUTTON");
        expect(head?.textContent).toBe(group.members[0]?.fork);
        await unmount();
        container.remove();
      } else expect(head?.textContent).toBe("2 forks");
    }
  });

  it("Integration's second line keeps the cascade wait through a partial read and names those forks", async () => {
    const body = whole();
    const integration = body.briefing.today?.fleet?.stations.find(({ id }) => id === "integration");
    if (!integration) throw new Error("16 Nov has its Integration figure");
    Object.assign(integration, {
      count: 0,
      forks: [],
      stopped: [],
      red: [],
      notRead: ["file"],
      waitingOnClock: ["search"],
    });
    await render(body, "#today/yours/integration");
    expect(station("integration")?.querySelector(".flow-word")?.textContent).toBe("⌀ not read");
    expect(station("integration")?.querySelector(".flow-line")?.textContent).toBe(
      "1 waiting for cascade",
    );
    expect(container.querySelector(".today-filter-note")?.textContent).toBe(
      "Waiting for cascade on search.",
    );
    expect(memberIds().sort()).toEqual(atStation(body, "integration").sort());
  });

  it("a station claims red only for its red PRs, and a fork not read is never not green", async () => {
    const body = whole();
    const stations = body.briefing.today?.fleet?.stations ?? [];
    const integration = stations.find(({ id }) => id === "integration");
    const main = stations.find(({ id }) => id === "main");
    if (!integration || !main) throw new Error("16 Nov has its Integration and Main figures");
    Object.assign(integration, { count: 1, forks: ["unit"], stopped: ["search"], red: [] });
    Object.assign(main, { count: 11, forks: main.forks.slice(0, 11), notRead: ["file", "unit"] });
    await render(body);
    expect(station("integration")?.querySelector(".flow-line")).toBeNull();
    expect(station("main")?.querySelector(".flow-word")?.textContent).toBe("11 green ⌀");
    expect(station("main")?.querySelector(".flow-line")).toBeNull();
    await unmount();
    container.remove();

    Object.assign(integration, { stopped: ["unit"], red: ["unit"] });
    await render(body);
    expect(station("integration")?.querySelector(".flow-line")?.textContent).toBe("1 red");
  });

  it("pressing a station from Activity opens Yours filtered", async () => {
    await render(whole(), "#today/activity");
    await click(station("upstream"));
    expect(route()).toEqual({ kind: "today", station: "upstream" });
    expect(tab("yours")?.getAttribute("aria-selected")).toBe("true");
    expect(memberIds()).toHaveLength(3);
  });

  it("Main is not a button and Environment opens Environment", async () => {
    await render(whole());
    expect(station("main")?.tagName).toBe("DIV");
    await click(station("environment"));
    expect(route()).toEqual({ kind: "environment" });
  });

  it("a filter whose figure was not fully read shows its known rows and the not-read line", async () => {
    const body = whole();
    const sync = body.briefing.today?.fleet?.stations.find(({ id }) => id === "sync");
    if (!sync) throw new Error("16 Nov has its Sync PR figure");
    sync.notRead = ["file"];
    await render(body, "#today/yours/sync");
    expect(station("sync")?.querySelector(".flow-word")?.textContent).toBe(`${sync.count} open ⌀`);
    expect(container.querySelector(".today-not-read")?.textContent).toMatch(
      /^⌀ Not read on file\./,
    );
    expect(memberIds().sort()).toEqual(atStation(body, "sync").sort());
    await unmount();
    container.remove();

    const empty = whole();
    const upstream = empty.briefing.today?.fleet?.stations.find(({ id }) => id === "upstream");
    if (!upstream || !empty.briefing.lines) throw new Error("16 Nov has its Upstream figure");
    Object.assign(upstream, { count: 0, forks: [], stopped: [], notRead: ["indexer"] });
    empty.briefing.lines = empty.briefing.lines.filter(
      ({ members }) => !members.some(({ station }) => station === "upstream"),
    );
    await render(empty, "#today/yours/upstream");
    expect(station("upstream")?.querySelector(".flow-word")?.textContent).toBe("⌀ not read");
    expect(container.querySelector(".today-not-read")?.textContent).toMatch(/indexer/);
    expect(container.querySelector(".today-table-calm")).toBeNull();
    expect(memberIds()).toEqual([]);
  });

  it("a known empty filter says nothing waits there", async () => {
    const body = whole();
    body.briefing.lines = [];
    await render(body, "#today/yours/sync");
    expect(container.querySelector(".today-not-read")).toBeNull();
    expect(container.querySelector(".today-table-calm")?.textContent).toBe(
      "Nothing waiting on you here.",
    );
  });
});

describe("Can wait by cause", () => {
  const causes = () => whole().briefing.today?.causes?.rows ?? [];
  const causeRow = (id: string) =>
    container.querySelector<HTMLElement>(`tr.today-row--cause[data-row=${JSON.stringify(id)}]`);

  it("draws one row per cause, each opening into its forks one at a time", async () => {
    await render(whole());
    const rows = causes();
    expect(
      [...container.querySelectorAll<HTMLElement>("tr.today-row--cause")].map(
        (tr) => tr.dataset.row,
      ),
    ).toEqual(rows.map(({ id }) => id));
    const dependabot = rows.find(({ kind }) => kind === "dependabot");
    if (!dependabot) throw new Error("16 Nov has its Dependabot cause");
    await click(causeRow(dependabot.id)?.querySelector(".today-row-what button"));
    expect(openSelection()).toEqual({ kind: "cause", id: dependabot.id });
    const body = causeRow(dependabot.id)?.nextElementSibling;
    const forks = [...(body?.querySelectorAll(".today-cause-forks > *") ?? [])];
    expect(forks).toHaveLength(dependabot.forks.length);
    await click(causeRow("release")?.querySelector(".today-row-what button"));
    expect(opened()).toHaveLength(1);
    await press("Escape");
    expect(opened()).toHaveLength(0);
  });

  it("a fork pill opens its service page with the row holding its object, else the cause's place", async () => {
    await render(whole());
    await click(causeRow("release")?.querySelector(".today-row-what button"));
    const pill = (fork: string) =>
      container.querySelector<HTMLElement>(`.today-cause-fork[data-fork=${JSON.stringify(fork)}]`);
    await click(pill("search"));
    expect(route()).toEqual({
      kind: "service",
      id: "search",
      tab: "overview",
      row: "can:releases:https://github.com/Azure/osdu-spi-search/pull/29",
    });
    await act(async () => navigate({ kind: "today" }));
    expect(causeRow("release")?.hasAttribute("data-open")).toBe(true);
    await click(pill("osdu-spi-stack"));
    expect(route()).toEqual({ kind: "releases" });
  });

  it.each(["release", "dependabot", "other"])(
    "the %s door opens the Can wait row core names",
    async (id) => {
      const body = whole();
      const target = body.briefing.today?.fleet?.doors.find((entry) => entry.id === id)?.target;
      if (target?.kind !== "cause") throw new Error(`16 Nov's ${id} door has a row`);
      await render(body, "#today/activity");
      await click(door(id));
      expect(route()).toEqual({ kind: "today" });
      expect(openSelection()).toEqual({ kind: "cause", id: target.row });
      expect(causeRow(target.row)?.hasAttribute("data-open")).toBe(true);
    },
  );

  it("a door opens its cause from Activity in view, with focus on it", async () => {
    const scrolled: Element[] = [];
    const scroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      await render(whole(), "#today/activity");
      await click(door("release"));
      const head = causeRow("release")?.querySelector(".today-row-what button");
      expect(head?.getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(head);
      expect(scrolled).toContain(causeRow("release"));
    } finally {
      Element.prototype.scrollIntoView = scroll;
    }
  });

  it("a door with nothing behind it is not a button", async () => {
    const body = whole();
    const doors = body.briefing.today?.fleet?.doors ?? [];
    for (const entry of doors) delete entry.target;
    await render(body);
    for (const entry of doors) expect(door(entry.id)?.tagName).toBe("SPAN");
  });

  it("a cause kind core could not read says so, never zero", async () => {
    const body = whole();
    const summary = body.briefing.today;
    if (!summary?.causes) throw new Error("16 Nov has its causes");
    summary.causes.rows = summary.causes.rows.filter(({ kind }) => kind !== "dependabot");
    summary.causes.notRead.dependabot = ["indexer", "search"];
    summary.causes.notRead.release = ["legal"];
    await render(body);
    expect(container.querySelector("[data-unread=dependabot]")?.textContent).toMatch(
      /^⌀ Dependabot PRs not read on indexer, search\./,
    );
    expect(causeRow("release")?.querySelector(".today-row-gaps")?.getAttribute("title")).toBe(
      "legal",
    );
  });
});
