// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type TodaySummary,
  todayMembers,
  type ViewSnapshot,
  ViewSnapshotSchema,
} from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import {
  navigate,
  openSelection,
  parseRoute,
  setOpenSelection,
  useOpenSelection,
} from "../../app/navigation.js";
import { fixtureLoader, installSpi } from "../../test-utils/harness.js";
import { threadStore } from "../../threads/store.js";
import { timedText, when } from "../../time.js";
import { TodayHome } from "./Home.js";
import snapshot1116 from "./snapshot-1116.json?raw";
import { ageInOneUnit, todayRowOf } from "./Table.js";

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

let harness: ReturnType<typeof installSpi>;
let container: HTMLDivElement;
let unmount: () => Promise<void>;
const initialThreadState = threadStore.getState();
beforeEach(() => {
  harness = installSpi();
  window.location.hash = "#today";
});
afterEach(async () => {
  await unmount();
  container.remove();
  setOpenSelection(null);
  threadStore.setState(initialThreadState, true);
  harness.restore();
  window.location.hash = "";
});

async function render(snapshot: ViewSnapshot = nov16(), hash = "#today") {
  window.location.hash = hash;
  container = document.createElement("div");
  container.className = "today";
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Routed snapshot={snapshot} />));
  unmount = () => act(async () => root.unmount());
  return (next: ViewSnapshot) => act(async () => root.render(<Routed snapshot={next} />));
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
const station = (id: string) =>
  container.querySelector<HTMLElement>(`.fleet-cell[data-station=${id}]`);
const door = (id: string) => container.querySelector<HTMLElement>(`.fleet-cell[data-door=${id}]`);
const tab = (id: string) => container.querySelector<HTMLElement>(`[data-today-tab=${id}]`);
const route = () => parseRoute(window.location.hash);
const value = (id: string) =>
  (station(id) ?? door(id))
    ?.querySelector(".fleet-value")
    ?.textContent?.replace(/\s+/g, " ")
    .trim();
const readout = (id: string) => [value(id), station(id)?.querySelector(".fleet-sub")?.textContent];
const chip = (id: string) =>
  (station(id) ?? door(id))?.parentElement?.querySelector<HTMLAnchorElement>(".fleet-gap");

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

