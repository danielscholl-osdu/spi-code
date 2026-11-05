// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFileSync, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
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
import { HostSupervisor, hostPortCallbacks } from "./supervisor.js";

function assertFreshBuild(directory: string) {
  const source = join(directory, "src");
  const config = statSync(join(directory, "tsconfig.build.json"), { throwIfNoEntry: false })
    ? "tsconfig.build"
    : "tsconfig";
  // Incremental builds acknowledge unchanged sources without re-emitting JavaScript.
  const checked = statSync(join(directory, `${config}.tsbuildinfo`), { throwIfNoEntry: false });
  for (const relative of readdirSync(source, { recursive: true, encoding: "utf8" })) {
    if (!/\.tsx?$/.test(relative) || /\.test\.tsx?$|\.d\.ts$/.test(relative)) continue;
    const compiled = join(directory, "dist", relative.replace(/\.tsx?$/, ".js"));
    const built = statSync(compiled, { throwIfNoEntry: false });
    if (!built || !checked || checked.mtimeMs < statSync(join(source, relative)).mtimeMs)
      throw new Error(`Missing or stale build: ${compiled}. Run pnpm exec tsc -b --force.`);
  }
}

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
  postMessage = vi.fn();
  kill = vi.fn(() => {
    this.emit("exit", 0);
    return true;
  });
}

class Port extends EventEmitter {
  postMessage = vi.fn();
  start = vi.fn();
  close = vi.fn();
}

function channels() {
  const makeChannel = vi.fn(() => ({ port1: new Port(), port2: new Port() }));
  const webContents = Object.assign(new EventEmitter(), {
    postMessage: vi.fn(),
    isLoadingMainFrame: vi.fn(() => false),
  });
  const window = { webContents, isDestroyed: vi.fn(() => false) };
  const callbacks = hostPortCallbacks(makeChannel, window);
  return { makeChannel, window, callbacks };
}

it("transfers fresh peer ports to each respawned host and the window through the production callbacks", async () => {
  const { makeChannel, window, callbacks } = channels();
  const clock = new Clock();
  const hosts: Host[] = [];
  const supervisor = new HostSupervisor({
    clock,
    log: vi.fn(),
    spawn: () => {
      const host = new Host();
      hosts.push(host);
      return host;
    },
    ...callbacks,
  });
  try {
    supervisor.start();
    hosts[0]?.emit("spawn");
    hosts[0]?.emit("exit", 1);
    clock.advance(500);
    hosts[1]?.emit("spawn");
    expect(makeChannel).toHaveBeenCalledTimes(2);
    const first = makeChannel.mock.results[0]?.value;
    const second = makeChannel.mock.results[1]?.value;
    expect(first?.port1).not.toBe(second?.port1);
    expect(first?.port2).not.toBe(second?.port2);
    for (const [index, channel] of [first, second].entries()) {
      expect(hosts[index]?.postMessage).toHaveBeenCalledExactlyOnceWith(
        {
          version: PROTOCOL_VERSION,
          id: "connect",
          kind: "request",
          type: "ping",
          payload: {},
        },
        [channel?.port2],
      );
      expect(window.webContents.postMessage).toHaveBeenNthCalledWith(index + 1, "host:port", null, [
        channel?.port1,
      ]);
    }
  } finally {
    await supervisor.stop();
    callbacks.dispose();
  }
});

type Contents = ReturnType<typeof channels>["window"]["webContents"];

const INDEX = "file:///index.html";

// Event orders below follow traces recorded from Electron 44.10.0.
function startNavigation(
  contents: Contents,
  url: string,
  { isMainFrame = true, isSameDocument = false } = {},
) {
  const event = { url, isMainFrame, isSameDocument, frame: null, initiator: null };
  contents.emit("did-start-navigation", event, url, isSameDocument, isMainFrame, 1, 1);
}

function beginMainFrameLoad(contents: Contents, url = INDEX) {
  contents.isLoadingMainFrame.mockReturnValue(true);
  contents.emit("did-start-loading");
  startNavigation(contents, url);
}

function commitMainFrame(contents: Contents, url = INDEX) {
  contents.emit("did-frame-navigate", {}, url, -1, "", true, 1, 1);
  contents.emit("did-navigate", {}, url, -1, "");
  contents.emit("did-frame-finish-load", {}, true, 1, 1);
  contents.emit("did-finish-load");
}

