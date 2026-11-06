// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { execFile } from "node:child_process";

export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type Exec = (file: string, args: readonly string[], timeout: number) => Promise<ExecResult>;

export const execText: Exec = (file, args, timeout) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      { encoding: "utf8", timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) resolve({ status: 0, stdout, stderr });
        else if (typeof error.code === "number" && !error.killed && !error.signal)
          resolve({ status: error.code, stdout, stderr });
        else reject(error);
      },
    );
    child.stdin?.end();
  });

async function run(exec: Exec, file: string, args: readonly string[], timeout: number) {
  const result = await exec(file, args, timeout);
  assert.equal(result.status, 0, `${file} failed (${result.status}): ${result.stderr.trim()}`);
  return result.stdout;
}

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

export function windowsListeners(output: string, pids: Iterable<number>): string[] {
  const scanned = new Set(pids);
  const rows = output.split(/\r?\n/).filter((line) => /^\s*TCP(?:v6)?\s/i.test(line));
  return rows.filter((line) => {
    const fields = line.trim().split(/\s+/);
    assert(
      fields.length === 5 && /^\d+$/.test(fields[4] ?? ""),
      `Unexpected netstat TCP row: ${line}`,
    );
    assert(englishTcpStates.has(fields[3] ?? ""), `Unexpected netstat TCP state: ${fields[3]}`);
    return scanned.has(Number(fields[4])) && fields[3] === "LISTENING";
  });
}

export async function listenersOf(
  pids: readonly number[],
  exec: Exec = execText,
): Promise<string[]> {
  for (const pid of pids) process.kill(pid, 0);
  let listeners: string[];
  if (process.platform === "win32") {
    listeners = windowsListeners(await run(exec, "netstat.exe", ["-ano"], 10000), pids);
  } else {
    const result = await exec(
      "lsof",
      ["-nP", "-a", "-p", pids.join(","), "-iTCP", "-sTCP:LISTEN"],
      5000,
    );
    const noMatches = result.status === 1 && result.stdout === "" && result.stderr === "";
    assert(
      result.status === 0 || noMatches,
      `lsof failed (${result.status}): ${result.stderr.trim()}`,
    );
    listeners = result.stdout
      .split("\n")
      .filter((line) => line.trim() && !/^COMMAND\s+PID\s/.test(line));
  }
  for (const pid of pids) process.kill(pid, 0);
  return listeners;
}

interface ProcessRow {
  pid: number;
  parentPid: number;
  command: string;
}

async function processTree(exec: Exec): Promise<ProcessRow[]> {
  if (process.platform === "win32") {
    const output = await run(
      exec,
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        '$ErrorActionPreference = "Stop"; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
      ],
      10000,
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
  return (await run(exec, "ps", ["-axww", "-o", "pid=,ppid=,command="], 10000))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      assert(match, "Invalid ps process row");
      return { pid: Number(match[1]), parentPid: Number(match[2]), command: match[3] ?? "" };
    });
}

export async function assertNoProcessListeners(
  mainPid: number,
  hostPid: number,
  options: { runtimePath?: string; exec?: Exec } = {},
) {
  const { runtimePath, exec = execText } = options;
  const processes = await processTree(exec);
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
  const pids = [...new Set([mainPid, hostPid, ...runtimePids, ...rendererPids])];
  const listeners = await listenersOf(pids, exec);
  assert.deepEqual(listeners, [], "TCP listener found in the app process tree");
  return { mainPid, hostPid, runtimePids, rendererPids, listeners };
}
