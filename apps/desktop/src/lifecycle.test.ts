// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PROTOCOL_VERSION } from "@spi-code/contracts";
import { afterEach, expect, it, vi } from "vitest";
import {
  cacheSchema,
  createContext,
  emptyCache,
  factsSchema,
  Sweeper,
} from "../../../packages/core/src/index.js";
import { openRunStore } from "../../../packages/host/src/store/store.js";
import { SweepService } from "../../../packages/host/src/sweep/service.js";
import { type ProcessIdentity, QUIT_BUDGET_MS, reapProcesses, stopHostTree } from "./host-tree.js";
import { WINDOW_LEAVE_ID, windowLeave } from "./leave.js";
import {
  createLifecycle,
  HOST_KILL_WAIT_MS,
  HOST_STOP_GRACE_MS,
  LEAVE_WAIT_MS,
  stopHostAndReleaseLeases,
  stopWithin,
} from "./lifecycle.js";

class FakeApp extends EventEmitter {
  requestSingleInstanceLock = vi.fn(() => true);
  exited = false;
  quit = vi.fn(() => {
    const event = { preventDefault: vi.fn() };
    this.emit("before-quit", event);
    if (!event.preventDefault.mock.calls.length) this.exited = true;
  });
}

class FakeWindow extends EventEmitter {
  isDestroyed = vi.fn(() => false);
  isMinimized = vi.fn(() => false);
  restore = vi.fn();
  show = vi.fn();
  focus = vi.fn();
  hide = vi.fn();
}

function fixture(locked = true, stop = vi.fn(async () => {})) {
  const app = new FakeApp();
  app.requestSingleInstanceLock.mockReturnValue(locked);
  const window = new FakeWindow();
  const dispose = vi.fn();
  const onError = vi.fn();
  const lifecycle = createLifecycle(app, { stopHost: stop, dispose, onError });
  lifecycle?.setWindow(window);
  return { app, window, lifecycle, stop, dispose, onError };
}

afterEach(() => vi.useRealTimers());

it("quits a second launch before creating a window or starting a host", () => {
  const { app, lifecycle, stop } = fixture(false);
  expect(lifecycle).toBeUndefined();
  expect(app.requestSingleInstanceLock).toHaveBeenCalledOnce();
  expect(app.exited).toBe(true);
  expect(stop).not.toHaveBeenCalled();
});

it("restores, shows and focuses the existing window on second-instance and activate", () => {
  const { app, window } = fixture();
  window.isMinimized.mockReturnValue(true);
  app.emit("second-instance");
  expect(window.restore).toHaveBeenCalledOnce();
  expect(window.show).toHaveBeenCalledOnce();
  expect(window.focus).toHaveBeenCalledOnce();
  window.isMinimized.mockReturnValue(false);
  app.emit("activate");
  expect(window.restore).toHaveBeenCalledOnce();
  expect(window.show).toHaveBeenCalledTimes(2);
  expect(window.focus).toHaveBeenCalledTimes(2);
});

it("remembers a second launch arriving before the first window is ready", () => {
  const app = new FakeApp();
  const lifecycle = createLifecycle(app, {
    stopHost: async () => {},
    dispose: vi.fn(),
    onError: vi.fn(),
  });
  app.emit("second-instance");
  const window = new FakeWindow();
  lifecycle?.setWindow(window);
  expect(window.show).toHaveBeenCalledOnce();
  expect(window.focus).toHaveBeenCalledOnce();
});

it("waits for shutdown once before quitting, including repeated OS quit events", async () => {
  let finish!: () => void;
  const stop = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
  const { app, lifecycle, dispose } = fixture(true, stop);
  app.quit();
  app.quit();
  const stopped = lifecycle?.quit();
  await Promise.resolve();
  expect(stop).toHaveBeenCalledOnce();
  expect(app.exited).toBe(false);
  expect(dispose).not.toHaveBeenCalled();
  finish();
  await stopped;
  expect(dispose).toHaveBeenCalledOnce();
  expect(app.exited).toBe(true);
});