function stopLoading(contents: Contents) {
  contents.isLoadingMainFrame.mockReturnValue(false);
  contents.emit("did-stop-loading");
}

function reload(contents: Contents) {
  beginMainFrameLoad(contents);
  commitMainFrame(contents);
  stopLoading(contents);
}

it("reconnects once after each reload when the main frame stops loading after did-finish-load", () => {
  const { makeChannel, window, callbacks } = channels();
  const host = new Host();
  try {
    callbacks.onSpawn(host);
    for (const count of [2, 3]) {
      beginMainFrameLoad(window.webContents);
      commitMainFrame(window.webContents);
      expect(makeChannel).toHaveBeenCalledTimes(count - 1);
      stopLoading(window.webContents);
      expect(makeChannel).toHaveBeenCalledTimes(count);
      const channel = makeChannel.mock.results[count - 1]?.value;
      const previous = makeChannel.mock.results[count - 2]?.value;
      expect(channel?.port1).not.toBe(previous?.port1);
      expect(channel?.port2).not.toBe(previous?.port2);
      expect(host.postMessage).toHaveBeenNthCalledWith(
        count,
        expect.objectContaining({ id: "connect", type: "ping" }),
        [channel?.port2],
      );
      expect(window.webContents.postMessage).toHaveBeenNthCalledWith(count, "host:port", null, [
        channel?.port1,
      ]);
    }
    window.webContents.emit("did-finish-load");
    window.webContents.emit("did-stop-loading");
    expect(makeChannel).toHaveBeenCalledTimes(3);
  } finally {
    callbacks.dispose();
  }
});

it("keeps the existing channel when a late subframe finishes loading", () => {
  const { makeChannel, window, callbacks } = channels();
  try {
    beginMainFrameLoad(window.webContents);
    callbacks.onSpawn(new Host());
    commitMainFrame(window.webContents);
    expect(makeChannel).not.toHaveBeenCalled();
    stopLoading(window.webContents);
    expect(makeChannel).toHaveBeenCalledOnce();

    window.webContents.emit("did-start-loading");
    startNavigation(window.webContents, "about:srcdoc", { isMainFrame: false });
    window.webContents.emit("did-frame-navigate", {}, "about:srcdoc", -1, "", false, 1, 2);
    window.webContents.emit("did-frame-finish-load", {}, false, 1, 2);
    window.webContents.emit("did-stop-loading");
    expect(makeChannel).toHaveBeenCalledOnce();
    expect(window.webContents.postMessage).toHaveBeenCalledOnce();
  } finally {
    callbacks.dispose();
  }
});

it("keeps the existing channel when will-navigate blocks a main-frame navigation", () => {
  const { makeChannel, window, callbacks } = channels();
  try {
    callbacks.onSpawn(new Host());
    beginMainFrameLoad(window.webContents, "file:///other.html");
    window.webContents.emit("will-navigate", { url: "file:///other.html", isMainFrame: true });
    stopLoading(window.webContents);
    expect(makeChannel).toHaveBeenCalledOnce();
    window.webContents.emit("did-stop-loading");
    expect(makeChannel).toHaveBeenCalledOnce();
    reload(window.webContents);
    expect(makeChannel).toHaveBeenCalledTimes(2);
  } finally {
    callbacks.dispose();
  }
});

it("keeps the existing channel when reload() is followed by stop() before the reload commits", () => {
  const { makeChannel, window, callbacks } = channels();
  try {
    callbacks.onSpawn(new Host());
    beginMainFrameLoad(window.webContents);
    stopLoading(window.webContents);
    expect(makeChannel).toHaveBeenCalledOnce();
    expect(window.webContents.postMessage).toHaveBeenCalledOnce();
    reload(window.webContents);
    expect(makeChannel).toHaveBeenCalledTimes(2);
  } finally {
    callbacks.dispose();
  }
});

