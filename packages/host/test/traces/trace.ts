// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEvent } from "@github/copilot-sdk";

export type HostOp =
  | {
      op: "host";
      action: "send";
      prompt: string;
      attachments?: { name: string; bytes: number }[];
      outcome?: string;
    }
  | { op: "host"; action: "stop" | "restart" };

export type TraceOp =
  | { op: "trace"; scenario: string; sdk: string; scope: string }
  | HostOp
  | { op: "open"; sessionId: string; resumeId?: string }
  | { op: "history"; sessionId: string; events: SessionEvent[] }
  | { op: "send"; sessionId: string }
  | { op: "sent"; sessionId: string; messageId: string; sandbox: unknown }
  | { op: "event"; sessionId: string; event: SessionEvent }
  | {
      op: "permission";
      sessionId: string;
      handler: "request" | "denied";
      request: unknown;
      result?: unknown;
    }
  | { op: "tool"; sessionId: string; name: string; toolCallId: string; arguments: unknown }
  | { op: "abort" | "release"; sessionId: string }
  | { op: "setModel"; sessionId: string; model: string; reasoningEffort?: string; result?: string };

export const SCENARIOS = [
  "two-messages",
  "cold-resume",
  "stop-mid-stream",
  "spi-tool",
  "denied-write",
  "denied-read",
] as const;
export type Scenario = (typeof SCENARIOS)[number];

// Resolves to the source folder from both test/traces and build/traces.
export const tracesRoot = fileURLToPath(new URL("../../test/traces/", import.meta.url));

function packageVersion(from: string): string {
  let directory = from;
  for (;;) {
    const candidate = join(directory, "node_modules", "@github", "copilot-sdk", "package.json");
    try {
      return (JSON.parse(readFileSync(candidate, "utf8")) as { version: string }).version;
    } catch {
      const parent = dirname(directory);
      if (parent === directory) throw new Error("The Copilot SDK is not installed.");
      directory = parent;
    }
  }
}

export function installedSdkVersion(): string {
  return packageVersion(dirname(dirname(tracesRoot)));
}

export function traceVersions(): string[] {
  return readdirSync(tracesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => name);
}

export function tracePath(version: string, scenario: string): string {
  return join(tracesRoot, version, `${scenario}.jsonl`);
}

export function parseTrace(text: string): TraceOp[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as TraceOp);
}

export function readTrace(version: string, scenario: string): TraceOp[] {
  return parseTrace(readFileSync(tracePath(version, scenario), "utf8"));
}
