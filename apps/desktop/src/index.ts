// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Message, parseMessage } from "@spi-code/contracts";
import { app, ipcMain } from "electron";
import { createDesktop } from "./start.js";

const smoke = process.argv.includes("--smoke");
const liveFlag = process.argv.indexOf("--live-report");
const livePath = liveFlag >= 0 ? process.argv[liveFlag + 1] : undefined;
const proof = smoke || liveFlag >= 0;
const reportFlag = process.argv.indexOf("--smoke-report");
const reportPath =
  reportFlag >= 0
    ? process.argv[reportFlag + 1]
    : (process.env.SPI_CODE_SMOKE_REPORT ?? join(app.getPath("temp"), "spi-code-smoke.json"));
let failing = false;
const desktop = createDesktop({ smoke, proof, onError: fail });

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
    void desktop.stopHost().then(
      () => {
        desktop.disposeHostPorts();
        app.exit(1);
      },
      () => {
        console.error("Failed to stop the host after a proof failure");
        process.exit(1);
      },
    );
  }
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
  const messages = proof ? (await import("./smoke-messages.js")).smokeMessages() : undefined;
  if (proof) {
    const { SMOKE_TIMEOUT_MS } = await import("./smoke-report.js");
    setTimeout(
      () => fail(new Error("Proof exceeded its time limit")),
      smoke ? SMOKE_TIMEOUT_MS : 120000,
    ).unref();
  }
  const handles = await desktop.start();
  if (!handles) return;
  const { window, stopHost } = handles;
  if (!messages) {
    await handles.loadWindow();
    handles.startHost();
    return;
  }
  const evidence = {
    signedIn: false,
    modelCount: 0,
    streamedDeltaCount: 0,
    toolEvents: [] as Extract<Message, { type: "tool.call" }>["payload"][],
  };
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
  await handles.loadWindow();
  if (!smoke) {
    handles.startHost();
    return;
  }
  const { runSmoke } = await import("./smoke-run.js");
  await runSmoke(handles, reportPath, messages, evidence, saveReport);
}

app.on("window-all-closed", () => {});
void run().catch(fail);