it("reconnects once when a reload replaces an in-flight main-frame load", () => {
  const { makeChannel, window, callbacks } = channels();
  try {
    callbacks.onSpawn(new Host());
    beginMainFrameLoad(window.webContents);
    startNavigation(window.webContents, INDEX);
    window.webContents.emit("did-stop-loading");
    expect(makeChannel).toHaveBeenCalledOnce();
    commitMainFrame(window.webContents);
    expect(makeChannel).toHaveBeenCalledOnce();
    stopLoading(window.webContents);
    expect(makeChannel).toHaveBeenCalledTimes(2);
    window.webContents.emit("did-stop-loading");
    expect(makeChannel).toHaveBeenCalledTimes(2);

    beginMainFrameLoad(window.webContents);
    window.webContents.emit("did-navigate", {}, INDEX, -1, "");
    startNavigation(window.webContents, INDEX);
    window.webContents.emit("did-stop-loading");
    expect(makeChannel).toHaveBeenCalledTimes(2);
    stopLoading(window.webContents);
    expect(makeChannel).toHaveBeenCalledTimes(3);
  } finally {
    callbacks.dispose();
  }
});

it("does not leave a reconnect armed after a renderer crash and reconnects on recovery", () => {
  const { makeChannel, window, callbacks } = channels();
  try {
    callbacks.onSpawn(new Host());
    beginMainFrameLoad(window.webContents);
    commitMainFrame(window.webContents);
    window.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    stopLoading(window.webContents);
    expect(makeChannel).toHaveBeenCalledOnce();
    window.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    reload(window.webContents);
    expect(makeChannel).toHaveBeenCalledTimes(2);
  } finally {
    callbacks.dispose();
  }
});

it("waits for a committed document after a load fails into an error page", () => {
  const { makeChannel, window, callbacks } = channels();
  try {
    callbacks.onSpawn(new Host());
    beginMainFrameLoad(window.webContents, "file:///missing.html");
    window.webContents.emit("did-fail-provisional-load", {}, -6, "", "file:///missing.html", true);
    window.webContents.emit("did-fail-load", {}, -6, "", "file:///missing.html", true);
    window.webContents.emit("did-frame-finish-load", {}, true, 1, 1);
    window.webContents.emit("did-finish-load");
    stopLoading(window.webContents);
    expect(makeChannel).toHaveBeenCalledOnce();
    reload(window.webContents);
    expect(makeChannel).toHaveBeenCalledTimes(2);
  } finally {
    callbacks.dispose();
  }
});

it("does not arm a reconnect for a same-document navigation followed by a subframe load", () => {
  const { makeChannel, window, callbacks } = channels();
  try {
    callbacks.onSpawn(new Host());
    window.webContents.emit("did-start-loading");
    startNavigation(window.webContents, `${INDEX}#section`, { isSameDocument: true });
    window.webContents.emit("did-navigate-in-page", {}, `${INDEX}#section`, true, 1, 1);
    window.webContents.emit("did-stop-loading");
    window.webContents.emit("did-start-loading");
    startNavigation(window.webContents, "about:blank", { isMainFrame: false });
    window.webContents.emit("did-stop-loading");
    expect(makeChannel).toHaveBeenCalledOnce();
  } finally {
    callbacks.dispose();
  }
});

it("disposes navigation, crash and load listeners without reconnecting", () => {
  const { makeChannel, window, callbacks } = channels();
  callbacks.onSpawn(new Host());
  callbacks.dispose();
  for (const event of [
    "did-start-navigation",
    "did-navigate",
    "render-process-gone",
    "did-finish-load",
    "did-stop-loading",
  ])
    expect(window.webContents.listenerCount(event)).toBe(0);
  reload(window.webContents);
  expect(makeChannel).toHaveBeenCalledOnce();
});

