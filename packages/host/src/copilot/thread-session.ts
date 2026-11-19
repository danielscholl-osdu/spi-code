// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CopilotClient,
  CopilotSession,
  MessageOptions,
  PermissionHandler,
  SessionConfig,
} from "@github/copilot-sdk";
import {
  buildSandboxConfig,
  type CopilotSandboxState,
  type PreflightInvocation,
  quoteShell,
  runSandboxPreflight,
  type SandboxRuntimePaths,
  type SandboxWorkspace,
  sandboxToolList,
  sandboxUnavailable,
} from "./sandbox.js";

export type ThreadSessionOptions = Pick<
  SessionConfig,
  "model" | "reasoningEffort" | "systemMessage" | "tools" | "onPermissionRequest"
> & { readonly resumeId?: string; readonly onPermissionRequest: PermissionHandler };

export interface ThreadCopilotSession {
  readonly sessionId: string;
  readonly sandbox: CopilotSandboxState;
  readonly on: CopilotSession["on"];
  readonly getEvents: CopilotSession["getEvents"];
  readonly abort: CopilotSession["abort"];
  send(message: MessageOptions): Promise<{ messageId: string; sandbox: CopilotSandboxState }>;
  release(): Promise<void>;
}

export async function openSandboxedThread(
  client: CopilotClient,
  token: string,
  workspace: SandboxWorkspace,
  runtimePaths: SandboxRuntimePaths,
  options: ThreadSessionOptions,
  isCurrent: () => boolean,
  withCurrentCredential: <T>(operation: () => Promise<T>) => Promise<T>,
  platform: NodeJS.Platform = process.platform,
): Promise<ThreadCopilotSession> {
  const sandboxConfig = buildSandboxConfig(workspace, runtimePaths.tempPath);
  const customTools = options.tools?.map(({ name }) => name) ?? [];
  let state = sandboxUnavailable(
    platform === "darwin" ? "preflight-not-run" : "unsupported-platform",
  );
  let released = false;
  let preflight: PreflightInvocation | undefined;

  const currentState = () =>
    released || !isCurrent() ? sandboxUnavailable("session-released") : state;
  const permission: PermissionHandler = (request, invocation) => {
    if ("requestSandboxBypass" in request && request.requestSandboxBypass)
      return { kind: "reject" };
    if (
      preflight &&
      request.kind === "shell" &&
      !request.managedApprovalRequired &&
      request.toolCallId === preflight.id &&
      request.fullCommandText === preflight.command
    ) {
      return { kind: "approve-once" };
    }
    if (released || !isCurrent()) return { kind: "reject" };
    if (
      (request.kind === "read" && (!workspace.clonePath || state.kind !== "confined")) ||
      ((request.kind === "shell" || request.kind === "write") &&
        (!workspace.worktreePath || state.kind !== "confined"))
    ) {
      return { kind: "reject" };
    }
    return options.onPermissionRequest(request, invocation);
  };

  const initialTools = sandboxToolList(customTools, state, workspace);
  if (platform === "darwin") initialTools.push("builtin:bash");
  const config: SessionConfig = {
    model: options.model ?? "auto",
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
    ...(options.systemMessage ? { systemMessage: options.systemMessage } : {}),
    ...(options.tools ? { tools: options.tools } : {}),
    availableTools: initialTools,
    gitHubToken: token,
    workingDirectory: workspace.worktreePath ?? workspace.clonePath ?? workspace.tempPath,
    enableConfigDiscovery: false,
    toolSearch: { enabled: false },
    streaming: true,
    sandboxConfig,
    onPermissionRequest: permission,
  };
  let setupDir: string | undefined;
  const cleanSetup = () =>
    setupDir ? rm(setupDir, { recursive: true, force: true }) : Promise.resolve();
  const session =
    options.resumeId === undefined
      ? await client.createSession(config)
      : await client.resumeSession(options.resumeId, { ...config, continuePendingWork: false });
  const unsubscribe = session.on("session.shutdown", () => {
    released = true;
    void cleanSetup().catch(() => {});
  });
  const updateTools = (availableTools: string[]) =>
    session.rpc.options.update({ availableTools, toolFilterPrecedence: "excluded" });
  try {
    if (platform === "darwin") {
      try {
        setupDir = await mkdtemp(join(runtimePaths.canaryRoot, "shell-"));
        const script = join(setupDir, "env.sh");
        const threadTemp = quoteShell(workspace.tempPath);
        await writeFile(
          script,
          `export TMPDIR=${threadTemp} TMP=${threadTemp} TEMP=${threadTemp}\n`,
          {
            flag: "wx",
            mode: 0o600,
          },
        );
        const filesystem = sandboxConfig.userPolicy?.filesystem;
        await session.rpc.options.update({
          availableTools: initialTools,
          toolFilterPrecedence: "excluded",
          sandboxConfig: {
            ...sandboxConfig,
            userPolicy: {
              ...sandboxConfig.userPolicy,
              filesystem: {
                ...filesystem,
                readonlyPaths: [...(filesystem?.readonlyPaths ?? []), script],
              },
            },
          },
          shell: { initScripts: [{ path: script, shell: "bash" }] },
        });
        await session.rpc.tools.initializeAndValidate();
        state = await runSandboxPreflight(
          session,
          runtimePaths.canaryRoot,
          sandboxConfig,
          (invocation) => {
            preflight = invocation;
          },
          platform,
        );
      } catch {
        state = sandboxUnavailable("preflight-failed");
      }
    }
    await updateTools(sandboxToolList(customTools, currentState(), workspace));
  } catch (error) {
    released = true;
    unsubscribe();
    await session.disconnect().catch(() => {});
    await cleanSetup().catch(() => {});
    throw error;
  }

  let release: Promise<void> | undefined;
  return {
    sessionId: session.sessionId,
    get sandbox() {
      return currentState();
    },
    on: session.on.bind(session),
    getEvents: session.getEvents.bind(session),
    abort: () => (released || !isCurrent() ? Promise.resolve() : session.abort()),
    async send(message) {
      if (released || !isCurrent()) throw new Error("Reopen the Copilot session before sending.");
      return withCurrentCredential(async () => {
        if (released || !isCurrent()) throw new Error("Reopen the Copilot session before sending.");
        if (state.kind === "confined") {
          const status = await Promise.resolve()
            .then(() => session.rpc.sandbox.getEnforcementStatus())
            .catch(() => undefined);
          if (status?.blocked !== false) {
            state = sandboxUnavailable("sandbox-not-attested");
            try {
              await updateTools(sandboxToolList(customTools, state, workspace));
            } catch (error) {
              released = true;
              unsubscribe();
              await session.disconnect().catch(() => {});
              await cleanSetup().catch(() => {});
              throw error;
            }
          }
        }
        if (released || !isCurrent()) throw new Error("Reopen the Copilot session before sending.");
        const messageId = await session.send(message);
        return { messageId, sandbox: currentState() };
      });
    },
    release() {
      if (!release) {
        released = true;
        unsubscribe();
        release = session.disconnect().finally(cleanSetup);
      }
      return release;
    },
  };
}
