// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertNoProcessListeners, listenersOf, windowsListeners } from "./smoke-listeners.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const ipv4 = "  TCP    0.0.0.0:9222           0.0.0.0:0              LISTENING       42";
const ipv6 = "  TCP    [::]:9223              [::]:0                 LISTENING       42";
const output = [
  "",
  "Active Connections",
  "",
  "  Proto  Local Address          Foreign Address        State           PID",
  ipv4,
  ipv6,
  "  TCP    127.0.0.1:5000         127.0.0.1:443          ESTABLISHED     42",
  "  TCP    [::1]:5001             [::1]:443              ESTABLISHED     42",
  "  TCP    0.0.0.0:9224           0.0.0.0:0              LISTENING       142",
  "  UDP    0.0.0.0:5353           *:*                                    42",
  "  UDP    [::]:5353              *:*                                    42",
].join("\r\n");

describe("TCP listener evidence", () => {
  it("finds IPv4 and IPv6 listeners for exactly the requested pid", () => {
    expect(windowsListeners(output, 42)).toEqual([ipv4, ipv6]);
    expect(windowsListeners(output, 7)).toEqual([]);
  });

  describe.each(["darwin", "win32"])("%s app process-tree listener check", (platform) => {
    const originalPlatform = process.platform;
    const runtimePath = "/app/copilot-runtime";
    const tree = [
      { pid: 100, parentPid: 1, command: "/app/SPI Code" },
      { pid: 101, parentPid: 100, command: "/app/host" },
      { pid: 102, parentPid: 101, command: `${runtimePath} --stdio` },
      { pid: 103, parentPid: 100, command: "/app/helper --type=renderer" },
      { pid: 104, parentPid: 106, command: "/app/helper --type=renderer" },
      { pid: 106, parentPid: 100, command: "/app/helper --type=utility" },
      { pid: 202, parentPid: 1, command: `${runtimePath} --stdio` },
      { pid: 203, parentPid: 1, command: "/app/helper --type=renderer" },
    ];

    function fixture(listeningPid?: number, processes = tree) {
      vi.mocked(execFileSync).mockImplementation((file, args) => {
        if (file === "ps")
          return processes
            .map(({ pid, parentPid, command }) => `${pid} ${parentPid} ${command}`)
            .join("\n");
        if (file === "powershell.exe")
          return JSON.stringify(
            processes.map(({ pid, parentPid, command }) => ({
              ProcessId: pid,
              ParentProcessId: parentPid,
              CommandLine: command,
            })),
          );
        if (file === "netstat.exe")
          return listeningPid ? `TCP 0.0.0.0:9222 0.0.0.0:0 LISTENING ${listeningPid}` : "";
        if (file === "lsof") {
          const pid = Number(args?.[3]);
          if (pid === listeningPid) return `runtime ${pid} TCP *:9222 (LISTEN)`;
          throw { status: 1, stdout: "", stderr: "" };
        }
        throw new Error(`Unexpected command: ${file}`);
      });
    }

    beforeEach(() => {
      vi.clearAllMocks();
      Object.defineProperty(process, "platform", { value: platform });
      vi.spyOn(process, "kill").mockReturnValue(true);
    });

    afterEach(() => {
      Object.defineProperty(process, "platform", { value: originalPlatform });
      vi.restoreAllMocks();
    });

    it("collects runtime and all renderer descendants, excluding unrelated matching processes", () => {
      fixture(202);
      expect(assertNoProcessListeners(100, 101, runtimePath)).toEqual({
        mainPid: 100,
        hostPid: 101,
        runtimePids: [102],
        rendererPids: [103, 104],
        listeners: [],
      });
      expect(new Set(vi.mocked(process.kill).mock.calls.map(([pid]) => pid))).toEqual(
        new Set([100, 101, 102, 103, 104]),
      );
      if (platform === "win32")
        expect(execFileSync).toHaveBeenCalledWith(
          "powershell.exe",
          expect.arrayContaining(["-NoProfile", "-NonInteractive"]),
          expect.objectContaining({ timeout: 10000 }),
        );
      else
        expect(execFileSync).toHaveBeenCalledWith(
          "ps",
          ["-axww", "-o", "pid=,ppid=,command="],
          expect.objectContaining({ timeout: 10000 }),
        );
    });

    it.each([100, 101, 102, 103, 104])("fails when app pid %i has a listener", (pid) => {
      fixture(pid);
      expect(() => assertNoProcessListeners(100, 101, runtimePath)).toThrow("TCP listener");
    });

    it("fails closed if the runtime is missing during the packaged handshake", () => {
      fixture(
        undefined,
        tree.filter(({ pid }) => pid !== 102),
      );
      expect(() => assertNoProcessListeners(100, 101, runtimePath)).toThrow("runtime");
    });

    it("rejects a matching runtime outside the host subtree", () => {
      fixture(
        undefined,
        tree.map((entry) => (entry.pid === 102 ? { ...entry, parentPid: 100 } : entry)),
      );
      expect(() => assertNoProcessListeners(100, 101, runtimePath)).toThrow("runtime");
    });

    it("fails closed if no renderer belongs to the main process", () => {
      fixture(
        undefined,
        tree.filter(({ pid }) => pid !== 103 && pid !== 104),
      );
      expect(() => assertNoProcessListeners(100, 101, runtimePath)).toThrow("renderer");
    });

    it("rejects a host outside the main process tree", () => {
      fixture(
        undefined,
        tree.map((entry) => (entry.pid === 101 ? { ...entry, parentPid: 1 } : entry)),
      );
      expect(() => assertNoProcessListeners(100, 101, runtimePath)).toThrow("host");
    });

    it("still checks renderer pids after the packaged runtime has stopped", () => {
      fixture(
        undefined,
        tree.filter(({ pid }) => pid !== 102),
      );
      expect(assertNoProcessListeners(100, 101).rendererPids).toEqual([103, 104]);
    });

    it("propagates process-tree command failures", () => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error("Process tree unavailable");
      });
      expect(() => assertNoProcessListeners(100, 101, runtimePath)).toThrow(
        "Process tree unavailable",
      );
    });
  });

  it("also parses an explicit TCPv6 protocol label", () => {
    const row = "  TCPv6  [::]:9223              [::]:0                 LISTENING       42";
    expect(windowsListeners(row, 42)).toEqual([row]);
  });

  it("does not mistake SYN_SENT with a zero foreign port for a listener", () => {
    const row = "  TCP    192.0.2.1:5000         0.0.0.0:0              SYN_SENT        42";
    expect(windowsListeners(row, 42)).toEqual([]);
  });

  it.each(["ABHÖREN", "UNKNOWN"])("rejects an unrecognized TCP state: %s", (state) => {
    const row = `  TCP    0.0.0.0:9222           0.0.0.0:0              ${state}       42`;
    expect(() => windowsListeners(row, 42)).toThrow("Unexpected netstat TCP state");
  });

  it("requests both IP families from netstat and checks process liveness", () => {
    const platform = process.platform;
    const exec = vi.mocked(execFileSync).mockReturnValue(output);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      expect(listenersOf(42)).toEqual([ipv4, ipv6]);
      expect(exec).toHaveBeenCalledWith(
        "netstat.exe",
        ["-ano"],
        expect.objectContaining({ encoding: "utf8", timeout: 10000 }),
      );
      expect(kill.mock.calls).toEqual([
        [42, 0],
        [42, 0],
      ]);
    } finally {
      Object.defineProperty(process, "platform", { value: platform });
      vi.restoreAllMocks();
    }
  });

  it("rejects malformed TCP evidence rather than treating it as no listeners", () => {
    expect(() => windowsListeners("  TCP    0.0.0.0:80    0.0.0.0:0", 42)).toThrow(
      "Unexpected netstat TCP row",
    );
  });
});
