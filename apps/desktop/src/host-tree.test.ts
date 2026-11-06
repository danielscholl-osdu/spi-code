// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, it, vi } from "vitest";
import { captureDescendants, identifyProcesses, reapProcesses } from "./host-tree.js";
import type { ExecResult } from "./smoke-listeners.js";

const ok = (stdout: string): ExecResult => ({ status: 0, stdout, stderr: "" });
const none: ExecResult = { status: 1, stdout: "", stderr: "" };
const calls = (exec: { mock: { calls: unknown[][] } }) =>
  exec.mock.calls.map(([file, args]) => [file, ...(args as string[])]);

function fakeProcesses(table: Record<number, string>) {
  const live = new Map(Object.entries(table).map(([pid, started]) => [Number(pid), started]));
  return {
    live,
    alive: (pid: number) => live.has(pid),
    identify: vi.fn(
      async (pids: readonly number[]) =>
        new Map(pids.flatMap((pid) => (live.has(pid) ? [[pid, live.get(pid) ?? ""]] : []))),
    ),
    kill: vi.fn((pid: number) => {
      live.delete(pid);
    }),
  };
}

it("walks the host's children with pgrep -P and reads their start times in one ps call", async () => {
  const tree: Record<string, string> = { "10": "20\n21\n", "20": "30\n" };
  const exec = vi.fn(async (file: string, args: readonly string[]) => {
    if (file === "ps")
      return ok(
        [
          "   10     1 Fri Nov  6 01:00:00 2026",
          "   20    10 Fri Nov  6 01:00:01 2026",
          "   21     1 Fri Nov  6 01:00:09 2026",
          "   30    20 Fri Nov  6 01:00:02 2026",
        ].join("\n"),
      );
    const children = tree[args[1] ?? ""];
    return children ? ok(children) : none;
  });
  await expect(captureDescendants(10, { platform: "darwin", exec })).resolves.toEqual([
    { pid: 20, started: "Fri Nov  6 01:00:01 2026" },
    { pid: 30, started: "Fri Nov  6 01:00:02 2026" },
  ]);
  expect(calls(exec)).toEqual([
    ["pgrep", "-P", "10"],
    ["pgrep", "-P", "20"],
    ["pgrep", "-P", "21"],
    ["pgrep", "-P", "30"],
    ["ps", "-o", "pid=,ppid=,lstart=", "-p", "10,20,21,30"],
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

it("captures Windows descendants with their creation times from the host down", async () => {
  const exec = vi.fn(async () => ok("20:134000000000000001,21:134000000000000002\r\n"));
  await expect(captureDescendants(10, { platform: "win32", exec })).resolves.toEqual([
    { pid: 20, started: "134000000000000001" },
    { pid: 21, started: "134000000000000002" },
  ]);
  const [[file, args]] = exec.mock.calls as unknown as [[string, string[]]];
  expect(file).toBe("powershell.exe");
  expect(args.at(-1)).toContain('-Filter "ProcessId=10"');
  expect(args.at(-1)).toContain("ParentProcessId=$($p.ProcessId)");
  expect(args.at(-1)).toContain("CreationDate -ge $p.CreationDate");
  expect(args.at(-1)).toContain("$($_.CreationDate.ToFileTimeUtc())");
});

it("reads current identities with ps or CIM, leaving out pids that are gone", async () => {
  const ps = vi.fn(async () => ok("   20 Fri Nov  6 01:00:01 2026\n"));
  await expect(identifyProcesses({ platform: "darwin", exec: ps })([20, 21], 300)).resolves.toEqual(
    new Map([[20, "Fri Nov  6 01:00:01 2026"]]),
  );
  expect(calls(ps)).toEqual([["ps", "-o", "pid=,lstart=", "-p", "20,21"]]);
  await expect(
    identifyProcesses({ platform: "darwin", exec: async () => none })([20], 300),
  ).resolves.toEqual(new Map());
  const cim = vi.fn(async () => ok("21:134000000000000002\r\n"));
  await expect(identifyProcesses({ platform: "win32", exec: cim })([20, 21], 300)).resolves.toEqual(
    new Map([[21, "134000000000000002"]]),
  );
  const [[, args]] = cim.mock.calls as unknown as [[string, string[]]];
  expect(args.at(-1)).toContain('-Filter "ProcessId=20 OR ProcessId=21"');
});

it("kills a surviving descendant and confirms it is gone", async () => {
  const processes = fakeProcesses({ 20: "a" });
  await expect(
    reapProcesses([{ pid: 20, started: "a" }], { platform: "darwin", ...processes }),
  ).resolves.toEqual([]);
  expect(processes.kill).toHaveBeenCalledWith(20, expect.any(Number));
});

it("leaves an already-exited descendant alone", async () => {
  const processes = fakeProcesses({});
  await expect(
    reapProcesses([{ pid: 20, started: "a" }], { platform: "darwin", ...processes }),
  ).resolves.toEqual([]);
  expect(processes.identify).not.toHaveBeenCalled();
  expect(processes.kill).not.toHaveBeenCalled();
});

it("kills nothing when the identities cannot be read", async () => {
  const kill = vi.fn();
  await expect(
    reapProcesses([{ pid: 20, started: "a" }], {
      platform: "darwin",
      alive: () => true,
      identify: async () => {
        throw new Error("ps timed out");
      },
      kill,
    }),
  ).rejects.toThrow("ps timed out");
  expect(kill).not.toHaveBeenCalled();
});

it("reports a descendant still running as itself when the reap wait ends", async () => {
  let clock = 0;
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  const processes = fakeProcesses({ 20: "a", 21: "b" });
  const kill = vi.fn(() => {
    throw Object.assign(new Error("not permitted"), { code: "EPERM" });
  });
  await expect(
    reapProcesses(
      [
        { pid: 20, started: "a" },
        { pid: 21, started: "b" },
      ],
      { platform: "darwin", ...processes, kill, now: () => clock, sleep, waitMs: 100 },
    ),
  ).resolves.toEqual([
    { pid: 20, started: "a" },
    { pid: 21, started: "b" },
  ]);
  expect(kill).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledTimes(4);
});

it("never signals a POSIX pid that an unrelated process took over after capture", async () => {
  const live = new Map([
    [20, "Fri Nov  6 01:00:05 2026"],
    [21, "Fri Nov  6 01:00:02 2026"],
  ]);
  const exec = vi.fn(async (_file: string, args: readonly string[]) => {
    const rows = (args.at(-1) ?? "")
      .split(",")
      .map(Number)
      .flatMap((pid) => (live.has(pid) ? [`${pid} ${live.get(pid)}`] : []));
    return rows.length ? ok(rows.join("\n")) : none;
  });
  const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
    live.delete(Number(pid));
    return true;
  });
  try {
    await expect(
      reapProcesses(
        [
          { pid: 20, started: "Fri Nov  6 01:00:01 2026" },
          { pid: 21, started: "Fri Nov  6 01:00:02 2026" },
        ],
        { platform: "darwin", exec, alive: (pid) => live.has(pid) },
      ),
    ).resolves.toEqual([]);
    expect(kill.mock.calls).toEqual([[21, "SIGKILL"]]);
    expect(live.has(20)).toBe(true);
  } finally {
    kill.mockRestore();
  }
});

it("never runs taskkill on a Windows pid that an unrelated process took over, and never with /T", async () => {
  const live = new Map([
    [20, "134000000000000009"],
    [21, "134000000000000002"],
  ]);
  const exec = vi.fn(async (file: string, args: readonly string[]) => {
    if (file === "taskkill.exe") {
      live.delete(Number(args[1]));
      return ok("");
    }
    return ok(
      [...live]
        .filter(([pid]) => (args.at(-1) ?? "").includes(`ProcessId=${pid}`))
        .map(([pid, started]) => `${pid}:${started}`)
        .join(","),
    );
  });
  await expect(
    reapProcesses(
      [
        { pid: 20, started: "134000000000000001" },
        { pid: 21, started: "134000000000000002" },
      ],
      { platform: "win32", exec, alive: (pid) => live.has(pid) },
    ),
  ).resolves.toEqual([]);
  expect(calls(exec).filter(([file]) => file === "taskkill.exe")).toEqual([
    ["taskkill.exe", "/pid", "21", "/F"],
  ]);
  expect(live.has(20)).toBe(true);
});
