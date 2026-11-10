// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      expect(process.kill).not.toHaveBeenCalled();
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
    const startedAt = Date.UTC(2020, 0, 1);
    const tree = [
      { pid: 100, parentPid: 1, command: "/app/SPI Code" },
      { pid: 101, parentPid: 100, command: "/app/host" },
      { pid: 102, parentPid: 101, command: `${runtimePath} --stdio` },
      { pid: 103, parentPid: 100, command: "/app/helper --type=renderer" },
      { pid: 104, parentPid: 106, command: "/app/helper --type=renderer" },
      { pid: 106, parentPid: 100, command: "/app/helper --type=utility" },
      { pid: 107, parentPid: 100, command: "/app/helper --type=gpu-process" },
      { pid: 108, parentPid: 106, command: "/app/network-service" },
      { pid: 109, parentPid: 102, command: "/app/runtime-child" },
      { pid: 202, parentPid: 1, command: `${runtimePath} --stdio` },
      { pid: 203, parentPid: 1, command: "/app/helper --type=renderer" },
    ].map((row) => ({ ...row, startedAt }));

    function fixture(listeningPid?: number, processes = tree, scanPid?: number) {
      return vi.fn<Exec>((file) => {
        if (file === "ps")
          return Promise.resolve({
            status: 0,
            stderr: "",
            pid: scanPid,
            stdout: processes
              .map(({ pid, parentPid, command, startedAt }) => {
                const [weekday, month, day, year, time] = new Date(startedAt).toString().split(" ");
                return `${pid} ${parentPid} ${weekday} ${month} ${day} ${time} ${year} ${command}`;
              })
              .join("\n"),
          });
        if (file === "powershell.exe")
          return Promise.resolve({
            status: 0,
            stderr: "",
            pid: scanPid,
            stdout: JSON.stringify(
              processes.map(({ pid, parentPid, command, startedAt }) => ({
                ProcessId: pid,
                ParentProcessId: parentPid,
                CommandLine: command,
                StartedAt: startedAt,
              })),
            ),
          });
        if (file === "netstat.exe")
          return ok(listeningPid ? `TCP 0.0.0.0:9222 0.0.0.0:0 LISTENING ${listeningPid}` : "");
        if (file === "lsof") {
          if (listeningPid) return ok(`${lsofHeader}\nruntime ${listeningPid} TCP *:9222 (LISTEN)`);
          return Promise.resolve({ status: 1, stdout: "", stderr: "" });
        }
        return Promise.reject(new Error(`Unexpected command: ${file}`));
      });
    }

    beforeEach(() => {
      Object.defineProperty(process, "platform", { value: platform });
    });

    it("scans every descendant in one process and one socket snapshot", async () => {
      const exec = fixture(202);
      await expect(assertNoProcessListeners(100, 101, { runtimePath, exec })).resolves.toEqual({
        mainPid: 100,
        hostPid: 101,
        runtimePids: [102],
        rendererPids: [103, 104],
        scannedPids: [100, 101, 102, 103, 104, 106, 107, 108, 109],
        scanDurationMs: expect.any(Number),
        processQueryAttempts: 1,
        listeners: [],
      });
      expect(process.kill).not.toHaveBeenCalled();
      expect(exec).toHaveBeenCalledTimes(2);
      expect(exec.mock.calls.map(([file]) => file)).toEqual(
        platform === "win32" ? ["netstat.exe", "powershell.exe"] : ["lsof", "ps"],
      );
      if (platform === "win32")
        expect(exec).toHaveBeenCalledWith(
          "powershell.exe",
          expect.arrayContaining(["-NoProfile", "-NonInteractive"]),
          expect.any(Number),
        );
      else
        expect(exec).toHaveBeenCalledWith(
          "ps",
          ["-axww", "-o", "pid=,ppid=,lstart=,command="],
          expect.any(Number),
        );
      for (const [, , timeout] of exec.mock.calls) {
        expect(timeout).toBeGreaterThan(0);
        expect(timeout).toBeLessThanOrEqual(platform === "win32" ? 30000 : 8000);
      }
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

    it.each([100, 101, 102, 103, 104, 106, 107, 108, 109])(
      "fails when app pid %i has a listener",
      async (pid) => {
        await expect(
          assertNoProcessListeners(100, 101, { runtimePath, exec: fixture(pid) }),
        ).rejects.toThrow("TCP listener");
      },
    );

    it("terminates a cyclic walk and excludes orphaned and stale-parent processes", async () => {
      const processes = [
        ...tree.map((row) => (row.pid === 100 ? { ...row, parentPid: 109 } : row)),
        { pid: 110, parentPid: 999, command: "/orphan", startedAt },
        { pid: 111, parentPid: 112, command: "/cycle", startedAt },
        { pid: 112, parentPid: 111, command: "/cycle", startedAt },
        { pid: 113, parentPid: 106, command: "/old-child", startedAt: startedAt - 1000 },
        { pid: 114, parentPid: 113, command: "/old-grandchild", startedAt },
      ].reverse();
      const exec = fixture(113, processes);
      const result = await assertNoProcessListeners(100, 101, { runtimePath, exec });
      expect(new Set(result.scannedPids)).toEqual(
        new Set([100, 101, 102, 103, 104, 106, 107, 108, 109]),
      );
      expect(exec).toHaveBeenCalledTimes(2);
    });

    it("does not fail when a listening descendant exits during the scan", async () => {
      const exec = fixture(
        109,
        tree.filter(({ pid }) => pid !== 109),
      );
      await expect(
        assertNoProcessListeners(100, 101, { runtimePath, exec }),
      ).resolves.toMatchObject({
        listeners: [],
        scannedPids: [100, 101, 102, 103, 104, 106, 107, 108],
      });
      expect(exec).toHaveBeenCalledTimes(2);
    });

    it("does not attribute an old listener to a pid reused during the scan", async () => {
      const exec = fixture(
        109,
        tree.map((row) => (row.pid === 109 ? { ...row, startedAt: Date.now() + 1000 } : row)),
      );
      await expect(
        assertNoProcessListeners(100, 101, { runtimePath, exec }),
      ).resolves.toMatchObject({
        listeners: [],
        scannedPids: [100, 101, 102, 103, 104, 106, 107, 108],
      });
    });

    it("reports only sampled pids, without the scan's own process-table command", async () => {
      const socketStartedAt = Date.UTC(2026, 10, 6, 12, 0, 0, 400);
      vi.spyOn(Date, "now").mockReturnValue(socketStartedAt);
      // ps truncates its own start to the snapshot's second; CIM keeps the child's milliseconds.
      const exec = fixture(
        120,
        [
          ...tree,
          {
            pid: 120,
            parentPid: 101,
            command: platform === "win32" ? "powershell.exe -NoProfile" : "ps -axww",
            startedAt: platform === "win32" ? socketStartedAt + 30 : socketStartedAt - 400,
          },
          ...(platform === "win32"
            ? [
                {
                  pid: 121,
                  parentPid: 120,
                  command: "conhost.exe 0xffffffff",
                  startedAt: socketStartedAt + 1,
                },
              ]
            : []),
        ],
        120,
      );
      await expect(
        assertNoProcessListeners(100, 101, { runtimePath, exec }),
      ).resolves.toMatchObject({
        listeners: [],
        scannedPids: [100, 101, 102, 103, 104, 106, 107, 108, 109],
      });
    });

    it("measures both snapshots within the platform's shared scan budget", async () => {
      let now = 100;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const exec = fixture();
      const timed: Exec = async (...args) => {
        now += 125;
        return exec(...args);
      };
      await expect(
        assertNoProcessListeners(100, 101, { runtimePath, exec: timed }),
      ).resolves.toMatchObject({
        scanDurationMs: 250,
      });
      expect(exec.mock.calls.map(([, , timeout]) => timeout)).toEqual(
        platform === "win32" ? [30000, 15000] : [8000, 7875],
      );
    });

    it("does not start another command once the scan budget is spent", async () => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const exec = fixture();
      const timed: Exec = async (...args) => {
        now = platform === "win32" ? 30000 : 8000;
        return exec(...args);
      };
      await expect(
        assertNoProcessListeners(100, 101, { runtimePath, exec: timed }),
      ).rejects.toThrow(`Listener scan exceeded ${platform === "win32" ? 30000 : 8000} ms`);
      expect(exec).toHaveBeenCalledTimes(1);
    });

    if (platform === "win32") {
      const timeoutError = () =>
        Object.assign(new Error("CIM timed out"), { code: null, killed: true, signal: "SIGTERM" });

      it.each(["exit", "timeout"])(
        "recovers from one CIM %s failure and reports attempt two",
        async (failure) => {
          let now = 0;
          vi.spyOn(performance, "now").mockImplementation(() => now);
          const base = fixture();
          let queries = 0;
          const exec: Exec = (file, args, timeout) => {
            if (file === "powershell.exe" && ++queries === 1) {
              if (failure === "timeout") now += timeout;
              return failure === "exit"
                ? Promise.resolve({ status: 1, stdout: "", stderr: "CIM unavailable" })
                : Promise.reject(timeoutError());
            }
            return base(file, args, timeout);
          };
          const sleep = vi.fn(async (ms: number) => {
            now += ms;
          });
          await expect(
            assertNoProcessListeners(100, 101, { runtimePath, exec, sleep }),
          ).resolves.toMatchObject({
            processQueryAttempts: 2,
            scannedPids: [100, 101, 102, 103, 104, 106, 107, 108, 109],
          });
          expect(queries).toBe(2);
          expect(sleep.mock.calls).toEqual([[250]]);
        },
      );

      it.each(["exit", "timeout"])(
        "fails after three CIM %s failures with the attempt count",
        async (failure) => {
          const base = fixture();
          let queries = 0;
          const exec: Exec = (file, args, timeout) => {
            if (file !== "powershell.exe") return base(file, args, timeout);
            queries++;
            return failure === "exit"
              ? Promise.resolve({ status: 1, stdout: "", stderr: "CIM unavailable" })
              : Promise.reject(timeoutError());
          };
          const sleep = vi.fn(async () => {});
          await expect(
            assertNoProcessListeners(100, 101, { runtimePath, exec, sleep }),
          ).rejects.toThrow(
            /Windows process query failed after 3 attempts.*(?:CIM unavailable|SIGTERM)/s,
          );
          expect(queries).toBe(3);
          expect(sleep.mock.calls).toEqual([[250], [250]]);
        },
      );

      it("gives a cold CIM query more than eight seconds, within the total budget", async () => {
        let now = 0;
        vi.spyOn(performance, "now").mockImplementation(() => now);
        const base = fixture();
        const exec: Exec = async (...args) => {
          if (args[0] === "powershell.exe") now += 10000;
          return base(...args);
        };
        await expect(
          assertNoProcessListeners(100, 101, { runtimePath, exec }),
        ).resolves.toMatchObject({
          scanDurationMs: 10000,
          processQueryAttempts: 1,
        });
      });

      it("stops retrying when timed-out queries consume the scan deadline", async () => {
        let now = 0;
        vi.spyOn(performance, "now").mockImplementation(() => now);
        const base = fixture();
        let queries = 0;
        const exec: Exec = async (file, args, timeout) => {
          if (file !== "powershell.exe") return base(file, args, timeout);
          queries++;
          now += timeout;
          throw timeoutError();
        };
        const sleep = vi.fn(async (ms: number) => {
          now += ms;
        });
        await expect(
          assertNoProcessListeners(100, 101, { runtimePath, exec, sleep }),
        ).rejects.toThrow(/Windows process query failed after 2 attempts.*SIGTERM/s);
        expect(queries).toBe(2);
        expect(now).toBe(30000);
        expect(sleep.mock.calls).toEqual([[250]]);
      });

      it.each(["listener", "missing host", "malformed JSON"])(
        "does not retry invalid %s evidence",
        async (failure) => {
          const base = fixture(
            failure === "listener" ? 102 : undefined,
            failure === "missing host" ? tree.filter(({ pid }) => pid !== 101) : tree,
          );
          const exec = vi.fn<Exec>((file, args, timeout) =>
            file === "powershell.exe" && failure === "malformed JSON"
              ? ok("invalid JSON")
              : base(file, args, timeout),
          );
          const sleep = vi.fn(async () => {});
          await expect(
            assertNoProcessListeners(100, 101, { runtimePath, exec, sleep }),
          ).rejects.toThrow();
          expect(exec).toHaveBeenCalledTimes(2);
          expect(sleep).not.toHaveBeenCalled();
        },
      );
    }

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
      expect(result).toEqual({ status: 0, stdout: "done", stderr: "", pid: expect.any(Number) });
    } finally {
      clearInterval(timer);
    }
    expect(ticks.length).toBeGreaterThan(0);
  });

  it("reports a non-zero exit with its output instead of throwing", async () => {
    await expect(
      execText(process.execPath, ["-e", "process.stderr.write('no'); process.exit(3)"], 5000),
    ).resolves.toEqual({ status: 3, stdout: "", stderr: "no", pid: expect.any(Number) });
  });
});

