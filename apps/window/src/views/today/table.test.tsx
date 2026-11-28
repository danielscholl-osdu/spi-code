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
/** Every member Yours draws, a collapsed group's members by its row's data-member-ids. */
const memberIds = () =>
  [
    ...container.querySelectorAll<HTMLElement>(
      "[data-section] tr.today-row:not(.today-row--sub):is([data-item-id], [data-member-ids])",
    ),
  ].flatMap(({ dataset }) =>
    dataset.itemId ? [dataset.itemId] : (dataset.memberIds?.split(" ") ?? []),
  );
const expand = (lineId: string) => click(row(lineId).querySelector(".today-row-what button"));
const station = (id: string) =>
  container.querySelector<HTMLElement>(`.fleet-cell[data-station=${id}]`);
const door = (id: string) => container.querySelector<HTMLElement>(`.fleet-cell[data-door=${id}]`);
const tab = (id: string) => container.querySelector<HTMLElement>(`[data-today-tab=${id}]`);
const route = () => parseRoute(window.location.hash);
const chips = (id: string) =>
  [...(tab(id)?.querySelectorAll<HTMLElement>(".today-tab-count") ?? [])].map(
    (chip) => `${chip.dataset.tone} ${chip.textContent}`,
  );
const headCount = (id: string) =>
  section(id)?.querySelector(".today-section-head .today-section-count")?.textContent;
const scope = () => container.querySelector(".today-tabrow .today-filter-scope")?.textContent;
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
  expect(container.querySelectorAll("tr.today-row--sub")).toHaveLength(0);
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
  await expand("waiting:blocker:stack:lanes:gate2");
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
  expect(chips("yours")).toEqual(["bad 1 blocked", "warn 26 waiting"]);
  await expand(group.id);
  for (const member of group.members) {
    expect(todayRowOf(lines, member.id)).toEqual({ kind: "item", id: member.id });
    expect(row(group.id, member.id).querySelector(".today-row-open a")?.getAttribute("href")).toBe(
      member.primary?.url,
    );
  }
  await act(async () => navigate({ kind: "today", station: "template" }));
  expect(row(group.id).dataset.memberIds?.split(" ")).toEqual(group.members.map(({ id }) => id));
  expect(todayRowOf(lines, "rollout")).toEqual({ kind: "line", id: group.id });
  await click(row(group.id).querySelector(".today-row-what button"));
  expect(
    [...container.querySelectorAll<HTMLElement>(`[data-line="${group.id}"] [data-item-id]`)].map(
      ({ dataset }) => dataset.itemId,
    ),
  ).toEqual(group.members.map(({ id }) => id));
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
  expect(storage.querySelector(".today-row-gaps")?.textContent).toBe("⌀ 1 ›");
  expect(storage.querySelector(".today-row-gaps")?.getAttribute("aria-label")).toMatch(
    / not read, open Evidence$/,
  );
  await click(storage.querySelector(".today-row-gaps"));
  expect(opened()).toHaveLength(0);
  expect(route()).toMatchObject({
    kind: "evidence",
    from: { kind: "today" },
    selection: { kind: "item", id: "gate2:storage" },
  });

  await act(async () => navigate({ kind: "today" }));
  const group = row("waiting:blocker:stack:lanes:gate2");
  expect(group.querySelector(".today-row-gaps")?.textContent).toBe("⌀ 1 ›");
  await expand("waiting:blocker:stack:lanes:gate2");
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
  await expand("waiting:upgrade:os-core-common");
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

