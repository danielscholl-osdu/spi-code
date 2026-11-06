// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import { createLifecycle, stopHostAndReleaseLeases } from "./lifecycle.js";

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
