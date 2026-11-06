// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { CopilotClient } from "@github/copilot-sdk";
import { assertNoProcessListeners } from "../apps/desktop/dist/smoke-listeners.js";
import { publishRuntimeProbe } from "../apps/desktop/dist/smoke-runtime-report.js";
import { buildClientOptions, resolveRuntimePath } from "../packages/host/dist/copilot/runtime.js";

/**
 * @param {CopilotClient} client
 * @param {unknown} failure
 */
async function stopProbe(client, failure) {
  const errors = await client.stop();
  if (failure || errors.length)
    throw new AggregateError(
      failure ? [failure, ...errors] : errors,
      "Packaged runtime probe failed",
    );
}

if (process.argv.includes("--stub-model") && process.argv[3] === "write") {
  const storePath = process.argv[2];
  assert(storePath, "Packaged host requires a store path");
  const reportPath =
    process.env.SPI_CODE_RUNTIME_REPORT || join(dirname(storePath), "runtime-report.json");
  const runtimePath = resolveRuntimePath();
  assert(/[/\\]app\.asar\.unpacked[/\\]/.test(runtimePath), "Runtime must be outside app.asar");
  const client = new CopilotClient(
    buildClientOptions({
      appDataDir: dirname(storePath),
      capturedPath: process.env.PATH || (process.platform === "win32" ? "" : "/usr/bin:/bin"),
      cliPath: runtimePath,
    }),
  );
  // Stays under the desktop's 10s wait for host.hello so a slow start reports this error.
  const timeout = setTimeout(() => {
    console.error("Packaged runtime handshake timed out");
    process.exit(1);
  }, 8000);
  let handshake;
  try {
    await client.start();
    const ping = await client.ping("spi-code-packaged-smoke");
    const status = await client.getStatus();
    assert.equal(ping.message, "pong: spi-code-packaged-smoke");
    assert(Number.isSafeInteger(status.protocolVersion) && status.protocolVersion > 0);
    handshake = { hostPid: process.pid, runtimePath, transport: "stdio", ping, status };
  } catch (error) {
    await stopProbe(client, error);
  } finally {
    clearTimeout(timeout);
  }
  assert(handshake, "Packaged runtime produced no evidence");
  // Scanned after host.hello is sent; the desktop waits for this report, pass or fail, before
  // killing the host, and the replacement host never writes it.
  publishRuntimeProbe(reportPath, handshake, async () => {
    let listenerCheck;
    let failure;
    try {
      listenerCheck = await assertNoProcessListeners(process.ppid, process.pid, { runtimePath });
    } catch (error) {
      failure = error;
    }
    await stopProbe(client, failure);
    return listenerCheck;
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

await import("../packages/host/dist/main.js");