it("a deadline is a chip on its row, red in Blocked and amber in Waiting on you, with its reason", async () => {
  const body = nov16();
  const waiting = body.briefing.lines?.find(({ id }) => id === "waiting:release-approval");
  const halt = body.briefing.lines?.find(({ id }) => id === "blocked:halt:crs-conversion");
  if (!waiting || !halt?.deadline) throw new Error("16 Nov has a halt with a deadline");
  waiting.deadline = { at: "2026-11-17T02:00:00Z", reason: "Dispatch before the scheduled sync" };
  await render(body);
  const chip = row(halt.id).querySelector(".today-row-what .today-row-due");
  expect(chip?.getAttribute("data-tone")).toBe("error");
  expect(chip?.getAttribute("aria-label")).toBe(timedText(halt.deadline.reason, { hint: false }));
  expect(chip?.getAttribute("data-tip")).toBe(chip?.getAttribute("aria-label"));
  expect(chip?.getAttribute("tabindex")).toBe("0");
  expect(chip?.textContent).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d\d:\d\d$/);
  const amber = row(waiting.id).querySelector(".today-row-due");
  expect(amber?.getAttribute("data-tone")).toBe("warning");
  expect(amber?.getAttribute("aria-label")).toBe("Dispatch before the scheduled sync");
  expect(row("blocked:sync-run:indexer").querySelector(".today-row-due")).toBeNull();
});

it("a group stays collapsed and names its forks; one chevron button opens it, and one row at a time", async () => {
  await render();
  const group = lines.find(({ id }) => id === "waiting:blocker:stack:lanes:gate2");
  if (!group) throw new Error("16 Nov has the red lanes group");
  const head = row(group.id);
  const button = head.querySelector(".today-row-what button");
  expect(head.querySelectorAll(".today-row-what button")).toHaveLength(1);
  expect(button?.querySelector(".today-row-chevron svg")).not.toBeNull();
  expect(button?.textContent).toBe(group.headline);
  expect(button?.getAttribute("aria-expanded")).toBe("false");
  expect(head.querySelector(".today-row-forks")?.textContent).toBe(
    [...new Set(group.members.map(({ fork }) => fork))].join(", "),
  );
  expect(container.querySelectorAll(`tr.today-row--sub[data-line-id="${group.id}"]`)).toHaveLength(
    0,
  );
  await click(button);
  expect(button?.getAttribute("aria-expanded")).toBe("true");
  expect(head.querySelector(".today-row-forks")).toBeNull();
  const after = [...container.querySelectorAll(`[data-line="${group.id}"] tr`)];
  expect(after[0]).toBe(head);
  expect(after[1]?.classList.contains("today-row-body")).toBe(true);
  expect(after.slice(2).map((tr) => (tr as HTMLElement).dataset.itemId)).toEqual(
    group.members.map(({ id }) => id),
  );
  const halt = row("blocked:halt:crs-conversion");
  await click(halt.querySelector(".today-row-what button"));
  expect(opened()).toHaveLength(1);
  expect(bodyAfter(halt)).not.toBeNull();
  expect(container.querySelectorAll(`tr.today-row--sub[data-line-id="${group.id}"]`)).toHaveLength(
    0,
  );
  expect(button?.getAttribute("aria-expanded")).toBe("false");
});

it("a cause the read proved follows the headline in muted text", async () => {
  const body = loadFixture("snapshot-bad.json");
  const line = body.briefing.lines?.find(({ proved }) => proved);
  if (!line?.proved) throw new Error("The bad morning reads a failed check");
  await render(body);
  const what = row(line.id).querySelector(".today-row-what");
  expect(what?.querySelector("button")?.nextElementSibling?.className).toBe("today-row-proved");
  expect(what?.querySelector(".today-row-proved")?.textContent).toBe(line.proved);
  expect(container.querySelectorAll(".today-row-proved")).toHaveLength(
    body.briefing.lines?.filter(({ proved }) => proved).length ?? 0,
  );
});

