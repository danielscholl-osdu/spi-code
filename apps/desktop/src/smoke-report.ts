// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";

export interface SmokeReport {
  mainPid: number;
  hostPid: number;
  restartedHostPid: number;
  mainNodeVersion: string;
  hostNodeVersion: string;
  sqliteIsTransaction: true;
  rendererRoundTrip: true;
  malformed: "rejected";
  rowSurvived: true;
  listeners: "none";
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
  assert.equal(report.malformed, "rejected");
  assert.equal(report.rowSurvived, true);
  assert.equal(report.listeners, "none");
}
