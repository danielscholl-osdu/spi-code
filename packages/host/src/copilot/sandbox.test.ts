// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CopilotClient, SessionConfig } from "@github/copilot-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSandboxConfig, type SandboxWorkspace } from "./sandbox.js";
import { openSandboxedThread } from "./thread-session.js";

const roots = {
  clone: resolve("managed", "clone"),
  worktree: resolve("managed", "worktree"),
  temp: resolve("managed", "thread-temp"),
  tools: resolve("managed", "tools"),
};
const workspace: SandboxWorkspace = {
  clonePath: roots.clone,
  worktreePath: roots.worktree,
  tempPath: roots.temp,
  toolchainPaths: [roots.tools],
};
const git = join(roots.clone, ".git");
const protectedPaths = [roots.tools, roots.clone, join(git, "hooks"), join(git, "config")];

describe("Copilot sandbox policy", () => {
  it("does not make the Asking clone or its Git directory writable", () => {
    const { worktreePath: _, ...asking } = workspace;
    expect(buildSandboxConfig(asking).userPolicy?.filesystem).toEqual({
      readwritePaths: [roots.temp],
      readonlyPaths: [...protectedPaths, git],
    });
  });

  it("allows a linked worktree and Git metadata while protecting hooks and config", () => {
    const runtimeTemp = resolve("app", "copilot", "runtime-temp");
    expect(buildSandboxConfig(workspace, runtimeTemp)).toEqual({
      enabled: true,
      allowBypass: false,
      addCurrentWorkingDirectory: false,
      allowDevToolAccess: false,
      auth: { git: false, gh: false },
      userPolicy: {
        filesystem: {
          readwritePaths: [roots.temp, roots.worktree, git],
          readonlyPaths: protectedPaths,
          deniedPaths: [runtimeTemp],
        },
        network: {
          allowOutbound: true,
          allowLocalNetwork: false,
          allowedHosts: [
            "github.com",
            "api.github.com",
            "community.opengroup.org",
            "repo.maven.apache.org",
            "repo1.maven.org",
          ],
        },
        seatbelt: { keychainAccess: false },
      },
    });
  });

  it.each([
    { ...workspace, worktreePath: join(roots.clone, "nested") },
    { ...workspace, tempPath: join(roots.worktree, "temp") },
    { ...workspace, clonePath: "relative" },
    { worktreePath: roots.worktree, tempPath: roots.temp },
  ])("rejects conflicting or unanchored workspace paths (%j)", (paths) => {
    expect(() => buildSandboxConfig(paths)).toThrow();
  });
});

type Sample =
  | "blocked"
  | "write"
  | "unsupported"
  | "missing-event"
  | "wrong-call"
  | "credential"
  | "unknown-name"
  | "missing-output"
  | "no-preflight";

function recordedRuntime(sample: Sample, canaryRoot: string) {
  const listeners = new Set<(event: unknown) => void>();
  let config: SessionConfig;
  const session = {
    sessionId: "thread-session",
    on: vi.fn((eventOrListener: string | ((event: unknown) => void)) => {
      if (typeof eventOrListener === "string") return () => {};
      listeners.add(eventOrListener);
      return () => listeners.delete(eventOrListener);
    }),
    getEvents: vi.fn(async () => []),
    abort: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    send: vi.fn(async () => "message"),
    rpc: {
      options: { update: vi.fn(async (_options: { availableTools: string[] }) => {}) },
      sandbox: {
        getEnforcementStatus: vi.fn().mockResolvedValue({ required: false, blocked: false }),
      },
      tools: {
        initializeAndValidate: vi.fn(async () => {
          if (sample === "no-preflight") throw new Error("RPC unavailable");
        }),
        execute: vi.fn(async (call: { toolCallId: string; arguments: { command: string } }) => {
          const { toolCallId } = call;
          const { command } = call.arguments;
          if (sample === "write") {
            const canary = command.match(/printf x > '([^']+)'/)?.[1];
            if (!canary?.startsWith(canaryRoot)) throw new Error("Expected a scratch canary.");
            await writeFile(canary, "x");
          }
          const backend = sample === "unsupported" ? "unsupported" : "seatbelt";
          const id = sample === "wrong-call" ? "different-tool-call" : toolCallId;
          const observed = {
            control: "process",
            enforcementPoint: "shell",
            platform: "macos",
            backend,
            toolCallId: id,
          };
          if (sample !== "missing-event") {
            for (const data of [
              {
                ...observed,
                kind: "policy_resolved",
                outcome: "resolved",
                policySource: "user_policy",
                allowBypass: false,
                gitAuth: false,
                ghAuth: false,
                keychainAccess: false,
              },
              { ...observed, kind: "spawn_completed", outcome: "succeeded", durationMs: 10 },
              {
                ...observed,
                kind: "enforcement_state",
                outcome: "engaged",
                attestation: "spawn_succeeded",
              },
            ]) {
              for (const listener of listeners) listener({ type: "sandbox.decision", data });
            }
          }
          const names = ["HOME", "PATH"];
          if (sample === "credential") names.push("COPILOT_SDK_AUTH_TOKEN");
          if (sample === "unknown-name") names.push("NEW_SDK_BRIDGE");
          const text = [`${toolCallId}:begin`, "blocked", ...names, `${toolCallId}:end`].join("\n");
          return {
            resultType: "success",
            textResultForLlm: sample === "missing-output" ? "" : text,
          };
        }),
      },
    },
  };
  const open = async (options: SessionConfig) => {
    config = options;
    return session;
  };
  const client = {
    createSession: vi.fn(open),
    resumeSession: vi.fn(async (_id: string, options: SessionConfig) => open(options)),
  };
  return {
    client,
    session,
    open: (resumeId?: string, platform: NodeJS.Platform = "darwin", paths = workspace) =>
      openSandboxedThread(
        client as unknown as CopilotClient,
        "fixture-token",
        paths,
        { canaryRoot, tempPath: resolve("app", "runtime-temp") },
        {
          ...(resumeId === undefined ? {} : { resumeId }),
          tools: [{ name: "spi_read", handler: async () => "fixture" }],
          onPermissionRequest: () => ({ kind: "approve-once" }),
        },
        () => true,
        (operation) => operation(),
        platform,
      ),
    permission: (request: Parameters<NonNullable<SessionConfig["onPermissionRequest"]>>[0]) =>
      config.onPermissionRequest?.(request, { sessionId: session.sessionId }),
  };
}