describe("a new dot marks a row only against a seen time", () => {
  const morning = (basis: TodaySummary["history"]["basis"], since?: string) => {
    const body = nov16();
    const today = body.briefing.today;
    if (!today) throw new Error("16 Nov has a summary");
    today.history = {
      ...today.history,
      basis,
      from: "2026-11-16T08:00:00Z",
      ...(basis === "stale" ? { asOf: "2026-11-16T08:00:00Z" } : { asOf: undefined }),
    };
    if (basis !== "stale") delete today.history.asOf;
    for (const line of body.briefing.lines ?? [])
      for (const member of line.members) {
        delete member.since;
        if (since && line.id === "blocked:halt:crs-conversion") member.since = since;
      }
    return body;
  };
  const dots = () => [...container.querySelectorAll(".today-row-new")];

  it("seen with a later since gives the dot, named for the time", async () => {
    await render(morning("seen", "2026-11-16T09:00:00Z"));
    expect(dots()).toHaveLength(1);
    expect(row("blocked:halt:crs-conversion").querySelector(".today-row-new")).not.toBeNull();
    expect(dots()[0]?.getAttribute("aria-label")).toMatch(/^New since /);
  });

  it.each(["fallback", "stale", "history-short"] as const)("%s gives none", async (basis) => {
    await render(morning(basis, "2026-11-16T09:00:00Z"));
    expect(dots()).toHaveLength(0);
  });

  it("an earlier since, or a member with no since, is never new", async () => {
    await render(morning("seen", "2026-11-16T07:00:00Z"));
    expect(dots()).toHaveLength(0);
    await unmount();
    container.remove();
    await render(morning("seen"));
    expect(dots()).toHaveLength(0);
  });
});

describe("a rollout row draws its bar across the forks with the tally beneath", () => {
  const rollout = (
    tally: NonNullable<NonNullable<ViewSnapshot["briefing"]["lines"]>[number]["rollout"]>["tally"],
  ) => {
    const body = loadFixture("snapshot-calm.json");
    const line = body.briefing.lines?.find((l) => l.rollout);
    if (!line?.rollout) throw new Error("The calm morning has a rollout");
    if (tally) line.rollout.tally = tally;
    return { body, line };
  };

  it("one segment per fork by stage; the review group names its forks and the stages the rest are at", async () => {
    const { body, line } = rollout([
      { state: "merged", forks: ["partition"] },
      { state: "to-review", forks: ["legal", "file"] },
      { state: "checking", forks: ["schema"] },
      { state: "not-started", forks: ["unit", "search"] },
      { state: "not-read", forks: ["indexer"] },
    ]);
    line.members = line.members
      .slice(0, 2)
      .map((m, i) => ({ ...m, fork: ["legal", "file"][i] ?? m.fork }));
    await render(body);
    const head = row(line.id);
    const bar = head.querySelector(".today-rollout-bar");
    expect(bar?.getAttribute("role")).toBe("img");
    expect(bar?.getAttribute("aria-label")).toBe(
      "Rollout across 7 forks: 1 merged, 2 to review, 1 checking, 2 not started, 1 not read",
    );
    expect(
      [...(bar?.querySelectorAll<HTMLElement>(".today-rollout-seg") ?? [])].map(
        ({ dataset }) => `${dataset.fork}:${dataset.state}`,
      ),
    ).toEqual([
      "partition:merged",
      "legal:to-review",
      "file:to-review",
      "schema:checking",
      "unit:not-started",
      "search:not-started",
      "indexer:not-read",
    ]);
    expect(head.querySelector(".today-row-forks")?.textContent).toBe(
      "legal, file · 1 merged · 1 checking · 2 not started · 1 not read",
    );
  });

  it("the Template row's tally names the forks to dispatch, and the review group then draws no bar", async () => {
    const { body, line } = rollout([
      { state: "merged", forks: ["partition", "legal"] },
      { state: "to-review", forks: ["file"] },
      { state: "to-dispatch", forks: ["unit", "search"] },
    ]);
    const lines = body.briefing.lines ?? [];
    line.members = line.members.slice(0, 1).map((m) => ({ ...m, fork: "file" }));
    line.subject = "1 fork";
    lines.push({ ...line, id: `${line.id}:template`, subject: "Template", members: [] });
    await render(body);
    expect(row(line.id).querySelector(".today-rollout-bar")).toBeNull();
    expect(row(line.id).querySelector(".today-row-forks")?.textContent).toBe("file");
    const template = row(`${line.id}:template`);
    expect(template.querySelectorAll(".today-rollout-seg")).toHaveLength(5);
    expect(template.querySelector(".today-row-forks")?.textContent).toBe(
      "2 merged · 1 to review · 2 to dispatch: unit, search",
    );
  });

  it.each([
    [{ dispatch: 2, review: 1 }, "2 to dispatch"],
    [{ dispatch: 0, review: 3 }, "3 to review"],
    [{ dispatch: 0, review: 0 }, "2 open"],
  ])(
    "the flow's Template cell reads core's owed stages %o, with no rollout row on Yours",
    async (owed, says) => {
      const { body } = rollout(undefined);
      body.briefing.lines = (body.briefing.lines ?? []).filter((l) => !l.rollout);
      const figure = body.briefing.today?.fleet?.doors.find(({ id }) => id === "template");
      if (!figure) throw new Error("The calm morning has a Template door");
      Object.assign(figure, { count: 2, owed });
      await render(body);
      expect(value("template")).toBe(says);
    },
  );
});

