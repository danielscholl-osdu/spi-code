// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Station, Tone, ViewSnapshot } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import { selectStrip } from "../../store/strip.js";
import { watchStore } from "../../store/watch.js";
import { fixtureLoader } from "../../test-utils/harness.js";
import { SidebarSweep } from "./SweepSegment.js";

const previous = watchStore.getState();
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  watchStore.setState(previous, true);
});

type Change = (body: ViewSnapshot) => ViewSnapshot;

const environment =
  (fact: { tone: Tone; sub: string; figure?: string }, hold = false): Change =>
  (body) => {
    body.briefing.facts = body.briefing.facts.map((entry) =>
      entry.label === "Environment" ? { ...entry, ...fact } : entry,
    );
    if (hold)
      body.briefing.environment.lanes
        .find(({ id }) => id === "holds")
        ?.events.push({
          id: "hold-open",
          start: new Date(Date.now() - 2 * 86_400_000).toISOString(),
          state: "held",
          label: "2 d",
          detail: "in maintenance for 2 d so far",
        });
    return body;
  };

const slots =
  (state: "broken" | "waiting" | "done" | "unknown"): Change =>
  (body) => {
    for (const place of body.briefing.places ?? [])
      if (place.visual?.kind === "rollout")
        place.visual.slots = place.visual.slots.map((slot) => ({ ...slot, state }));
    return body;
  };

const stations =
  (station: Partial<Station>): Change =>
  (body) => {
    for (const row of body.stations)
      row.stations = row.stations.map((entry) => ({
        ...entry,
        ...station,
      })) as typeof row.stations;
    return body;
  };

const scenes: [string, Change][] = [
  ["as recorded", (body) => body],
  ["environment in maintenance", environment({ tone: "bad", sub: "held" }, true)],
  [
    "environment refreshing",
    environment({ tone: "warn", sub: "refresh running · at deploy" }, true),
  ],
  ["environment unread", environment({ tone: "ok", sub: "deployable", figure: "?" })],
  ["templates failed", slots("broken")],
  ["templates pending", slots("waiting")],
  ["templates current", slots("done")],
  ["templates unread", slots("unknown")],
  ["forks stopped", stations({ state: "stopped", substate: "stopped" })],
  ["forks waiting", stations({ state: "waiting", substate: "waiting-on-person" })],
  ["forks flowing", stations({ state: "idle", substate: "ready" })],
  ["forks unread", stations({ state: "unknown" })],
  [
    "next sync in an hour",
    (body) => {
      body.briefing.nextSyncAt = new Date(Date.now() + 3_600_000).toISOString();
      return body;
    },
  ],
];

async function render(body: ViewSnapshot | null) {
  watchStore.setState({
    snapshot: body ? { cursor: body.cursor, body } : null,
    progress: null,
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  await act(async () =>
    root.render(
      <footer>
        <SidebarSweep />
      </footer>,
    ),
  );
  return container.querySelector<HTMLElement>("footer");
}

it("draws only the footer sweep for every strip classification and with no snapshot", async () => {
  const seen = new Set<string>();
  for (const [name, change] of scenes) {
    const body = change(fixtureLoader(readFixture)("snapshot-1106.json"));
    const strip = selectStrip(body);
    for (const field of [strip.environment, strip.template, strip.forks])
      seen.add(field.classification);
    const footer = await render(body);
    expect(
      [...(footer?.querySelectorAll<HTMLElement>("[data-field]") ?? [])].map(
        (element) => element.dataset.field,
      ),
      name,
    ).toEqual(["freshness"]);
    expect(footer?.querySelectorAll("button, a, [role=button]").length, name).toBe(1);
    expect(footer?.querySelector("button")?.hasAttribute("data-sweep-line"), name).toBe(true);
    await cleanup?.();
    cleanup = undefined;
  }
  expect([...seen].sort()).toEqual(
    [
      "fine",
      "unread",
      "maintenance",
      "refreshing",
      "failed",
      "pending",
      "stopped",
      "waiting",
    ].sort(),
  );
  const footer = await render(null);
  expect(
    [...(footer?.querySelectorAll<HTMLElement>("[data-field]") ?? [])].map(
      (element) => element.dataset.field,
    ),
  ).toEqual(["freshness"]);
});
