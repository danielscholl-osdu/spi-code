// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Message, parseMessage } from "@spi-code/contracts";
import {
  app,
  BrowserWindow,
  ipcMain,
  MessageChannelMain,
  type MessagePortMain,
  nativeTheme,
  shell,
  type UtilityProcess,
  utilityProcess,
} from "electron";
import { externalLinkHandlers } from "./external-links.js";
import { hostLaunch } from "./host-launch.js";
import { stopHostTree } from "./host-tree.js";
import { createLifecycle, stopHostAndReleaseLeases, stopWithin } from "./lifecycle.js";
import { assertNoProcessListeners } from "./smoke-listeners.js";
import { smokeMessages } from "./smoke-messages.js";
import { assertSmokeReport, assertSmokeTools, type SmokeReport } from "./smoke-report.js";
import { HostSupervisor, hostPortCallbacks } from "./supervisor.js";
import { createSweepTray, trayChannel } from "./tray.js";
import { bindTitleBarAppearance, windowTitleBarOptions } from "./window-chrome.js";

const smoke = process.argv.includes("--smoke");
const liveFlag = process.argv.indexOf("--live-report");
const livePath = liveFlag >= 0 ? process.argv[liveFlag + 1] : undefined;
const proof = smoke || liveFlag >= 0;
const reportFlag = process.argv.indexOf("--smoke-report");
const reportPath =
  reportFlag >= 0
    ? process.argv[reportFlag + 1]
    : (process.env.SPI_CODE_SMOKE_REPORT ?? join(app.getPath("temp"), "spi-code-smoke.json"));
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
let relay: ReturnType<typeof trayChannel<MessagePortMain>> | undefined;
let storePath: string | undefined;
let failing = false;

