// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertNoProcessListeners,
  type Exec,
  execText,
  listenersOf,
  windowsListeners,
} from "./smoke-listeners.js";

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
const lsofHeader = "COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME";

function ok(stdout: string) {
  return Promise.resolve({ status: 0, stdout, stderr: "" });
}

describe("TCP listener evidence", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.spyOn(process, "kill").mockReturnValue(true);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    vi.restoreAllMocks();
  });

  it("finds IPv4 and IPv6 listeners for exactly the requested pids", () => {
    expect(windowsListeners(output, [42])).toEqual([ipv4, ipv6]);
    expect(windowsListeners(output, [7])).toEqual([]);
    expect(windowsListeners(output, [7, 42, 142])).toEqual([
      ipv4,
      ipv6,
      "  TCP    0.0.0.0:9224           0.0.0.0:0              LISTENING       142",
    ]);
  });

  it.each(["darwin", "win32"])(
    "takes one %s socket snapshot for several pids",
    async (platform) => {
      Object.defineProperty(process, "platform", { value: platform });
      const exec = vi.fn<Exec>((file) =>
        file === "netstat.exe"
          ? ok(output)
          : ok(`${lsofHeader}\nnode       42 user   12u  IPv4 0x1      0t0  TCP *:9222 (LISTEN)\n`),
      );
      const listeners = await listenersOf([7, 42, 99], exec);
      expect(listeners).toHaveLength(platform === "win32" ? 2 : 1);
      expect(exec).toHaveBeenCalledTimes(1);
      if (platform === "win32") expect(exec).toHaveBeenCalledWith("netstat.exe", ["-ano"], 10000);
      else
        expect(exec).toHaveBeenCalledWith(
          "lsof",
          ["-nP", "-a", "-p", "7,42,99", "-iTCP", "-sTCP:LISTEN"],
          5000,
        );
      expect(new Set(vi.mocked(process.kill).mock.calls.map(([pid]) => pid))).toEqual(
        new Set([7, 42, 99]),
      );
      expect(vi.mocked(process.kill)).toHaveBeenCalledTimes(6);
    },
  );

  it("treats lsof's empty no-match exit as no listeners and other failures as errors", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    await expect(
      listenersOf([42], () => Promise.resolve({ status: 1, stdout: "", stderr: "" })),
    ).resolves.toEqual([]);
    await expect(
      listenersOf([42], () => Promise.resolve({ status: 1, stdout: "", stderr: "lsof: denied" })),
    ).rejects.toThrow("lsof");
    Object.defineProperty(process, "platform", { value: "win32" });
    await expect(
      listenersOf([42], () => Promise.resolve({ status: 1, stdout: "", stderr: "" })),
    ).rejects.toThrow("netstat");
  });

  describe.each(["darwin", "win32"])("%s app process-tree listener check", (platform) => {
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
      return vi.fn<Exec>((file, args) => {
        if (file === "ps")
          return ok(
            processes
              .map(({ pid, parentPid, command }) => `${pid} ${parentPid} ${command}`)
              .join("\n"),
          );
        if (file === "powershell.exe")
          return ok(
            JSON.stringify(
              processes.map(({ pid, parentPid, command }) => ({
                ProcessId: pid,
                ParentProcessId: parentPid,
                CommandLine: command,
              })),
            ),
          );
        if (file === "netstat.exe")
          return ok(listeningPid ? `TCP 0.0.0.0:9222 0.0.0.0:0 LISTENING ${listeningPid}` : "");
        if (file === "lsof") {
          const pids = String(args[3]).split(",").map(Number);
          if (listeningPid && pids.includes(listeningPid))
            return ok(`${lsofHeader}\nruntime ${listeningPid} TCP *:9222 (LISTEN)`);
          return Promise.resolve({ status: 1, stdout: "", stderr: "" });
        }
        return Promise.reject(new Error(`Unexpected command: ${file}`));
      });
    }

    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: platform });
    });

    it("collects runtime and all renderer descendants, excluding unrelated matching processes", async () => {
      const exec = fixture(202);
      await expect(assertNoProcessListeners(100, 101, { runtimePath, exec })).resolves.toEqual({
        mainPid: 100,
        hostPid: 101,
        runtimePids: [102],
        rendererPids: [103, 104],
        listeners: [],
      });
      expect(new Set(vi.mocked(process.kill).mock.calls.map(([pid]) => pid))).toEqual(
        new Set([100, 101, 102, 103, 104]),
      );
      expect(exec).toHaveBeenCalledTimes(2);
      if (platform === "win32")
        expect(exec).toHaveBeenCalledWith(
          "powershell.exe",
          expect.arrayContaining(["-NoProfile", "-NonInteractive"]),
          10000,
        );
      else expect(exec).toHaveBeenCalledWith("ps", ["-axww", "-o", "pid=,ppid=,command="], 10000);
    });

    it("lets a timer scheduled before the scan fire while the scan is pending", async () => {
      const exec = fixture();
      let fired = false;
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const gated: Exec = async (...args) => {
        await released;
        return exec(...args);
      };
      setTimeout(() => {
        fired = true;
        release();
      }, 0);
      const scan = assertNoProcessListeners(100, 101, { runtimePath, exec: gated });
      expect(fired).toBe(false);
      await expect(scan).resolves.toMatchObject({ listeners: [] });
      expect(fired).toBe(true);
    });

    it.each([100, 101, 102, 103, 104])("fails when app pid %i has a listener", async (pid) => {
      await expect(
        assertNoProcessListeners(100, 101, { runtimePath, exec: fixture(pid) }),
      ).rejects.toThrow("TCP listener");
    });

    it("fails closed if the runtime is missing during the packaged handshake", async () => {
      const exec = fixture(
        undefined,
        tree.filter(({ pid }) => pid !== 102),
      );
      await expect(assertNoProcessListeners(100, 101, { runtimePath, exec })).rejects.toThrow(
        "runtime",
      );
    });

    it("rejects a matching runtime outside the host subtree", async () => {
      const exec = fixture(
        undefined,
        tree.map((entry) => (entry.pid === 102 ? { ...entry, parentPid: 100 } : entry)),
      );
      await expect(assertNoProcessListeners(100, 101, { runtimePath, exec })).rejects.toThrow(
        "runtime",
      );
    });

    it("fails closed if no renderer belongs to the main process", async () => {
      const exec = fixture(
        undefined,
        tree.filter(({ pid }) => pid !== 103 && pid !== 104),
      );
      await expect(assertNoProcessListeners(100, 101, { runtimePath, exec })).rejects.toThrow(
        "renderer",
      );
    });

    it("fails closed if the main process is missing", async () => {
      const exec = fixture(
        undefined,
        tree.filter(({ pid }) => pid !== 100),
      );
      await expect(assertNoProcessListeners(100, 101, { runtimePath, exec })).rejects.toThrow(
        "main process",
      );
    });

    it("rejects a host outside the main process tree", async () => {
      const exec = fixture(
        undefined,
        tree.map((entry) => (entry.pid === 101 ? { ...entry, parentPid: 1 } : entry)),
      );
      await expect(assertNoProcessListeners(100, 101, { runtimePath, exec })).rejects.toThrow(
        "host",
      );
    });

    it("still checks renderer pids after the packaged runtime has stopped", async () => {
      const exec = fixture(
        undefined,
        tree.filter(({ pid }) => pid !== 102),
      );
      await expect(assertNoProcessListeners(100, 101, { exec })).resolves.toMatchObject({
        rendererPids: [103, 104],
      });
    });

    it("propagates process-tree command failures", async () => {
      const exec: Exec = () => Promise.reject(new Error("Process tree unavailable"));
      await expect(assertNoProcessListeners(100, 101, { runtimePath, exec })).rejects.toThrow(
        "Process tree unavailable",
      );
    });

    it("rejects a process-tree command that exits non-zero", async () => {
      const exec: Exec = () => Promise.resolve({ status: 1, stdout: "", stderr: "denied" });
      await expect(assertNoProcessListeners(100, 101, { runtimePath, exec })).rejects.toThrow(
        "denied",
      );
    });
  });

  it("also parses an explicit TCPv6 protocol label", () => {
    const row = "  TCPv6  [::]:9223              [::]:0                 LISTENING       42";
    expect(windowsListeners(row, [42])).toEqual([row]);
  });

  it("does not mistake SYN_SENT with a zero foreign port for a listener", () => {
    const row = "  TCP    192.0.2.1:5000         0.0.0.0:0              SYN_SENT        42";
    expect(windowsListeners(row, [42])).toEqual([]);
  });

  it.each(["ABHÖREN", "UNKNOWN"])("rejects an unrecognized TCP state: %s", (state) => {
    const row = `  TCP    0.0.0.0:9222           0.0.0.0:0              ${state}       42`;
    expect(() => windowsListeners(row, [42])).toThrow("Unexpected netstat TCP state");
  });

  it("rejects malformed TCP evidence rather than treating it as no listeners", () => {
    expect(() => windowsListeners("  TCP    0.0.0.0:80    0.0.0.0:0", [42])).toThrow(
      "Unexpected netstat TCP row",
    );
  });

  it("runs commands without blocking the event loop", async () => {
    const ticks: string[] = [];
    const timer = setInterval(() => ticks.push("tick"), 5);
    try {
      const result = await execText(
        process.execPath,
        ["-e", "setTimeout(() => process.stdout.write('done'), 200)"],
        5000,
      );
      expect(result).toEqual({ status: 0, stdout: "done", stderr: "" });
    } finally {
      clearInterval(timer);
    }
    expect(ticks.length).toBeGreaterThan(0);
  });

  it("reports a non-zero exit with its output instead of throwing", async () => {
    await expect(
      execText(process.execPath, ["-e", "process.stderr.write('no'); process.exit(3)"], 5000),
    ).resolves.toEqual({ status: 3, stdout: "", stderr: "no" });
  });
});
