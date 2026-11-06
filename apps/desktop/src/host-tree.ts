// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { setTimeout as delay } from "node:timers/promises";
import { type Exec, execText } from "./smoke-listeners.js";

export const DESCENDANT_CAPTURE_MS = 1000;
export const DESCENDANT_REAP_MS = 500;

interface TreeOptions {
  platform?: NodeJS.Platform;
  exec?: Exec;
  now?(): number;
}

function pids(text: string): number[] {
  return text
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number)
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

/** Walks down from the host only, so the host must still be alive: orphans lose their parent. */
export async function captureDescendants(
  root: number,
  {
    platform = process.platform,
    exec = execText,
    now = () => performance.now(),
    timeoutMs = DESCENDANT_CAPTURE_MS,
  }: TreeOptions & { timeoutMs?: number } = {},
): Promise<number[]> {
  if (!Number.isSafeInteger(root) || root <= 0) throw new Error(`Invalid host pid: ${root}`);
  const deadline = now() + timeoutMs;
  const remaining = () => {
    const left = Math.floor(deadline - now());
    if (left <= 0) throw new Error(`Host descendants not captured within ${timeoutMs} ms`);
    return left;
  };
  if (platform === "win32") {
    // Windows keeps a dead parent's id on its children, so a reused id must not adopt older processes.
    const script = [
      '$ErrorActionPreference = "Stop"',
      `$queue = @(Get-CimInstance Win32_Process -Filter "ProcessId=${root}")`,
      "$found = @()",
      "while ($queue.Count) {",
      "  $next = @()",
      "  foreach ($p in $queue) {",
      '    $next += @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($p.ProcessId)" | Where-Object { $_.CreationDate -ge $p.CreationDate })',
      "  }",
      "  $found += $next",
      "  $queue = $next",
      "}",
      '($found | ForEach-Object { $_.ProcessId }) -join ","',
    ].join("\n");
    const result = await exec(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      remaining(),
    );
    if (result.status !== 0) throw new Error(`Process query failed: ${result.stderr.trim()}`);
    return pids(result.stdout);
  }
  const found: number[] = [];
  let frontier = [root];
  while (frontier.length) {
    const next: number[] = [];
    for (const parent of frontier) {
      const result = await exec("pgrep", ["-P", String(parent)], remaining());
      if (result.status === 1) continue;
      if (result.status !== 0) throw new Error(`pgrep failed: ${result.stderr.trim()}`);
      next.push(...pids(result.stdout).filter((pid) => !found.includes(pid) && pid !== root));
    }
    found.push(...next);
    frontier = next;
  }
  return found;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Kills each pid and returns the ones still alive once the wait ends. */
export async function reapProcesses(
  targets: readonly number[],
  {
    platform = process.platform,
    exec = execText,
    now = () => performance.now(),
    kill = (pid: number) => process.kill(pid, "SIGKILL"),
    alive = isAlive,
    sleep = (ms: number) => delay(ms),
    waitMs = DESCENDANT_REAP_MS,
  }: TreeOptions & {
    kill?(pid: number): void;
    alive?(pid: number): boolean;
    sleep?(ms: number): Promise<unknown>;
    waitMs?: number;
  } = {},
): Promise<number[]> {
  const deadline = now() + waitMs;
  for (const pid of targets.filter(alive)) {
    try {
      if (platform === "win32")
        await exec(
          "taskkill.exe",
          ["/pid", String(pid), "/T", "/F"],
          Math.max(1, Math.floor(deadline - now())),
        );
      else kill(pid);
    } catch {}
  }
  let survivors = targets.filter(alive);
  while (survivors.length && now() < deadline) {
    await sleep(25);
    survivors = survivors.filter(alive);
  }
  return survivors;
}

/**
 * Captures the host's descendants before stopping it, then kills any that outlive it, whether the
 * host exited on SIGTERM, a hard kill or Electron's own termination. Survivors are logged rather
 * than thrown: they never held the run store, so they do not block lease release.
 */
export async function stopHostTree(
  hostPid: number | undefined,
  stop: () => Promise<void>,
  {
    capture = captureDescendants,
    reap = reapProcesses,
    log = console.warn,
  }: {
    capture?(pid: number): Promise<number[]>;
    reap?(pids: readonly number[]): Promise<number[]>;
    log?(message: string): void;
  } = {},
): Promise<void> {
  let descendants: number[] = [];
  if (hostPid !== undefined) {
    try {
      descendants = await capture(hostPid);
    } catch (error) {
      log(`Host descendants not captured: ${error instanceof Error ? error.message : error}`);
    }
  }
  try {
    await stop();
  } finally {
    if (descendants.length) {
      const survivors = await reap(descendants);
      if (survivors.length) log(`Host descendants survived quit: ${survivors.join(", ")}`);
    }
  }
}
