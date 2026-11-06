// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { APPENDIX_A_TOOLS } from "@spi-code/host";
import type { SupervisionReport } from "./smoke-supervision.js";

export interface SmokeReport {
  mainPid: number;
  hostPid: number;
  restartedHostPid: number;
  rendererPids: number[];
  mainNodeVersion: string;
  hostNodeVersion: string;
  sqliteIsTransaction: true;
  rendererRoundTrip: boolean;
  reloadRoundTrip: boolean;
  permissionDenied: boolean;
  permissionQueryDenied: boolean;
  malformed: "rejected" | "accepted";
  rowSurvived: true;
  listeners: string[];
  tools: { name: string; outcome: "completed" | "refused" | "error" }[];
  deniedBuiltIn: { name: string; outcome: "refused" };
  supervision: SupervisionReport;
}

export function assertSmokeReport(value: unknown): asserts value is SmokeReport {
  assert(value !== null && typeof value === "object", "Smoke report must be an object");
  const report = value as Record<string, unknown>;
  for (const key of ["mainPid", "hostPid", "restartedHostPid"]) {
    assert(Number.isSafeInteger(report[key]) && Number(report[key]) > 0, `${key} must be a pid`);
  }
  assert.equal(new Set([report.mainPid, report.hostPid, report.restartedHostPid]).size, 3);
  assert(Array.isArray(report.rendererPids) && report.rendererPids.length > 0);
  for (const pid of report.rendererPids) {
    assert(Number.isSafeInteger(pid) && pid > 0, "rendererPids must contain pids");
    assert(![report.mainPid, report.hostPid, report.restartedHostPid].includes(pid));
  }
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
  assert.equal(report.permissionQueryDenied, true);
  assert.equal(report.malformed, "rejected");
  assert.equal(report.rowSurvived, true);
  assert.deepEqual(report.listeners, []);
  assertSmokeTools(report.tools, report.deniedBuiltIn);
  assert(report.supervision !== null && typeof report.supervision === "object");
  const supervision = report.supervision as Record<string, unknown>;
  assert.equal(supervision.signal, "SIGKILL");
  assert(Array.isArray(supervision.hostPids) && supervision.hostPids.length === 8);
  for (const pid of supervision.hostPids) assert(Number.isSafeInteger(pid) && pid > 0);
  assert.equal(new Set(supervision.hostPids).size, 8);
  assert.equal(supervision.hostPids[0], report.hostPid);
  assert.equal(supervision.hostPids[1], report.restartedHostPid);
  assert.equal(supervision.channelTransfers, 9);
  assert(Number.isSafeInteger(supervision.fromCursor) && Number(supervision.fromCursor) > 0);
  assert(
    Number.isSafeInteger(supervision.resumedCursor) &&
      Number(supervision.resumedCursor) > Number(supervision.fromCursor),
  );
  assert.deepEqual(supervision.persistedCursors, [
    supervision.fromCursor,
    supervision.resumedCursor,
  ]);
  assert.equal(supervision.sameRenderer, true);
  assert.equal(supervision.freshChannel, true);
  assert.equal(supervision.giveUpAcrossReload, true);
  assert.equal(supervision.reloadExactlyOnce, true);
  assert.equal(supervision.lateSubframeNoReconnect, true);
  assert.equal(supervision.canceledNavigationNoReconnect, true);
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
