// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { type ExecFileSyncOptionsWithStringEncoding, execFileSync } from "node:child_process";

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

interface ProcessRow {
  pid: number;
  parentPid: number;
  command: string;
}

function processTree(): ProcessRow[] {
  const options: ExecFileSyncOptionsWithStringEncoding = {
    encoding: "utf8",
    timeout: 10000,
    stdio: ["ignore", "pipe", "pipe"],
  };
  if (process.platform === "win32") {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        '$ErrorActionPreference = "Stop"; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
      ],
      options,
    );
    const parsed: unknown = JSON.parse(output);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((row: unknown) => {
      assert(row && typeof row === "object", "Invalid Windows process row");
      assert("ProcessId" in row && Number.isSafeInteger(row.ProcessId));
      assert("ParentProcessId" in row && Number.isSafeInteger(row.ParentProcessId));
      assert(
        "CommandLine" in row && (row.CommandLine === null || typeof row.CommandLine === "string"),
      );
      return {
        pid: Number(row.ProcessId),
        parentPid: Number(row.ParentProcessId),
        command: row.CommandLine ?? "",
      };
    });
  }
  return execFileSync("ps", ["-axww", "-o", "pid=,ppid=,command="], options)
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      assert(match, "Invalid ps process row");
      return { pid: Number(match[1]), parentPid: Number(match[2]), command: match[3] ?? "" };
    });
}

export function assertNoProcessListeners(mainPid: number, hostPid: number, runtimePath?: string) {
  const processes = processTree();
  assert(
    processes.some(({ pid }) => pid === mainPid),
    "App main process is missing",
  );
  function descendants(root: number): ProcessRow[] {
    const pids = new Set([root]);
    let size: number;
    do {
      size = pids.size;
      for (const { pid, parentPid } of processes) {
        if (pids.has(parentPid)) pids.add(pid);
      }
    } while (pids.size !== size);
    return processes.filter(({ pid }) => pid !== root && pids.has(pid));
  }
  const children = descendants(mainPid);
  assert(
    children.some(({ pid }) => pid === hostPid),
    "Smoke host is outside the app process tree",
  );
  const rendererPids = children
    .filter(({ command }) => /(?:^|\s)--type=renderer(?:\s|$)/.test(command))
    .map(({ pid }) => pid);
  assert(rendererPids.length > 0, "No renderer in the app process tree");
  const runtimePids = runtimePath
    ? descendants(hostPid)
        .filter(({ command }) => command.includes(runtimePath))
        .map(({ pid }) => pid)
    : [];
  assert(!runtimePath || runtimePids.length > 0, "No Copilot runtime in the host process tree");
  const pids = new Set([mainPid, hostPid, ...runtimePids, ...rendererPids]);
  const listeners = [...pids].flatMap(listenersOf);
  assert.deepEqual(listeners, [], "TCP listener found in the app process tree");
  return { mainPid, hostPid, runtimePids, rendererPids, listeners };
}