function leaving(leave: () => Promise<void>, stop = vi.fn(async () => {})) {
  const app = new FakeApp();
  const timers: { ms: number; fire: () => void; cancel: ReturnType<typeof vi.fn> }[] = [];
  const onError = vi.fn();
  const lifecycle = createLifecycle(app, {
    stopHost: stop,
    dispose: vi.fn(),
    onError,
    leave,
    schedule: (ms, fire) => {
      const cancel = vi.fn();
      timers.push({ ms, fire, cancel });
      return cancel;
    },
  });
  lifecycle?.setWindow(new FakeWindow());
  return { app, stop, timers, onError };
}

it("lets the window acknowledge what Today showed before the host stops", async () => {
  const handled: string[] = [];
  // Handles the window's requests in order and answers its ping, as the host port does.
  const host = (message: { type: "view.acknowledge"; cursor: number } | { type: "ping" }) =>
    setTimeout(() => {
      if (message.type === "view.acknowledge") handled.push(`acknowledge ${message.cursor}`);
      else
        windowRelay.observe({
          version: PROTOCOL_VERSION,
          id: WINDOW_LEAVE_ID,
          kind: "response",
          type: "pong",
          payload: {},
        });
    }, 5);
  const windowRelay = windowLeave(() => {
    host({ type: "view.acknowledge", cursor: 6 });
    host({ type: "ping" });
    return true;
  });
  const { app, timers } = leaving(
    () => windowRelay.leave(),
    vi.fn(async () => {
      handled.push("stop host");
    }),
  );
  app.quit();
  await vi.waitFor(() => expect(app.exited).toBe(true));
  expect(handled).toEqual(["acknowledge 6", "stop host"]);
  expect(timers.map(({ ms }) => ms)).toEqual([LEAVE_WAIT_MS]);
  expect(timers[0]?.cancel).toHaveBeenCalledOnce();
});

it("stops the host without waiting when the window has nothing to acknowledge", async () => {
  const signal = vi.fn(() => false);
  const { app, stop, timers } = leaving(() => windowLeave(signal).leave());
  app.quit();
  await vi.waitFor(() => expect(app.exited).toBe(true));
  expect(signal).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledOnce();
  expect(timers[0]?.cancel).toHaveBeenCalledOnce();
});

it("bounds the wait for a window that never answers", async () => {
  const { app, stop, timers } = leaving(() => new Promise<void>(() => {}));
  app.quit();
  await vi.waitFor(() => expect(timers).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(stop).not.toHaveBeenCalled();
  timers[0]?.fire();
  await vi.waitFor(() => expect(app.exited).toBe(true));
  expect(stop).toHaveBeenCalledOnce();
});

it("still stops the host and exits normally when the leave throws synchronously", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const error = new Error("relay gone");
    const { app, stop, timers, onError } = leaving(() => {
      throw error;
    });
    app.quit();
    await vi.waitFor(() => expect(app.exited).toBe(true));
    expect(stop).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("Window did not acknowledge before quit", error);
    expect(timers[0]?.cancel).toHaveBeenCalledOnce();
  } finally {
    warn.mockRestore();
  }
});

it("reports shutdown failure instead of exiting successfully", async () => {
  const error = new Error("Host did not stop");
  const { app, onError, dispose } = fixture(
    true,
    vi.fn(async () => {
      throw error;
    }),
  );
  app.quit();
  await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(error));
  expect(app.exited).toBe(false);
  expect(dispose).not.toHaveBeenCalled();
});

