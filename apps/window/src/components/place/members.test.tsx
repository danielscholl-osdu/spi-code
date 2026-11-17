// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import recorded from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { readFixture, watchFixtures } from "../../../../../scripts/watch-generated.mjs";
import { openSelection, setOpenSelection } from "../../app/navigation.js";
import { createWatchStore, watchStore } from "../../store/watch.js";
import { fixtureLoader, installSpi } from "../../test-utils/harness.js";
import Line from "../../views/line/index.js";
import Template from "../../views/template/index.js";
import sweepText from "../opened-body/sweep-1116.json?raw";
import { ProgramSidebar } from "../sidebar/ProgramSidebar.js";
import { SidebarProvider } from "../sidebar/ui-sidebar.js";
import { type MemberPlace, placeMembers, todayMembers } from "./members.js";
import fixtureText from "./members-1116.json?raw";
import { PlaceHead } from "./PlaceHead.js";

const places: MemberPlace[] = ["line", "environment", "engineering", "upstream", "security"];
const body = (): ViewSnapshot => {
  const recordedBody = JSON.parse(recorded);
  const fixture = JSON.parse(fixtureText);
  return ViewSnapshotSchema.parse({
    ...recordedBody,
    provenance: [],
    stations: fixture.stations,
    briefing: {
      ...recordedBody.briefing,
      lines: fixture.lines,
      places: fixture.places,
      focus: fixture.items,
      rest: [],
      repositories: { ...recordedBody.briefing.repositories, rows: fixture.repositories },
    },
  });
};
let harness: ReturnType<typeof installSpi>;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  harness = installSpi();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  setOpenSelection(null);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  setOpenSelection(null);
  harness.restore();
});

it("partitions Today once across the place heads on every watch fixture and 16 Nov", async () => {
  const snapshots = watchFixtures()
    .filter(({ name }) => name.startsWith("snapshot-"))
    .map(({ name, path }) => ({
      name,
      snapshot: ViewSnapshotSchema.parse(JSON.parse(readFixture(path))),
    }));
  snapshots.push({ name: "members-1116", snapshot: body() });
  const sweep = JSON.parse(sweepText);
  const sweepSnapshot = body();
  sweepSnapshot.briefing.lines = sweep.lines;
  snapshots.push({ name: "sweep-1116", snapshot: sweepSnapshot });
  for (const { name, snapshot } of snapshots) {
    const members = todayMembers(snapshot.briefing).map(({ member }) => member.id);
    const homes = places.flatMap((place) =>
      placeMembers(snapshot, place).map(({ member }) => member.id),
    );
    const store = createWatchStore(vi.fn());
    store.setState({ snapshot: { cursor: snapshot.cursor, body: snapshot } });
    await act(async () =>
      root.render(
        <SidebarProvider>
          <ProgramSidebar store={store} route={{ kind: "today" }} onNavigate={vi.fn()} />
        </SidebarProvider>,
      ),
    );
    const sidebar = container.querySelector("[data-sidebar-row=today] .sidebar-pip");
    expect
      .soft(homes.length, `${name}: heads sum to sidebar Today`)
      .toBe(Number(sidebar?.textContent));
    expect.soft(homes.length, `${name}: counts every Today member`).toBe(members.length);
    expect.soft(new Set(homes).size, `${name}: no member has two homes`).toBe(homes.length);
    expect.soft([...homes].sort(), `${name}: every member has a home`).toEqual([...members].sort());
  }
});

