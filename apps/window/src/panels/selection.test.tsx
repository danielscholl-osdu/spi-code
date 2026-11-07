// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import recorded from "../../../../fixtures/watch/snapshot-mixed-59d6895.json?raw";
import { createSelectionStore, type SelectionStore } from "./selection.js";
import { routeSelectionIds, type SelectionRow, selectionRows } from "./selection-rows.js";
import { useSelectionList } from "./useSelectionList.js";

const snapshot = ViewSnapshotSchema.parse(JSON.parse(recorded));

function List({
  rows,
  open,
  store,
}: {
  rows: SelectionRow[];
  open(row: SelectionRow): void;
  store: SelectionStore;
}) {
  const list = useSelectionList(rows, open, store);
  return (
    <div data-selection-list role="listbox" aria-label="Repositories">
      {rows.map((row) => (
        <button type="button" key={row.id} role="option" {...list.rowProps(row)}>
          {row.title}
        </button>
      ))}
    </div>
  );
}

it("keeps a flow row on its service, clears elsewhere, and restores each route's scroll and row", () => {
  const postMessage = vi.fn();
  const store = createSelectionStore({ postMessage });
  const state = store.getState;
  const flow = snapshot.briefing.flow.rows[0];
  if (!flow) throw new Error("Missing recorded flow row");
  const row = selectionRows(snapshot).find(({ id }) => id === flow.inspect);
  state().visit("#service", routeSelectionIds(snapshot, { kind: "service", id: flow.fork }), 0);
  state().select(flow.inspect, row);
  const request = state().request;
  expect(
    state().visit(
      "#same-service",
      routeSelectionIds(snapshot, { kind: "service", id: flow.fork }),
      275,
    ),
  ).toBe(0);
  expect(state().selected).toBe(flow.inspect);
  expect(state().request).toBe(request);
  expect(state().visit("#setup", [], 90)).toBe(0);
  expect(state().selected).toBeNull();
  expect(state().request).toBeNull();
  expect(
    state().visit("#service", routeSelectionIds(snapshot, { kind: "service", id: flow.fork }), 0),
  ).toBe(275);
  expect(state().selected).toBe(flow.inspect);
  expect(state().row).toEqual(row);
  expect(state().request).not.toBe(request);
  state().visit("#service", [], 275);
  expect(state().selected).toBeNull();
  expect(state().visit("#same-service", [], 0)).toBe(90);
  expect(state().selected).toBeNull();
});

it("moves in displayed order, inspects on arrows, and opens only on Enter or double-click", async () => {
  const rows: SelectionRow[] = [
    { id: "repo:legal", title: "Legal", kind: "repository" },
    { id: "repo:partition", title: "Partition", kind: "repository" },
  ];
  const postMessage = vi.fn();
  const store = createSelectionStore({ postMessage });
  const open = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<List rows={rows} open={open} store={store} />));
  const options = container.querySelectorAll<HTMLElement>('[role="option"]');
  const press = async (index: number, key: string) =>
    act(async () =>
      options[index]?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })),
    );
  try {
    options[0]?.focus();
    await press(0, "ArrowDown");
    expect(store.getState().selected).toBe(rows[1]?.id);
    expect(document.activeElement).toBe(options[1]);
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "inspect.request", payload: { id: rows[1]?.id } }),
    );
    expect(open).not.toHaveBeenCalled();
    await press(1, "Enter");
    expect(open).toHaveBeenLastCalledWith(rows[1]);
    await press(1, "ArrowUp");
    expect(store.getState().selected).toBe(rows[0]?.id);
    expect(document.activeElement).toBe(options[0]);
    await act(async () => options[0]?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(open).toHaveBeenLastCalledWith(rows[0]);
    const request = store.getState().request;
    await act(async () => store.getState().clear());
    await act(async () =>
      store.getState().receive({
        version: PROTOCOL_VERSION,
        id: request,
        kind: "response",
        type: "error",
        payload: { code: "not_found", message: "Old request" },
      }),
    );
    expect(store.getState().missing).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