const customOnly = ["custom:spi_read"];
describe("Copilot sandbox preflight", () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "spicode-xia4-test-")));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    ["write", "write-not-blocked"],
    ["unsupported", "sandbox-not-attested"],
    ["missing-event", "sandbox-not-attested"],
    ["wrong-call", "sandbox-not-attested"],
    ["credential", "credential-environment"],
    ["unknown-name", "credential-environment"],
    ["missing-output", "preflight-failed"],
  ] as const)("keeps only custom tools when the preflight records %s", async (sample, reason) => {
    const runtime = recordedRuntime(sample, root);
    const thread = await runtime.open();
    expect(thread.sandbox).toEqual({ kind: "not-confined", reason });
    expect(runtime.session.rpc.options.update).toHaveBeenLastCalledWith({
      availableTools: customOnly,
      toolFilterPrecedence: "excluded",
    });
    await thread.send({ prompt: "Ask" });
    expect(runtime.session.send).toHaveBeenCalledOnce();
  });

  it("attests the recorded shell spawn and withdraws tools if the next turn is blocked", async () => {
    const runtime = recordedRuntime("blocked", root);
    const thread = await runtime.open();
    expect(thread.sandbox).toEqual({ kind: "confined", backend: "seatbelt" });
    expect(runtime.session.rpc.options.update).toHaveBeenLastCalledWith({
      availableTools: [
        ...customOnly,
        "builtin:view",
        "builtin:glob",
        "builtin:grep",
        "builtin:create",
        "builtin:edit",
        "builtin:apply_patch",
        "builtin:bash",
      ],
      toolFilterPrecedence: "excluded",
    });
    runtime.session.rpc.sandbox.getEnforcementStatus.mockResolvedValueOnce({ blocked: true });
    await expect(thread.send({ prompt: "Ask" })).resolves.toMatchObject({
      sandbox: { kind: "not-confined", reason: "sandbox-not-attested" },
    });
    expect(runtime.session.rpc.options.update).toHaveBeenLastCalledWith({
      availableTools: customOnly,
      toolFilterPrecedence: "excluded",
    });
  });

  it("offers only file reads alongside custom tools in a confined Asking session", async () => {
    const { worktreePath: _, ...asking } = workspace;
    const runtime = recordedRuntime("blocked", root);
    const thread = await runtime.open(undefined, "darwin", asking);
    expect(thread.sandbox).toEqual({ kind: "confined", backend: "seatbelt" });
    expect(runtime.session.rpc.options.update).toHaveBeenLastCalledWith({
      availableTools: [...customOnly, "builtin:view", "builtin:glob", "builtin:grep"],
      toolFilterPrecedence: "excluded",
    });
  });

  it("releases the attestation and requires a fresh preflight on resume", async () => {
    const original = recordedRuntime("blocked", root);
    const thread = await original.open();
    await thread.release();
    expect(thread.sandbox).toEqual({ kind: "not-confined", reason: "session-released" });
    await expect(thread.send({ prompt: "Ask" })).rejects.toThrow("Reopen");
    expect(original.session.send).not.toHaveBeenCalled();

    const resumedRuntime = recordedRuntime("no-preflight", root);
    const resumed = await resumedRuntime.open(thread.sessionId);
    expect(resumedRuntime.client.resumeSession).toHaveBeenCalledWith(
      thread.sessionId,
      expect.objectContaining({
        continuePendingWork: false,
        sandboxConfig: buildSandboxConfig(workspace, resolve("app", "runtime-temp")),
      }),
    );
    expect(resumedRuntime.session.rpc.tools.execute).not.toHaveBeenCalled();
    expect(resumed.sandbox).toEqual({ kind: "not-confined", reason: "preflight-failed" });
    expect(resumedRuntime.session.rpc.options.update).toHaveBeenLastCalledWith({
      availableTools: customOnly,
      toolFilterPrecedence: "excluded",
    });
  });

  it("keeps Windows unsupported even if the runtime could return Seatbelt evidence", async () => {
    const runtime = recordedRuntime("blocked", root);
    const thread = await runtime.open(undefined, "win32");
    expect(runtime.session.rpc.tools.execute).not.toHaveBeenCalled();
    expect(thread.sandbox).toEqual({ kind: "not-confined", reason: "unsupported-platform" });
    expect(runtime.client.createSession.mock.calls[0]?.[0].availableTools).toEqual(customOnly);
  });

  it("rejects bypass requests even when the caller would approve them", async () => {
    const runtime = recordedRuntime("blocked", root);
    await runtime.open();
    const writeRequest = {
      kind: "write" as const,
      requestSandboxBypass: true,
      fileName: "canary",
    } as Parameters<NonNullable<SessionConfig["onPermissionRequest"]>>[0];
    await expect(Promise.resolve(runtime.permission(writeRequest))).resolves.toEqual({
      kind: "reject",
    });
  });
});
