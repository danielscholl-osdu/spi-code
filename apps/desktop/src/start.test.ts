// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { PROTOCOL_VERSION } from "@spi-code/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseAst } from "vitest/node";

const electron = { current: undefined as ReturnType<typeof harness> | undefined };
vi.mock("./tray.js", () => ({
  createSweepTray: () => ({ dispose: vi.fn(), disconnected: vi.fn() }),
  trayChannel: () => ({ dispose: vi.fn(), connected: () => false }),
}));
vi.mock("./interrupts.js", () => ({
  createInterruptNotifications: () => ({ dispose: vi.fn() }),
}));
vi.mock("./outage.js", () => ({ createOutageNotifications: () => ({ dispose: vi.fn() }) }));
const smokeModules = readdirSync(new URL(".", import.meta.url))
  .filter((name) => /^smoke-.*\.ts$/.test(name) && !name.endsWith(".test.ts"))
  .map((name) => `./${name.replace(/\.ts$/, ".js")}`);

function harness() {
  const directory = mkdtempSync(join(tmpdir(), "spi-start-"));
  const app = Object.assign(new EventEmitter(), {
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    whenReady: async () => {},
    getPath: () => directory,
    setPath: vi.fn(),
    exit: vi.fn(),
  });
  const ipcMain = Object.assign(new EventEmitter(), { handle: vi.fn(), removeHandler: vi.fn() });
  const host = Object.assign(new EventEmitter(), {
    pid: 999999,
    kill: vi.fn(() => {
      queueMicrotask(() => host.emit("exit", 0));
      return true;
    }),
  });
  class BrowserWindow extends EventEmitter {
    static windows: BrowserWindow[] = [];
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: {},
      isLoadingMainFrame: () => false,
      session: {
        setPermissionCheckHandler: vi.fn(),
        setPermissionRequestHandler: vi.fn(),
      },
      setWindowOpenHandler: vi.fn(),
    });
    isDestroyed = () => false;
    loadFile = vi.fn(async () => {});
    constructor(readonly options: Electron.BrowserWindowConstructorOptions) {
      super();
      BrowserWindow.windows.push(this);
    }
  }
  return {
    directory,
    app,
    BrowserWindow,
    ipcMain,
    nativeTheme: { shouldUseDarkColors: false },
    powerMonitor: new EventEmitter(),
    shell: { openExternal: vi.fn(async () => {}) },
    utilityProcess: { fork: vi.fn(() => host) },
    host,
  };
}

const originalArgv = process.argv;
beforeEach(() => {
  vi.resetModules();
  const current = harness();
  electron.current = current;
  vi.doMock("electron", () => current);
  vi.doMock("./host-tree.js", () => ({
    stopHostTree: (_pid: number, stop: () => Promise<void>) => stop(),
  }));
  process.argv = ["electron", "."];
});
afterEach(() => {
  process.argv = originalArgv;
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const module of smokeModules) vi.doUnmock(module);
  rmSync(electron.current?.directory ?? "", { recursive: true, force: true });
});

it("keeps every renderer limit when the start function builds a fake BrowserWindow", async () => {
  const { createDesktop } = await import("./start.js");
  const desktop = createDesktop({ smoke: false, proof: false, onError: vi.fn() });
  await desktop.start();
  const window = electron.current?.BrowserWindow.windows[0];
  expect(window).toBeDefined();
  expect(window?.options.webPreferences).toMatchObject({
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    additionalArguments: [],
  });
  expect(window?.options.webPreferences?.preload).toMatch(/[/\\]src[/\\]preload\.cjs$/);
  const session = window?.webContents.session;
  expect(session?.setPermissionCheckHandler.mock.calls[0]?.[0]()).toBe(false);
  const denied = vi.fn();
  session?.setPermissionRequestHandler.mock.calls[0]?.[0]({}, "notifications", denied);
  expect(denied).toHaveBeenCalledExactlyOnceWith(false);
  const event = { preventDefault: vi.fn() };
  window?.webContents.emit("will-navigate", event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  const windowOpen = window?.webContents.setWindowOpenHandler.mock.calls[0]?.[0];
  expect(windowOpen?.({ url: "https://example.com" })).toEqual({ action: "deny" });
  expect(electron.current?.shell.openExternal).not.toHaveBeenCalled();
  const url = "https://github.com/Azure/stack";
  expect(windowOpen?.({ url })).toEqual({ action: "deny" });
  expect(electron.current?.shell.openExternal).toHaveBeenCalledExactlyOnceWith(url);
});

type Node = { type: string; [key: string]: unknown };
const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as Node).type === "string";

function moduleLoads(name: string): { specifier: string | undefined; dynamic: boolean }[] {
  const source = readFileSync(new URL(name, import.meta.url), "utf8");
  const loads: { specifier: string | undefined; dynamic: boolean }[] = [];
  const literal = (node: unknown) =>
    isNode(node) && node.type === "Literal" && typeof node.value === "string"
      ? node.value
      : undefined;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isNode(value)) return;
    // verbatimModuleSyntax erases only whole `import type`; `import { type X }` still loads.
    const typeOnly = value.importKind === "type" || value.exportKind === "type";
    const declaration = /^(Import|ExportNamed|ExportAll)Declaration$/.test(value.type);
    if (declaration && value.source && !typeOnly)
      loads.push({ specifier: literal(value.source), dynamic: false });
    const reference = value.moduleReference;
    if (value.type === "TSImportEqualsDeclaration" && !typeOnly && isNode(reference))
      if (reference.type === "TSExternalModuleReference")
        loads.push({ specifier: literal(reference.expression), dynamic: false });
    if (value.type === "ImportExpression")
      loads.push({ specifier: literal(value.source), dynamic: true });
    for (const child of Object.values(value)) visit(child);
  };
  visit(parseAst(source, { lang: "ts", sourceType: "module" }, name));
  return loads;
}

