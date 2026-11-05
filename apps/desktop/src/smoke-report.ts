// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { APPENDIX_A_TOOLS } from "@spi-code/host";

export interface SmokeReport {
  mainPid: number;
  hostPid: number;
  restartedHostPid: number;
  mainNodeVersion: string;
  hostNodeVersion: string;
  sqliteIsTransaction: true;
  rendererRoundTrip: boolean;
  reloadRoundTrip: boolean;
  permissionDenied: boolean;
  malformed: "rejected" | "accepted";
  rowSurvived: true;
  listeners: string[];
  tools: { name: string; outcome: "completed" | "refused" | "error" }[];
  deniedBuiltIn: { name: string; outcome: "refused" };
}

export function assertSmokeReport(value: unknown): asserts value is SmokeReport {
  assert(value !== null && typeof value === "object", "Smoke report must be an object");
  const report = value as Record<string, unknown>;
  for (const key of ["mainPid", "hostPid", "restartedHostPid"]) {
    assert(Number.isSafeInteger(report[key]) && Number(report[key]) > 0, `${key} must be a pid`);
  }
  assert.equal(new Set([report.mainPid, report.hostPid, report.restartedHostPid]).size, 3);
  for (const key of ["mainNodeVersion", "hostNodeVersion"]) {
    assert(typeof report[key] === "string" && /^\d+\.\d+\.\d+$/.test(report[key]));
    const [major, minor] = report[key].split(".").map(Number);
    assert(
      major !== undefined && minor !== undefined && (major > 22 || (major === 22 && minor >= 16)),
    );
  }
  assert.equal(report.sqliteIsTransaction, true);
  assert.equal(report.rendererRoundTrip, true);
  assert.equal(report.reloadRoundTrip, true);
  assert.equal(report.permissionDenied, true);
  assert.equal(report.malformed, "rejected");
  assert.equal(report.rowSurvived, true);
  assert.deepEqual(report.listeners, []);
  assertSmokeTools(report.tools, report.deniedBuiltIn);
}

export function assertSmokeTools(
  value: unknown,
  deniedBuiltIn: unknown,
): asserts deniedBuiltIn is SmokeReport["deniedBuiltIn"] {
  assert(Array.isArray(value));
  const tools = value as SmokeReport["tools"];
  assert.equal(tools.length, APPENDIX_A_TOOLS.length);
  assert.equal(new Set(tools.map(({ name }) => name)).size, APPENDIX_A_TOOLS.length);
  for (const { name, tier } of APPENDIX_A_TOOLS) {
    const observed = tools.find((tool) => tool.name === name);
    assert(observed, `Missing tool: ${name}`);
    assert.equal(observed.outcome, tier === "Read" ? "completed" : "refused");
  }
  assert(deniedBuiltIn !== null && typeof deniedBuiltIn === "object");
  assert("name" in deniedBuiltIn && deniedBuiltIn.name === "builtin:shell");
  assert("outcome" in deniedBuiltIn && deniedBuiltIn.outcome === "refused");
}
