// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient, type CopilotSession } from "@github/copilot-sdk";
import { captureLoginShellPath, ghAuthToken } from "../env/shell-environment.js";
import {
  buildAuthEnvironment,
  buildClientOptions,
  CopilotRuntime,
  type RuntimeOptions,
  streamTurn,
  stubToolSource,
} from "./runtime.js";

async function scan(directory: string, tokens: string[]): Promise<boolean> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (await scan(path, tokens)) return true;
    } else if (entry.isFile()) {
      const content = await readFile(path);
      if (tokens.some((token) => content.includes(Buffer.from(token)))) return true;
    }
  }
  return false;
}

async function mcpEvidence(session: CopilotSession) {
  const liveServerNames = (await session.rpc.mcp.list()).servers.map((server) => server.name);
  const configuredServerNames = (await session.rpc.mcp.listConfigured()).servers.map(
    (server) => server.name,
  );
  return {
    liveServerNames,
    configuredServerNames,
    sentinelAbsent:
      !liveServerNames.includes("spicode_sentinel") &&
      !configuredServerNames.includes("spicode_sentinel"),
  };
}

async function exercise(runtime: CopilotRuntime, isolationOnly = false) {
  const modelCount = (await runtime.listModels()).models.length;
  if (!modelCount) throw new Error("Model listing returned no models.");
  const session = await runtime.createSession();
  try {
    await session.rpc.tools.initializeAndValidate();
    const metadata = await session.rpc.tools.getCurrentMetadata();
    if (metadata.tools === null) throw new Error("Runtime tool list is uninitialized.");
    const toolNames = metadata.tools.map((tool) => tool.name);
    if (toolNames.length) throw new Error("Empty-mode session exposed unexpected tools.");
    const mcp = await mcpEvidence(session);
    if (!mcp.sentinelAbsent) throw new Error("Empty mode discovered the user MCP sentinel.");
    let streamedDeltaCount = 0;
    if (!isolationOnly) {
      await streamTurn(session, "Reply with just OK.", () => {
        streamedDeltaCount++;
      });
      if (!streamedDeltaCount) throw new Error("Turn produced no streamed deltas.");
    }
    return { modelCount, streamedDeltaCount, toolNames, ...mcp };
  } finally {
    await session.disconnect();
  }
}

async function sentinelControl(options: RuntimeOptions, home: string, token: string) {
  const client = new CopilotClient({
    ...buildClientOptions(options),
    mode: "copilot-cli",
    baseDirectory: join(home, ".copilot"),
    gitHubToken: token,
  });
  try {
    await client.start();
    const session = await client.createSession({
      model: "auto",
      availableTools: ["mcp:*"],
      onPermissionRequest: stubToolSource.onPermissionRequest,
      enableConfigDiscovery: true,
    });
    try {
      await session.rpc.tools.initializeAndValidate();
      const { tools } = await session.rpc.tools.getCurrentMetadata();
      const names = tools
        ?.filter((tool) => tool.mcpServerName === "spicode_sentinel")
        .map((tool) => tool.name);
      if (!names?.length)
        throw new Error("Positive control did not discover the configured sentinel.");
      const mcp = await mcpEvidence(session);
      if (!mcp.liveServerNames.includes("spicode_sentinel")) {
        throw new Error("Positive control MCP inventory did not discover the sentinel.");
      }
      return { toolNames: names, ...mcp };
    } finally {
      await session.disconnect();
    }
  } finally {
    await stopClient(client);
  }
}

async function stopClient(client: CopilotClient): Promise<void> {
  const errors = await client.stop();
  if (errors.length) throw new AggregateError(errors, "Sentinel control shutdown failed.");
}