it("partitions the 16 Nov Today members by home, with each head stepping exactly its sidebar share", async () => {
  const snapshot = body();
  const store = createWatchStore(vi.fn());
  store.setState({ snapshot: { cursor: snapshot.cursor, body: snapshot } });
  await act(async () =>
    root.render(
      <SidebarProvider>
        <ProgramSidebar store={store} route={{ kind: "today" }} onNavigate={vi.fn()} />
        {places.map((place) => (
          <section key={place} data-test-place={place}>
            <PlaceHead name={place} place={place} snapshot={snapshot} />
          </section>
        ))}
      </SidebarProvider>,
    ),
  );
  const counts = places.map((place) => placeMembers(snapshot, place).length);
  expect(counts).toEqual([16, 0, 1, 1, 0]);
  const all = places.flatMap((place) =>
    placeMembers(snapshot, place).map(({ member }) => member.id),
  );
  expect(new Set(all).size).toBe(all.length);
  expect([...all].sort()).toEqual(
    todayMembers(snapshot.briefing)
      .map(({ member }) => member.id)
      .sort(),
  );
  const sidebar = container.querySelector("[data-sidebar-row=today] .sidebar-pip");
  expect(sidebar?.textContent).toBe("18");
  expect(counts.reduce((sum, count) => sum + count, 0)).toBe(Number(sidebar?.textContent));
  const crossReferences = snapshot.briefing.repositories.rows.flatMap(({ sections }) =>
    sections.flatMap(({ lines }) => lines.flatMap(({ onToday }) => (onToday ? [onToday.id] : []))),
  );
  expect(new Set(crossReferences).size).toBe(7);
  expect(
    crossReferences.every((id) =>
      placeMembers(snapshot, "line").some(({ member }) => member.id === id),
    ),
  ).toBe(true);
  for (const [index, place] of places.entries()) {
    const section = container.querySelector(`[data-test-place=${place}]`);
    const next = section?.querySelector<HTMLButtonElement>('[aria-label="Next of yours"]');
    const previous = section?.querySelector<HTMLButtonElement>('[aria-label="Previous of yours"]');
    if (!counts[index]) {
      expect(next).toBeNull();
      expect(previous).toBeNull();
      continue;
    }
    expect(section?.querySelector("[data-member-count]")?.getAttribute("data-member-count")).toBe(
      String(counts[index]),
    );
    await act(async () => setOpenSelection(null));
    const visited: string[] = [];
    for (let step = 0; step < (counts[index] ?? 0); step++) {
      await act(async () => next?.click());
      visited.push(openSelection()?.id ?? "");
    }
    expect(visited).toEqual(placeMembers(snapshot, place).map(({ member }) => member.id));
    await act(async () => next?.click());
    expect(openSelection()?.id).toBe(visited[0]);
    await act(async () => previous?.click());
    expect(openSelection()?.id).toBe(visited.at(-1));
  }
  expect(harness.spi.postMessage).not.toHaveBeenCalled();
});

it.each(["snapshot-busy.json", "snapshot-bad.json"] as const)(
  "draws no unread claim in Security's head after core read it (%s)",
  async (name) => {
    const snapshot = fixtureLoader(readFixture)(name);
    const security = snapshot.briefing.places?.find(({ place }) => place === "security");
    expect(security?.unread).toBeUndefined();
    expect(security?.figure).toBe("26 high or critical");
    await act(async () =>
      root.render(<PlaceHead name="Security" place="security" snapshot={snapshot} />),
    );
    expect(container.querySelector(".place-status-word")).toBeNull();
    expect(container.querySelector("[data-member-count]")?.textContent).toContain(
      "1 yours on Today",
    );
    if (!security) throw new Error("Missing Security place");
    security.unread = { areas: ["security"] };
    await act(async () =>
      root.render(<PlaceHead name="Security" place="security" snapshot={snapshot} />),
    );
    expect(container.querySelector(".place-status-word")?.textContent).toBe("not read yet");
  },
);

it("claims no home without core's home field; absent lines have no Today count", () => {
  const snapshot = body();
  snapshot.briefing.places = [];
  snapshot.briefing.focus = [];
  snapshot.briefing.rest = [];
  expect(places.flatMap((place) => placeMembers(snapshot, place))).toHaveLength(18);
  for (const { member } of todayMembers(snapshot.briefing)) delete member.home;
  expect(places.flatMap((place) => placeMembers(snapshot, place))).toEqual([]);
  delete snapshot.briefing.lines;
  expect(todayMembers(snapshot.briefing)).toEqual([]);
});

it("marks every stepped Line member on its cells and the Engineering member on its rollout rungs", async () => {
  const previous = watchStore.getState();
  const snapshot = body();
  try {
    watchStore.setState({ snapshot: { cursor: snapshot.cursor, body: snapshot } });
    await act(async () =>
      root.render(
        <>
          <Line presentation="overlay" />
          <Template />
        </>,
      ),
    );
    const next = container.querySelector<HTMLButtonElement>(
      '.line-content [aria-label="Next of yours"]',
    );
    for (const { member } of placeMembers(snapshot, "line")) {
      await act(async () => next?.click());
      expect(openSelection()?.id).toBe(member.id);
      const marks = container.querySelectorAll(".line-cell[data-member-marked]");
      expect(marks.length, member.id).toBeGreaterThan(0);
      expect(
        [...marks].every(
          (mark) => mark.closest("[data-service]")?.getAttribute("data-service") === member.fork,
        ),
      ).toBe(true);
    }
    const engineering = container.querySelector<HTMLButtonElement>(
      '[aria-label="Engineering system"] [aria-label="Next of yours"]',
    );
    await act(async () => engineering?.click());
    expect(openSelection()?.id).toBe("rollout");
    expect(
      container.querySelectorAll(".rollout-rung[data-member] button[data-member-marked]"),
    ).toHaveLength(7);
    expect(
      container.querySelector('.popover[data-selection="item~rollout"] .opened-body'),
    ).not.toBeNull();
    expect(harness.spi.postMessage).not.toHaveBeenCalled();
  } finally {
    await act(async () => watchStore.setState(previous, true));
  }
});
