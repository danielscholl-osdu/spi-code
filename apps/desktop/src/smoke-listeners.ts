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
      {
        encoding: "utf8",
        timeout,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, LC_ALL: "C" },
      },
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

interface ListenerRow {
  pid: number;
  listener: string;
}

function windowsListenerRows(output: string): ListenerRow[] {
  const rows = output.split(/\r?\n/).filter((line) => /^\s*TCP(?:v6)?\s/i.test(line));
  return rows.flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    assert(
      fields.length === 5 && /^\d+$/.test(fields[4] ?? ""),
      `Unexpected netstat TCP row: ${line}`,
    );
    assert(englishTcpStates.has(fields[3] ?? ""), `Unexpected netstat TCP state: ${fields[3]}`);
    return fields[3] === "LISTENING" ? [{ pid: Number(fields[4]), listener: line }] : [];
  });
}

export function windowsListeners(output: string, pids: Iterable<number>): string[] {
  const scanned = new Set(pids);
  return windowsListenerRows(output)
    .filter(({ pid }) => scanned.has(pid))
    .map(({ listener }) => listener);
}

async function socketSnapshot(
  exec: Exec,
  timeout: number,
  pids?: readonly number[],
): Promise<ListenerRow[]> {
  if (process.platform === "win32") {
    return windowsListenerRows(await run(exec, "netstat.exe", ["-ano"], timeout));
  }
  const result = await exec(
    "lsof",
    ["-nP", ...(pids ? ["-a", "-p", pids.join(",")] : []), "-iTCP", "-sTCP:LISTEN"],
    timeout,
  );
  const noMatches = result.status === 1 && result.stdout === "" && result.stderr === "";
  assert(
    result.status === 0 || noMatches,
    `lsof failed (${result.status}): ${result.stderr.trim()}`,
  );
  return result.stdout
    .split("\n")
    .filter((line) => line.trim() && !/^COMMAND\s+PID\s/.test(line))
    .map((listener) => {
      const pid = Number(listener.trim().split(/\s+/)[1]);
      assert(Number.isSafeInteger(pid) && pid > 0, `Unexpected lsof row: ${listener}`);
      return { pid, listener };
    });
}

export async function listenersOf(
  pids: readonly number[],
  exec: Exec = execText,
): Promise<string[]> {
  const scanned = new Set(pids);
  return (await socketSnapshot(exec, process.platform === "win32" ? 10000 : 5000, pids))
    .filter(({ pid }) => scanned.has(pid))
    .map(({ listener }) => listener);
}

interface ProcessRow {
  pid: number;
  parentPid: number;
  command: string;
  startedAt: number | null;
}

async function processTree(exec: Exec, timeout: number): Promise<ProcessRow[]> {
  if (process.platform === "win32") {
    const output = await run(
      exec,
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        '$ErrorActionPreference = "Stop"; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,@{Name="StartedAt";Expression={if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { $null }}} | ConvertTo-Json -Compress',
      ],
      timeout,
    );
    const parsed: unknown = JSON.parse(output);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((row: unknown) => {
      assert(row && typeof row === "object", "Invalid Windows process row");
      assert("ProcessId" in row && Number.isSafeInteger(row.ProcessId));
      assert("ParentProcessId" in row && Number.isSafeInteger(row.ParentProcessId));
      assert(
        "CommandLine" in row && (row.CommandLine === null || typeof row.CommandLine === "string"),
      );
      assert(
        "StartedAt" in row && (row.StartedAt === null || Number.isSafeInteger(row.StartedAt)),
        "Invalid Windows process start time",
      );
      return {
        pid: Number(row.ProcessId),
        parentPid: Number(row.ParentProcessId),
        command: row.CommandLine ?? "",
        startedAt: row.StartedAt === null ? null : Number(row.StartedAt),
      };
    });
  }
  return (await run(exec, "ps", ["-axww", "-o", "pid=,ppid=,lstart=,command="], timeout))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.*)$/.exec(
        line,
      );
      assert(match, "Invalid ps process row");
      const startedAt = Date.parse(match[3] ?? "");
      assert(Number.isFinite(startedAt), "Invalid ps process start time");
      return {
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        command: match[4] ?? "",
        startedAt,
      };
    });
}

function descendants(root: number, processes: readonly ProcessRow[]): ProcessRow[] {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of processes) {
    const siblings = byParent.get(row.parentPid) ?? [];
    siblings.push(row);
    byParent.set(row.parentPid, siblings);
  }
  const main = processes.find(({ pid }) => pid === root);
  assert(main, `Process ${root} is missing`);
  const visited = new Set([root]);
  const queue = [main];
  for (let index = 0; index < queue.length; index++) {
    const parent = queue[index];
    assert(parent && parent.startedAt !== null, "Missing app process start time");
    for (const child of byParent.get(parent.pid) ?? []) {
      if (visited.has(child.pid)) continue;
      assert(child.startedAt !== null, "Missing app process start time");
      // Windows retains a dead parent's pid; a reused pid must not adopt its older children.
      if (child.startedAt < parent.startedAt) continue;
      visited.add(child.pid);
      queue.push(child);
    }
  }
  return processes.filter(({ pid }) => pid !== root && visited.has(pid));
}

export async function assertNoProcessListeners(
  mainPid: number,
  hostPid: number,
  options: { runtimePath?: string; exec?: Exec } = {},
) {
  const started = performance.now();
  const remaining = () => {
    const timeout = Math.floor(8000 - (performance.now() - started));
    assert(timeout > 0, "Listener scan exceeded 8000 ms");
    return timeout;
  };
  const { runtimePath, exec = execText } = options;
  // Sockets first: exited processes disappear from the tree, and reused pids have a newer birth.
  const socketStartedAt = Date.now();
  const sockets = await socketSnapshot(exec, remaining());
  const processes = await processTree(exec, remaining());
  assert(
    processes.some(({ pid }) => pid === mainPid),
    "App main process is missing",
  );
  const children = descendants(mainPid, processes);
  assert(
    children.some(({ pid }) => pid === hostPid),
    "Smoke host is outside the app process tree",
  );
  const rendererPids = children
    .filter(({ command }) => /(?:^|\s)--type=renderer(?:\s|$)/.test(command))
    .map(({ pid }) => pid);
  assert(rendererPids.length > 0, "No renderer in the app process tree");
  const runtimePids = runtimePath
    ? descendants(hostPid, children)
        .filter(({ command }) => command.includes(runtimePath))
        .map(({ pid }) => pid)
    : [];
  assert(!runtimePath || runtimePids.length > 0, "No Copilot runtime in the host process tree");
  const scannedPids = [mainPid, ...children.map(({ pid }) => pid)];
  const scanned = new Set(scannedPids);
  const sampled = new Set(
    processes
      .filter(
        ({ pid, startedAt }) =>
          scanned.has(pid) && startedAt !== null && startedAt <= socketStartedAt,
      )
      .map(({ pid }) => pid),
  );
  const listeners = sockets.filter(({ pid }) => sampled.has(pid)).map(({ listener }) => listener);
  assert.deepEqual(listeners, [], "TCP listener found in the app process tree");
  remaining();
  const scanDurationMs = performance.now() - started;
  return { mainPid, hostPid, runtimePids, rendererPids, scannedPids, listeners, scanDurationMs };
}