it("an opened row on Today says one sentence, then its steps", async () => {
  const body = nov16();
  body.briefing.lines = structuredClone(lines);
  const line = body.briefing.lines.find(({ id }) => id === "waiting:upgrade:os-core-common");
  if (!line) throw new Error("16 Nov waits on an upgrade");
  for (const said of [line, ...line.members]) {
    said.cause = "The sync PR carries a change that needs the newer library.";
    said.effect = "Two later syncs queue behind it.";
  }
  await render(body);
  await expand(line.id);
  const [opened1] = opened();
  expect(opened1?.textContent).toContain("needs the newer library");
  expect(opened1?.textContent).not.toContain("queue behind it");
});

it("keeps every row of every section and the opened body in the four shared columns", async () => {
  await render();
  const spans = (tr: Element) => [...tr.children].map((td) => (td as HTMLTableCellElement).colSpan);
  for (const table of container.querySelectorAll("table"))
    expect(table.querySelectorAll("colgroup col")).toHaveLength(4);
  for (const tr of container.querySelectorAll("tr.today-row"))
    expect(spans(tr)).toEqual([1, 1, 1, 1]);
  expect(container.querySelectorAll("tr.today-row--place")).toHaveLength(5);
  await click(row("waiting:upgrade:os-core-common").querySelector(".today-row-what button"));
  const [body] = opened();
  expect([...(body?.children ?? [])].map((td) => (td as HTMLTableCellElement).colSpan)).toEqual([
    1, 3,
  ]);
});

it("says nothing is yours on a morning with no lines, and draws only the unfiltered lower sections without them", async () => {
  const calm = nov16();
  calm.briefing.lines = [];
  delete calm.briefing.today;
  await render(calm);
  expect(container.querySelector(".today-table")?.textContent).toBe("Nothing is yours to move.");
  expect(chips("yours")).toEqual([]);
  await unmount();
  container.remove();
  const older = nov16();
  delete older.briefing.lines;
  await render(older);
  expect(sections()).toEqual(["moving", "history"]);
  expect(container.querySelector(".today-table")?.textContent).not.toContain(
    "Nothing is yours to move.",
  );
  expect(lowerRow("moving", "lanes")).toBeDefined();
  await act(async () => navigate({ kind: "today", station: "integration" }));
  expect(sections()).toEqual([]);
  await unmount();
  container.remove();
  delete older.briefing.today;
  await render(older);
  expect(container.querySelector("[role=tabpanel]")?.textContent).toBe("");
});

it("has two tabs, and Yours holds every section in order under one set of columns", async () => {
  await render();
  expect(
    [...container.querySelectorAll<HTMLElement>("[data-today-tab]")].map((t) => t.textContent),
  ).toEqual(["Yours3 blocked16 waiting", "Forks8 stopped"]);
  expect(tab("activity")).toBeNull();
  expect(sections()).toEqual(["blocked", "waiting", "moving", "can-wait", "history"]);
  expect(container.querySelectorAll("[data-section=moving] tr")).toHaveLength(3);
  const lanes = lowerRow("moving", "lanes");
  expect(lanes.querySelector(".today-row-when")?.textContent).toBe("Now");
  expect(lanes.querySelector("time")).toBeNull();
  expect(what(lanes)).toBe("Lanes · 1 lane busy: partition");
  expect(lowerRow("history", "sync").querySelector(".today-row-label")?.textContent).toBe(
    "Sync Upstream",
  );
  const sync = lowerRow("history", "sync");
  expect(count(sync, "failed")?.getAttribute("title")).toBe("indexer, search, crs-conversion");
});

