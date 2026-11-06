// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { setTimeout as delay } from "node:timers/promises";
import { type Exec, execText } from "./smoke-listeners.js";

export const DESCENDANT_CAPTURE_MS = 1000;
export const DESCENDANT_REAP_MS = 500;
/** Capture, the host's 2 s grace and 1 s kill wait, then the reap's own wait; the reap never extends it. */
export const QUIT_BUDGET_MS = 4500;

/** A pid with its start time, so a pid reused by an unrelated process never matches. */
export interface ProcessIdentity {
  pid: number;
  started: string;
}

export type Identify = (pids: readonly number[], timeoutMs: number) => Promise<Map<number, string>>;

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

function windowsIdentities(text: string): ProcessIdentity[] {
  return text
    .split(/[\s,]+/)
    .map((pair) => /^(\d+):(\d+)$/.exec(pair))
    .filter((match) => match !== null)
    .map(([, pid, started]) => ({ pid: Number(pid), started: started ?? "" }));
}

function posixRows(text: string, columns: 2 | 3): { pid: number; ppid: number; started: string }[] {
  const row = columns === 3 ? /^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/ : /^\s*(\d+)\s+()(\S.*?)\s*$/;
  return text.split("\n").flatMap((line) => {
    const match = row.exec(line);
    if (!match) return [];
    const [, pid, ppid, started = ""] = match;
    return [{ pid: Number(pid), ppid: Number(ppid), started }];
  });
}

const windowsIdentity = '"$($_.ProcessId):$($_.CreationDate.ToFileTimeUtc())"';

/** Reads the start time of each pid that is still running; a pid that is gone has no entry. */
export function identifyProcesses({
  platform = process.platform,
  exec = execText,
}: TreeOptions = {}): Identify {
  return async (targets, timeoutMs) => {
    if (!targets.length) return new Map();
    if (platform === "win32") {
      const filter = targets.map((pid) => `ProcessId=${pid}`).join(" OR ");
      const script = [
        '$ErrorActionPreference = "Stop"',
        `(@(Get-CimInstance Win32_Process -Filter "${filter}") | ForEach-Object { ${windowsIdentity} }) -join ","`,
      ].join("\n");
      const result = await exec(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        timeoutMs,
      );
      if (result.status !== 0) throw new Error(`Process query failed: ${result.stderr.trim()}`);
      return new Map(windowsIdentities(result.stdout).map(({ pid, started }) => [pid, started]));
    }
    const result = await exec("ps", ["-o", "pid=,lstart=", "-p", targets.join(",")], timeoutMs);
    if (result.status === 1 && !result.stdout.trim()) return new Map();
    if (result.status !== 0) throw new Error(`ps failed: ${result.stderr.trim()}`);
    return new Map(posixRows(result.stdout, 2).map(({ pid, started }) => [pid, started]));
  };
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
): Promise<ProcessIdentity[]> {
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
      `($found | ForEach-Object { ${windowsIdentity} }) -join ","`,
    ].join("\n");
    const result = await exec(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      remaining(),
    );
    if (result.status !== 0) throw new Error(`Process query failed: ${result.stderr.trim()}`);
    return windowsIdentities(result.stdout);
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
  if (!found.length) return [];
  // One ps call reads each start time with its parent, so a pid reused since pgrep is dropped.
  const result = await exec(
    "ps",
    ["-o", "pid=,ppid=,lstart=", "-p", [root, ...found].join(",")],
    remaining(),
  );
  if (result.status !== 0 && result.status !== 1)
    throw new Error(`ps failed: ${result.stderr.trim()}`);
  const rows = posixRows(result.stdout, 3);
  const tree = new Set([root]);
  const descendants: ProcessIdentity[] = [];
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows) {
      if (tree.has(row.pid) || !tree.has(row.ppid)) continue;
      tree.add(row.pid);
      descendants.push({ pid: row.pid, started: row.started });
      grew = true;
    }
  }
  return descendants;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Kills each recorded process whose identity still matches, read just before the kill, and
 * returns the ones still running as themselves once the wait ends. A pid that is gone or now
 * belongs to another process is never signalled.
 */
export async function reapProcesses(
  targets: readonly ProcessIdentity[],
  {
    platform = process.platform,
    exec = execText,
    now = () => performance.now(),
    identify = identifyProcesses({ platform, exec }),
    kill = platform === "win32"
      ? async (pid: number, timeoutMs: number) => {
          await exec("taskkill.exe", ["/pid", String(pid), "/F"], timeoutMs);
        }
      : (pid: number) => {
          process.kill(pid, "SIGKILL");
        },
    alive = isAlive,
    sleep = (ms: number) => delay(ms),
    waitMs = DESCENDANT_REAP_MS,
  }: TreeOptions & {
    identify?: Identify;
    kill?(pid: number, timeoutMs: number): void | Promise<void>;
    alive?(pid: number): boolean;
    sleep?(ms: number): Promise<unknown>;
    waitMs?: number;
  } = {},
): Promise<ProcessIdentity[]> {
  const deadline = now() + waitMs;
  const remaining = () => Math.max(1, Math.floor(deadline - now()));
  const unchanged = async (list: readonly ProcessIdentity[]) => {
    const running = list.filter(({ pid }) => alive(pid));
    if (!running.length) return [];
    const current = await identify(
      running.map(({ pid }) => pid),
      remaining(),
    );
    return running.filter(({ pid, started }) => current.get(pid) === started);
  };
  const confirmed = await unchanged(targets);
  await Promise.all(
    confirmed.map(async ({ pid }) => {
      try {
        await kill(pid, remaining());
      } catch {}
    }),
  );
  let survivors = confirmed;
  try {
    survivors = await unchanged(survivors);
    while (survivors.length && now() < deadline) {
      await sleep(25);
      survivors = await unchanged(survivors);
    }
  } catch {}
  return survivors;
}

/**
 * Captures the host's descendants before stopping it, then kills any that outlive it, whether the
 * host exited on SIGTERM, a hard kill or Electron's own termination. The reap gets what is left of
 * the quit budget. Survivors are logged rather than thrown: they never held the run store, so they
 * do not block lease release.
 */
export async function stopHostTree(
  hostPid: number | undefined,
  stop: () => Promise<void>,
  {
    capture = captureDescendants,
    reap = (targets, waitMs) => reapProcesses(targets, { waitMs }),
    log = console.warn,
    now = () => performance.now(),
  }: {
    capture?(pid: number): Promise<ProcessIdentity[]>;
    reap?(targets: readonly ProcessIdentity[], waitMs: number): Promise<ProcessIdentity[]>;
    log?(message: string): void;
    now?(): number;
  } = {},
): Promise<void> {
  const started = now();
  let descendants: ProcessIdentity[] = [];
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
      try {
        const waitMs = QUIT_BUDGET_MS - (now() - started);
        if (waitMs <= 0) {
          log(
            `Host descendants not reaped: the ${QUIT_BUDGET_MS} ms quit budget is spent (${descendants.map(({ pid }) => pid).join(", ")})`,
          );
        } else {
          const survivors = await reap(descendants, waitMs);
          if (survivors.length)
            log(`Host descendants survived quit: ${survivors.map(({ pid }) => pid).join(", ")}`);
        }
      } catch (error) {
        log(`Host descendants not reaped: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
}
