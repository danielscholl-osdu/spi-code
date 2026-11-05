// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const englishTcpStates = new Set([
  "BOUND",
  "CLOSED",
  "LISTENING",
  "SYN_SENT",
  "SYN_RECEIVED",
  "ESTABLISHED",
  "FIN_WAIT_1",
  "FIN_WAIT_2",
  "CLOSE_WAIT",
  "CLOSING",
  "LAST_ACK",
  "TIME_WAIT",
  "DELETE_TCB",
]);

export function windowsListeners(output: string, pid: number): string[] {
  const rows = output.split(/\r?\n/).filter((line) => /^\s*TCP(?:v6)?\s/i.test(line));
  return rows.filter((line) => {
    const fields = line.trim().split(/\s+/);
    assert(
      fields.length === 5 && /^\d+$/.test(fields[4] ?? ""),
      `Unexpected netstat TCP row: ${line}`,
    );
    assert(englishTcpStates.has(fields[3] ?? ""), `Unexpected netstat TCP state: ${fields[3]}`);
    return Number(fields[4]) === pid && fields[3] === "LISTENING";
  });
}

export function listenersOf(pid: number): string[] {
  process.kill(pid, 0);
  let listeners: string[];
  if (process.platform === "win32") {
    listeners = windowsListeners(
      execFileSync("netstat.exe", ["-ano"], {
        encoding: "utf8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "pipe"],
      }),
      pid,
    );
  } else {
    try {
      const output = execFileSync(
        "lsof",
        ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"],
        { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] },
      );
      listeners = output.trim() ? output.trim().split("\n") : [];
    } catch (error) {
      const noMatches =
        error !== null &&
        typeof error === "object" &&
        "status" in error &&
        error.status === 1 &&
        "stdout" in error &&
        error.stdout === "" &&
        "stderr" in error &&
        error.stderr === "";
      if (!noMatches) throw error;
      listeners = [];
    }
  }
  process.kill(pid, 0);
  return listeners;
}
