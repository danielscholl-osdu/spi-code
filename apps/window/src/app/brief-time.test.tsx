// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import inspected from "../../../../fixtures/watch/inspect-1106.json?raw";
import recorded from "../../../../fixtures/watch/snapshot-1106.json?raw";
import { fixtureLoader, installSpi } from "../test-utils/harness.js";

const load = fixtureLoader((path) => (path.endsWith("snapshot-1106.json") ? recorded : inspected));
const previousZone = process.env.TZ;
let cleanup: () => Promise<void>;
afterEach(async () => {
  await cleanup?.();
  vi.useRealTimers();
  if (previousZone === undefined) delete process.env.TZ;
  else process.env.TZ = previousZone;
});

it.each([
  ["America/Chicago", "18:00", "11-05 22:20"],
  ["UTC", "11-07 00:00", "04:20"],
])("uses the shared clock in every briefing surface under TZ=%s", async (zone, sync, green) => {
  process.env.TZ = zone;
  vi.resetModules();
  const [{ Shell }, { watchStore }, { selectionStore }, { navigate }] = await Promise.all([
    import("./Shell.js"),
    import("../store/watch.js"),
    import("../panels/selection.js"),
    import("./navigation.js"),
  ]);
  const spi = installSpi();
  vi.useFakeTimers({ toFake: ["Date"] });
  const body = load("snapshot-1106.json");
  vi.setSystemTime(new Date(body.sweptAt));
  watchStore.setState({ snapshot: { cursor: body.cursor, body }, setup: null });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanup = async () => {
    await act(async () => root.unmount());
    host.remove();
    watchStore.setState({ snapshot: null });
    selectionStore.getState().clear();
    spi.restore();
  };
  await act(async () => {
    navigate({ kind: "upstream" });
    root.render(<Shell />);
  });
  expect(host.querySelector(".place-headline")?.textContent).toBe(
    `At ${sync}, 65 commits reach 8 forks. 13 need you first.`,
  );
  for (const when of host.querySelectorAll(".upstream-theme-when time"))
    expect(when.textContent).toBe(sync);
  expect(host.querySelectorAll(".upstream-theme-when time")).toHaveLength(3);
  const due =
    body.readings
      .find(({ anchor }) => anchor.kind === "upstream")
      ?.content?.items.filter((item) => item.due) ?? [];
  expect(due.length).toBeGreaterThan(0);
  for (const item of due) {
    expect(
      host.querySelector(`[data-item-id="${item.id}"] .place-item-meta`)?.textContent ??
        host
          .querySelector(`[data-item-id="${item.id}"] .place-item-content`)
          ?.getAttribute("title"),
    ).toContain(`Before ${item.due?.before}`);
  }
  await act(async () => navigate({ kind: "environment" }));
  expect(
    host.querySelector('[data-event="refresh:42160446124"]')?.getAttribute("aria-label"),
  ).toContain(`to ${green}`);
});
