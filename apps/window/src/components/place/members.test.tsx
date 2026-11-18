// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { todayMembers, type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import recorded from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import { setOpenSelection } from "../../app/navigation.js";
import { watchStore } from "../../store/watch.js";
import { fixtureLoader, installSpi } from "../../test-utils/harness.js";
import Line from "../../views/line/index.js";
import Template from "../../views/template/index.js";
import { type MemberPlace, placeMembers } from "./members.js";
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

it("marks every open Line member on its cells and the Engineering member on its rollout rungs", async () => {
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
    for (const { member } of placeMembers(snapshot, "line")) {
      await act(async () => setOpenSelection({ kind: "item", id: member.id }));
      expect(container.querySelectorAll(".rollout-rung [data-member-marked]")).toHaveLength(0);
      const marks = container.querySelectorAll(".line-cell[data-member-marked]");
      expect(marks.length, member.id).toBeGreaterThan(0);
      expect(
        [...marks].every(
          (mark) => mark.closest("[data-service]")?.getAttribute("data-service") === member.fork,
        ),
      ).toBe(true);
    }
    await act(async () => setOpenSelection({ kind: "item", id: "rollout" }));
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
