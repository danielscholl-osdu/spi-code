// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, it } from "vitest";
import { assertSmokeReport, type SmokeReport } from "./smoke-report.js";

const report: SmokeReport = {
  mainPid: 101,
  hostPid: 102,
  restartedHostPid: 103,
  mainNodeVersion: "24.15.0",
  hostNodeVersion: "24.15.0",
  sqliteIsTransaction: true,
  rendererRoundTrip: true,
  malformed: "rejected",
  rowSurvived: true,
  listeners: "none",
};

it("accepts the terminal smoke report", () => {
  expect(() => assertSmokeReport(JSON.parse(JSON.stringify(report)))).not.toThrow();
});

it.each([
  { hostPid: 101 },
  { restartedHostPid: 102 },
  { hostPid: -1 },
  { malformed: "accepted" },
  { rowSurvived: false },
  { listeners: "present" },
  { sqliteIsTransaction: false },
  { rendererRoundTrip: false },
  { hostNodeVersion: "22.15.0" },
  { mainNodeVersion: "invalid" },
])("rejects a failed smoke check: %j", (failure) => {
  expect(() => assertSmokeReport({ ...report, ...failure })).toThrow();
});
