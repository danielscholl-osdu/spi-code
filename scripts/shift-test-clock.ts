// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { beforeEach } from "vitest";

// Git Bash drops TZ before it starts a Windows program, so scripts/check names its zone here.
if (process.env.SPI_TEST_ZONE) process.env.TZ = process.env.SPI_TEST_ZONE;

const RealDate = globalThis.Date;
const offset = 400 * 24 * 60 * 60 * 1_000;

// Keep real timers and a ticking clock; explicit dates and test-owned fake clocks stay intact.
const ShiftedDate = new Proxy(RealDate, {
  construct(target, args, newTarget) {
    return Reflect.construct(target, args.length ? args : [target.now() + offset], newTarget);
  },
  apply() {
    return new RealDate(RealDate.now() + offset).toString();
  },
  get(target, key, receiver) {
    return key === "now" ? () => RealDate.now() + offset : Reflect.get(target, key, receiver);
  },
});

globalThis.Date = ShiftedDate;
beforeEach(() => {
  // Vitest's useRealTimers/unstubAllGlobals can restore the original Date between tests.
  if (globalThis.Date === RealDate) globalThis.Date = ShiftedDate;
});
