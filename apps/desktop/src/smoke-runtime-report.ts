// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

export interface RuntimeFailure {
  message: string;
  stack?: string;
}

function describe(error: unknown): string {
  if (error instanceof AggregateError)
    return `${error.message}: ${error.errors.map(describe).join("; ")}`;
  return error instanceof Error ? error.message : String(error);
}

export function publishRuntimeReport(path: string, report: object): void {
  const partial = `${path}.partial`;
  writeFileSync(partial, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(partial, path);
}

/** Only the first host probes the runtime, so a failure must reach the report too. */
export async function publishRuntimeProbe(
  path: string,
  handshake: object,
  probe: () => Promise<unknown>,
): Promise<void> {
  let listenerCheck: unknown;
  try {
    listenerCheck = await probe();
  } catch (error) {
    const failure: RuntimeFailure = {
      message: describe(error),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    };
    publishRuntimeReport(path, { ...handshake, failure });
    throw error;
  }
  publishRuntimeReport(path, { ...handshake, listenerCheck });
}

export async function waitForFile(path: string, timeout: number): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!existsSync(path)) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await sleep(100);
  }
}

export async function waitForRuntimeReport(path: string, timeout: number): Promise<unknown> {
  await waitForFile(path, timeout);
  const report: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (report !== null && typeof report === "object" && "failure" in report) {
    const failure = report.failure as RuntimeFailure;
    const error = new Error(failure.message);
    const frames = failure.stack?.split("\n").filter((line) => /^\s+at /.test(line)) ?? [];
    if (frames.length) error.stack = [`Error: ${failure.message}`, ...frames].join("\n");
    throw error;
  }
  return report;
}