it("hides on close while real sweeps keep rising, then Quit stops and releases the stored lease", async () => {
  vi.useFakeTimers();
  const clock = { now: () => new Date(Date.now()) };
  const directory = mkdtempSync(join(tmpdir(), "spi-lifecycle-"));
  const path = join(directory, "runs.sqlite");
  openRunStore(path).close();
  const db = new DatabaseSync(path);
  const read = vi.fn(async () => ({
    data: { gh: { ok: true, detail: "fixture" }, glab: { ok: true, detail: "fixture" } },
    reads: [],
  }));
  const sweep = new SweepService({
    db,
    appData: directory,
    fleet: "test",
    ctx: createContext({ clock }),
    exec: {
      runJSON: async () => {
        throw new Error("No external commands in this fixture");
      },
      runText: async () => {
        throw new Error("No external commands in this fixture");
      },
    },
    factsSchema,
    doctor: () => ({ state: "clear", problems: [] }),
    intervalMs: 300,
    ttlMs: 3000,
    timers: {
      after(ms, callback) {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    },
    onError: (error) => {
      throw error;
    },
    createSweeper: (options) =>
      new Sweeper({ ...options, areas: [{ name: "auth", read }], cacheSchema, emptyCache }),
  });
  try {
    const { app, window, lifecycle, stop } = fixture(
      true,
      vi.fn(() => stopHostAndReleaseLeases(() => sweep.stop(), path)),
    );
    await sweep.start();
    expect(read).toHaveBeenCalledOnce();
    expect(sweep.latest()?.cursor).toBe(1);
    const close = { preventDefault: vi.fn() };
    window.emit("close", close);
    expect(close.preventDefault).toHaveBeenCalledOnce();
    expect(window.hide).toHaveBeenCalledOnce();
    app.emit("window-all-closed");
    await vi.advanceTimersByTimeAsync(600);
    expect(read).toHaveBeenCalledTimes(3);
    expect(sweep.latest()?.cursor).toBe(3);
    expect(stop).not.toHaveBeenCalled();
    expect(app.exited).toBe(false);
    expect(db.prepare("SELECT owner FROM leases").get()?.owner).toBe(sweep.owner);
    await lifecycle?.quit();
    expect(app.exited).toBe(true);
    expect(db.prepare("SELECT owner, expires_at, fence FROM leases").get()).toEqual({
      owner: null,
      expires_at: 0,
      fence: 1,
    });
    await vi.advanceTimersByTimeAsync(600);
    expect(read).toHaveBeenCalledTimes(3);
  } finally {
    await sweep.stop();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("releases a terminated Windows host's persisted lease only after its exit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "spi-quit-leases-"));
  const path = join(directory, "runs.sqlite");
  openRunStore(path).close();
  const db = new DatabaseSync(path);
  try {
    db.exec("INSERT INTO leases VALUES ('test', 'terminated-host', 7, 9999999999999)");
    let exit!: () => void;
    const stopped = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          expect(db.prepare("SELECT owner FROM leases").get()?.owner).toBe("terminated-host");
          exit = resolve;
        }),
    );
    const quitting = stopHostAndReleaseLeases(stopped, path);
    expect(stopped).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT owner FROM leases").get()?.owner).toBe("terminated-host");
    exit();
    await quitting;
    expect(db.prepare("SELECT owner, expires_at, fence FROM leases").get()).toEqual({
      owner: null,
      expires_at: 0,
      fence: 7,
    });
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("does not release leases if the host fails to stop", async () => {
  const directory = mkdtempSync(join(tmpdir(), "spi-quit-failure-"));
  const path = join(directory, "runs.sqlite");
  openRunStore(path).close();
  const db = new DatabaseSync(path);
  try {
    db.exec("INSERT INTO leases VALUES ('test', 'live-host', 2, 9999999999999)");
    await expect(
      stopHostAndReleaseLeases(async () => {
        throw new Error("Still running");
      }, path),
    ).rejects.toThrow("Still running");
    expect(db.prepare("SELECT owner FROM leases").get()?.owner).toBe("live-host");
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function fakeTimers() {
  const pending: { ms: number; callback: () => void; cancelled: boolean }[] = [];
  return {
    pending,
    schedule: vi.fn((ms: number, callback: () => void) => {
      const timer = { ms, callback, cancelled: false };
      pending.push(timer);
      return () => {
        timer.cancelled = true;
      };
    }),
    fire(ms: number) {
      const timer = pending.find((entry) => entry.ms === ms && !entry.cancelled);
      expect(timer, `no live ${ms} ms timer`).toBeDefined();
      timer?.callback();
    },
  };
}

function stubbornHost() {
  let exit!: () => void;
  const exited = new Promise<void>((resolve) => {
    exit = resolve;
  });
  return {
    exit,
    stop: vi.fn(() => exited),
    kill: vi.fn(() => exit()),
  };
}

function leaseStore(owner: string) {
  const directory = mkdtempSync(join(tmpdir(), "spi-bounded-quit-"));
  const path = join(directory, "runs.sqlite");
  openRunStore(path).close();
  const db = new DatabaseSync(path);
  db.exec(`INSERT INTO leases VALUES ('test', '${owner}', 4, 9999999999999)`);
  return {
    path,
    owner: () => db.prepare("SELECT owner FROM leases").get()?.owner,
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

it("bounds the stop at 2 s of grace and 1 s after a hard kill", () => {
  expect(HOST_STOP_GRACE_MS).toBe(2000);
  expect(HOST_KILL_WAIT_MS).toBe(1000);
});

it("does not hard-kill a host that stops within its grace", async () => {
  const timers = fakeTimers();
  const host = stubbornHost();
  const stopping = stopWithin(host.stop, host.kill, { schedule: timers.schedule });
  host.exit();
  await stopping;
  expect(host.kill).not.toHaveBeenCalled();
  expect(timers.pending).toEqual([expect.objectContaining({ ms: 2000, cancelled: true })]);
});

it("hard-kills a host that ignores SIGTERM, then Quit releases leases and completes", async () => {
  const timers = fakeTimers();
  const host = stubbornHost();
  host.kill.mockImplementation(() => {
    expect(store.owner()).toBe("stubborn-host");
    setImmediate(host.exit);
  });
  const store = leaseStore("stubborn-host");
  const log = vi.fn();
  try {
    const { app, lifecycle, dispose } = fixture(
      true,
      vi.fn(() =>
        stopHostAndReleaseLeases(
          () => stopWithin(host.stop, host.kill, { graceMs: 50, schedule: timers.schedule, log }),
          store.path,
        ),
      ),
    );
    const quitting = lifecycle?.quit();
    await vi.waitFor(() => expect(host.stop).toHaveBeenCalledOnce());
    expect(host.kill).not.toHaveBeenCalled();
    timers.fire(50);
    await quitting;
    expect(host.kill).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("Host did not stop within 50 ms; killing it");
    expect(store.owner()).toBeNull();
    expect(dispose).toHaveBeenCalledOnce();
    expect(app.exited).toBe(true);
  } finally {
    store.close();
  }
});

it("keeps leases when the hard kill fails", async () => {
  const timers = fakeTimers();
  const host = stubbornHost();
  host.kill.mockImplementation(() => {
    throw new Error("EPERM");
  });
  const store = leaseStore("unkillable-host");
  try {
    const stopping = stopHostAndReleaseLeases(
      () => stopWithin(host.stop, host.kill, { schedule: timers.schedule, log: vi.fn() }),
      store.path,
    );
    await vi.waitFor(() => expect(timers.schedule).toHaveBeenCalledOnce());
    timers.fire(HOST_STOP_GRACE_MS);
    await expect(stopping).rejects.toThrow("EPERM");
    expect(store.owner()).toBe("unkillable-host");
  } finally {
    store.close();
  }
});

it("keeps leases when the host has not exited by the end of the kill wait", async () => {
  const timers = fakeTimers();
  const host = stubbornHost();
  host.kill.mockImplementation(() => {});
  const store = leaseStore("zombie-host");
  try {
    const stopping = stopHostAndReleaseLeases(
      () => stopWithin(host.stop, host.kill, { schedule: timers.schedule, log: vi.fn() }),
      store.path,
    );
    await vi.waitFor(() => expect(timers.schedule).toHaveBeenCalledOnce());
    timers.fire(HOST_STOP_GRACE_MS);
    await vi.waitFor(() => expect(timers.schedule).toHaveBeenCalledTimes(2));
    expect(host.kill).toHaveBeenCalledOnce();
    timers.fire(HOST_KILL_WAIT_MS);
    await expect(stopping).rejects.toThrow("Host did not exit within 1000 ms of a hard kill");
    expect(store.owner()).toBe("zombie-host");
  } finally {
    store.close();
  }
});

it.each(["query-session-end", "session-end"])(
  "quits on Windows %s without the hidden-window close handler blocking it",
  async (event) => {
    let finish!: () => void;
    const { app, window, stop } = fixture(
      true,
      vi.fn(() => new Promise<void>((resolve) => (finish = resolve))),
    );
    window.emit(event, { reasons: ["logoff"], preventDefault: vi.fn() });
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    const close = { preventDefault: vi.fn() };
    window.emit("close", close);
    expect(close.preventDefault).not.toHaveBeenCalled();
    expect(window.hide).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(app.exited).toBe(true));
  },
);

it("lets macOS logout close the hidden window once before-quit has started quitting", async () => {
  const { app, window, stop } = fixture();
  const quit = { preventDefault: vi.fn() };
  app.emit("before-quit", quit);
  expect(quit.preventDefault).toHaveBeenCalledOnce();
  const close = { preventDefault: vi.fn() };
  window.emit("close", close);
  expect(close.preventDefault).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(app.exited).toBe(true));
  expect(stop).toHaveBeenCalledOnce();
});

it("quits cleanly when the run store has no leases table", async () => {
  const directory = mkdtempSync(join(tmpdir(), "spi-quit-no-leases-"));
  const path = join(directory, "runs.sqlite");
  new DatabaseSync(path).close();
  const log = vi.fn();
  try {
    await stopHostAndReleaseLeases(async () => {}, path, log);
    expect(log).toHaveBeenCalledWith("Run store has no leases table; nothing to release");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function hostTree(...runtimes: number[]) {
  const live = new Map(runtimes.map((pid) => [pid, `started-${pid}`]));
  const kill = vi.fn((pid: number) => {
    live.delete(pid);
  });
  const capture = vi.fn(async (_pid: number) =>
    runtimes.map((pid) => ({ pid, started: `started-${pid}` })),
  );
  const log = vi.fn();
  return {
    live,
    kill,
    capture,
    log,
    options: {
      capture,
      reap: (targets: readonly ProcessIdentity[], waitMs: number) =>
        reapProcesses(targets, {
          platform: "darwin",
          kill: (pid) => kill(pid),
          alive: (pid) => live.has(pid),
          identify: async (pids) =>
            new Map(pids.flatMap((pid) => (live.has(pid) ? [[pid, live.get(pid) ?? ""]] : []))),
          waitMs,
        }),
      log,
    },
  };
}

it("captures the runtime before SIGTERM and kills it when it outlives the host", async () => {
  const timers = fakeTimers();
  const host = stubbornHost();
  const tree = hostTree(501);
  const store = leaseStore("graceful-host");
  try {
    const quitting = stopHostAndReleaseLeases(
      () =>
        stopHostTree(
          41,
          () => stopWithin(host.stop, host.kill, { schedule: timers.schedule }),
          tree.options,
        ),
      store.path,
    );
    await vi.waitFor(() => expect(host.stop).toHaveBeenCalledOnce());
    expect(tree.capture).toHaveBeenCalledWith(41);
    expect(tree.capture.mock.invocationCallOrder[0]).toBeLessThan(
      host.stop.mock.invocationCallOrder[0] ?? 0,
    );
    host.exit();
    await quitting;
    expect(host.kill).not.toHaveBeenCalled();
    expect(tree.kill).toHaveBeenCalledWith(501);
    expect(tree.live.size).toBe(0);
    expect(tree.log).not.toHaveBeenCalled();
    expect(store.owner()).toBeNull();
  } finally {
    store.close();
  }
});

it("kills the runtime when Electron reaps the host before the JS fallback, and Quit completes", async () => {
  const timers = fakeTimers();
  const host = stubbornHost();
  const tree = hostTree(502, 503);
  const { app, lifecycle } = fixture(
    true,
    vi.fn(() =>
      stopHostTree(
        42,
        () => stopWithin(host.stop, host.kill, { schedule: timers.schedule }),
        tree.options,
      ),
    ),
  );
  const quitting = lifecycle?.quit();
  await vi.waitFor(() => expect(host.stop).toHaveBeenCalledOnce());
  host.exit();
  await quitting;
  expect(timers.pending).toEqual([expect.objectContaining({ ms: 2000, cancelled: true })]);
  expect(host.kill).not.toHaveBeenCalled();
  expect(tree.kill.mock.calls).toEqual([[502], [503]]);
  expect(tree.live.size).toBe(0);
  expect(app.exited).toBe(true);
});

it("kills the runtime after a hard kill too", async () => {
  const timers = fakeTimers();
  const host = stubbornHost();
  const tree = hostTree(504);
  const stopping = stopHostTree(
    43,
    () => stopWithin(host.stop, host.kill, { schedule: timers.schedule, log: vi.fn() }),
    tree.options,
  );
  await vi.waitFor(() => expect(timers.schedule).toHaveBeenCalledOnce());
  timers.fire(HOST_STOP_GRACE_MS);
  await stopping;
  expect(host.kill).toHaveBeenCalledOnce();
  expect(tree.kill).toHaveBeenCalledWith(504);
  expect(tree.live.size).toBe(0);
});

it("quits normally when the runtime has already exited with the host", async () => {
  const host = stubbornHost();
  const tree = hostTree(505);
  const stopping = stopHostTree(
    44,
    async () => {
      await Promise.resolve();
      tree.live.delete(505);
      host.exit();
    },
    tree.options,
  );
  await stopping;
  expect(tree.kill).not.toHaveBeenCalled();
  expect(tree.log).not.toHaveBeenCalled();
});

it("releases leases and logs when a runtime survives quit, since it never held the store", async () => {
  const tree = hostTree(506);
  const store = leaseStore("exited-host");
  try {
    await stopHostAndReleaseLeases(
      () =>
        stopHostTree(45, async () => {}, {
          ...tree.options,
          reap: async (pids) => [...pids],
        }),
      store.path,
    );
    expect(tree.log).toHaveBeenCalledWith("Host descendants survived quit: 506");
    expect(store.owner()).toBeNull();
  } finally {
    store.close();
  }
});

it("still stops the host when its descendants cannot be captured", async () => {
  const stop = vi.fn(async () => {});
  const log = vi.fn();
  const reap = vi.fn(async () => []);
  await stopHostTree(46, stop, {
    capture: async () => {
      throw new Error("pgrep missing");
    },
    reap,
    log,
  });
  expect(stop).toHaveBeenCalledOnce();
  expect(reap).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith("Host descendants not captured: pgrep missing");
});

it("reaps the runtime but keeps leases when the host's hard kill fails", async () => {
  const tree = hostTree(507);
  const store = leaseStore("stuck-host");
  try {
    await expect(
      stopHostAndReleaseLeases(
        () =>
          stopHostTree(
            47,
            async () => {
              throw new Error("kill EPERM");
            },
            tree.options,
          ),
        store.path,
      ),
    ).rejects.toThrow("kill EPERM");
    expect(tree.kill).toHaveBeenCalledWith(507);
    expect(store.owner()).toBe("stuck-host");
  } finally {
    store.close();
  }
});

function budgetedTree(elapsedMs: number) {
  let clock = 0;
  const reap = vi.fn(async (_targets: readonly ProcessIdentity[], waitMs: number) => {
    clock += waitMs;
    return [];
  });
  const log = vi.fn();
  const stopping = stopHostTree(
    48,
    async () => {
      clock = elapsedMs;
    },
    { capture: async () => [{ pid: 508, started: "started-508" }], reap, log, now: () => clock },
  );
  return { reap, log, stopping, clock: () => clock };
}

it.each([1200, 4350])("keeps quit within 4.5 s when %i ms are already spent", async (elapsedMs) => {
  const tree = budgetedTree(elapsedMs);
  await tree.stopping;
  expect(tree.reap).toHaveBeenCalledWith(expect.anything(), QUIT_BUDGET_MS - elapsedMs);
  expect(tree.clock()).toBeLessThanOrEqual(QUIT_BUDGET_MS);
});

it.each([QUIT_BUDGET_MS, 4600])(
  "skips the reap and logs once %i ms have spent the quit budget, and Quit still completes",
  async (elapsedMs) => {
    const tree = budgetedTree(elapsedMs);
    await expect(tree.stopping).resolves.toBeUndefined();
    expect(tree.reap).not.toHaveBeenCalled();
    expect(tree.clock()).toBe(elapsedMs);
    expect(tree.log).toHaveBeenCalledWith(
      "Host descendants not reaped: the 4500 ms quit budget is spent (508)",
    );
  },
);
