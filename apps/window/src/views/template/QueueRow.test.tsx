// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useStore } from "zustand";
import recorded from "../../../../../fixtures/watch/snapshot-59d6895.json?raw";
import { queueGroups, treeServices } from "../../app/queue.js";
import { DEFAULT_REGISTRY, navigate } from "../../app/routes.js";
import { Shell } from "../../app/Shell.js";
import { selectionStore } from "../../panels/selection.js";
import { watchStore } from "../../store/watch.js";
import { QueueRow } from "./QueueRow.js";

const body = ViewSnapshotSchema.parse(JSON.parse(recorded));
const previous = watchStore.getState();
const previousSpi = window.spi;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.location.hash = "";
  window.spi = {
    proof: false,
    openExternal: vi.fn(),
    postMessage: vi.fn(),
    onMessage: () => () => {},
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  selectionStore.getState().clear();
  watchStore.setState(previous);
  window.spi = previousSpi;
  window.location.hash = "";
});

function Queue() {
  const snapshot = useStore(watchStore, (state) => state.snapshot);
  const selectedId = useStore(watchStore, (state) => state.selection?.id);
  const select = useStore(watchStore, (state) => state.select);
  if (!snapshot) return null;
  const services = treeServices(snapshot.body.tree);
  return (
    <ul>
      {queueGroups(snapshot.body.briefing)
        .flatMap(({ entries }) => entries)
        .map((entry) => (
          <QueueRow
            key={entry.item.id}
            entry={entry}
            selected={selectedId === entry.item.id}
            services={services}
            onSelect={select}
            onNavigate={navigate}
          />
        ))}
    </ul>
  );
}

it("routes a scope chip to the thing's page and keeps the row selected there", async () => {
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  await act(async () =>
    root.render(
      <Shell
        registry={{
          ...DEFAULT_REGISTRY,
          views: { ...DEFAULT_REGISTRY.views, today: () => <Queue /> },
        }}
      />,
    ),
  );
  const row = container.querySelector('[data-selection-id="halt:entitlements"]');
  const chip = row?.querySelector<HTMLButtonElement>("button.inbox-scope");
  expect(chip?.textContent).toBe("entitlements");
  await act(async () => chip?.click());
  expect(window.location.hash).toBe("#service/entitlements");
  expect(container.querySelector("header [data-place]")?.textContent).toBe("entitlements");
  expect(watchStore.getState().selection).toEqual({ id: "halt:entitlements" });
  expect(window.spi.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: "inspect.request" }),
  );
  await act(async () => {
    window.location.hash = "#inbox";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  expect(
    container
      .querySelector('[data-selection-id="halt:entitlements"]')
      ?.hasAttribute("data-selected"),
  ).toBe(true);
  const fleet = container.querySelector('[data-selection-id="rollout"] .inbox-scope');
  expect(fleet?.tagName).toBe("SPAN");
});
