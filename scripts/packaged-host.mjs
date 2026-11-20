// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CopilotClient } from "@github/copilot-sdk";
import { assertNoProcessListeners } from "../apps/desktop/dist/smoke-listeners.js";
import { publishRuntimeProbe } from "../apps/desktop/dist/smoke-runtime-report.js";
import { buildClientOptions, resolveRuntimePath } from "../packages/host/dist/copilot/runtime.js";
import { runConfined } from "../packages/host/dist/scopes/confined.js";

const mxcNativeDir = fileURLToPath(
  new URL(
    `../../app.asar.unpacked/node_modules/@microsoft/mxc-sdk/bin/${process.arch}`,
    import.meta.url,
  ),
);
process.env.MXC_FFI_DIR = mxcNativeDir;

/** @param {string} appDataDir */
async function probeConfinement(appDataDir) {
  const scratch = await mkdtemp(join(await realpath(appDataDir), "mxc-smoke-"));
  try {
    const clone = join(scratch, "clone");
    const worktree = join(scratch, "worktree");
    await Promise.all([mkdir(join(clone, ".git"), { recursive: true }), mkdir(worktree)]);
    return await runConfined({
      binary: "/bin/echo",
      args: ["spi-code-packaged-mxc"],
      env: { HOME: clone, PATH: "/usr/bin:/bin", LC_ALL: "C" },
      clone,
      worktree,
      scratch,
      readonlyPaths: [],
      timeoutMs: 4000,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

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
    handshake = {
      hostPid: process.pid,
      nodeVersion: process.versions.node,
      runtimePath,
      transport: "stdio",
      ping,
      status,
    };
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
    const confinement = await probeConfinement(dirname(storePath));
    if (process.platform !== "win32") return { listenerCheck, confinement };
    const { probeWindowsSandbox } = await import("./windows-sandbox-probe.mjs");
    return {
      listenerCheck,
      confinement,
      windowsSandboxObservation: await probeWindowsSandbox({
        mxcBin: dirname(mxcNativeDir),
        sdkPackage: dirname(mxcNativeDir),
      }),
    };
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

await import("../packages/host/dist/main.js");
