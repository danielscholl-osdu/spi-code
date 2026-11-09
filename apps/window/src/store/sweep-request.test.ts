// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { LastSweep } from "@spi-code/contracts";
import { expect, it, vi } from "vitest";
import snapshot from "../../../../fixtures/watch/snapshot-1106.json" with { type: "json" };
import {
  after,
  midSweep,
  savedSweep,
  sweepEvent,
  sweepStatus,
} from "../components/sweep/test-helper.js";
import { createWatchStore } from "./watch.js";

const last: LastSweep = {
  sweep: "sweep-1",
  startedAt: after(0),
  endedAt: after(130),
  outcome: "committed",
  requested: true,
};
const committed = (cursor: number, sweptAt = after(0)) => ({ ...snapshot, cursor, sweptAt });
const status = (lastSweep: LastSweep = last) =>
  sweepEvent("sweep.status", sweepStatus({ lastSweep }));

it.each(["snapshot-first", "progress-first", "status-first"])(
  "tracks a forced request until both the terminal sweep and its snapshot arrive: %s",
  (order) => {
    const send = vi.fn();
    const store = createWatchStore(send);
    const receive = store.getState().receive;
    receive(sweepEvent("view.snapshot", committed(1, after(-300))));
    store.getState().requestSweepNow();
    store.getState().requestSweepNow();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sweep.request", payload: { now: true } }),
    );
    receive(sweepEvent("sweep.progress", midSweep({ first: false })));
    const request = store.getState().sweepRequest;
    expect(request?.sweep).toBe("sweep-1");
    const frames = {
      snapshot: sweepEvent("view.snapshot", committed(2)),
      progress: sweepEvent("sweep.progress", savedSweep()),
      status: status(),
    };
    const sequence =
      order === "snapshot-first"
        ? [frames.snapshot, frames.progress, frames.status]
        : order === "progress-first"
          ? [frames.progress, frames.status, frames.snapshot]
          : [frames.status, frames.progress, frames.snapshot];
    for (const frame of sequence.slice(0, -1)) {
      receive(frame);
      expect(store.getState().sweepRequest).not.toBeNull();
    }
    receive(sequence.at(-1));
    expect(store.getState().sweepRequest).toBeNull();
    expect(store.getState().sweep?.lastSweep).toEqual(last);
  },
);

it("does not mistake a newer cursor from an older sweep for the requested commit", () => {
  const store = createWatchStore(vi.fn());
  const receive = store.getState().receive;
  receive(sweepEvent("view.snapshot", committed(1, after(-300))));
  receive(status({ ...last, sweep: "previous", requested: true }));
  store.getState().requestSweepNow();
  receive(status({ ...last, sweep: "previous", requested: true }));
  expect(store.getState().sweepRequest?.sweep).toBeNull();
  receive(sweepEvent("sweep.progress", savedSweep()));
  receive(status());
  receive(sweepEvent("view.snapshot", committed(2, after(-300))));
  expect(store.getState().sweepRequest).not.toBeNull();
  receive(sweepEvent("view.snapshot", committed(3)));
  expect(store.getState().sweepRequest).toBeNull();
});

it("accepts a later committed snapshot when the requested sweep's last status is unchanged", () => {
  const store = createWatchStore(vi.fn());
  const receive = store.getState().receive;
  receive(sweepEvent("view.snapshot", committed(1, after(-300))));
  store.getState().requestSweepNow();
  receive(sweepEvent("sweep.progress", savedSweep()));
  receive(status());
  expect(store.getState().sweepRequest).not.toBeNull();
  receive(sweepEvent("view.snapshot", committed(2, after(160))));
  expect(store.getState().sweepRequest).toBeNull();
  expect(store.getState().sweep?.lastSweep).toEqual(last);
});

it.each(["committed", "failed", "cancelled"] as const)(
  "releases a tracked %s sweep that was not requested without waiting for its snapshot",
  (outcome) => {
    const send = vi.fn();
    const store = createWatchStore(send);
    const receive = store.getState().receive;
    store.getState().requestSweepNow();
    receive(sweepEvent("sweep.progress", midSweep({ first: false })));
    const progress =
      outcome === "failed"
        ? midSweep({ outcome, code: "save", failure: "Could not save.", nextAttemptAt: after(430) })
        : midSweep({ outcome });
    receive(sweepEvent("sweep.progress", progress));
    receive(
      status(
        outcome === "failed"
          ? { ...last, requested: false, outcome, code: "save" }
          : { ...last, requested: false, outcome },
      ),
    );
    expect(store.getState().sweepRequest).toBeNull();
    expect(store.getState().sweepRequestError).toBeNull();
    store.getState().requestSweepNow();
    expect(send).toHaveBeenCalledTimes(2);
  },
);