describe.runIf(process.platform === "darwin")("darwin process table locale", () => {
  const tree = `const { spawn } = require("node:child_process");
const [role] = process.argv.slice(2);
const start = (...args) =>
  spawn(process.execPath, [__filename, ...args], { stdio: ["ignore", "inherit", "inherit"] });
if (role === "main") { start("host"); start("renderer", "--type=renderer"); }
if (role === "host") start("runtime", "--stdio");
process.stdout.write(\`\${role} \${process.pid}\\n\`);
setInterval(() => {}, 60000);
`;
  let root: string;
  const children: number[] = [];
  let main: ChildProcess | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "spi-listeners-"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    main?.kill("SIGKILL");
    for (const pid of children.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    { LC_ALL: "de_DE.UTF-8", LANG: undefined, LC_CTYPE: undefined, LC_TIME: undefined },
    { LC_ALL: undefined, LANG: undefined, LC_CTYPE: undefined, LC_TIME: undefined },
    { LC_ALL: undefined, LANG: "de_DE.UTF-8", LC_CTYPE: undefined, LC_TIME: undefined },
  ])("finds a runtime under a non-ASCII path with locale %o", async (locale) => {
    for (const [name, value] of Object.entries(locale)) vi.stubEnv(name, value);
    const directory = join(root, "Jösé");
    await mkdir(directory);
    const runtimePath = join(directory, "copilot-runtime.cjs");
    await writeFile(runtimePath, tree);
    const spawned = spawn(process.execPath, [runtimePath, "main"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    main = spawned;
    const pids = await new Promise<Record<string, number>>((resolve, reject) => {
      const found: Record<string, number> = {};
      let output = "";
      spawned.once("error", reject);
      spawned.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
        for (const line of output.split("\n")) {
          const [role, pid] = line.split(" ");
          if (role && pid) found[role] = Number(pid);
        }
        if (["main", "host", "runtime", "renderer"].every((role) => found[role])) resolve(found);
      });
    });
    children.push(pids.host ?? 0, pids.runtime ?? 0, pids.renderer ?? 0);
    const exec: Exec = (file, args, timeout) =>
      file === "lsof"
        ? Promise.resolve({ status: 1, stdout: "", stderr: "" })
        : execText(file, args, timeout);

    const result = await assertNoProcessListeners(pids.main ?? 0, pids.host ?? 0, {
      runtimePath,
      exec,
    });

    expect(result).toMatchObject({ runtimePids: [pids.runtime], rendererPids: [pids.renderer] });
    expect(new Set(result.scannedPids)).toEqual(
      new Set([pids.main, pids.host, pids.runtime, pids.renderer]),
    );
  });
});
