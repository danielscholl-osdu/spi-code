// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient, type ToolResultObject } from "@github/copilot-sdk";
import { buildClientOptions } from "../packages/host/dist/copilot/runtime.js";
import { modelOutputRedactor } from "../packages/threads/dist/index.js";

const fixture = ["gh", "p_", "FAKE".repeat(9)].join("");
const fixtureLine = `probe-value=${fixture}`;
const redactedLine = "probe-value=[redacted]";

function commandOf(args: unknown): unknown {
  return args && typeof args === "object" && "command" in args ? args.command : undefined;
}

function redact(result: ToolResultObject): ToolResultObject {
  const { text } = modelOutputRedactor;
  return {
    resultType: result.resultType,
    textResultForLlm: text(result.textResultForLlm),
    ...(result.sessionLog === undefined ? {} : { sessionLog: text(result.sessionLog) }),
    ...(result.error === undefined ? {} : { error: text(result.error) }),
  };
}

function observation(text: string | undefined) {
  if (text === undefined) return { state: "unavailable" };
  if (text?.includes(fixtureLine)) return { state: "original", display: redactedLine };
  if (text?.includes(redactedLine)) return { state: "redacted", display: redactedLine };
  if (text?.includes(fixture)) return { state: "original", display: "[redacted]" };
  if (text?.includes("[redacted]")) return { state: "redacted", display: "[redacted]" };
  return { state: "absent" };
}

async function runShell(
  client: CopilotClient,
  cwd: string,
  command: string,
  token: string | undefined,
  injectInvalidMode = false,
) {
  let successHookSaw = observation(undefined);
  let failureHookSaw = observation(undefined);
  const session = await client.createSession({
    model: "auto",
    ...(token === undefined ? {} : { gitHubToken: token }),
    workingDirectory: cwd,
    streaming: true,
    availableTools: ["builtin:bash"],
    toolSearch: { enabled: false },
    enableConfigDiscovery: false,
    sandboxConfig: {
      enabled: true,
      allowBypass: false,
      allowDevToolAccess: false,
      addCurrentWorkingDirectory: false,
      auth: { gh: false, git: false },
      userPolicy: {
        filesystem: { readwritePaths: [cwd], deniedPaths: [homedir()] },
        network: { allowOutbound: false, allowLocalNetwork: false },
        seatbelt: { keychainAccess: false },
      },
    },
    onPermissionRequest: (request) => {
      if (
        request.kind !== "shell" ||
        request.fullCommandText !== command ||
        request.requestSandboxBypass ||
        request.managedApprovalRequired
      ) {
        return { kind: "reject" };
      }
      return { kind: "approve-once" };
    },
    hooks: {
      onPreToolUse: ({ toolName, toolArgs }) => {
        if (
          (toolName === "bash" || toolName === "builtin:bash") &&
          commandOf(toolArgs) === command
        ) {
          if (injectInvalidMode) {
            return {
              permissionDecision: "allow",
              modifiedArgs: { command, description: "Read the probe fixture", mode: fixture },
            };
          }
          return { permissionDecision: "allow" };
        }
        return { permissionDecision: "deny" };
      },
      onPostToolUse: ({ toolResult }) => {
        successHookSaw = observation(toolResult.textResultForLlm);
        return { modifiedResult: redact(toolResult) };
      },
      onPostToolUseFailure: ({ error }) => {
        failureHookSaw = observation(error);
        return {
          additionalContext: "",
          modifiedResult: {
            resultType: "failure",
            textResultForLlm: modelOutputRedactor.text(error),
          },
        };
      },
    },
  });
  try {
    const calls = new Set<string>();
    const completions: {
      success: boolean;
      sandboxed: boolean;
      exitCode: number | undefined;
      modelContent: ReturnType<typeof observation>;
      error: ReturnType<typeof observation>;
    }[] = [];
    session.on("tool.execution_start", ({ data }) => {
      if (commandOf(data.arguments) === command) calls.add(data.toolCallId);
    });
    session.on("tool.execution_complete", ({ data }) => {
      if (!calls.has(data.toolCallId)) return;
      completions.push({
        success: data.success,
        sandboxed: data.sandboxed === true,
        exitCode: data.shellExecution?.exitCode,
        modelContent: observation(data.result?.content),
        error: observation(data.error?.message),
      });
    });
    const reply = await session.sendAndWait(
      `Use the bash tool once with exactly this command, even though it may fail: ${command}\n` +
        "Then reply with MARKER if the tool result contains [redacted], ORIGINAL if it contains a " +
        "test value starting with gh, then p and an underscore, or ABSENT if neither is present. " +
        "Never quote the test value.",
      60_000,
    );
    const answer = reply?.data.content.trim();
    const modelReply =
      answer === "MARKER" || answer === "ORIGINAL" || answer === "ABSENT" ? answer : "unexpected";
    return {
      command,
      successHookSaw,
      failureHookSaw,
      completions,
      modelReply,
    };
  } finally {
    await session.disconnect();
    await client.deleteSession(session.sessionId);
  }
}