async function probe() {
  const root = await mkdtemp(join(tmpdir(), "spicode-copilot-"));
  const appDataDir = join(root, "app-data");
  const home = join(root, "home");
  const report: Record<string, unknown> = { tokenSource: "gh", sdk: "1.0.26" };
  const secrets: string[] = [];
  let runtime: CopilotRuntime | undefined;
  try {
    await mkdir(appDataDir);
    await mkdir(join(home, ".copilot"), { recursive: true });
    const captured = await captureLoginShellPath();
    const authEnv = await buildAuthEnvironment({ appDataDir, capturedPath: captured.path });
    const realToken = await ghAuthToken(authEnv, { hostname: "github.com" });
    const invalidToken = "spicode-deliberately-invalid-token";
    secrets.push(realToken, invalidToken);
    let invalid = false;
    const readToken = () =>
      invalid ? Promise.resolve(invalidToken) : ghAuthToken(authEnv, { hostname: "github.com" });
    report.tokenLength = realToken.length;
    const env = authEnv;
    const options = { appDataDir, capturedPath: captured.path, env };
    runtime = new CopilotRuntime({ ...options, credentialMode: "session" }, readToken);
    await runtime.start();
    try {
      const trial = await runtime.createSession();
      await trial.disconnect();
      throw new Error("Short-lived provider unexpectedly succeeded; reassess CP-03 fallback.");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("more than 3600 seconds"))
        throw error;
      report.providerFinding = error.message;
    }
    await runtime.stop();
    report.credentialMode = "client-level-fallback";
    runtime = new CopilotRuntime(options, readToken);
    await runtime.start();
    report.baseline = await exercise(runtime);
    const baselineGeneration = runtime.clientGeneration;

    invalid = true;
    let modelRejected = false;
    try {
      await runtime.listModels();
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("401 Unauthorized") ||
        !error.message.includes("Bad credentials")
      )
        throw error;
      modelRejected = true;
      report.invalidModelError = error.message;
    }
    let sessionRejected = false;
    try {
      const session = await runtime.createSession();
      try {
        await streamTurn(session, "Reply with just OK.", () => {});
      } finally {
        await session.disconnect();
      }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes(
          "Session was not created with authentication info or custom provider",
        )
      )
        throw error;
      sessionRejected = true;
      report.invalidSessionError = error.message;
    }
    if (!modelRejected || !sessionRejected)
      throw new Error("Invalid credential did not fail authentication.");
    const invalidGeneration = runtime.clientGeneration;
    invalid = false;
    report.restored = await exercise(runtime);
    const restoredGeneration = runtime.clientGeneration;
    const clientRestartOnChange =
      baselineGeneration !== invalidGeneration && invalidGeneration !== restoredGeneration;
    if (!clientRestartOnChange) throw new Error("Client was not replaced on credential changes.");
    report.accountSwitch = {
      modelRejected,
      sessionRejected,
      clientRestartOnChange,
      clientGenerations: [baselineGeneration, invalidGeneration, restoredGeneration],
    };
    await runtime.stop();

    runtime = new CopilotRuntime(
      { ...options, env: { ...env, GH_TOKEN: invalidToken } },
      readToken,
    );
    await runtime.start();
    report.strayGhToken = await exercise(runtime);
    await runtime.stop();

    await writeFile(
      join(home, ".copilot", "mcp-config.json"),
      JSON.stringify({
        mcpServers: {
          spicode_sentinel: {
            command: process.execPath,
            args: [join(import.meta.dirname, "sentinel.js")],
            tools: ["*"],
          },
        },
      }),
    );
    report.sentinelControl = await sentinelControl(options, home, realToken);
    runtime = new CopilotRuntime(options, readToken);
    await runtime.start();
    report.userMcpConfigured = await exercise(runtime);
    await runtime.stop();
    runtime = new CopilotRuntime(options, readToken, {
      ...stubToolSource,
      availableTools: ["mcp:*"],
    });
    await runtime.start();
    report.mcpAllowedIsolation = { availableTools: ["mcp:*"], ...(await exercise(runtime, true)) };
  } catch (error) {
    report.error = error instanceof Error ? error.message : "UnknownError";
    process.exitCode = 1;
  } finally {
    try {
      await runtime?.stop();
      report.tokenFoundInAppData = await scan(appDataDir, secrets);
      if (report.tokenFoundInAppData) {
        report.cleanupError = "App data contains a credential.";
        process.exitCode = 1;
      }
    } catch (error) {
      report.cleanupError = error instanceof Error ? error.message : "UnknownError";
      process.exitCode = 1;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    // SDK errors can contain credential-bearing RPC parameters.
    const json = secrets.reduce(
      (text, secret) => text.replaceAll(secret, "[redacted]"),
      JSON.stringify(report),
    );
    console.log(json);
  }
}

await probe();
