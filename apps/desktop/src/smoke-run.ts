// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@spi-code/contracts";
import { app } from "electron";
import { assertNoProcessListeners, listenerScanBudget } from "./smoke-listeners.js";
import type { smokeMessages } from "./smoke-messages.js";
import { assertSmokeReport, assertSmokeTools, type SmokeReport } from "./smoke-report.js";
import type { DesktopHandles } from "./start.js";

export async function runSmoke(
  {
    window,
    dataDir,
    storePath: hostStorePath,
    channels,
    tray,
    deniedPermissionRequests,
    currentHost,
    startHost,
    stopHost,
    dispose,
  }: DesktopHandles,
  reportPath: string,
  messages: ReturnType<typeof smokeMessages>,
  evidence: { toolEvents: Extract<Message, { type: "tool.call" }>["payload"][] },
  saveReport: (report: unknown) => void,
): Promise<void> {
  const wait = messages.wait;
  const [
    { initialSmoke, writeSmokeSnapshot },
    { exerciseSupervision, smokeClock },
    { scanAfterRuntimeReport },
    { captureSmokeViews },
    { MORNINGS, MORNING_FIXTURES },
  ] = await Promise.all([
    import("./smoke-snapshot.js"),
    import("./smoke-supervision.js"),
    import("./smoke-runtime-report.js"),
    import("./smoke-views.js"),
    import("./smoke-mornings.js"),
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
  const morningPaths = Object.fromEntries(
    MORNINGS.map((morning) => {
      const flag = process.argv.indexOf(`--smoke-views-${morning}-fixture`);
      const path =
        flag >= 0
          ? process.argv[flag + 1]
          : fileURLToPath(
              new URL(`../../../fixtures/watch/${MORNING_FIXTURES[morning]}`, import.meta.url),
            );
      assert(path && !path.startsWith("--"), `Smoke views require the ${morning} morning path`);
      return [morning, path];
    }),
  ) as Record<(typeof MORNINGS)[number], string>;
  const views = await captureSmokeViews(window, reportPath, fixturePath, designPath, morningPaths);
  const rowId = randomUUID();
  const probePath = join(dataDir, "probe.json");
  const firstCursor = writeSmokeSnapshot(hostStorePath, initialSmoke);
  const clock = smokeClock(process.argv);
  assert(clock);
  let launches = 0;
  startHost(() => [hostStorePath, launches++ === 0 ? "write" : "read", rowId, probePath], clock);
  const hello = await wait("hello");
  assert(hello.type === "host.hello");
  const hostPid = currentHost().pid;
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
  const permissionDenied = permission === "denied" && deniedPermissionRequests() > 0;
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
    listenerScanBudget() + 7000,
    () => assertNoProcessListeners(process.pid, hostPid),
  );
  const supervision = await exerciseSupervision({
    window,
    messages,
    currentHost,
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
  dispose();
  saveReport(report);
  console.log(JSON.stringify(report, null, 2));
  window.destroy();
  app.exit(0);
}
