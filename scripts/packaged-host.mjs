// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CopilotClient } from "@github/copilot-sdk";
import { buildClientOptions, resolveRuntimePath } from "../packages/host/dist/copilot/runtime.js";

if (process.argv.includes("--stub-model") && process.argv[3] === "write") {
  const reportPath = process.env.SPI_CODE_RUNTIME_REPORT;
  assert(reportPath, "Packaged smoke requires a runtime report path");
  const runtimePath = resolveRuntimePath();
  const storePath = process.argv[2];
  assert(storePath, "Packaged host requires a store path");
  assert(/[/\\]app\.asar\.unpacked[/\\]/.test(runtimePath), "Runtime must be outside app.asar");
  const client = new CopilotClient(
    buildClientOptions({
      appDataDir: dirname(storePath),
      capturedPath: "/usr/bin:/bin",
      cliPath: runtimePath,
    }),
  );
  const timeout = setTimeout(() => {
    console.error("Packaged runtime handshake timed out");
    process.exit(1);
  }, 15000);
  let evidence;
  let failure;
  try {
    await client.start();
    const ping = await client.ping("spi-code-packaged-smoke");
    const status = await client.getStatus();
    assert.equal(ping.message, "pong: spi-code-packaged-smoke");
    assert(Number.isSafeInteger(status.protocolVersion) && status.protocolVersion > 0);
    evidence = { hostPid: process.pid, runtimePath, transport: "stdio", ping, status };
  } catch (error) {
    failure = error;
  }
  const errors = await client.stop();
  clearTimeout(timeout);
  if (failure || errors.length)
    throw new AggregateError(
      failure ? [failure, ...errors] : errors,
      "Packaged runtime probe failed",
    );
  assert(evidence, "Packaged runtime produced no evidence");
  writeFileSync(reportPath, `${JSON.stringify(evidence, null, 2)}\n`);
}

await import("../packages/host/dist/main.js");