it("retains give-up across an in-progress reload and replays it on later reloads", () => {
  const { makeChannel, window, callbacks } = channels();
  const message: Extract<Message, { type: "error" }> = {
    version: PROTOCOL_VERSION,
    id: "host-supervisor",
    kind: "response",
    type: "error",
    payload: { code: "host_unavailable", message: "Host stopped after repeated crashes." },
  };
  try {
    beginMainFrameLoad(window.webContents);
    callbacks.onGiveUp(message);
    expect(makeChannel).not.toHaveBeenCalled();
    commitMainFrame(window.webContents);
    expect(makeChannel).not.toHaveBeenCalled();
    stopLoading(window.webContents);
    const first = makeChannel.mock.results[0]?.value;
    expect(window.webContents.postMessage).toHaveBeenCalledExactlyOnceWith("host:port", null, [
      first?.port1,
    ]);
    expect(first?.port2.start).toHaveBeenCalledOnce();
    expect(first?.port2.postMessage).toHaveBeenCalledExactlyOnceWith(message);
    expect(parseMessage(first?.port2.postMessage.mock.calls[0]?.[0]).ok).toBe(true);
    beginMainFrameLoad(window.webContents);
    commitMainFrame(window.webContents);
    expect(makeChannel).toHaveBeenCalledOnce();
    stopLoading(window.webContents);
    const second = makeChannel.mock.results[1]?.value;
    expect(second?.port1).not.toBe(first?.port1);
    expect(first?.port2.close).toHaveBeenCalledOnce();
    expect(window.webContents.postMessage).toHaveBeenLastCalledWith("host:port", null, [
      second?.port1,
    ]);
    expect(second?.port2.postMessage).toHaveBeenCalledExactlyOnceWith(message);
  } finally {
    callbacks.dispose();
  }
});

it("fails clearly for missing or stale dist and accepts a fresh build", () => {
  const directory = mkdtempSync(join(tmpdir(), "spi-build-freshness-"));
  const source = join(directory, "src", "module.ts");
  const compiled = join(directory, "dist", "module.js");
  const buildInfo = join(directory, "tsconfig.tsbuildinfo");
  try {
    mkdirSync(join(directory, "src"));
    mkdirSync(join(directory, "dist"));
    writeFileSync(source, "export const value = 1;");
    utimesSync(source, 2000, 2000);
    expect(() => assertFreshBuild(directory)).toThrow("Run pnpm exec tsc -b --force");
    writeFileSync(compiled, "export const value = 1;");
    utimesSync(compiled, 1000, 1000);
    expect(() => assertFreshBuild(directory)).toThrow("Missing or stale build:");
    writeFileSync(buildInfo, "{}");
    utimesSync(buildInfo, 1000, 1000);
    expect(() => assertFreshBuild(directory)).toThrow("Missing or stale build:");
    utimesSync(buildInfo, 3000, 3000);
    expect(() => assertFreshBuild(directory)).not.toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each(["tsconfig.json", "tsconfig.build.json"])(
  "accepts a content-unchanged incremental rebuild and rejects an unbuilt edit (%s)",
  (configName) => {
    const directory = mkdtempSync(join(tmpdir(), "spi-incremental-freshness-"));
    const source = join(directory, "src", "module.ts");
    const compiled = join(directory, "dist", "module.js");
    const buildInfo = join(directory, configName.replace(/\.json$/, ".tsbuildinfo"));
    const config = join(directory, configName);
    const original = "export const value = 1;";
    const build = () =>
      execFileSync("pnpm", ["exec", "tsc", "-b", config], {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        encoding: "utf8",
        timeout: 15000,
        shell: process.platform === "win32",
      });
    try {
      mkdirSync(join(directory, "src"));
      writeFileSync(
        config,
        JSON.stringify({
          compilerOptions: { composite: true, rootDir: "src", outDir: "dist", types: [] },
          include: ["src/**/*.ts"],
        }),
      );
      writeFileSync(source, original);
      build();
      utimesSync(compiled, 1000, 1000);
      utimesSync(buildInfo, 1000, 1000);
      utimesSync(source, 2000, 2000);
      build();
      expect(readFileSync(source, "utf8")).toBe(original);
      expect(statSync(compiled).mtimeMs).toBe(1000000);
      expect(statSync(buildInfo).mtimeMs).toBeGreaterThan(statSync(source).mtimeMs);
      expect(() => assertFreshBuild(directory)).not.toThrow();
      writeFileSync(source, "export const value = 2;");
      const afterBuild = (statSync(buildInfo).mtimeMs + 1000) / 1000;
      utimesSync(source, afterBuild, afterBuild);
      expect(() => assertFreshBuild(directory)).toThrow("Run pnpm exec tsc -b --force");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  120_000,
);

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
  for (const directory of [
    "packages/contracts",
    "packages/core",
    "packages/tools",
    "packages/host",
    "apps/window",
  ])
    assertFreshBuild(fileURLToPath(new URL(`../../../${directory}/`, import.meta.url)));
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
      process.argv[2], "durable", process.argv[3], "--stub-model", "--smoke"
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
}, 120_000);
