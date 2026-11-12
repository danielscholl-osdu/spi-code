// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  ipcMain,
  MessageChannelMain,
  type MessagePortMain,
  nativeTheme,
  powerMonitor,
  shell,
  type UtilityProcess,
  utilityProcess,
} from "electron";
import { externalLinkHandlers } from "./external-links.js";
import { hostLaunch } from "./host-launch.js";
import { stopHostTree } from "./host-tree.js";
import { createInterruptNotifications } from "./interrupts.js";
import { windowLeave, windowLeaveSignal } from "./leave.js";
import { createLifecycle, stopHostAndReleaseLeases, stopWithin } from "./lifecycle.js";
import { createOutageNotifications } from "./outage.js";
import { HostSupervisor, hostPortCallbacks } from "./supervisor.js";
import { createSweepTray, trayChannel } from "./tray.js";
import { wakeSweep } from "./wake.js";
import { bindTitleBarAppearance, windowTitleBarOptions } from "./window-chrome.js";
import { showDestination } from "./window-navigation.js";

export function createDesktop({
  smoke,
  proof,
  onError,
}: {
  smoke: boolean;
  proof: boolean;
  onError(error: unknown): void;
}) {
  const desktopDir = fileURLToPath(new URL("..", import.meta.url));
  const hostEntry = app.isPackaged
    ? join(app.getAppPath(), "scripts/packaged-host.mjs")
    : fileURLToPath(new URL("../../../packages/host/dist/main.js", import.meta.url));
  const windowEntry = app.isPackaged
    ? join(app.getAppPath(), "apps/window/build/index.html")
    : fileURLToPath(new URL("../../window/build/index.html", import.meta.url));
  let child: UtilityProcess | undefined;
  let supervisor: HostSupervisor<UtilityProcess> | undefined;
  let hostPorts: ReturnType<typeof hostPortCallbacks<MessagePortMain>> | undefined;
  let tray: ReturnType<typeof createSweepTray> | undefined;
  let interrupts: ReturnType<typeof createInterruptNotifications> | undefined;
  let outage: ReturnType<typeof createOutageNotifications> | undefined;
  let relay: ReturnType<typeof trayChannel<MessagePortMain>> | undefined;
  let wake: ReturnType<typeof wakeSweep> | undefined;
  let storePath: string | undefined;
  let leaving: ReturnType<typeof windowLeave> | undefined;
  function killHost(): void {
    if (!child?.pid) throw new Error("Host has no pid to kill");
    process.kill(child.pid, "SIGKILL");
  }

  async function stopHost(): Promise<void> {
    const stop = async () => {
      if (supervisor) {
        await supervisor.stop();
        return;
      }
      if (!child) return;
      const exited = once(child, "exit");
      if (!child.kill()) throw new Error("Could not kill host");
      await exited;
      child = undefined;
    };
    await stopHostAndReleaseLeases(
      () => stopHostTree(child?.pid, () => stopWithin(stop, killHost)),
      storePath,
    );
  }

  function forkHost(args: string[]): UtilityProcess {
    const launch = hostLaunch(app.isPackaged, smoke, proof, process.env);
    const host = utilityProcess.fork(hostEntry, [...args, ...launch.args], {
      env: launch.env,
      serviceName: "SPI Code host",
      stdio: "pipe",
    });
    child = host;
    host.stderr?.on("data", (data: Buffer) => process.stderr.write(data));
    host.stdout?.on("data", (data: Buffer) => process.stdout.write(data));
    host.once("exit", () => {
      if (child === host) child = undefined;
      tray?.disconnected();
    });
    return host;
  }

  function dispose(): void {
    hostPorts?.dispose();
    relay?.dispose();
    wake?.dispose();
    tray?.dispose();
    interrupts?.dispose();
    outage?.dispose();
  }

  async function start() {
    const lifecycle = createLifecycle(app, {
      stopHost,
      dispose,
      onError,
      leave: () => leaving?.leave() ?? Promise.resolve(),
    });
    if (!lifecycle) return;
    await app.whenReady();
    const dataDir = smoke
      ? join(app.getPath("userData"), "smoke", randomUUID())
      : app.getPath("userData");
    mkdirSync(dataDir, { recursive: true });
    storePath = join(dataDir, "runs.sqlite");
    const window = new BrowserWindow({
      width: smoke ? 1280 : 900,
      height: smoke ? 800 : 650,
      minWidth: 740,
      useContentSize: true,
      show: !smoke,
      ...windowTitleBarOptions(nativeTheme.shouldUseDarkColors, process.platform),
      webPreferences: {
        preload: app.isPackaged
          ? join(app.getAppPath(), "apps/desktop/src/preload.cjs")
          : join(desktopDir, "src/preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        additionalArguments: proof ? ["--spi-proof", ...(smoke ? ["--spi-smoke"] : [])] : [],
      },
    });
    lifecycle.setWindow(window);
    leaving = windowLeave(windowLeaveSignal(window, () => relay?.connected() ?? false));
    tray = createSweepTray(lifecycle.open, () => void lifecycle.quit().catch(onError), {
      hidden: () => window.isDestroyed() || !window.isVisible() || window.isMinimized(),
      request: (message) => relay?.request(message) ?? false,
      viewSweep: () => showDestination(lifecycle.open, window.webContents, { to: "evidence" }),
      // AU-09: the dock carries the Today count on macOS; Windows reads it in the tooltip.
      ...(process.platform === "darwin"
        ? { badge: (text: string) => app.dock?.setBadge(text) }
        : {}),
    });
    wake = wakeSweep(powerMonitor, (message) => relay?.request(message) ?? false);
    interrupts = createInterruptNotifications({
      focused: () => !window.isDestroyed() && window.isFocused(),
      open: (destination) => showDestination(lifecycle.open, window.webContents, destination),
    });
    outage = createOutageNotifications({
      focused: () => !window.isDestroyed() && window.isFocused(),
      open: (destination) => showDestination(lifecycle.open, window.webContents, destination),
      power: powerMonitor,
    });
    relay = trayChannel(
      () => new MessageChannelMain(),
      (message) => {
        leaving?.observe(message);
        wake?.observe(message);
        tray?.observe(message);
        interrupts?.observe(message);
        outage?.observe(message);
      },
      interrupts.outgoing,
    );
    const channels: MessageChannelMain[] = [];
    hostPorts = hostPortCallbacks(() => {
      assert(relay);
      const channel = relay.connect();
      if (smoke) channels.push(channel);
      return channel;
    }, window);
    let deniedPermissionRequests = 0;
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
      deniedPermissionRequests++;
      callback(false);
    });
    const externalLinks = externalLinkHandlers(window.webContents, {
      openExternal: (url) => shell.openExternal(url),
      warn: (message) => console.warn(message),
    });
    ipcMain.handle("external:open", externalLinks.openFromRenderer);
    window.on("closed", () => ipcMain.removeHandler("external:open"));
    bindTitleBarAppearance(ipcMain, window, process.platform);
    window.webContents.setWindowOpenHandler(externalLinks.windowOpen);
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    const hostStorePath = storePath;
    const ports = hostPorts;
    return {
      window,
      dataDir,
      storePath: hostStorePath,
      channels,
      tray,
      deniedPermissionRequests: () => deniedPermissionRequests,
      currentHost: () => {
        assert(child, "Supervised utility process is missing");
        return child;
      },
      startHost(
        args = () => [hostStorePath],
        clock?: ConstructorParameters<typeof HostSupervisor<UtilityProcess>>[0]["clock"],
      ) {
        supervisor = new HostSupervisor<UtilityProcess>({
          spawn: () => forkHost(args()),
          onSpawn: ports.onSpawn,
          onGiveUp: ports.onGiveUp,
          ...(clock ? { clock } : {}),
        });
        supervisor.start();
      },
      loadWindow: () => window.loadFile(windowEntry),
      stopHost,
      dispose,
    };
  }

  return { start, stopHost, disposeHostPorts: () => hostPorts?.dispose() };
}

export type DesktopHandles = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createDesktop>["start"]>>
>;
