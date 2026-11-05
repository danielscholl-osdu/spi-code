// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, it } from "vitest";
import { APPENDIX_A_TOOLS } from "../../../packages/host/src/tools/tool-names.js";
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
  tools: APPENDIX_A_TOOLS.map(({ name, tier }) => ({
    name,
    outcome: tier === "Read" ? "completed" : "refused",
  })),
  deniedBuiltIn: { name: "builtin:shell", outcome: "refused" },
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
  { tools: report.tools.slice(1) },
  { tools: [...report.tools, report.tools[0]] },
  { tools: report.tools.map((tool) => ({ ...tool, outcome: "completed" })) },
  { deniedBuiltIn: { name: "builtin:shell", outcome: "completed" } },
  { deniedBuiltIn: undefined },
])("rejects a failed smoke check: %j", (failure) => {
  expect(() => assertSmokeReport({ ...report, ...failure })).toThrow();
});
