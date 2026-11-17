// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION } from "@spi-code/contracts";
import { expect, it, vi } from "vitest";
import { createSelectionStore } from "./selection.js";
import type { SelectionRow } from "./selection-rows.js";

it.each([true, false])(
  "retries an inspect after host restart without changing the selection (open: %s)",
  (open) => {
    const postMessage = vi.fn();
    const store = createSelectionStore({ postMessage });
    const state = store.getState;
    const hello = (pid: number) => ({
      version: PROTOCOL_VERSION,
      id: "hello",
      kind: "event",
      type: "host.hello",
      payload: { pid },
    });
    const row: SelectionRow = {
      id: "station:legal:upstream",
      title: "Upstream",
      kind: "station",
      inspectId: "upstream:legal",
    };
    state().receive(hello(123));
    state().select(row.id, row);
    if (!open) state().setOpen(false);
    const before = state();
    expect(before.request).not.toBeNull();

    state().receive(hello(456));

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenLastCalledWith({
      version: PROTOCOL_VERSION,
      id: state().request,
      kind: "request",
      type: "inspect.request",
      payload: { id: row.inspectId },
    });
    expect(state().request).not.toBe(before.request);
    expect(state()).toEqual({ ...before, request: state().request });
    state().receive(hello(456));
    expect(postMessage).toHaveBeenCalledTimes(2);
  },
);
