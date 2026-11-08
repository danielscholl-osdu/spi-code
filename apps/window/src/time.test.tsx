// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { clockTime, Time, TimedText } from "./time.js";

// 2026-11-06 09:04 in Chicago (UTC-6), 2026-11-07 00:04 in Tokyo (UTC+9).
const now = Date.parse("2026-11-06T15:04:00Z");
const chicago = { now, timeZone: "America/Chicago" };
const tokyo = { now, timeZone: "Asia/Tokyo" };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("reads a past time today as a bare 24-hour clock time", () => {
  expect(clockTime("2026-11-06T14:02:00Z", chicago)).toBe("08:02");
  expect(
    clockTime("2026-11-06T22:30:00-06:00", { ...chicago, now: Date.parse("2026-11-07T05:00:00Z") }),
  ).toBe("22:30");
  expect(clockTime(now, chicago)).toBe("09:04");
});

it("adds a relative hint to a future time", () => {
  expect(clockTime("2026-11-06T15:36:00Z", chicago)).toBe("09:36 (in 32 min)");
  expect(clockTime("2026-11-06T15:04:20Z", chicago)).toBe("09:04 (in 1 min)");
  expect(clockTime("2026-11-06T17:04:00Z", chicago)).toBe("11:04 (in 2 h)");
  expect(clockTime("2026-11-06T17:19:00Z", chicago)).toBe("11:19 (in 2 h 15 min)");
  expect(clockTime("2026-11-10T15:04:00Z", chicago)).toBe("11-10 09:04 (in 4 d)");
});

it("dates a time across midnight, before and after", () => {
  const late = { ...chicago, now: Date.parse("2026-11-07T05:50:00Z") };
  expect(clockTime("2026-11-07T06:10:00Z", late)).toBe("11-07 00:10 (in 20 min)");
  const early = { ...chicago, now: Date.parse("2026-11-07T06:10:00Z") };
  expect(clockTime("2026-11-07T05:50:00Z", early)).toBe("11-06 23:50");
});

it("reads one instant in the window's zone, not UTC", () => {
  expect(clockTime("2026-11-06T14:02:00Z", chicago)).toBe("08:02");
  expect(clockTime("2026-11-06T14:02:00Z", tokyo)).toBe("11-06 23:02");
  expect(clockTime("2026-11-06T15:30:00Z", tokyo)).toBe("00:30 (in 26 min)");
});

it("passes through what it cannot read", () => {
  expect(clockTime("next sync", chicago)).toBe("next sync");
  expect(clockTime(Number.NaN, chicago)).toBe("");
});

it("renders a time element that keeps the ISO value in datetime", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const at = new Date(now + 32 * 60_000).toISOString();
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<Time at={at} />));
  const time = container.querySelector("time");
  expect(time?.getAttribute("datetime")).toBe(at);
  expect(time?.textContent).toBe(clockTime(at, { now }));
  expect(time?.textContent).toMatch(/^\d\d:\d\d \(in 32 min\)$/);
  await act(async () => root.unmount());
});

it("reads each ISO instant inside composed text as a time element", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const text = "2026-11-06T04:07:05.000Z to 2026-11-06T04:20:16+00:00 · held";
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<TimedText text={text} />));
  const times = [...container.querySelectorAll("time")];
  expect(times.map((time) => time.dateTime)).toEqual([
    "2026-11-06T04:07:05.000Z",
    "2026-11-06T04:20:16+00:00",
  ]);
  expect(container.textContent).toBe(
    `${clockTime("2026-11-06T04:07:05.000Z")} to ${clockTime("2026-11-06T04:20:16+00:00")} · held`,
  );
  await act(async () => root.render(<TimedText text="No time here" />));
  expect(container.innerHTML).toBe("No time here");
  await act(async () => root.unmount());
});
