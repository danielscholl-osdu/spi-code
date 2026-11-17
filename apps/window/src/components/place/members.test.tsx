// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import recorded from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { openSelection, setOpenSelection } from "../../app/navigation.js";
import { createWatchStore, watchStore } from "../../store/watch.js";
import { installSpi } from "../../test-utils/harness.js";
import Line from "../../views/line/index.js";
import Template from "../../views/template/index.js";
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
const fixture = body().briefing;
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

it("claims no home without membership, or when core names two homes; absent lines have no Today count", () => {
  const snapshot = body();
  const id = fixture.lines?.[0]?.members[0]?.id;
  if (!id) throw new Error("Missing member");
  snapshot.briefing.places = [];
  expect(placeMembers(snapshot, "line")).toEqual([]);
  expect(placeMembers(snapshot, "upstream").map(({ member }) => member.id)).toEqual([
    "port:entitlements",
  ]);
  snapshot.briefing.focus = [];
  expect(places.flatMap((place) => placeMembers(snapshot, place))).toEqual([]);
  snapshot.briefing.places = (fixture.places ?? []).map((row) => ({ ...row, itemIds: [id] }));
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
      container.querySelectorAll(".rollout-rung[data-member] button[data-selected]"),
    ).toHaveLength(7);
    expect(container.querySelector(".opened-body")).toBeNull();
    expect(harness.spi.postMessage).not.toHaveBeenCalled();
  } finally {
    await act(async () => watchStore.setState(previous, true));
  }
});