it("counts Yours and each section with the shared count, whole and filtered", async () => {
  const body = whole();
  const group = body.briefing.lines?.find(({ id }) => id === "waiting:upgrade:os-core-common");
  const moved = group?.members[0];
  if (!group || !moved) throw new Error("16 Nov has the os-core-common group");
  moved.station = "integration";
  await render(body);
  expect(chips("yours")).toEqual(["bad 3 blocked", "warn 16 waiting"]);
  expect([headCount("blocked"), headCount("waiting")]).toEqual(["3", "16"]);
  expect(scope()).toBeUndefined();

  await act(async () => navigate({ kind: "today", station: "sync" }));
  expect(chips("yours")).toEqual(["bad 3 blocked", "warn 16 waiting"]);
  expect(scope()).toBe("Sync PR · 4 waiting");
  expect([headCount("blocked"), headCount("waiting")]).toEqual([undefined, "4"]);

  await act(async () => navigate({ kind: "today", station: "integration" }));
  expect(scope()).toBe("Integration · 10 waiting");
  expect(headCount("waiting")).toBe("10");

  await act(async () => navigate({ kind: "today", station: "template" }));
  expect(scope()).toBe("Template · 1 waiting");
  expect(headCount("waiting")).toBe("1");

  await act(async () => navigate({ kind: "today", station: "upstream" }));
  expect(scope()).toBe("Upstream · 3 blocked");
  expect([headCount("blocked"), headCount("waiting")]).toEqual(["3", undefined]);
});

