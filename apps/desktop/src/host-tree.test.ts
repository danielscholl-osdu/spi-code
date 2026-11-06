// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, it, vi } from "vitest";
import { captureDescendants, reapProcesses } from "./host-tree.js";
import type { ExecResult } from "./smoke-listeners.js";

const ok = (stdout: string): ExecResult => ({ status: 0, stdout, stderr: "" });
const none: ExecResult = { status: 1, stdout: "", stderr: "" };

function fakeProcesses(...pids: number[]) {
  const live = new Set(pids);
  return {
    live,
    alive: (pid: number) => live.has(pid),
    kill: vi.fn((pid: number) => {
      live.delete(pid);
    }),
  };
}

it("walks the host's children and grandchildren with pgrep -P only", async () => {
  const tree: Record<string, string> = { "10": "20\n21\n", "20": "30\n" };
  const exec = vi.fn(async (_file: string, args: readonly string[]) => {
    const children = tree[args[1] ?? ""];
    return children ? ok(children) : none;
  });
  await expect(captureDescendants(10, { platform: "darwin", exec })).resolves.toEqual([20, 21, 30]);
  expect(exec.mock.calls.map(([file, args]) => [file, ...args])).toEqual([
    ["pgrep", "-P", "10"],
    ["pgrep", "-P", "20"],
    ["pgrep", "-P", "21"],
    ["pgrep", "-P", "30"],
  ]);
});

it("refuses a failed or overdue capture", async () => {
  await expect(
    captureDescendants(10, {
      platform: "darwin",
      exec: async () => ({ status: 2, stdout: "", stderr: "bad" }),
    }),
  ).rejects.toThrow("pgrep failed: bad");
  let clock = 0;
  await expect(
    captureDescendants(10, {
      platform: "darwin",
      now: () => clock,
      timeoutMs: 100,
      exec: async () => {
        clock += 150;
        return ok("20\n");
      },
    }),
  ).rejects.toThrow("Host descendants not captured within 100 ms");
});

it("captures Windows descendants by ParentProcessId from the host down", async () => {
  const exec = vi.fn(async () => ok("20,21\r\n"));
  await expect(captureDescendants(10, { platform: "win32", exec })).resolves.toEqual([20, 21]);
  const [[file, args]] = exec.mock.calls as unknown as [[string, string[]]];
  expect(file).toBe("powershell.exe");
  expect(args.at(-1)).toContain('-Filter "ProcessId=10"');
  expect(args.at(-1)).toContain("ParentProcessId=$($p.ProcessId)");
  expect(args.at(-1)).toContain("CreationDate -ge $p.CreationDate");
});

it("kills a surviving descendant and confirms it is gone", async () => {
  const processes = fakeProcesses(20);
  await expect(reapProcesses([20], { platform: "darwin", ...processes })).resolves.toEqual([]);
  expect(processes.kill).toHaveBeenCalledWith(20);
});

it("leaves an already-exited descendant alone", async () => {
  const processes = fakeProcesses();
  await expect(reapProcesses([20], { platform: "darwin", ...processes })).resolves.toEqual([]);
  expect(processes.kill).not.toHaveBeenCalled();
});

it("reports a descendant still alive when the reap wait ends", async () => {
  let clock = 0;
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  const kill = vi.fn(() => {
    throw Object.assign(new Error("not permitted"), { code: "EPERM" });
  });
  await expect(
    reapProcesses([20, 21], {
      platform: "darwin",
      alive: (pid) => pid === 20,
      kill,
      now: () => clock,
      sleep,
      waitMs: 100,
    }),
  ).resolves.toEqual([20]);
  expect(kill).toHaveBeenCalledOnce();
  expect(sleep).toHaveBeenCalledTimes(4);
});

it("terminates each Windows descendant's tree with taskkill", async () => {
  const live = new Set([20, 21]);
  const exec = vi.fn(async (_file: string, args: readonly string[]) => {
    live.delete(Number(args[1]));
    return ok("");
  });
  await expect(
    reapProcesses([20, 21], { platform: "win32", exec, alive: (pid) => live.has(pid) }),
  ).resolves.toEqual([]);
  expect(exec.mock.calls.map(([file, args]) => [file, ...args])).toEqual([
    ["taskkill.exe", "/pid", "20", "/T", "/F"],
    ["taskkill.exe", "/pid", "21", "/T", "/F"],
  ]);
});
