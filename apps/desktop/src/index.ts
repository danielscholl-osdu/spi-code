// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Message, parseMessage } from "@spi-code/contracts";
import {
  app,
  BrowserWindow,
  ipcMain,
  MessageChannelMain,
  type UtilityProcess,
  utilityProcess,
} from "electron";
import { hostLaunch } from "./host-launch.js";
import { assertSmokeReport, assertSmokeTools, type SmokeReport } from "./smoke-report.js";

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
let stopping = false;
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
  stopping = true;
  try {
    if (smoke) saveReport({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    void stopHost().then(
      () => app.exit(1),
      () => {
        console.error("Failed to stop the host after a proof failure");
        process.exit(1);
      },
    );
  }
}

function assertNoListeners(pid: number): void {
  process.kill(pid, 0);
  try {
    const output = execFileSync("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(output.trim(), "", `TCP listener owned by ${pid}: ${output}`);
  } catch (error) {
    const noMatches =
      error !== null &&
      typeof error === "object" &&
      "status" in error &&
      error.status === 1 &&
      "stdout" in error &&
      error.stdout === "" &&
      "stderr" in error &&
      error.stderr === "";
    if (!noMatches) throw error;
  }
  process.kill(pid, 0);
}

async function stopHost(): Promise<void> {
  if (!child) return;
  stopping = true;
  const exited = once(child, "exit");
  if (!child.kill()) throw new Error("Could not kill host");
  await exited;
  child = undefined;
  stopping = false;
}

async function startHost(window: BrowserWindow, args: string[]): Promise<number> {
  const launch = hostLaunch(app.isPackaged, smoke, liveFlag >= 0, process.env);
  child = utilityProcess.fork(hostEntry, [...args, ...launch.args], {
    env: launch.env,
    serviceName: "SPI Code host",
    stdio: "pipe",
  });
  child.stderr?.on("data", (data: Buffer) => process.stderr.write(data));
  child.stdout?.on("data", (data: Buffer) => process.stdout.write(data));
  child.on("exit", (code) => {
    if (!stopping) fail(new Error(`Host exited unexpectedly (${code})`));
  });
  await once(child, "spawn");
  const pid = child.pid;
  assert(pid, "Host has no pid");
  const { port1, port2 } = new MessageChannelMain();
  child.postMessage({ version: 1, id: "connect", kind: "request", type: "ping", payload: {} }, [
    port2,
  ]);
  window.webContents.postMessage("host:port", null, [port1]);
  return pid;
}

async function run(): Promise<void> {
  if (!reportPath) throw new Error("--smoke-report requires a path");
  if (liveFlag >= 0 && (!livePath || livePath.startsWith("--")))
    throw new Error("--live-report requires a path");
  await app.whenReady();
  const dataDir = smoke
    ? join(app.getPath("userData"), "smoke", randomUUID())
    : app.getPath("userData");
  mkdirSync(dataDir, { recursive: true });
  const window = new BrowserWindow({
    width: 900,
    height: 650,
    show: !smoke,
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
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  const messages: Message[] = [];
  const received = new EventEmitter();
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
      received.emit("message");
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
  const wait = (predicate: (message: Message) => boolean): Promise<Message> =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        received.off("message", check);
        reject(new Error("Timed out waiting for a host message"));
      }, 10000);
      function check() {
        const index = messages.findIndex(predicate);
        const message = messages[index];
        if (message) {
          messages.splice(index, 1);
          clearTimeout(timeout);
          received.off("message", check);
          resolve(message);
        }
      }
      received.on("message", check);
      check();
    });
  await window.loadFile(windowEntry);
  const storePath = join(dataDir, "runs.sqlite");
  if (!smoke) {
    await startHost(window, [storePath]);
    return;
  }
  const rowId = randomUUID();
  const probePath = join(dataDir, "probe.json");
  const hostPid = await startHost(window, [storePath, "write", rowId, probePath]);
  const hello = await wait((message) => message.type === "host.hello");
  assert(hello.type === "host.hello");
  assert.equal(hello.payload.pid, hostPid);
  await wait((message) => message.type === "pong" && message.id === "window-ping");
  const turn = await wait((message) => message.type === "turn.end");
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
  await wait((message) => message.type === "error" && message.payload.code === "invalid_message");
  assertNoListeners(process.pid);
  assertNoListeners(hostPid);
  await stopHost();
  const restartedHostPid = await startHost(window, [storePath, "read", rowId, probePath]);
  const restartedHello = await wait((message) => message.type === "host.hello");
  assert(restartedHello.type === "host.hello");
  assert.equal(restartedHello.payload.pid, restartedHostPid);
  await wait((message) => message.type === "pong" && message.id === "window-ping");
  assertNoListeners(process.pid);
  assertNoListeners(restartedHostPid);
  const probe: unknown = JSON.parse(readFileSync(probePath, "utf8"));
  assert(probe !== null && typeof probe === "object");
  assert("pid" in probe && probe.pid === restartedHostPid);
  assert("rowSurvived" in probe && probe.rowSurvived === true);
  assert("sqliteIsTransaction" in probe && probe.sqliteIsTransaction === true);
  assert("nodeVersion" in probe && typeof probe.nodeVersion === "string");
  const report: SmokeReport = {
    mainPid: process.pid,
    hostPid,
    restartedHostPid,
    mainNodeVersion: process.versions.node,
    hostNodeVersion: probe.nodeVersion,
    sqliteIsTransaction: probe.sqliteIsTransaction,
    rendererRoundTrip: true,
    malformed: "rejected",
    rowSurvived: probe.rowSurvived,
    listeners: "none",
    tools,
    deniedBuiltIn: { name: deniedBuiltIn.name, outcome: deniedBuiltIn.outcome },
  };
  assertSmokeReport(report);
  await stopHost();
  saveReport(report);
  console.log(JSON.stringify(report, null, 2));
  app.exit(0);
}

app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => {
  stopping = true;
  child?.kill();
});
if (proof)
  setTimeout(
    () => fail(new Error("Proof exceeded its time limit")),
    smoke ? 30000 : 120000,
  ).unref();
void run().catch(fail);