function saveReport(report: unknown): void {
  assert(reportPath);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

function fail(error: unknown): void {
  if (failing) return;
  failing = true;
  setTimeout(() => process.exit(1), 2000).unref();
  console.error(error);
  try {
    if (smoke) saveReport({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    void stopHost().then(
      () => {
        hostPorts?.dispose();
        app.exit(1);
      },
      () => {
        console.error("Failed to stop the host after a proof failure");
        process.exit(1);
      },
    );
  }
}

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
  const launch = hostLaunch(app.isPackaged, smoke, liveFlag >= 0, process.env);
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

async function run(): Promise<void> {
  if (!reportPath) throw new Error("--smoke-report requires a path");
  if (liveFlag >= 0 && (!livePath || livePath.startsWith("--")))
    throw new Error("--live-report requires a path");
  if (smoke) {
    const userData = process.argv.find((arg) => arg.startsWith("--user-data-dir="))?.slice(16);
    assert(userData, "Smoke requires an isolated --user-data-dir (use the smoke launcher)");
    app.setPath("userData", userData);
  }
  const lifecycle = createLifecycle(app, {
    stopHost,
    dispose: () => {
      hostPorts?.dispose();
      relay?.dispose();
      tray?.dispose();
    },
    onError: fail,
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
  tray = createSweepTray(lifecycle.open, () => void lifecycle.quit().catch(fail), {
    hidden: () => window.isDestroyed() || !window.isVisible() || window.isMinimized(),
  });
  relay = trayChannel(() => new MessageChannelMain(), tray.observe);
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
  const messages = smokeMessages();
  const wait = messages.wait;
  const evidence = {
    signedIn: false,
    modelCount: 0,
    streamedDeltaCount: 0,
    toolEvents: [] as Extract<Message, { type: "tool.call" }>["payload"][],
  };
  if (proof) {
    ipcMain.on("proof:message", (event, input: unknown) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
        return;
      const parsed = parseMessage(input);
      if (!parsed.ok) {
        fail(new Error("Host sent a malformed message"));
        return;
      }
      messages.push(parsed.message);
      const message = parsed.message;
      if (message.type === "signin.state") evidence.signedIn = message.payload.signedIn;
      if (message.type === "models.result") evidence.modelCount = message.payload.models.length;
      if (message.type === "turn.delta") evidence.streamedDeltaCount++;
      if (message.type === "tool.call") evidence.toolEvents.push(message.payload);
      if (livePath && message.type === "error") {
        fail(new Error("Live proof request failed"));
        return;
      }
      if (livePath && message.type === "turn.end") {
        void (async () => {
          assert.equal(message.payload.reason, "completed");
          assert(evidence.signedIn && evidence.modelCount > 0 && evidence.streamedDeltaCount > 0);
          assert(evidence.toolEvents.length > 0, "Live turn did not reach a gated tool");
          mkdirSync(dirname(livePath), { recursive: true });
          writeFileSync(livePath, `${JSON.stringify(evidence, null, 2)}\n`);
          await new Promise((resolve) => setTimeout(resolve, 500));
          writeFileSync(`${livePath}.png`, (await window.webContents.capturePage()).toPNG());
          await stopHost();
          app.exit(0);
        })().catch(fail);
      }
    });
  }
  await window.loadFile(windowEntry);
  const hostStorePath = storePath;
  if (!smoke) {
    supervisor = new HostSupervisor<UtilityProcess>({
      spawn: () => forkHost([hostStorePath]),
      onSpawn: hostPorts.onSpawn,
      onGiveUp: hostPorts.onGiveUp,
    });
    supervisor.start();
    return;
  }
  const [
    { initialSmoke, writeSmokeSnapshot },
    { exerciseSupervision, smokeClock },
    { scanAfterRuntimeReport },
    { captureSmokeViews },
  ] = await Promise.all([
    import("./smoke-snapshot.js"),
    import("./smoke-supervision.js"),
    import("./smoke-runtime-report.js"),
    import("./smoke-views.js"),
  ]);
  const fixtureFlag = process.argv.indexOf("--smoke-views-fixture");
  const designFlag = process.argv.indexOf("--smoke-views-design");
  const fixturePath =
    fixtureFlag >= 0
      ? process.argv[fixtureFlag + 1]
      : fileURLToPath(new URL("../../../fixtures/watch/snapshot-1106.json", import.meta.url));
  const designPath =
    designFlag >= 0
      ? process.argv[designFlag + 1]
      : fileURLToPath(new URL("../../../design/spi-code-window-layout.html", import.meta.url));
  assert(
    fixturePath && !fixturePath.startsWith("--"),
    "Smoke views require the Nov 6 fixture path",
  );
  assert(designPath && !designPath.startsWith("--"), "Smoke views require the window design path");
  const views = await captureSmokeViews(window, reportPath, fixturePath, designPath);
  const rowId = randomUUID();
  const probePath = join(dataDir, "probe.json");
  const firstCursor = writeSmokeSnapshot(hostStorePath, initialSmoke);
  const clock = smokeClock(process.argv);
  assert(clock);
  let launches = 0;
  supervisor = new HostSupervisor<UtilityProcess>({
    spawn: () => forkHost([hostStorePath, launches++ === 0 ? "write" : "read", rowId, probePath]),
    onSpawn: hostPorts.onSpawn,
    onGiveUp: hostPorts.onGiveUp,
    clock,
  });
  supervisor.start();
  const hello = await wait("hello");
  assert(hello.type === "host.hello");
  const hostPid = child?.pid;
  assert(hostPid);
  assert.equal(hello.payload.pid, hostPid);
  const pong = await wait("window-ping");
  const turn = await messages.waitForStartedTurn();
  assert(turn.type === "turn.end" && turn.payload.reason === "completed");
  const tools = evidence.toolEvents
    .filter(({ name }) => !name.startsWith("builtin:"))
    .map(({ name, outcome }) => {
      assert(outcome, "Missing observed tool outcome");
      return { name, outcome };
    });
  const deniedBuiltIn = evidence.toolEvents.find(({ name }) => name === "builtin:shell");
  assertSmokeTools(tools, deniedBuiltIn);
  window.webContents.send("smoke:malformed");
  const malformed = await wait("invalid");
  const permission: unknown = await window.webContents.executeJavaScript(
    "Notification.requestPermission()",
  );
  const permissionDenied = permission === "denied" && deniedPermissionRequests > 0;
  const permissionQuery: unknown = await window.webContents.executeJavaScript(
    "navigator.permissions.query({ name: 'notifications' }).then(result => result.state)",
  );
  messages.clear();
  const loaded = once(window.webContents, "did-finish-load");
  window.webContents.reload();
  await loaded;
  const reloadedHello = await wait("hello");
  const reloadedPong = await wait("window-ping");
  const reloadTurn = await messages.waitForStartedTurn();
  assert(reloadTurn.type === "turn.end" && reloadTurn.payload.reason === "completed");
  const { listeners, rendererPids } = await scanAfterRuntimeReport(
    app.isPackaged
      ? process.env.SPI_CODE_RUNTIME_REPORT || join(dataDir, "runtime-report.json")
      : undefined,
    15000,
    () => assertNoProcessListeners(process.pid, hostPid),
  );
  const supervision = await exerciseSupervision({
    window,
    messages,
    currentHost: () => {
      assert(child, "Supervised utility process is missing");
      return child;
    },
    channels,
    storePath: hostStorePath,
    firstCursor,
    clock,
    listeners,
  });
  const restartedHostPid = supervision.hostPids[1];
  assert(restartedHostPid);
  const probe: unknown = JSON.parse(readFileSync(probePath, "utf8"));
  assert(probe !== null && typeof probe === "object");
  assert("pid" in probe && probe.pid === supervision.hostPids.at(-1));
  assert("rowSurvived" in probe && probe.rowSurvived === true);
  assert("sqliteIsTransaction" in probe && probe.sqliteIsTransaction === true);
  assert("nodeVersion" in probe && typeof probe.nodeVersion === "string");
  const report: SmokeReport = {
    mainPid: process.pid,
    hostPid,
    restartedHostPid,
    rendererPids,
    mainNodeVersion: process.versions.node,
    hostNodeVersion: probe.nodeVersion,
    sqliteIsTransaction: probe.sqliteIsTransaction,
    tray: tray.present(),
    rendererRoundTrip: pong.type === "pong",
    reloadRoundTrip:
      reloadedHello.type === "host.hello" &&
      reloadedHello.payload.pid === hostPid &&
      reloadedPong.type === "pong",
    permissionDenied,
    permissionQueryDenied: permissionQuery === "denied",
    malformed:
      malformed.type === "error" && malformed.payload.code === "invalid_message"
        ? "rejected"
        : "accepted",
    rowSurvived: probe.rowSurvived,
    listeners,
    tools,
    deniedBuiltIn: { name: deniedBuiltIn.name, outcome: deniedBuiltIn.outcome },
    supervision,
    views,
  };
  assertSmokeReport(report);
  await stopHost();
  hostPorts.dispose();
  relay.dispose();
  tray.dispose();
  saveReport(report);
  console.log(JSON.stringify(report, null, 2));
  window.destroy();
  app.exit(0);
}

app.on("window-all-closed", () => {});
if (proof)
  setTimeout(
    () => fail(new Error("Proof exceeded its time limit")),
    smoke ? 240000 : 120000,
  ).unref();
void run().catch(fail);