async function probe() {
  const existingLogin = process.argv.includes("--use-existing-login");
  const token = existingLogin ? undefined : process.env.SPICODE_COPILOT_PROBE_TOKEN;
  if (!existingLogin && !token) throw new Error("missing probe credential");
  const root = await mkdtemp(join(await realpath(tmpdir()), "spicode-redaction-"));
  try {
    const cwd = join(root, "workspace");
    const appDataDir = join(root, "app-data");
    await mkdir(cwd);
    await mkdir(appDataDir);
    await writeFile(join(cwd, "probe-fixture.txt"), `${fixtureLine}\n`);
    const options = buildClientOptions({
      appDataDir,
      capturedPath: "/usr/bin:/bin",
      env: {},
    });
    const client = new CopilotClient({
      ...options,
      ...(existingLogin
        ? {
            mode: "copilot-cli",
            useLoggedInUser: true,
            baseDirectory: join(homedir(), ".copilot"),
            env: { ...options.env, HOME: homedir(), USERPROFILE: homedir() },
          }
        : {}),
    });
    try {
      const success = await runShell(client, cwd, "cat probe-fixture.txt", token);
      const nonzero = await runShell(client, cwd, "cat probe-fixture.txt >&2; exit 7", token);
      const failure = await runShell(client, cwd, "cat probe-fixture.txt", token, true);
      console.log(
        JSON.stringify({ success, nonzeroExit: nonzero, validationFailure: failure }, null, 2),
      );
      const [ok] = success.completions;
      const [exited] = nonzero.completions;
      const [failed] = failure.completions;
      if (
        success.completions.length !== 1 ||
        !ok?.success ||
        !ok.sandboxed ||
        ok.exitCode !== 0 ||
        ok.modelContent.state !== "redacted" ||
        success.successHookSaw.state !== "original" ||
        success.modelReply !== "MARKER" ||
        nonzero.completions.length !== 1 ||
        !exited?.success ||
        !exited.sandboxed ||
        exited.exitCode !== 7 ||
        exited.modelContent.state !== "redacted" ||
        nonzero.modelReply !== "MARKER" ||
        !failed?.sandboxed ||
        failed.success ||
        failed.modelContent.state === "redacted" ||
        failed.error.state === "redacted" ||
        failure.failureHookSaw.state !== "original"
      ) {
        process.exitCode = 1;
      }
    } finally {
      if ((await client.stop()).length) {
        console.error("Copilot probe runtime did not shut down cleanly.");
        process.exitCode = 1;
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

try {
  await probe();
} catch (error) {
  // The SDK may put request parameters in thrown errors.
  const message = error instanceof Error ? error.message : "";
  const reason = /401|403|authenticat|credential|sign.in or log.in/i.test(message)
    ? "authentication"
    : /sandbox/i.test(message)
      ? "sandbox"
      : /timed? ?out/i.test(message)
        ? "timeout"
        : "runtime error";
  console.error(`Copilot redaction probe did not complete (${reason}).`);
  process.exitCode = 1;
}
