// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type Message,
  PROTOCOL_VERSION,
  parseMessage,
  ViewSnapshotSchema,
} from "@spi-code/contracts";
import { expect, it, vi } from "vitest";
import { createLeaseStore } from "../../../packages/host/src/store/leases.js";
import { createSnapshotStore } from "../../../packages/host/src/store/snapshots.js";
import { openRunStore } from "../../../packages/host/src/store/store.js";
import { HostSupervisor } from "./supervisor.js";

class Clock {
  now = 0;
  tasks = new Set<{ at: number; callback: () => void }>();
  schedule = (delay: number, callback: () => void) => {
    const task = { at: this.now + delay, callback };
    this.tasks.add(task);
    return () => this.tasks.delete(task);
  };
  advance(delay: number) {
    const end = this.now + delay;
    for (;;) {
      const task = [...this.tasks].sort((a, b) => a.at - b.at)[0];
      if (!task || task.at > end) break;
      this.tasks.delete(task);
      this.now = task.at;
      task.callback();
    }
    this.now = end;
  }
}

class Host extends EventEmitter {
  kill = vi.fn(() => {
    this.emit("exit", 0);
    return true;
  });
}

function harness() {
  const clock = new Clock();
  const hosts: Host[] = [];
  const spawn = vi.fn(() => {
    const host = new Host();
    hosts.push(host);
    return host;
  });
  const onSpawn = vi.fn();
  const onGiveUp = vi.fn();
  const supervisor = new HostSupervisor({ spawn, onSpawn, onGiveUp, clock, log: vi.fn() });
  return { clock, hosts, spawn, onSpawn, onGiveUp, supervisor };
}

it("backs off repeated crashes, caps the delay, and gives up even if each host spawned", () => {
  const { clock, hosts, spawn, onGiveUp, supervisor } = harness();
  supervisor.start();
  supervisor.start();
  expect(spawn).toHaveBeenCalledTimes(1);
  for (const delay of [500, 1000, 2000, 4000, 8000, 10000, 10000]) {
    const host = hosts.at(-1);
    host?.emit("spawn");
    host?.emit("exit", 1);
    const starts = spawn.mock.calls.length;
    clock.advance(delay - 1);
    expect(spawn).toHaveBeenCalledTimes(starts);
    clock.advance(1);
    expect(spawn).toHaveBeenCalledTimes(starts + 1);
  }
  hosts.at(-1)?.emit("spawn");
  hosts.at(-1)?.emit("exit", 1);
  expect(onGiveUp).toHaveBeenCalledTimes(1);
  expect(parseMessage(onGiveUp.mock.calls[0]?.[0])).toMatchObject({
    ok: true,
    message: { type: "error", payload: { code: "host_unavailable" } },
  });
  clock.advance(120000);
  expect(spawn).toHaveBeenCalledTimes(8);
});

it("resets the crash budget only after a stable minute and ignores stale spawn and exit events", () => {
  const { clock, hosts, spawn, onSpawn, supervisor } = harness();
  supervisor.start();
  const first = hosts[0];
  first?.emit("exit", 1);
  first?.emit("spawn");
  clock.advance(500);
  expect(onSpawn).not.toHaveBeenCalled();
  first?.emit("exit", 1);
  hosts[1]?.emit("spawn");
  clock.advance(60000);
  hosts[1]?.emit("exit", 1);
  clock.advance(499);
  expect(spawn).toHaveBeenCalledTimes(2);
  clock.advance(1);
  expect(spawn).toHaveBeenCalledTimes(3);
});

it("cancels pending restarts and never restarts an intentionally stopped or still-starting host", async () => {
  const { clock, hosts, spawn, onSpawn, supervisor } = harness();
  supervisor.start();
  await supervisor.stop();
  hosts[0]?.emit("spawn");
  expect(hosts[0]?.kill).toHaveBeenCalledTimes(1);
  expect(onSpawn).not.toHaveBeenCalled();
  supervisor.start();
  hosts[1]?.emit("exit", 1);
  await supervisor.stop();
  clock.advance(120000);
  expect(spawn).toHaveBeenCalledTimes(2);
});

it("retries synchronous launch failures and reports a failed intentional kill", async () => {
  const { clock, spawn, hosts, supervisor } = harness();
  spawn.mockImplementationOnce(() => {
    throw new Error("Cannot fork");
  });
  supervisor.start();
  clock.advance(500);
  const host = hosts[0];
  host?.kill.mockReturnValueOnce(false);
  await expect(supervisor.stop()).rejects.toThrow("Could not stop host");
  host?.emit("exit", 1);
  clock.advance(120000);
  expect(spawn).toHaveBeenCalledTimes(2);
});