it("counts the 6 Nov rollout PRs in Yours and opens the group and each PR separately", async () => {
  const snapshot = loadFixture("snapshot-1106.json");
  const lines = snapshot.briefing.lines ?? [];
  const group = lines.find(({ rollout }) => rollout);
  if (!group) throw new Error("6 Nov has template sync PRs");
  await render(snapshot);
  expect(tab("yours")?.querySelector(".today-tab-count")?.textContent).toBe("27");
  for (const member of group.members) {
    expect(todayRowOf(lines, member.id)).toEqual({ kind: "item", id: member.id });
    expect(row(group.id, member.id).querySelector(".today-row-open a")?.getAttribute("href")).toBe(
      member.primary?.url,
    );
  }
  await act(async () => navigate({ kind: "today", station: "template" }));
  expect(
    [...container.querySelectorAll<HTMLElement>(`[data-line="${group.id}"] [data-item-id]`)].map(
      ({ dataset }) => dataset.itemId,
    ),
  ).toEqual(group.members.map(({ id }) => id));
  expect(todayRowOf(lines, "rollout")).toEqual({ kind: "line", id: group.id });
  await click(row(group.id).querySelector(".today-row-what button"));
  const body = bodyAfter(row(group.id));
  expect(body?.querySelector("a[href='#engineering-system']")).not.toBeNull();
  expect(body?.querySelector("a[href^='#evidence']")).not.toBeNull();
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
  for (const [raw, shown] of [
    ["12s", "12s"],
    ["33m", "33m"],
    ["23h", "23h"],
    ["24h", "1d"],
    ["35h", "1d"],
    ["36h", "2d"],
    ["1d", "1d"],
    ["1d 11h", "1d"],
    ["1d 12h", "2d"],
    ["1d 23h", "2d"],
    ["2d", "2d"],
    ["59h", "2d"],
    ["60h", "3d"],
    ["83h", "3d"],
    ["84h", "4d"],
    ["6d 22h", "7d"],
  ]) {
    expect(ageInOneUnit(raw), raw).toBe(shown);
  }
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
  expect(container.querySelector(".today-table")?.textContent).toBe("Nothing is yours to move.");
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

it("names what the Forks chip counts, and draws none when no fork is stopped", async () => {
  const body = whole();
  const fleet = body.briefing.today?.fleet;
  if (!fleet) throw new Error("16 Nov has its fleet");
  await render(body);
  const chip = tab("forks")?.querySelector(".today-tab-count");
  expect(chip?.textContent).toBe(`${fleet.forks.stopped.length} stopped`);
  expect(chip?.getAttribute("title")).toBe(fleet.forks.stopped.join(", "));
  await unmount();
  container.remove();

  fleet.forks.stopped = [];
  await render(body);
  expect(tab("forks")?.querySelector(".today-tab-count")).toBeNull();
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
    "Nothing is yours to move.",
  );
  expect(sections()).toEqual(["can-wait"]);
  expect(yoursRows()).toHaveLength(0);
});

it.each([
  ["moving", "lanes", "forks"],
  ["moving", "template", "engineering-system"],
  ["moving", "sync", "upstream"],
  ["history", "sync", "forks"],
  ["history", "template", "engineering-system"],
])("the %s row %s opens its place, %s", async (section, id, place) => {
  await render(nov16(), "#today/activity");
  for (const target of [".today-row-what", ".today-row-fork button"]) {
    await act(async () => navigate({ kind: "today", tab: "activity" }));
    await click(lowerRow(section, id).querySelector(target));
    if (place === "forks") expect(route()).toEqual({ kind: "today", tab: "forks" });
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
  const time = (at: string) => when(at);
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

  it("Integration keeps the cascade wait through a partial read and names those forks", async () => {
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
    expect(value("integration")).toBe("1 waiting for cascade");
    expect(chip("integration")?.title).toBe("Integration not read on file · opens Evidence");
    expect(container.querySelector(".today-filter-note")?.textContent).toBe(
      "Waiting for cascade on search.",
    );
    expect(memberIds().sort()).toEqual(atStation(body, "integration").sort());
  });

  it("Main reads green only when every fork was read green, and red over its green count", async () => {
    const body = whole();
    const stations = body.briefing.today?.fleet?.stations ?? [];
    const integration = stations.find(({ id }) => id === "integration");
    const main = stations.find(({ id }) => id === "main");
    if (!integration || !main) throw new Error("16 Nov has its Integration and Main figures");
    await render(body);
    expect(readout("main")).toEqual(["✓ Green", "13 forks"]);
    await unmount();
    container.remove();

    Object.assign(main, { count: 11, forks: main.forks.slice(0, 11), notRead: ["file", "unit"] });
    await render(body);
    expect(readout("main")).toEqual(["11 green", undefined]);
    expect(chip("main")?.title).toBe("Main not read on file and unit · opens Evidence");
    await unmount();
    container.remove();

    Object.assign(integration, { stopped: ["unit"], red: ["unit"] });
    Object.assign(main, { stopped: ["search"] });
    await render(body);
    expect(value("integration")).toBe(`${integration.count} PRs · 1 red`);
    expect(readout("main")).toEqual(["1 red", "11 green"]);
    expect(station("main")?.querySelector(".fleet-value--bad")).not.toBeNull();
    await unmount();
    container.remove();

    Object.assign(main, { count: 0, forks: [], stopped: [] });
    await render(body);
    expect(station("main")?.dataset.kind).toBe("not-read");
    expect(station("main")?.textContent).not.toMatch(/Green|green|·/);
  });

  it.each([
    ["later today", 18, "· 18:00"],
    ["on another day this week", 19, "· Thu 18:00"],
  ] as const)("Upstream counts forks behind with a next sync %s", async (_, day, more) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(2026, 10, 18, 9, 0));
      const body = whole();
      const fleet = body.briefing.today?.fleet;
      const upstream = fleet?.stations.find(({ id }) => id === "upstream");
      if (!fleet || !upstream) throw new Error("16 Nov has its fleet");
      fleet.nextSyncAt = new Date(2026, 10, day, 18, 0).toISOString();
      Object.assign(upstream, { count: 0, forks: [], stopped: [], behind: ["file", "unit"] });
      await render(body);
      expect(value("upstream")).toBe(`2 forks behind ${more}`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pressing a station from Activity opens Yours filtered", async () => {
    await render(whole(), "#today/activity");
    await click(station("upstream"));
    expect(route()).toEqual({ kind: "today", station: "upstream" });
    expect(tab("yours")?.getAttribute("aria-selected")).toBe("true");
    expect(memberIds()).toHaveLength(3);
  });

  it.each([
    ["#today", false],
    ["#today/yours/sync", false],
    ["#today/activity", false],
    ["#today", true],
  ])(
    "at %s says what was not read once, under the flow, by core's names (past four: %s)",
    async (hash, many) => {
      const body = whole();
      const fleet = body.briefing.today?.fleet;
      if (!fleet) throw new Error("16 Nov has its fleet");
      fleet.notRead = many
        ? [
            "file's main run",
            "unit's deployment",
            "legal's upstream",
            "schema's main run",
            "search's upstream",
          ]
        : ["file's pull requests", "unit's pull requests and main run"];
      await render(body, hash);
      const lines = container.querySelectorAll(".today-not-read");
      expect(lines).toHaveLength(1);
      expect(lines[0]?.parentElement?.className).toBe("fleet");
      expect(lines[0]?.previousElementSibling?.className).toBe("fleet-flow");
      expect(lines[0]?.textContent).toBe(
        many
          ? "⌀ Not read on 5 forks · Evidence ›"
          : "⌀ Not read: file's pull requests, unit's pull requests and main run · Evidence ›",
      );
      expect(lines[0]?.getAttribute("title")).toBe(many ? fleet.notRead.join("\n") : null);
      await click(lines[0]?.querySelector("a"));
      expect(route()?.kind).toBe("evidence");
    },
  );

  it("a filter over forks not read never says its list is empty, and nothing unread draws no line", async () => {
    await render(whole());
    expect(container.querySelector(".today-not-read")).toBeNull();
    await unmount();
    container.remove();

    const empty = whole();
    const fleet = empty.briefing.today?.fleet;
    const upstream = fleet?.stations.find(({ id }) => id === "upstream");
    if (!fleet || !upstream || !empty.briefing.lines)
      throw new Error("16 Nov has its Upstream figure");
    Object.assign(upstream, { count: 0, forks: [], stopped: [], notRead: ["indexer"] });
    fleet.notRead = ["indexer's upstream"];
    empty.briefing.lines = empty.briefing.lines.filter(
      ({ members }) => !members.some(({ station }) => station === "upstream"),
    );
    await render(empty, "#today/yours/upstream");
    expect(station("upstream")?.dataset.kind).toBe("not-read");
    expect(station("upstream")?.title).toBe("Upstream not read on indexer · opens Evidence");
    expect(container.querySelectorAll(".today-not-read")).toHaveLength(1);
    expect(container.querySelector(".today-not-read")?.textContent).toMatch(
      /^⌀ Not read: indexer's upstream/,
    );
    expect(container.querySelector(".today-table-calm")).toBeNull();
    expect(container.querySelector("[role=tabpanel]")?.textContent).not.toMatch(
      /\bNone\b|Nothing|fine|\b0\b/,
    );
    expect(memberIds()).toEqual([]);
  });

  it("a snapshot stored before the flow named its gaps falls back to the figures' forks and counts no lanes", async () => {
    const stored = JSON.parse(snapshot1116);
    const fleet = stored.briefing.today.fleet;
    delete fleet.notRead;
    delete fleet.environment.notRead;
    Object.assign(fleet.environment, { state: "ready", lanes: 2 });
    fleet.stations.find(({ id }: { id: string }) => id === "sync").notRead = ["indexer"];
    await render(ViewSnapshotSchema.parse(stored));
    expect(container.querySelector(".today-not-read")?.textContent).toBe(
      "⌀ Not read: indexer · Evidence ›",
    );
    expect(station("environment")?.textContent).toContain("Ready");
    expect(station("environment")?.textContent).not.toMatch(/lanes? busy/);
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

describe("the fleet flow's four marks", () => {
  const IDS = ["upstream", "sync", "integration", "template", "release", "dependabot", "other"];
  const kinds = () =>
    Object.fromEntries(
      [...IDS, "main", "environment"].map((id) => {
        const cell = station(id) ?? door(id);
        const tone = cell?.className.match(/fleet-cell--(error|warning)/)?.[1];
        return [id, `${cell?.dataset.kind}${tone ? `:${tone}` : ""}`];
      }),
    );
  type Fleet = NonNullable<NonNullable<ViewSnapshot["briefing"]["today"]>["fleet"]>;
  const figures = (body: ViewSnapshot) => {
    const fleet = body.briefing.today?.fleet as Fleet;
    return [...fleet.stations, ...fleet.doors];
  };
  const clear = (body: ViewSnapshot, notRead: string[]) => {
    for (const figure of figures(body))
      Object.assign(figure, {
        count: 0,
        forks: [],
        notRead,
        ...("stopped" in figure
          ? { stopped: [], red: [], inProgress: [], waitingOnClock: [], waitingOnPerson: [] }
          : {}),
      });
    body.briefing.lines = [];
  };

  it.each<[string, (body: ViewSnapshot) => void, Record<string, string>]>([
    [
      "as swept: tinted where Yours holds a row, red over a Blocked row",
      () => {},
      {
        upstream: "filter:error",
        sync: "filter:warning",
        integration: "filter:warning",
        template: "filter:warning",
        release: "link",
        dependabot: "link",
        other: "link",
        main: "plain",
        environment: "link",
      },
    ],
    [
      "no rows: a stopped station with no Blocked row is untinted, its value a link or plain",
      (body) => {
        body.briefing.lines = [];
      },
      {
        upstream: "link",
        sync: "link",
        integration: "plain",
        template: "dot",
        release: "link",
        dependabot: "link",
        other: "link",
        main: "plain",
        environment: "link",
      },
    ],
    [
      "Upstream's rows only waiting: amber, never red",
      (body) => {
        for (const line of body.briefing.lines ?? [])
          if (line.members.some(({ station }) => station === "upstream")) line.section = "waiting";
      },
      { upstream: "filter:warning" },
    ],
    [
      "doors with no target: plain, never a link",
      (body) => {
        for (const figure of body.briefing.today?.fleet?.doors ?? []) delete figure.target;
        body.briefing.lines = [];
      },
      { template: "dot", release: "plain", dependabot: "plain", other: "plain" },
    ],
    [
      "nothing open and every fork read: the dot",
      (body) => clear(body, []),
      Object.fromEntries([...IDS, "main"].map((id) => [id, "dot"])),
    ],
    [
      "nothing counted and a fork not read: ⌀, never the dot",
      (body) => clear(body, ["file"]),
      Object.fromEntries([...IDS, "main"].map((id) => [id, "not-read"])),
    ],
    [
      "Environment's readiness not read: ⌀",
      (body) => {
        const fleet = body.briefing.today?.fleet as Fleet;
        fleet.environment = { state: "unread", version: "v0.35.5", lanes: 2, notRead: [] };
      },
      { environment: "not-read" },
    ],
  ])("%s", async (_, change, expected) => {
    const body = whole();
    change(body);
    await render(body);
    expect(kinds()).toMatchObject(expected);
    expect(station("main")?.tagName).not.toBe("BUTTON");
    for (const id of [...IDS, "main", "environment"]) {
      const cell = station(id) ?? door(id);
      const kind = cell?.dataset.kind;
      expect(cell?.tagName).toBe(
        kind === "filter" ? "BUTTON" : kind === "link" || kind === "not-read" ? "A" : "SPAN",
      );
      if (kind === "filter") expect(cell?.getAttribute("aria-pressed")).toBe("false");
      if (kind === "dot") expect(cell?.querySelector("[aria-label=None]")?.textContent).toBe("·");
      if (kind === "not-read")
        expect(cell?.querySelector("[aria-label='Not read']")?.textContent).toBe("⌀ ›");
    }
    if (body.briefing.today?.fleet?.environment.state === "unread")
      expect(station("environment")?.textContent).not.toMatch(/Ready|✓|lane/);
  });

  it("every value ending in › opens its place, and no → takes focus", async () => {
    const body = whole();
    body.briefing.lines = [];
    const fleet = body.briefing.today?.fleet as Fleet;
    const upstream = fleet.stations.find(({ id }) => id === "upstream");
    if (!upstream) throw new Error("16 Nov has its Upstream figure");
    Object.assign(upstream, { count: 0, forks: [], stopped: [], behind: ["file"] });
    await render(body);
    const values = [...container.querySelectorAll<HTMLElement>(".fleet-cell")].filter((cell) =>
      cell.querySelector(".fleet-go"),
    );
    expect(values.map((cell) => cell.dataset.station ?? cell.dataset.door)).toEqual([
      "upstream",
      "sync",
      "release",
      "dependabot",
      "other",
      "environment",
    ]);
    const opens = async (id: string) => {
      await act(async () => navigate({ kind: "today" }));
      await click(station(id) ?? door(id));
      return route();
    };
    expect(await opens("upstream")).toEqual({ kind: "upstream" });
    expect(await opens("sync")).toEqual({ kind: "today", tab: "forks" });
    expect(await opens("environment")).toEqual({ kind: "environment" });
    for (const id of ["release", "dependabot", "other"]) {
      expect(await opens(id)).toEqual({ kind: "today" });
      const target = fleet.doors.find((figure) => figure.id === id)?.target;
      expect(openSelection()).toEqual({
        kind: "cause",
        id: target?.kind === "cause" ? target.row : "",
      });
    }
    const arrows = [...container.querySelectorAll<HTMLElement>(".fleet-flow *")].filter(
      (element) => element.children.length === 0 && element.textContent === "→",
    );
    expect(arrows.length).toBeGreaterThan(0);
    for (const arrow of arrows) {
      expect(arrow.closest("[aria-hidden=true]")).not.toBeNull();
      expect(arrow.closest("a, button, [tabindex]")).toBeNull();
    }
  });

  it("a Sync PR value with forks not read opens Forks, and its ⌀ chip opens Evidence", async () => {
    const body = whole();
    body.briefing.lines = [];
    const sync = body.briefing.today?.fleet?.stations.find(({ id }) => id === "sync");
    if (!sync) throw new Error("16 Nov has its Sync PR figure");
    sync.notRead = ["file", "indexer"];
    await render(body);
    expect(station("sync")?.dataset.kind).toBe("link");
    expect(value("sync")).toBe(`${sync.count} open ›`);
    expect(chip("sync")?.title).toBe("Sync PR not read on file and indexer · opens Evidence");
    await click(station("sync"));
    expect(route()).toEqual({ kind: "today", tab: "forks" });
    await act(async () => navigate({ kind: "today" }));
    await click(chip("sync"));
    expect(route()?.kind).toBe("evidence");
  });

  it("a tinted value with a gap keeps its filter and its chip, and says so when pressed", async () => {
    const body = whole();
    const sync = body.briefing.today?.fleet?.stations.find(({ id }) => id === "sync");
    if (!sync) throw new Error("16 Nov has its Sync PR figure");
    sync.notRead = ["file"];
    await render(body, "#today/yours/sync");
    expect(station("sync")?.getAttribute("aria-pressed")).toBe("true");
    expect(station("sync")?.title).toMatch(/\nPress again to show all$/);
    expect(chip("sync")).not.toBeNull();
    await click(station("sync"));
    expect(route()).toEqual({ kind: "today" });
  });

  it.each([
    [
      { state: "ready", version: "v0.35.5", lanes: 1, notRead: [] },
      ["✓ Ready ›", "v0.35.5 · 1 lane busy"],
      null,
    ],
    [
      { state: "ready", version: "v0.35.5", lanes: 0, notRead: ["partition"] },
      ["✓ Ready ›", "v0.35.5"],
      "Deployments not read on partition · opens Evidence",
    ],
    [{ state: "maintenance", notRead: [] }, ["Maintenance ›", undefined], null],
  ] as const)("Environment %j reads %j", async (environment, words, gap) => {
    const body = whole();
    const fleet = body.briefing.today?.fleet as Fleet;
    fleet.environment = structuredClone(environment) as unknown as Fleet["environment"];
    await render(body);
    expect(readout("environment")).toEqual(words);
    expect(chip("environment")?.title ?? null).toBe(gap);
    await click(station("environment"));
    expect(route()).toEqual({ kind: "environment" });
  });
});

describe("Forks on the 16 Nov sweep", () => {
  const fork = (name: string) => section("forks")?.querySelector(`tr[data-fork="${name}"]`);
  const rowNames = () =>
    [...(section("forks")?.querySelectorAll<HTMLElement>("tr[data-fork]") ?? [])].map(
      ({ dataset }) => dataset.fork,
    );
  const fold = () => section("forks")?.querySelector(".forks-fold");

  it("shows exactly the forks with Yours rows in fleet order and folds the rest", async () => {
    const body = whole();
    const owned = new Set(todayMembers(body.briefing).map(({ member }) => member.fork));
    const ordered = body.services?.map(({ service }) => service) ?? [];
    const busy = ordered.filter((name) => owned.has(name));
    const rest = ordered.filter((name) => !owned.has(name));
    await render(body, "#today/forks");
    expect(rowNames()).toEqual(busy);
    expect(fold()?.textContent).toBe("▸ 1 release-only fork · oldest 8h on file");
    await click(fold());
    expect(rowNames()).toEqual([...busy, ...rest]);
    await click(fold());
    expect(rowNames()).toEqual(busy);
  });

  it("takes station words from Service Home", async () => {
    const body = whole();
    await render(body, "#today/forks");
    await click(fold());
    for (const { service, home } of body.services ?? []) {
      const row = fork(service);
      for (const { id, word } of home?.stations ?? [])
        expect(row?.querySelector(`[data-column="${id}"] .forks-reading`)?.textContent).toContain(
          word,
        );
      expect(row?.querySelector(".sidebar-mark")).toBeNull();
    }
  });

  it("rounds the Release PR age to the nearest day", async () => {
    await render(loadFixture("snapshot-1106.json"), "#today/forks");
    expect(fork("storage")?.querySelector('[data-column="release"]')?.textContent).toBe("2d›");
  });

  it("discloses a fork's exact Yours members and Can wait facts, and opens its service from its name", async () => {
    const body = whole();
    const name = "indexer";
    await render(body, "#today/forks");
    const expander = fork(name)?.querySelector<HTMLButtonElement>(
      `button[aria-label="Expand ${name} details"]`,
    );
    const link = fork(name)?.querySelector<HTMLButtonElement>("th button");
    await click(expander);
    expect(route()).toEqual({ kind: "today", tab: "forks" });
    expect(expander?.getAttribute("aria-expanded")).toBe("true");
    const detail = fork(name)?.nextElementSibling;
    const members = todayMembers(body.briefing).filter(({ member }) => member.fork === name);
    expect(members.length).toBeGreaterThan(0);
    expect(
      [...(detail?.querySelectorAll<HTMLElement>("[data-member]") ?? [])].map(
        ({ dataset }) => dataset.member,
      ),
    ).toEqual(members.map(({ member }) => member.id));
    expect(detail?.textContent).toContain("Can wait");
    const facts = [...(detail?.querySelectorAll(".forks-can-wait li") ?? [])];
    expect(
      facts.find(({ textContent }) => textContent?.startsWith("Release PRs"))?.textContent,
    ).toMatch(/^Release PRsPR #\d+/);
    expect(
      facts.find(({ textContent }) => textContent?.startsWith("Dependabot PRs"))?.textContent,
    ).toBe("Dependabot PRs3");
    await click(expander);
    expect(expander?.getAttribute("aria-expanded")).toBe("false");
    await click(link);
    expect(route()).toEqual({ kind: "service", id: name });
  });

  it("draws a request dashed and pending before a sweep holds it, then solid and owned once", async () => {
    const swept = whole();
    const found = todayMembers(swept.briefing).find(
      ({ member }) => member.primary?.kind === "pr" || member.primary?.kind === "mr",
    );
    if (!found?.member.primary) throw new Error("Fixture needs a request row");
    const { member } = found;
    const primary = found.member.primary;
    const unswept: ViewSnapshot = JSON.parse(JSON.stringify(swept), (_key, value) =>
      value === primary.url ? primary.url.replace(/\d+\/?$/, "1$&") : value,
    );
    const thread = (id: string, url: string, title: string) => ({
      id,
      thread: {
        scope: member.fork,
        title,
        request: {
          forge: primary.kind === "mr" ? ("gitlab" as const) : ("github" as const),
          repository: "fixture/repository",
          requestNumber: 42,
          url,
        },
      },
      status: "Open" as const,
      sequence: 1,
      updatedAt: 1,
      settledAt: null,
      done: false,
    });
    threadStore.setState({
      threads: [
        thread("request-thread", primary.url, "Fix the request"),
        thread("other-thread", "https://github.com/fixture/elsewhere/pull/7", "Elsewhere"),
      ],
    });
    const marks = (scope: ParentNode = container) => ({
      pending: scope.querySelectorAll(`[data-state="pending"][data-request="${primary.url}"]`)
        .length,
      owned: scope.querySelectorAll(`[data-state="owned"][data-request="${primary.url}"]`).length,
    });
    const openFork = async () =>
      click(
        fork(member.fork)?.querySelector<HTMLButtonElement>(
          `button[aria-label="Expand ${member.fork} details"]`,
        ),
      );

    const swap = await render(unswept);
    expect(marks()).toEqual({ pending: 1, owned: 0 });
    const pending = container.querySelector(`[data-request="${primary.url}"]`);
    expect(pending?.textContent).toContain("pending · not yet in a sweep");
    expect(pending?.closest("[data-section]")).toBeNull();
    expect(memberIds()).toEqual(todayMembers(unswept.briefing).map(({ member }) => member.id));
    await click(pending?.querySelector("button"));
    expect(window.location.hash).toBe("#thread/request-thread");

    window.location.hash = "#today";
    await swap(swept);
    expect(marks()).toEqual({ pending: 0, owned: 1 });
    expect(
      container.querySelector(`[data-item-id="${member.id}"] [data-state="owned"]`),
    ).not.toBeNull();
    expect(container.querySelectorAll('[data-state="pending"]')).toHaveLength(1);

    window.location.hash = "#today/forks";
    await swap(unswept);
    await openFork();
    const sheet = () => fork(member.fork)?.nextElementSibling ?? undefined;
    expect(marks(sheet())).toEqual({ pending: 1, owned: 0 });
    await swap(swept);
    expect(marks(sheet())).toEqual({ pending: 0, owned: 1 });
    expect(
      sheet()?.querySelector(`[data-member="${member.id}"] [data-state="owned"]`),
    ).not.toBeNull();
  });

  it("marks a swept Can wait PR owned on its entry, on Today and the Forks sheet", async () => {
    const swept = whole();
    const url = "https://github.com/Azure/osdu-spi-search/pull/71";
    const cause = swept.briefing.today?.causes?.rows.find(
      ({ kind, forks }) =>
        kind === "other" && forks.some(({ objects }) => objects.some((o) => o.url === url)),
    );
    if (!cause) throw new Error("16 Nov has Search #71 under Other PRs");
    expect(todayMembers(swept.briefing).some(({ member }) => member.primary?.url === url)).toBe(
      false,
    );
    const unswept: ViewSnapshot = JSON.parse(JSON.stringify(swept), (_key, value) =>
      value === url ? `${url.slice(0, -2)}171` : value,
    );
    threadStore.setState({
      threads: [
        {
          id: "governance-thread",
          thread: {
            scope: "search",
            title: "Declare governance inputs",
            request: {
              forge: "github",
              repository: "Azure/osdu-spi-search",
              requestNumber: 71,
              url,
            },
          },
          status: "Open",
          sequence: 1,
          updatedAt: 1,
          settledAt: null,
          done: false,
        },
      ],
    });
    const marks = (scope: ParentNode | null | undefined) => ({
      pending: scope?.querySelectorAll(`[data-state="pending"][data-request="${url}"]`).length ?? 0,
      owned: scope?.querySelectorAll(`[data-state="owned"][data-request="${url}"]`).length ?? 0,
    });
    const causeRow = () =>
      container.querySelector(`tr.today-row--cause[data-row=${JSON.stringify(cause.id)}]`);
    const reading = () => ({
      members: memberIds(),
      count: causeRow()?.querySelector(".today-row-age")?.textContent,
    });

    const swap = await render(unswept);
    await click(causeRow()?.querySelector(".today-row-what button"));
    expect(marks(container)).toEqual({ pending: 1, owned: 0 });
    const before = reading();
    await swap(swept);
    expect(marks(container)).toEqual({ pending: 0, owned: 1 });
    const entry = causeRow()
      ?.nextElementSibling?.querySelector('[data-fork="search"]')
      ?.closest("[data-cause-entry]");
    expect(marks(entry)).toEqual({ pending: 0, owned: 1 });
    expect(reading()).toEqual(before);

    window.location.hash = "#today/forks";
    await swap(unswept);
    await click(
      fork("search")?.querySelector<HTMLButtonElement>(
        'button[aria-label="Expand search details"]',
      ),
    );
    const sheet = () => fork("search")?.nextElementSibling;
    expect(marks(sheet())).toEqual({ pending: 1, owned: 0 });
    await swap(swept);
    expect(marks(sheet())).toEqual({ pending: 0, owned: 1 });
    expect(marks(sheet()?.querySelector(".forks-can-wait"))).toEqual({ pending: 0, owned: 1 });
  });

  it("presses a station on Forks and dims all the other reading columns", async () => {
    const body = whole();
    await render(body, "#today/forks");
    await click(station("sync"));
    expect(route()).toEqual({ kind: "today", tab: "forks", station: "sync" });
    expect(station("sync")?.getAttribute("aria-pressed")).toBe("true");
    const columns = [...(section("forks")?.querySelectorAll<HTMLElement>("[data-column]") ?? [])];
    expect(columns.length).toBeGreaterThan(8);
    for (const column of columns)
      expect(column.hasAttribute("data-dim")).toBe(column.dataset.column !== "sync");
    await click(container.querySelector(".today-filter button"));
    expect(section("forks")?.querySelector("[data-dim]")).toBeNull();
  });

  it.each([
    { gap: "Main and the service mark", blank: "main", release: "8h" },
    { gap: "a door with a known service count", blank: "dependabot", release: "8h" },
    { gap: "the release age", blank: "release", release: "" },
    { gap: "the age of a Release PR outside the door count", blank: "release", release: "" },
    { gap: "the home", blank: "main", release: "" },
  ])("keeps the fork visible with one mark when missing $gap", async ({ gap, blank, release }) => {
    const body = whole();
    const fleet = body.briefing.today?.fleet;
    const service = body.services?.find((service) => service.service === "file");
    const home = service?.home;
    const main = fleet?.stations.find(({ id }) => id === "main");
    const other = home?.doors.find(({ id }) => id === "other");
    const template = home?.doors.find(({ id }) => id === "template");
    const dependabot = home?.doors.find(({ id }) => id === "dependabot");
    if (!service || !home?.releasePr || !main || !other || !template || !dependabot)
      throw new Error("Fixture needs file's readings");

    if (gap === "Main and the service mark") {
      main.notRead.push("file");
      home.mark = { kind: "unread" };
      delete home.openPrTotal;
    } else if (gap === "a door with a known service count") {
      const pr = { number: 67, url: `${home.releasePr.url}/67` };
      Object.assign(other, { count: null, prs: [pr] });
      Object.assign(template, { count: 1, prs: [pr] });
      dependabot.count = null;
      home.mark = { kind: "count", count: 2, tone: "warning" };
    } else if (blank === "release") {
      delete home.releasePr.age;
      if (gap !== "the release age") {
        const door = home.doors.find(({ id }) => id === "release");
        if (!door) throw new Error("Fixture needs the Release door");
        Object.assign(door, { count: 0, prs: [] });
      }
    } else {
      delete service.home;
    }
    await render(body, "#today/forks");
    const row = fork("file");
    const cell = (column: string) => row?.querySelector(`[data-column="${column}"]`)?.textContent;
    expect(row?.closest('tbody[data-fork-group="unread"]')).not.toBeNull();
    expect(fold()).toBeNull();
    expect(row?.textContent?.match(/⌀/g)).toHaveLength(1);
    expect(
      row?.querySelector('[title="Not read. Showing what the last read held."]'),
    ).not.toBeNull();
    expect(cell(blank)).toBe("");
    expect(cell("release")).toBe(release && `${release}›`);
    expect(row?.textContent).not.toMatch(/\b0\b/);
    if (gap !== "the home") {
      expect(cell("upstream")).toContain("Sync current");
      expect(cell("sync")).toContain("None open");
    }
    if (blank === "main") expect(row?.textContent).not.toContain("Green");
    expect(row?.textContent).not.toContain("release-only");
    if (gap === "a door with a known service count") {
      expect(cell("other")).toBe("1");
      expect(cell("template")).toBe("PR #67");
    }
    await click(row?.querySelector("button[aria-expanded]"));
    expect(row?.nextElementSibling?.textContent).toContain("Not read on file");
    expect(row?.nextElementSibling?.textContent).not.toMatch(/Nothing waiting on you|⌀/);
  });

  it("shows a dot at an empty door on a fully read fork", async () => {
    await render(whole(), "#today/forks");
    await click(fold());
    const file = fork("file");
    expect(file?.querySelector('[data-column="other"]')?.textContent).toBe("·");
    await click(file?.querySelector("button[aria-expanded]"));
    expect(file?.nextElementSibling?.textContent).toContain("Nothing waiting on you.");
  });

  /** A fork outside Yours as read as file: every station quiet, holding one release PR or none. */
  function addQuiet(body: ViewSnapshot, name: string, age?: string) {
    const file = body.services?.find(({ service }) => service === "file");
    const fleet = body.briefing.today?.fleet;
    if (!file?.home || !fleet) throw new Error("Fixture needs file's home and the fleet");
    const home = structuredClone(file.home);
    if (age && home.releasePr) home.releasePr.age = age;
    else {
      delete home.releasePr;
      for (const door of home.doors)
        if (door.id === "release") Object.assign(door, { count: 0, prs: [] });
    }
    body.services?.push({ ...structuredClone(file), service: name, home });
    fleet.forks.rest.forks.push(name);
  }
  const fileHome = (body: ViewSnapshot) => {
    const home = body.services?.find(({ service }) => service === "file")?.home;
    if (!home) throw new Error("Fixture needs file's home");
    return home;
  };
  const fileDoor = (body: ViewSnapshot, id: string) => {
    const door = fileHome(body).doors.find((door) => door.id === id);
    if (!door) throw new Error(`Fixture needs file's ${id} door`);
    return door;
  };
  const fileStation = (body: ViewSnapshot, id: string) => {
    const station = fileHome(body).stations.find((station) => station.id === id);
    if (!station) throw new Error(`Fixture needs file's ${id} station`);
    return station;
  };

  it.each<{ case: string; edit: (body: ViewSnapshot) => void; group?: string; fold?: string }>([
    { case: "a release PR only", edit: () => {}, fold: "1 release-only fork · oldest 8h on file" },
    {
      case: "nothing at all",
      edit: (body) => {
        delete fileHome(body).releasePr;
        Object.assign(fileDoor(body, "release"), { count: 0, prs: [] });
        const figure = body.briefing.today?.fleet?.forks.rest.doors.find(
          ({ id }) => id === "release",
        );
        if (figure) Object.assign(figure, { count: 0, forks: [] });
      },
      fold: "1 fork with nothing waiting on you · no open PRs",
    },
    {
      case: "release-only forks, naming the oldest",
      edit: (body) => addQuiet(body, "alpha", "12d 3h"),
      fold: "2 release-only forks · oldest 12d on alpha",
    },
    {
      case: "release-only forks aged in hours and minutes",
      edit: (body) => addQuiet(body, "alpha", "25m"),
      fold: "2 release-only forks · oldest 8h on file",
    },
    {
      case: "release-only forks aged in seconds and minutes",
      edit: (body) => {
        const pr = fileHome(body).releasePr;
        if (!pr) throw new Error("Fixture needs file's release PR");
        pr.age = "40s";
        addQuiet(body, "alpha", "25m");
      },
      fold: "2 release-only forks · oldest 25m on alpha",
    },
    {
      case: "a release-only fork beside an empty one",
      edit: (body) => addQuiet(body, "alpha"),
      fold: "2 forks with nothing waiting on you · 1 release PR",
    },
    {
      case: "a Dependabot PR",
      edit: (body) => Object.assign(fileDoor(body, "dependabot"), { count: 1 }),
      group: "holding",
    },
    {
      case: "a template sync PR",
      edit: (body) => {
        const door = fileDoor(body, "template");
        Object.assign(door, {
          count: 1,
          prs: [{ number: 9, url: "https://github.com/x/y/pull/9" }],
        });
      },
      group: "holding",
    },
    {
      case: "changes to sync",
      edit: (body) =>
        Object.assign(fileStation(body, "upstream"), {
          state: "waiting-on-clock",
          word: "4 behind",
        }),
      group: "holding",
    },
    {
      case: "an open sync PR on a ready station",
      edit: (body) =>
        Object.assign(fileStation(body, "sync"), {
          pr: { number: 3, url: "https://github.com/x/y/pull/3" },
        }),
      group: "holding",
    },
    {
      case: "a stopped Main",
      edit: (body) => Object.assign(fileStation(body, "main"), { state: "stopped", word: "Red" }),
      group: "holding",
    },
    {
      case: "a row in Yours",
      edit: (body) => {
        const forks = body.briefing.today?.fleet?.forks;
        if (!forks) throw new Error("Fixture needs the fleet");
        forks.yours.push("file");
        forks.rest.forks = [];
      },
      group: "yours",
    },
    {
      case: "Yours rows core left in the rest",
      edit: (body) => {
        const forks = body.briefing.today?.fleet?.forks;
        if (!forks) throw new Error("Fixture needs the fleet");
        forks.yours = forks.yours.filter((fork) => fork !== "partition");
        forks.rest.forks.unshift("partition");
        addQuiet(body, "alpha", "2d");
        const partition = body.services?.find(({ service }) => service === "partition");
        const alpha = body.services?.find(({ service }) => service === "alpha");
        if (!partition || !alpha?.home) throw new Error("Fixture needs partition");
        partition.home = structuredClone(alpha.home);
      },
      group: "holding",
    },
    {
      case: "no home",
      edit: (body) => {
        const file = body.services?.find(({ service }) => service === "file");
        if (file) delete file.home;
      },
      group: "unread",
    },
    {
      case: "an unread door",
      edit: (body) => Object.assign(fileDoor(body, "dependabot"), { count: null }),
      group: "unread",
    },
    {
      case: "a station not read",
      edit: (body) =>
        body.briefing.today?.fleet?.stations
          .find(({ id }) => id === "integration")
          ?.notRead.push("file"),
      group: "unread",
    },
  ])(
    "a fork holding $case is folded or shown",
    async ({ case: name, edit, group, fold: words }) => {
      const body = whole();
      edit(body);
      await render(body, "#today/forks");
      if (name === "Yours rows core left in the rest") {
        expect(fork("partition")?.closest("tbody")?.dataset.forkGroup).toBe("holding");
        expect(fold()?.textContent).toBe("▸ 2 release-only forks · oldest 2d on alpha");
        return;
      }
      if (group) {
        expect(fork("file")?.closest("tbody")?.dataset.forkGroup).toBe(group);
        expect(fold()).toBeNull();
        expect(section("forks")?.textContent).not.toContain("release-only");
        return;
      }
      expect(fork("file")).toBeNull();
      expect(fold()?.textContent).toBe(`▸ ${words}`);
      await click(fold());
      expect(fork("file")?.closest("tbody")?.dataset.forkGroup).toBe("quiet");
    },
  );

  it("names each chevron for its fork, and only a value ending in › navigates", async () => {
    await render(whole(), "#today/forks");
    await click(fold());
    const rows = [...(section("forks")?.querySelectorAll<HTMLElement>("tr[data-fork]") ?? [])];
    expect(rows.length).toBe(13);
    for (const row of rows) {
      const chevron = row.querySelector(".forks-toggle");
      expect(chevron?.getAttribute("aria-label")).toBe(`Expand ${row.dataset.fork} details`);
      expect(chevron?.getAttribute("aria-expanded")).toBe("false");
    }
    const cells = [
      ...(section("forks")?.querySelectorAll<HTMLElement>("tbody [data-column]") ?? []),
    ];
    const going = cells.filter((cell) => cell.textContent?.endsWith("›"));
    expect(going.length).toBeGreaterThan(0);
    for (const cell of cells)
      expect(cell.querySelector("button") !== null).toBe(cell.textContent?.endsWith("›"));
    await click(going[0]?.querySelector("button"));
    expect(route()).toEqual({ kind: "releases" });
  });

  it.each([true, false])("shows the open PR total when one is held (%s)", async (held) => {
    const body = whole();
    const homes = body.services?.map(({ home }) => home).filter((home) => home !== undefined) ?? [];
    const total = homes[0]?.openPrTotal;
    if (total === undefined) throw new Error("Fixture needs a known PR total");
    for (const home of held ? homes.slice(1) : homes) delete home.openPrTotal;
    await render(body, "#today/forks");
    expect(section("forks")?.querySelector(".today-section-count")?.textContent).toBe(
      held ? `${total} open pull requests` : "⌀ not read",
    );
  });

  it("keeps the dot for a read empty door and blanks an unread empty door on an unread fork", async () => {
    const body = whole();
    const home = body.services?.find(({ service }) => service === "file")?.home;
    const dependabot = home?.doors.find(({ id }) => id === "dependabot");
    if (!home || !dependabot) throw new Error("Fixture needs file's home and Dependabot door");
    home.mark = { kind: "unread" };
    dependabot.count = null;
    await render(body, "#today/forks");
    expect(fold()).toBeNull();
    const file = fork("file");
    expect(file?.closest("[data-fork-group]")?.getAttribute("data-fork-group")).toBe("unread");
    expect(file?.querySelector('[data-column="other"]')?.textContent).toBe("·");
    expect(file?.querySelector('[data-column="dependabot"]')?.textContent).toBe("");
  });
});

describe("Can wait by cause", () => {
  const current = () => loadFixture("snapshot-1106.json");
  const causeRow = (id: string) =>
    container.querySelector<HTMLElement>(`tr.today-row--cause[data-row=${JSON.stringify(id)}]`);

  it("draws one row per cause, each opening into its forks one at a time", async () => {
    const snapshot = current();
    await render(snapshot);
    const rows = snapshot.briefing.today?.causes?.rows ?? [];
    expect(
      [...container.querySelectorAll<HTMLElement>("tr.today-row--cause")].map(
        (tr) => tr.dataset.row,
      ),
    ).toEqual(rows.map(({ id }) => id));
    const release = rows.find(({ kind }) => kind === "release");
    if (!release) throw new Error("6 Nov has its Release cause");
    await click(causeRow(release.id)?.querySelector(".today-row-what button"));
    expect(openSelection()).toEqual({ kind: "cause", id: release.id });
    const body = causeRow(release.id)?.nextElementSibling;
    const forks = [...(body?.querySelectorAll(".today-cause-forks > *") ?? [])];
    expect(forks).toHaveLength(release.forkCount);
    expect(body?.querySelectorAll(".today-cause-outside [data-cause-entry]")).toHaveLength(1);
    await click(
      causeRow(rows.find(({ kind }) => kind === "other")?.id ?? "")?.querySelector(
        ".today-row-what button",
      ),
    );
    expect(opened()).toHaveLength(1);
    await press("Escape");
    expect(opened()).toHaveLength(0);
  });

  it.each([
    { repositories: ["osdu-spi"], subject: "osdu-spi", prs: 2 },
    { repositories: ["osdu-spi", "osdu-spi-stack"], subject: "2 repositories", prs: 3 },
  ])(
    "counts and opens program-only Can wait work for $subject",
    async ({ repositories, subject, prs }) => {
      const snapshot = current();
      const release = snapshot.briefing.today?.causes?.rows.find(({ kind }) => kind === "release");
      const program = release?.forks.find(({ group }) => group === "program");
      const pull = program?.objects[0];
      if (!release || !program || !pull) throw new Error("6 Nov has a program release PR");
      release.forks = repositories.map((fork, index) => {
        const objects = [{ ...pull, id: fork }];
        if (index === 0) objects.push({ ...pull, id: `${fork}:second` });
        return { ...program, fork, count: objects.length, objects };
      });
      release.forkCount = 0;
      release.count = prs;
      await render(snapshot);
      const row = causeRow("release");
      expect(row?.querySelector(".today-row-fork")?.textContent).toBe(subject);
      expect(row?.querySelector(".today-row-age")?.textContent).toContain(`${prs} PRs`);
      expect(row?.dataset.forkCount).toBe("0");
      await click(row?.querySelector(".today-row-what button"));
      const body = row?.nextElementSibling;
      expect(body?.textContent).not.toContain("Outside the forks");
      expect(
        [...(body?.querySelectorAll("[data-cause-entry]") ?? [])].map(
          (entry) => entry.textContent?.split(" ")[0],
        ),
      ).toEqual(repositories);
    },
  );

  it("a fork pill opens its service page with the row holding its object, else the cause's place", async () => {
    await render(current());
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
    await click(pill("osdu-spi"));
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
    body.briefing.lines = [];
    await render(body);
    for (const entry of doors) expect(door(entry.id)?.tagName).toBe("SPAN");
  });

  it("a cause kind core could not read says so, never zero", async () => {
    const body = current();
    const summary = body.briefing.today;
    if (!summary?.causes) throw new Error("16 Nov has its causes");
    summary.causes.rows = summary.causes.rows.filter(({ kind }) => kind !== "dependabot");
    summary.causes.notRead.dependabot = ["indexer", "search"];
    summary.causes.notRead.release = ["legal"];
    const release = summary.causes.rows.find(({ id }) => id === "release");
    const fork = release?.forks.find(({ fork }) => fork === "legal");
    if (!release || !fork) throw new Error("6 Nov has a release PR for legal");
    fork.notRead = true;
    release.count -= fork.count;
    release.forkCount--;
    await render(body);
    expect(container.querySelector("[data-unread=dependabot]")?.textContent).toMatch(
      /^⌀ Dependabot PRs not read on indexer, search\./,
    );
    expect(causeRow("release")?.querySelector(".today-row-gaps")?.getAttribute("title")).toBe(
      "legal",
    );
    await click(causeRow("release")?.querySelector(".today-row-what button"));
    expect(container.querySelector(".today-cause-unread [data-fork=legal]")).not.toBeNull();
    expect(container.querySelector(".today-cause-forks [data-fork=legal]")).toBeNull();
  });

  it.each([
    [0, 1],
    [2, 0],
    [3, 4],
  ])("shows only the nonzero remainders (%i Blocked, %i Waiting)", async (blocked, waiting) => {
    const snapshot = current();
    const release = snapshot.briefing.today?.causes?.rows.find(({ id }) => id === "release");
    if (!release) throw new Error("6 Nov has its Release cause");
    release.remainder = { blocked, waiting };
    await render(snapshot);
    await click(causeRow("release")?.querySelector(".today-row-what button"));
    const body = causeRow("release")?.nextElementSibling;
    expect(body?.querySelector("[data-remainder=blocked]")?.textContent).toBe(
      blocked ? `${blocked} more in Blocked` : undefined,
    );
    expect(body?.querySelector("[data-remainder=waiting]")?.textContent).toBe(
      waiting ? `${waiting} more in Waiting on you` : undefined,
    );
  });
});
