// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

export function windowsListeners(output: string, pid: number): string[] {
  const rows = output.split(/\r?\n/).filter((line) => /^\s*TCP\s/i.test(line));
  return rows.filter((line) => {
    const fields = line.trim().split(/\s+/);
    assert(
      fields.length === 5 && /^\d+$/.test(fields[4] ?? ""),
      `Unexpected netstat TCP row: ${line}`,
    );
    // netstat translates state labels; a listening socket has a zero foreign port.
    return Number(fields[4]) === pid && /:0$/.test(fields[2] ?? "");
  });
}

export function listenersOf(pid: number): string[] {
  process.kill(pid, 0);
  let listeners: string[];
  if (process.platform === "win32") {
    listeners = windowsListeners(
      execFileSync("netstat.exe", ["-ano", "-p", "tcp"], {
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