it("draws only the split that has a count, and no chip when both have none", async () => {
  const body = nov16();
  body.briefing.lines = lines.filter(({ section }) => section === "waiting");
  await render(body);
  expect(chips("yours")).toEqual(["warn 16 waiting"]);
  await unmount();
  container.remove();
  body.briefing.lines = lines.filter(({ section }) => section === "blocked");
  await render(body);
  expect(chips("yours")).toEqual(["bad 3 blocked"]);
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

it("a calm morning says nothing is yours, then shows what moves, Can wait and the history", async () => {
  const calm = nov16();
  calm.briefing.lines = [];
  await render(calm);
  expect(container.querySelector(".today-table-calm")?.textContent).toBe(
    "Nothing is yours to move.",
  );
  expect(sections()).toEqual(["moving", "can-wait", "history"]);
  expect(yoursRows()).toHaveLength(0);
});

it.each([
  ["moving", "lanes", "forks"],
  ["moving", "template", "engineering-system"],
  ["moving", "sync", "upstream"],
  ["history", "sync", "forks"],
  ["history", "template", "engineering-system"],
])("the %s row %s opens its place, %s", async (section, id, place) => {
  await render(nov16());
  for (const target of [".today-row-what", ".today-row-open .today-row-place"]) {
    await act(async () => navigate({ kind: "today" }));
    await click(lowerRow(section, id).querySelector(target));
    if (place === "forks") expect(route()).toEqual({ kind: "today", tab: "forks" });
    else expect(route()).toEqual({ kind: place });
    expect(opened()).toHaveLength(0);
  }
});

it("an in-flight row names its fork and what runs, with its own link, age and what was not read", async () => {
  const body = nov16();
  const today = body.briefing.today as TodaySummary;
  today.moving.unshift({
    id: "rerun:indexer",
    label: "indexer",
    place: "line",
    time: "Now",
    count: 1,
    names: ["indexer"],
    what: "Main build rerunning",
    fork: "indexer",
    link: { label: "Run", url: "https://github.com/o/indexer/actions/runs/1", kind: "run" },
    age: "3h",
    notRead: ["indexer's main run"],
  });
  await render(body);
  const tr = lowerRow("moving", "rerun:indexer");
  expect(what(tr)).toBe("indexer: Main build rerunning");
  expect(tr.querySelector(".today-row-open a")?.getAttribute("href")).toBe(
    "https://github.com/o/indexer/actions/runs/1",
  );
  expect(tr.querySelector(".today-row-place")).toBeNull();
  expect(tr.querySelector(".today-row-age-text")?.textContent).toBe("3h");
  const gaps = tr.querySelector(".today-row-gaps");
  expect(gaps?.textContent).toBe("⌀ 1 ›");
  await click(gaps);
  expect(route()?.kind).toBe("evidence");
});

it("a workflow core did not read shows as not read, never as zero", async () => {
  const body = nov16();
  const [sync] = (body.briefing.today as TodaySummary).history.rows;
  if (!sync) throw new Error("16 Nov has its history");
  sync.counts = [
    { kind: "not-read", label: "not read", count: 13, tone: "neutral", names: [], urls: [] },
  ];
  await render(body);
  expect(what(lowerRow("history", "sync"))).toBe("13 forks · 13 not read");
  for (const tr of container.querySelectorAll("tr.today-row--place"))
    expect(what(tr)).not.toMatch(/(^|· )0 /);
});

it.each([
  ["fallback", undefined, "Last 24 hours"],
  ["seen", undefined, "Since you last looked {from}"],
  ["history-short", undefined, "Last 24 hours since {from}"],
  ["stale", "2026-11-16T22:00:00.000Z", "Last 24 hours to {asOf}"],
] as const)("names a %s history window only as far as core vouches", async (basis, asOf, text) => {
  const body = nov16();
  const history = (body.briefing.today as TodaySummary).history;
  history.basis = basis;
  history.from = "2026-11-16T20:00:00.000Z";
  if (asOf) history.asOf = asOf;
  else delete history.asOf;
  await render(body);
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
      for (const hidden of ["moving", "can-wait", "history"]) expect(section(hidden)).toBeNull();
      expect(scope()).toMatch(/^(Upstream|Sync PR|Integration|Template) · \d+ (blocked|waiting)$/);
      expect(container.querySelector(".today-filter button")?.textContent).toBe("Show all");
      await click(container.querySelector(".today-filter button"));
      expect(route()).toEqual({ kind: "today" });
      expect(memberIds()).toEqual(all);
      expect(sections()).toEqual(["blocked", "waiting", "moving", "can-wait", "history"]);
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
    await expand("waiting:upgrade:os-core-common");
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

  it.each([
    ["#today", false],
    ["#today/yours/sync", false],
    ["#today/forks", false],
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

  it("lists a rest fork whose service mark counts work above the fold with no Yours member", async () => {
    const body = whole();
    const owned = new Set(todayMembers(body.briefing).map(({ member }) => member.fork));
    const quiet = body.services?.find(
      ({ service, home }) => !owned.has(service) && home?.mark.kind !== "count",
    );
    if (!quiet?.home) throw new Error("16 Nov has a quiet rest fork");
    quiet.home.mark = { kind: "count", count: 1, tone: "warning" };
    await render(body, "#today/forks");
    expect(fork(quiet.service)?.closest("tbody")?.getAttribute("data-fork-group")).toBe("holding");
    expect(fold()?.textContent ?? "").not.toContain(quiet.service);
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
    expect([...(pending?.children ?? [])].map(({ className }) => className)).toEqual([
      "today-row-fork",
      "today-row-what",
      "today-row-open",
      "today-row-age",
    ]);
    expect(pending?.querySelector(".today-row-fork")?.textContent).toBe(member.fork);
    const block = pending?.closest(".today-section");
    expect(block?.previousElementSibling?.getAttribute("data-section")).toMatch(
      /^(blocked|waiting)$/,
    );
    expect(block?.nextElementSibling?.getAttribute("data-section")).toBe("moving");
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
      await render(body, "#today/forks");
      await click(door(id));
      expect(route()).toEqual({ kind: "today" });
      expect(openSelection()).toEqual({ kind: "cause", id: target.row });
      expect(causeRow(target.row)?.hasAttribute("data-open")).toBe(true);
    },
  );

  it("a door opens its cause from Forks in view, with focus on it", async () => {
    const scrolled: Element[] = [];
    const scroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      await render(whole(), "#today/forks");
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