const guardedEntryImports = ["./smoke-messages.js", "./smoke-report.js", "./smoke-run.js"];

it("reaches no smoke module through the static import graph of the entry and start module", () => {
  const visited = new Set<string>();
  const pending = ["index.ts", "start.ts"];
  const reached: string[] = [];
  const entryGuarded: string[] = [];
  const root = new URL(".", import.meta.url).pathname;
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (visited.has(name)) continue;
    visited.add(name);
    expect(existsSync(new URL(name, import.meta.url)), name).toBe(true);
    for (const { specifier, dynamic } of moduleLoads(name)) {
      if (specifier === undefined) {
        reached.push(`${name} -> import(<not a string literal>)`);
        continue;
      }
      if (!/^\.{1,2}\//.test(specifier)) continue;
      const url = new URL(specifier.replace(/\.js$/, ".ts"), new URL(name, import.meta.url));
      const path = url.pathname.slice(root.length);
      if (/^smoke-[^/]*\.ts$/.test(path)) {
        if (name === "index.ts" && dynamic) entryGuarded.push(specifier);
        else reached.push(`${name} -> ${path}`);
        continue;
      }
      pending.push(path);
    }
  }
  expect([...visited]).toEqual(
    expect.arrayContaining(["start.ts", "tray.ts", "interrupts.ts", "outage.ts", "host-tree.ts"]),
  );
  expect(reached).toEqual([]);
  // These sit behind --smoke/--proof; the production start test below fails if one runs.
  expect(entryGuarded.sort()).toEqual(guardedEntryImports);
});

it("starts production wiring without loading smoke or registering proof:message", async () => {
  const loadSmoke = vi.fn(() => {
    throw new Error("Production loaded smoke");
  });
  expect(smokeModules).toEqual(expect.arrayContaining(["./smoke-run.js", "./smoke-listeners.js"]));
  for (const module of smokeModules) vi.doMock(module, loadSmoke);
  vi.doUnmock("./host-tree.js");
  vi.useFakeTimers();
  await import("./index.js");
  await vi.waitFor(() => expect(electron.current?.utilityProcess.fork).toHaveBeenCalledOnce());
  await vi.dynamicImportSettled();
  await vi.runOnlyPendingTimersAsync();
  await vi.dynamicImportSettled();
  expect(electron.current?.ipcMain.listenerCount("proof:message")).toBe(0);
  expect(loadSmoke).not.toHaveBeenCalled();
  expect(electron.current?.app.exit).not.toHaveBeenCalled();
});

it("keeps the entry under 290 lines and the smoke report assertions in smoke-run", () => {
  const source = readFileSync(new URL("index.ts", import.meta.url), "utf8");
  expect(source.trimEnd().split("\n").length).toBeLessThan(290);
  expect(source).not.toMatch(/assertSmokeReport|assertSmokeTools/);
});

it.each(["load", "run"])(
  "writes an error report and stops the host when smoke fails to %s before reporting",
  async (failure) => {
    const current = electron.current;
    if (!current) throw new Error("Missing Electron harness");
    vi.useFakeTimers();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error(`Smoke ${failure} failed`);
    vi.doMock("./smoke-run.js", () => {
      if (failure === "load") throw error;
      return {
        runSmoke: async (handles: { startHost(): void }) => {
          handles.startHost();
          throw error;
        },
      };
    });
    const report = join(current.directory, "smoke.json");
    process.argv.push("--smoke", `--user-data-dir=${current.directory}`, "--smoke-report", report);
    await import("./index.js");
    await vi.waitFor(() => expect(current.app.exit).toHaveBeenCalledExactlyOnceWith(1));
    const caught: unknown = logged.mock.calls[0]?.[0];
    expect(caught).toBeInstanceOf(Error);
    expect(JSON.parse(readFileSync(report, "utf8"))).toEqual({
      error: (caught as Error).message,
    });
    if (failure === "run") expect(caught).toBe(error);
    else expect(caught).toHaveProperty("cause", error);
    expect(current.host.kill).toHaveBeenCalledTimes(failure === "run" ? 1 : 0);
    expect(current.app.exit).not.toHaveBeenCalledWith(0);
  },
);

it("pins the preload malformed probe version to PROTOCOL_VERSION", () => {
  const ipcRenderer = new EventEmitter();
  const port = { start: vi.fn(), postMessage: vi.fn() };
  runInNewContext(readFileSync(new URL("preload.cjs", import.meta.url), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: vi.fn() }, ipcRenderer }),
    process: { argv: ["--spi-smoke"] },
  });
  ipcRenderer.emit("host:port", { ports: [port] });
  ipcRenderer.emit("smoke:malformed");
  expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({
    version: PROTOCOL_VERSION,
    id: "bad",
    kind: "request",
    type: "ping",
    payload: { extra: true },
  });
});
