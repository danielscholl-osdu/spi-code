// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, it, vi } from "vitest";
import { smokeClock } from "./smoke-supervision.js";

it("has no accelerated supervisor hook outside explicit smoke mode", () => {
  expect(smokeClock(["electron", ".", "--stub-model"])).toBeUndefined();
  expect(smokeClock(["electron", ".", "--live-report", "proof.json"])).toBeUndefined();
});

it("keeps the first recovery delay and stable window real, accelerating only the give-up probe", () => {
  vi.useFakeTimers();
  try {
    const clock = smokeClock(["electron", ".", "--smoke"]);
    expect(clock).toBeDefined();
    const recovered = vi.fn();
    const stable = vi.fn();
    clock?.schedule(500, recovered);
    vi.advanceTimersByTime(499);
    expect(recovered).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(recovered).toHaveBeenCalledOnce();
    clock?.accelerate();
    clock?.schedule(10000, recovered);
    const cancel = clock?.schedule(10000, recovered);
    cancel?.();
    clock?.schedule(60000, stable);
    vi.advanceTimersByTime(5);
    expect(recovered).toHaveBeenCalledTimes(2);
    expect(stable).not.toHaveBeenCalled();
    vi.advanceTimersByTime(59995);
    expect(stable).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