it("SIGKILLs the real host, resumes the same window store from its cursor, and preserves SQLite", async () => {
  // Node's IPC stands in for Electron's transferable port; the host entry and routes are real.
  const hostEntry = new URL("../../../packages/host/dist/main.js", import.meta.url).href;
  const script = `
    const connect = ${JSON.stringify({
      version: PROTOCOL_VERSION,
      id: "connect",
      kind: "request",
      type: "ping",
      payload: {},
    })};
    process.parentPort = { on(_event, listener) {
      process.on("message", data => {
        if (data !== "connect") return;
        const receive = data => handler?.({ data });
        let handler;
        const port = {
          on(_event, listener) { handler = listener; },
          postMessage(data) { process.send(data); },
          start() {},
          close() { process.off("message", receive); }
        };
        process.on("message", receive);
        listener({ data: connect, ports: [port] });
      });
    }};
    process.argv = [
      process.execPath, ${JSON.stringify(hostEntry)}, process.argv[1],
      process.argv[2], "durable", process.argv[3], "--stub-model"
    ];
    await import(${JSON.stringify(hostEntry)});
    process.send("ready");
  `;
  const directory = mkdtempSync(join(tmpdir(), "spi-supervisor-"));
  const path = join(directory, "runs.sqlite");
  const probePath = join(directory, "probe.json");
  openRunStore(path).close();
  const db = new DatabaseSync(path);
  const fleet = "Azure/osdu-spi-stack";
  const lease = createLeaseStore(db).acquire(fleet, "test", 60000, 0);
  if (lease === undefined) throw new Error("Missing test lease");
  const snapshots = createSnapshotStore(db);
  const envelope = ViewSnapshotSchema.parse(
    JSON.parse(
      readFileSync(
        new URL("../../../fixtures/watch/snapshot-59d6895.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const write = () =>
    snapshots.writeSnapshot({ fleet, owner: "test", fence: lease }, {}, envelope, 0);
  const firstCursor = write();
  const clock = new Clock();
  const traffic = new EventEmitter();
  const requests: Message[] = [];
  const hosts: ReturnType<typeof spawn>[] = [];
  let host: ReturnType<typeof spawn> | undefined;
  let stderr = "";
  const windowModule: {
    createWatchStore(send: (message: Message) => void): {
      getState(): { snapshot: { cursor: number } | null; receive(message: unknown): void };
    };
  } = await import(new URL("../../window/dist/store/watch.js", import.meta.url).href);
  const window = windowModule.createWatchStore((message) => {
    requests.push(message);
    host?.send(message);
  });
  const onGiveUp = vi.fn();
  const supervisor = new HostSupervisor({
    clock,
    log: vi.fn(),
    spawn: () => {
      host = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          script,
          path,
          hosts.length === 0 ? "write" : "read",
          probePath,
        ],
        { stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
      hosts.push(host);
      host.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      host.on("message", (message) => {
        if (message === "ready") {
          host?.send("connect");
          return;
        }
        const parsed = parseMessage(message);
        if (!parsed.ok) throw new Error("Malformed host message");
        window.getState().receive(parsed.message);
        traffic.emit(parsed.message.type, parsed.message);
      });
      return host;
    },
    onSpawn: () => {},
    onGiveUp,
  });
  try {
    const initial = once(traffic, "view.snapshot");
    supervisor.start();
    await initial;
    expect(window.getState().snapshot?.cursor, stderr).toBe(firstCursor);
    const firstPid = host?.pid;
    const killed = once(traffic, "host.hello");
    const exited = once(host ?? traffic, "exit");
    expect(host?.kill("SIGKILL")).toBe(true);
    expect(await exited).toEqual([null, "SIGKILL"]);
    expect(window.getState().snapshot?.cursor).toBe(firstCursor);
    const laterCursor = write();
    const resumed = once(traffic, "view.snapshot");
    clock.advance(499);
    expect(hosts).toHaveLength(1);
    clock.advance(1);
    await killed;
    await resumed;
    expect(host?.pid).not.toBe(firstPid);
    expect(window.getState().snapshot?.cursor).toBe(laterCursor);
    expect(
      requests.filter(({ type }) => type === "view.subscribe").map(({ payload }) => payload),
    ).toEqual([{ fromCursor: 0 }, { fromCursor: firstCursor }]);
    const persisted = openRunStore(path);
    try {
      expect(persisted.get("durable")?.title).toBe("utilityProcess persistence");
      expect(persisted.listEvents("durable", 0).map(({ data }) => data)).toEqual([
        { durable: true },
      ]);
    } finally {
      persisted.close();
    }
    expect(JSON.parse(readFileSync(probePath, "utf8"))).toMatchObject({
      pid: host?.pid,
      rowSurvived: true,
      sqliteIsTransaction: true,
    });
    expect(snapshots.snapshotsSince(0).map(({ cursor }) => cursor)).toEqual([
      firstCursor,
      laterCursor,
    ]);
    for (const delay of [1000, 2000, 4000, 8000, 10000, 10000]) {
      const exited = once(host ?? traffic, "exit");
      expect(host?.kill("SIGKILL")).toBe(true);
      await exited;
      const hello = once(traffic, "host.hello");
      clock.advance(delay);
      await hello;
    }
    const finalExit = once(host ?? traffic, "exit");
    expect(host?.kill("SIGKILL")).toBe(true);
    await finalExit;
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(window.getState().snapshot?.cursor).toBe(laterCursor);
    expect(hosts).toHaveLength(8);
    expect(parseMessage(onGiveUp.mock.calls[0]?.[0]).ok).toBe(true);
  } finally {
    await supervisor.stop();
    for (const child of hosts) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
