// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import current from "../../../../fixtures/watch/snapshot-1106.json?raw";
import { sweepSources } from "../components/evidence/words.js";
import { SidebarProvider } from "../components/sidebar/ui-sidebar.js";
import { midSweep } from "../components/sweep/test-helper.js";
import { watchStore } from "../store/watch.js";
import { dropRunning } from "../test-utils/environment.test-helper.js";
import { SidebarToggle } from "./PanelControls.js";

const nov6 = ViewSnapshotSchema.parse(JSON.parse(current));
let container: HTMLDivElement;
let root: Root;
let previous: ReturnType<typeof watchStore.getState>;

beforeEach(() => {
  previous = watchStore.getState();
  watchStore.setState({ snapshot: null, progress: null });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  watchStore.setState(previous, true);
});

const toggle = () => container.querySelector<HTMLButtonElement>('[aria-label="Toggle sidebar"]');
const dot = () => toggle()?.querySelector(".sidebar-toggle-dot")?.getAttribute("data-tone");
const show = (body: ViewSnapshot) =>
  act(async () => watchStore.setState({ snapshot: { cursor: body.cursor, body } }));

async function mount(presentation: "inline" | "off-canvas") {
  await act(async () =>
    root.render(
      <SidebarProvider presentation={presentation}>
        <SidebarToggle rightPanelOpen={false} onToggleRightPanel={vi.fn()} />
      </SidebarProvider>,
    ),
  );
}

it.each(["inline", "off-canvas"] as const)(
  "dots the %s sidebar's toggle only while the sidebar is out of sight",
  async (presentation) => {
    await show(nov6);
    await mount(presentation);
    expect(dot()).toBe(presentation === "inline" ? undefined : "error");
    await act(async () => toggle()?.click());
    expect(dot()).toBe(presentation === "inline" ? "error" : undefined);
    await act(async () => toggle()?.click());
    expect(dot()).toBe(presentation === "inline" ? undefined : "error");
  },
);

it("dots the hidden sidebar's toggle for Today's count, then for the worst mark or sweep tone", async () => {
  await mount("off-canvas");
  expect(dot()).toBeUndefined();
  await show(nov6);
  expect(dot()).toBe("error");
  const calm = structuredClone(nov6);
  calm.briefing.focus = [];
  calm.briefing.rest = [];
  for (const row of calm.stations)
    for (const station of row.stations) {
      station.state = "idle";
      station.substate = "ready";
    }
  for (const { envelope } of sweepSources(calm)) {
    envelope.state = "fresh";
    envelope.completeness = { kind: "complete" };
  }
  await show(calm);
  expect(dot()).toBe("warning");
  for (const place of calm.briefing.places ?? [])
    if (place.visual?.kind === "rollout")
      for (const slot of place.visual.slots) slot.state = "done";
  await show({ ...calm, cursor: calm.cursor + 1 });
  expect(dot()).toBeUndefined();
  const source = calm.areas[0];
  if (!source) throw new Error("Fixture needs a sweep source");
  source.envelope.state = "stale";
  await show(structuredClone(calm));
  expect(dot()).toBe("warning");
  source.envelope.state = "failed";
  await show(structuredClone(calm));
  expect(dot()).toBe("error");
  const marked = structuredClone(calm);
  for (const place of marked.briefing.places ?? [])
    if (place.visual?.kind === "rollout")
      for (const slot of place.visual.slots) slot.state = "waiting";
  await show(marked);
  expect(dot()).toBe("error");
  source.envelope.state = "stale";
  const interrupted = structuredClone(calm);
  interrupted.briefing.focus = nov6.briefing.focus;
  await show(interrupted);
  expect(dot()).toBe("error");
});

it("draws no dot for unread fields and sweep, but reports a stopped first sweep", async () => {
  await mount("off-canvas");
  const unread = structuredClone(nov6);
  unread.briefing.focus = [];
  unread.briefing.rest = [];
  for (const row of unread.stations)
    for (const station of row.stations) {
      station.state = "unknown";
      station.substate = "ready";
    }
  for (const place of unread.briefing.places ?? [])
    if (place.visual?.kind === "rollout")
      for (const slot of place.visual.slots) slot.state = "unknown";
  dropRunning(unread);
  for (const { envelope } of sweepSources(unread)) {
    envelope.state = "unread";
    envelope.completeness = { kind: "complete" };
  }
  await show(unread);
  expect(dot()).toBeUndefined();
  await act(async () => watchStore.setState({ snapshot: null, progress: null }));
  expect(dot()).toBeUndefined();
  await act(async () => watchStore.setState({ progress: midSweep({ outcome: "cancelled" }) }));
  expect(dot()).toBe("error");
});
