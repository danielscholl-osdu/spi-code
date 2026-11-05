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
  reloadRoundTrip: true,
  permissionDenied: true,
  permissionQueryDenied: true,
  malformed: "rejected",
  rowSurvived: true,
  listeners: [],
  tools: APPENDIX_A_TOOLS.map(({ name, tier }) => ({
    name,
    outcome: tier === "Read" ? "completed" : "refused",
  })),
  deniedBuiltIn: { name: "builtin:shell", outcome: "refused" },
  supervision: {
    signal: "SIGKILL",
    hostPids: [102, 103, 104, 105, 106, 107, 108, 109],
    channelTransfers: 9,
    fromCursor: 1,
    resumedCursor: 2,
    persistedCursors: [1, 2],
    sameRenderer: true,
    freshChannel: true,
    giveUpAcrossReload: true,
    reloadExactlyOnce: true,
    lateSubframeNoReconnect: true,
    canceledNavigationNoReconnect: true,
  },
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
  { listeners: ["TCP *:1234 (LISTEN)"] },
  { sqliteIsTransaction: false },
  { rendererRoundTrip: false },
  { reloadRoundTrip: false },
  { permissionDenied: false },
  { permissionQueryDenied: false },
  { hostNodeVersion: "22.15.0" },
  { mainNodeVersion: "invalid" },
  { tools: report.tools.slice(1) },
  { tools: [...report.tools, report.tools[0]] },
  { tools: report.tools.map((tool) => ({ ...tool, outcome: "completed" })) },
  { deniedBuiltIn: { name: "builtin:shell", outcome: "completed" } },
  { deniedBuiltIn: undefined },
  { supervision: undefined },
])("rejects a failed smoke check: %j", (failure) => {
  expect(() => assertSmokeReport({ ...report, ...failure })).toThrow();
});

it.each([
  { signal: "SIGTERM" },
  { hostPids: [102, 103] },
  { hostPids: [102, 103, 104, 105, 106, 107, 108, 108] },
  { channelTransfers: 8 },
  { fromCursor: 0 },
  { resumedCursor: 1 },
  { persistedCursors: [2] },
  { sameRenderer: false },
  { freshChannel: false },
  { giveUpAcrossReload: false },
  { reloadExactlyOnce: false },
  { lateSubframeNoReconnect: false },
  { canceledNavigationNoReconnect: false },
])("rejects incomplete supervision evidence: %j", (failure) => {
  expect(() =>
    assertSmokeReport({ ...report, supervision: { ...report.supervision, ...failure } }),
  ).toThrow();
});