it("joins a non-forced sweep without queuing a forced follow-up or inventing a cooldown", () => {
  const send = vi.fn();
  const store = createWatchStore(send);
  const receive = store.getState().receive;
  receive(sweepEvent("sweep.progress", midSweep({ first: false })));
  store.getState().requestSweepNow();
  expect(store.getState().sweepRequest?.sweep).toBe("sweep-1");
  receive(sweepEvent("view.snapshot", committed(1)));
  receive(sweepEvent("sweep.progress", savedSweep()));
  receive(status());
  expect(store.getState().sweepRequest).toBeNull();
  expect(store.getState().sweep?.forceCooldownUntil).toBeNull();
  expect(send).toHaveBeenCalledTimes(1);
  store.getState().requestSweepNow();
  expect(send).toHaveBeenCalledTimes(2);
});

it("settles a request joining after the running sweep's snapshot was already delivered", () => {
  const store = createWatchStore(vi.fn());
  const receive = store.getState().receive;
  receive(sweepEvent("sweep.progress", midSweep({ first: false })));
  receive(sweepEvent("view.snapshot", committed(1)));
  store.getState().requestSweepNow();
  receive(sweepEvent("sweep.progress", savedSweep()));
  receive(status());
  expect(store.getState().sweepRequest).toBeNull();
});

it("does not lose sweep tracking when an unrelated setup send fails", () => {
  const send = vi.fn();
  const store = createWatchStore(send);
  store.getState().receive(sweepEvent("sweep.status", sweepStatus()));
  store.getState().receive(sweepEvent("sweep.progress", midSweep()));
  store.getState().requestSweepNow();
  const before = store.getState();
  send.mockImplementationOnce(() => {
    throw new Error("Cannot check");
  });
  expect(() => store.getState().requestSetup("setup.check")).toThrow("Cannot check");
  expect(store.getState()).toMatchObject({
    sweep: before.sweep,
    progress: before.progress,
    sweepRequest: before.sweepRequest,
  });
});

it.each(["failed", "cancelled"] as const)(
  "settles a %s request without a snapshot and ignores its later correlated error",
  (outcome) => {
    const store = createWatchStore(vi.fn());
    store.getState().requestSweepNow();
    const id = store.getState().sweepRequest?.id;
    const progress =
      outcome === "failed"
        ? midSweep({ outcome, code: "save", failure: "Could not save.", nextAttemptAt: after(430) })
        : midSweep({ outcome });
    store.getState().receive(sweepEvent("sweep.progress", progress));
    store
      .getState()
      .receive(
        status(outcome === "failed" ? { ...last, outcome, code: "save" } : { ...last, outcome }),
      );
    expect(store.getState().sweepRequest).toBeNull();
    store.getState().receive({
      ...sweepEvent("error", { code: "host_failed", message: "Host request failed" }, id),
      kind: "response",
    });
    expect(store.getState().sweepRequestError).toBeNull();
  },
);

it("releases a refused request with safe error copy and permits retry", () => {
  const store = createWatchStore(vi.fn());
  store.getState().requestSweepNow();
  const id = store.getState().sweepRequest?.id;
  const error = {
    ...sweepEvent("error", { code: "host_failed", message: "ghp_FixtureSecret" }, "other"),
    kind: "response",
  };
  store.getState().receive(error);
  expect(store.getState().sweepRequest).not.toBeNull();
  store.getState().receive({ ...error, id });
  expect(store.getState().sweepRequest).toBeNull();
  expect(store.getState().sweepRequestError).toBe("Could not request a sweep. Try again.");
  store.getState().requestSweepNow();
  expect(store.getState().sweepRequestError).toBeNull();
});

it.each(["sync", "async"])(
  "surfaces a %s send failure without leaving the request locked",
  async (mode) => {
    const error = new Error("Cannot send");
    const send = vi.fn(() => {
      if (mode === "sync") throw error;
      return Promise.reject(error);
    });
    const store = createWatchStore(send);
    if (mode === "sync") expect(() => store.getState().requestSweepNow()).toThrow(error);
    else await expect(store.getState().requestSweepNow()).rejects.toBe(error);
    expect(store.getState().sweepRequest).toBeNull();
    expect(store.getState().sweepRequestError).toBe("Could not send the sweep request. Try again.");
  },
);

it("drops connection-bound sweep state and ignores the old send's rejection after reconnect", async () => {
  let rejectSend: (error: Error) => void = () => {};
  const send = vi.fn().mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectSend = reject;
      }),
  );
  const store = createWatchStore(send);
  store.getState().receive(sweepEvent("sweep.status", sweepStatus()));
  const pending = store.getState().requestSweepNow();
  store.getState().receive(sweepEvent("sweep.progress", midSweep()));
  store.getState().receive(sweepEvent("host.hello", { pid: 123 }));
  expect(store.getState()).toMatchObject({
    sweep: null,
    progress: null,
    sweepRequest: null,
    sweepRequestError: null,
  });
  store.getState().requestSweepNow();
  const newer = store.getState().sweepRequest;
  rejectSend(new Error("Old connection"));
  await expect(pending).rejects.toThrow("Old connection");
  expect(store.getState().sweepRequest).toBe(newer);
  expect(store.getState().sweepRequestError).toBeNull();
  expect(() =>
    store.getState().receive({
      ...sweepEvent("error", { code: "host_unavailable", message: "Host stopped" }),
      kind: "response",
    }),
  ).toThrow("Host stopped");
  expect(store.getState()).toMatchObject({ sweep: null, sweepRequest: null, progress: null });
});
