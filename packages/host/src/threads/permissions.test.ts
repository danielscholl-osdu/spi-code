// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PermissionRequest } from "@github/copilot-sdk";
import { ThreadEngine } from "@spi-code/threads";
import { afterEach, expect, it, vi } from "vitest";
import {
  type AccessMode,
  askingPermission,
  PERMISSION_POLICY,
  permissionDecision,
} from "./permissions.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "spi-permission-")));
  roots.push(root);
  const clonePath = join(root, "clone");
  const worktreePath = join(root, "worktree");
  const tempPath = join(root, "temp");
  const outsidePath = join(root, "outside");
  const cloneGitPath = join(clonePath, ".git");
  for (const path of [clonePath, worktreePath, tempPath]) mkdirSync(path);
  mkdirSync(cloneGitPath);
  mkdirSync(outsidePath);
  writeFileSync(join(cloneGitPath, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(worktreePath, ".git"), "gitdir: ../clone/.git/worktrees/thread\n");
  writeFileSync(join(worktreePath, "src.ts"), "before");
  writeFileSync(join(worktreePath, "other.ts"), "other");
  writeFileSync(join(outsidePath, "secret.txt"), "outside");
  linkSync(join(outsidePath, "secret.txt"), join(worktreePath, "hard.txt"));
  symlinkSync(outsidePath, join(worktreePath, "outside-link"), "dir");
  return { root, clonePath, worktreePath, tempPath, outsidePath, cloneGitPath };
}

function request(kind: string): PermissionRequest {
  const common = { kind } as { kind: string };
  switch (kind) {
    case "read":
      return { ...common, intention: "Read", path: "src.ts" } as PermissionRequest;
    case "write":
      return {
        ...common,
        canOfferSessionApproval: false,
        diff: "--- a/src.ts\n+++ b/src.ts\n@@\n-old\n+new",
        fileName: "/repo/src.ts",
        intention: "Edit",
      } as PermissionRequest;
    case "shell":
      return {
        ...common,
        canOfferSessionApproval: false,
        commands: [],
        fullCommandText: "pnpm test",
        hasWriteFileRedirection: false,
        intention: "Test",
        possiblePaths: [],
        possibleUrls: [],
      } as PermissionRequest;
    case "custom-tool":
      return {
        ...common,
        toolDescription: "Read evidence",
        toolName: "spi_evidence",
      } as PermissionRequest;
    case "hook":
      return { ...common, toolName: "hook" } as PermissionRequest;
    case "extension-management":
      return { ...common, operation: "reload" } as PermissionRequest;
    case "workflow":
      return {
        ...common,
        approvalKey: "workflow",
        canPersistApproval: false,
        description: "Run",
        name: "run",
        operation: "run",
        phases: [],
      } as PermissionRequest;
    case "extension-permission-access":
      return {
        ...common,
        capabilities: [],
        extensionName: "fixture",
      } as PermissionRequest;
    case "extension-env-access":
      return {
        ...common,
        environmentVariables: ["TOKEN"],
        extensionName: "fixture",
      } as PermissionRequest;
    default:
      return {
        ...common,
        ...(kind === "mcp"
          ? { readOnly: true, serverName: "server", toolName: "tool", toolTitle: "Tool" }
          : kind === "url"
            ? { intention: "Fetch", url: "https://example.test" }
            : kind === "memory"
              ? { fact: "fact" }
              : {}),
      } as PermissionRequest;
  }
}

it.each(Object.entries(PERMISSION_POLICY))(
  "defines the closed table row for %s",
  (kind, expected) => {
    const probe = {
      read: ["pass", "pass"],
      write: ["ask", "pass"],
      shell: ["deny", "deny"],
      mcp: ["deny", "deny"],
      url: ["deny", "deny"],
      memory: ["deny", "deny"],
      "custom-tool": ["deny", "deny"],
      hook: ["deny", "deny"],
      "extension-management": ["deny", "deny"],
      workflow: ["deny", "deny"],
      "extension-permission-access": ["deny", "deny"],
      "extension-env-access": ["deny", "deny"],
    } as const;
    const row = probe[kind as keyof typeof probe];
    expect([expected.supervised, expected["auto-accept-edits"]]).toEqual(row);
    for (const mode of ["supervised", "auto-accept-edits"] as const)
      expect(permissionDecision(kind, mode)).toBe(row[mode === "supervised" ? 0 : 1]);
  },
);

it("denies a kind the current SDK does not define", () => {
  expect(permissionDecision("sdk-added-later", "supervised")).toBe("deny");
  expect(permissionDecision("sdk-added-later", "auto-accept-edits")).toBe("deny");
});

it.each(["supervised", "auto-accept-edits"] as const)(
  "applies every SDK kind in %s mode",
  async (mode) => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "spi-permission-")));
    roots.push(root);
    writeFileSync(join(root, "src.ts"), "before");
    const requestApproval = vi.fn(async (_request, decision?: boolean) => decision !== false);
    const events = {
      requestApproval,
      thinking() {},
      delta() {},
      toolStarted() {},
      toolFinished() {},
    };
    const handler = askingPermission({ tempPath: root, worktreePath: root }, () => events, {
      mode,
    });
    for (const kind of Object.keys(PERMISSION_POLICY)) {
      const probe = request(kind);
      await handler(probe.kind === "write" ? { ...probe, fileName: join(root, "src.ts") } : probe, {
        sessionId: "fixture",
      });
      const expected = permissionDecision(kind, mode);
      const recorded = requestApproval.mock.calls.at(-1)?.[1];
      expect(recorded, kind).toBe(
        kind === "read" || expected === "pass" ? true : expected === "ask" ? undefined : false,
      );
    }
  },
);

it.each(["supervised", "auto-accept-edits"] as const)(
  "denies bypasses and path grants in %s mode",
  async (mode) => {
    const paths = workspace();
    const requestApproval = vi.fn(async (_request: object, _decision?: boolean) => false);
    const events = {
      requestApproval,
      thinking() {},
      delta() {},
      toolStarted() {},
      toolFinished() {},
    };
    const handler = askingPermission(paths, () => events, { mode });
    const write = request("write") as Extract<PermissionRequest, { kind: "write" }>;
    await expect(
      handler({ ...write, requestSandboxBypass: true }, { sessionId: "fixture" }),
    ).resolves.toEqual({ kind: "reject" });
    await expect(
      handler(
        { ...write, sandboxPathGrant: { access: "readWrite", path: "/outside" } },
        { sessionId: "fixture" },
      ),
    ).resolves.toEqual({ kind: "reject" });
    expect(requestApproval.mock.calls.map((call) => call[1])).toEqual([false, false]);
    expect(
      requestApproval.mock.calls.map((call) => (call[0] as { reason?: string }).reason),
    ).toEqual([
      "Sandbox bypasses and path grants are not allowed.",
      "Sandbox bypasses and path grants are not allowed.",
    ]);
  },
);

it("shows and journals the exact edit path and diff before a supervised approval", async () => {
  const paths = workspace();
  const requestApproval = vi.fn(async () => true);
  const events = {
    requestApproval,
    thinking() {},
    delta() {},
    toolStarted() {},
    toolFinished() {},
  };
  const edit = {
    ...(request("write") as Extract<PermissionRequest, { kind: "write" }>),
    fileName: join(paths.worktreePath, "src.ts"),
  };
  await askingPermission(paths, () => events)(edit, { sessionId: "fixture" });
  expect(requestApproval).toHaveBeenCalledWith(
    expect.objectContaining({
      path: edit.fileName,
      diff: edit.diff,
    }),
    undefined,
  );
});

it("refuses a redacted write without applying it", async () => {
  const paths = workspace();
  let applied = false;
  const requestApproval = vi.fn(async (_request: object, _decision?: boolean) => false);
  const events = {
    requestApproval,
    thinking() {},
    delta() {},
    toolStarted() {},
    toolFinished() {},
  };
  const edit = request("write") as Extract<PermissionRequest, { kind: "write" }>;
  const result = await askingPermission(paths, () => events, { mode: "auto-accept-edits" })(
    {
      ...edit,
      fileName: join(paths.worktreePath, "src.ts"),
      diff: `${edit.diff}\n+[redacted]`,
    },
    { sessionId: "fixture" },
  );
  if (result.kind === "approve-once") applied = true;
  expect(result).toEqual({ kind: "reject" });
  expect(applied).toBe(false);
  expect(requestApproval.mock.calls[0]?.[0]).toMatchObject({
    reason: "This edit contains redacted text and cannot be written back.",
  });
});

const modes = ["supervised", "auto-accept-edits"] as const;
const boundaryRows = [
  {
    name: "the clone's .git",
    request: (paths: ReturnType<typeof workspace>) =>
      ({
        ...(request("write") as Extract<PermissionRequest, { kind: "write" }>),
        fileName: join(paths.cloneGitPath, "HEAD"),
      }) as PermissionRequest,
    gateDenied: false,
    reason: "This thread is not allowed to edit this path.",
  },
  {
    name: "a relative path through dot-dot to the clone's .git",
    request: (paths: ReturnType<typeof workspace>) =>
      ({
        ...(request("write") as Extract<PermissionRequest, { kind: "write" }>),
        fileName: join(paths.worktreePath, "..", "clone", ".git", "HEAD"),
      }) as PermissionRequest,
    gateDenied: false,
    reason: "This thread is not allowed to edit this path.",
  },
  {
    name: "a clone file",
    request: (paths: ReturnType<typeof workspace>) =>
      ({
        ...(request("write") as Extract<PermissionRequest, { kind: "write" }>),
        fileName: join(paths.clonePath, "README.md"),
      }) as PermissionRequest,
    gateDenied: false,
    reason: "This thread is not allowed to edit this path.",
  },
  {
    name: "the worktree .git pointer",
    request: (paths: ReturnType<typeof workspace>) =>
      ({
        ...(request("write") as Extract<PermissionRequest, { kind: "write" }>),
        fileName: join(paths.worktreePath, ".git"),
      }) as PermissionRequest,
    gateDenied: false,
    reason: "This thread is not allowed to edit this path.",
  },
  {
    name: "a relative dot-dot path",
    request: (_paths: ReturnType<typeof workspace>) =>
      ({
        ...(request("write") as Extract<PermissionRequest, { kind: "write" }>),
        fileName: "../outside/secret.txt",
      }) as PermissionRequest,
    gateDenied: false,
    reason: "This thread is not allowed to edit this path.",
  },
  {
    name: "an absolute outside path",
    request: (paths: ReturnType<typeof workspace>) =>
      ({
        ...(request("write") as Extract<PermissionRequest, { kind: "write" }>),
        fileName: join(paths.outsidePath, "secret.txt"),
      }) as PermissionRequest,
    gateDenied: false,
    reason: "This thread is not allowed to edit this path.",
  },
  {
    name: "a symlink to outside",
    request: (paths: ReturnType<typeof workspace>) =>
      ({
        ...(request("write") as Extract<PermissionRequest, { kind: "write" }>),
        fileName: join(paths.worktreePath, "outside-link", "secret.txt"),
      }) as PermissionRequest,
    gateDenied: false,
    reason: "This thread is not allowed to edit this path.",
  },
  {
    name: "a symlink to the clone's .git",
    request: (paths: ReturnType<typeof workspace>) => {
      symlinkSync(paths.cloneGitPath, join(paths.worktreePath, "git-link"), "dir");
      return {
        ...(request("write") as Extract<PermissionRequest, { kind: "write" }>),
        fileName: join(paths.worktreePath, "git-link", "HEAD"),
      } as PermissionRequest;
    },
    gateDenied: false,
    reason: "This thread is not allowed to edit this path.",
  },
  {
    name: "a mismatched resolvedPath",
    request: (paths: ReturnType<typeof workspace>) =>
      ({
        ...(request("write") as Extract<PermissionRequest, { kind: "write" }>),
        fileName: join(paths.worktreePath, "src.ts"),
        resolvedPath: join(paths.worktreePath, "other.ts"),
      }) as PermissionRequest,
    gateDenied: false,
    reason: "This thread is not allowed to edit this path.",
  },
  {
    name: "an outside fileEdits path",
    request: (paths: ReturnType<typeof workspace>) =>
      ({
        ...(request("write") as Extract<PermissionRequest, { kind: "write" }>),
        fileName: join(paths.worktreePath, "src.ts"),
        fileEdits: [
          {
            before: { path: join(paths.worktreePath, "src.ts"), content: "before" },
            after: { path: join(paths.outsidePath, "secret.txt"), content: "after" },
          },
        ],
      }) as PermissionRequest,
    gateDenied: false,
    reason: "This thread is not allowed to edit this path.",
  },
  {
    name: "a fileEdits move outside",
    request: (paths: ReturnType<typeof workspace>) =>
      ({
        ...(request("write") as Extract<PermissionRequest, { kind: "write" }>),
        fileName: join(paths.worktreePath, "src.ts"),
        fileEdits: [
          {
            before: { path: join(paths.worktreePath, "src.ts"), content: "before" },
            after: { path: join(paths.outsidePath, "moved.ts"), content: "after" },
          },
        ],
      }) as PermissionRequest,
    gateDenied: false,
    reason: "This thread is not allowed to edit this path.",
  },
  {
    name: "a fileEdits path for another file inside the worktree",
    request: (paths: ReturnType<typeof workspace>) =>
      ({
        ...(request("write") as Extract<PermissionRequest, { kind: "write" }>),
        fileName: join(paths.worktreePath, "src.ts"),
        fileEdits: [
          {
            before: { path: join(paths.worktreePath, "other.ts"), content: "a" },
            after: { path: join(paths.worktreePath, "other.ts"), content: "b" },
          },
        ],
      }) as PermissionRequest,
    gateDenied: false,
    reason: "This thread is not allowed to edit this path.",
  },
  {
    name: "a fileEdits rename to another file inside the worktree",
    request: (paths: ReturnType<typeof workspace>) =>
      ({
        ...(request("write") as Extract<PermissionRequest, { kind: "write" }>),
        fileName: join(paths.worktreePath, "src.ts"),
        fileEdits: [
          {
            before: { path: join(paths.worktreePath, "src.ts"), content: "before" },
            after: { path: join(paths.worktreePath, "other.ts"), content: "after" },
          },
        ],
      }) as PermissionRequest,
    gateDenied: false,
    reason: "This thread is not allowed to edit this path.",
  },
  {
    name: "a second fileEdits entry for another file inside the worktree",
    request: (paths: ReturnType<typeof workspace>) =>
      ({
        ...(request("write") as Extract<PermissionRequest, { kind: "write" }>),
        fileName: join(paths.worktreePath, "src.ts"),
        fileEdits: [
          {
            before: { path: join(paths.worktreePath, "src.ts"), content: "before" },
            after: { path: join(paths.worktreePath, "src.ts"), content: "after" },
          },
          {
            after: { path: join(paths.worktreePath, "other.ts"), content: "extra" },
          },
        ],
      }) as PermissionRequest,
    gateDenied: false,
    reason: "This thread is not allowed to edit this path.",
  },
  {
    name: "a hard link inside the worktree to an outside file",
    request: (paths: ReturnType<typeof workspace>) =>
      ({
        ...(request("write") as Extract<PermissionRequest, { kind: "write" }>),
        fileName: join(paths.worktreePath, "hard.txt"),
      }) as PermissionRequest,
    gateDenied: false,
    reason: "This thread is not allowed to edit this path.",
  },
  {
    name: "a hard link inside the worktree to another worktree file",
    request: (paths: ReturnType<typeof workspace>) => {
      const alias = join(paths.worktreePath, "hard-inside.ts");
      linkSync(join(paths.worktreePath, "other.ts"), alias);
      return {
        ...(request("write") as Extract<PermissionRequest, { kind: "write" }>),
        fileName: alias,
      } as PermissionRequest;
    },
    gateDenied: false,
    reason: "This thread is not allowed to edit this path.",
  },
  {
    name: "a read with only sandboxPathGrant",
    request: (paths: ReturnType<typeof workspace>) =>
      ({
        kind: "read",
        intention: "Read",
        path: join(paths.worktreePath, "src.ts"),
        sandboxPathGrant: { access: "readWrite", path: paths.outsidePath },
      }) as PermissionRequest,
    gateDenied: false,
    reason: "Sandbox bypasses and path grants are not allowed.",
  },
  {
    name: "a permissive-only read",
    request: (paths: ReturnType<typeof workspace>) =>
      ({
        kind: "read",
        intention: "Read",
        path: join(paths.worktreePath, "src.ts"),
        requestSandboxPermissive: true,
      }) as PermissionRequest,
    gateDenied: false,
    reason: "Sandbox bypasses and path grants are not allowed.",
  },
  {
    name: "a gate-denied read",
    request: (paths: ReturnType<typeof workspace>) =>
      ({
        kind: "read",
        intention: "Read",
        path: join(paths.worktreePath, "src.ts"),
      }) as PermissionRequest,
    gateDenied: true,
    reason: "The sandbox denied this request.",
  },
] as const;

it.each(boundaryRows.flatMap((row) => modes.map((mode) => ({ ...row, mode }))))(
  "denies $name in $mode mode",
  async ({ request: makeRequest, gateDenied, mode, reason }) => {
    const paths = workspace();
    const requestApproval = vi.fn(
      async (_request: object, decision?: boolean) => decision !== false,
    );
    const events = {
      requestApproval,
      thinking() {},
      delta() {},
      toolStarted() {},
      toolFinished() {},
    };
    const result = await askingPermission(paths, () => events, { mode, gateDenied })(
      makeRequest(paths),
      { sessionId: "fixture" },
    );
    expect(result).toEqual({ kind: "reject" });
    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({ reason }), false);
  },
);

it("draws new file contents as an all-added diff", async () => {
  const paths = workspace();
  const requestApproval = vi.fn(async () => true);
  const events = {
    requestApproval,
    thinking() {},
    delta() {},
    toolStarted() {},
    toolFinished() {},
  };
  await askingPermission(paths, () => events)(
    {
      ...(request("write") as Extract<PermissionRequest, { kind: "write" }>),
      fileName: join(paths.worktreePath, "new.ts"),
      diff: "",
      newFileContents: "export const value = 1;\n",
    },
    { sessionId: "fixture" },
  );
  expect(requestApproval).toHaveBeenCalledWith(
    expect.objectContaining({ diff: "+export const value = 1;\n" }),
    undefined,
  );
});

it.each(modes)("allows fileEdits whose paths canonicalize to fileName in %s mode", async (mode) => {
  const paths = workspace();
  const requestApproval = vi.fn(async (_request: object, decision?: boolean) => decision !== false);
  const events = {
    requestApproval,
    thinking() {},
    delta() {},
    toolStarted() {},
    toolFinished() {},
  };
  const target = join(paths.worktreePath, "src.ts");
  const result = await askingPermission(paths, () => events, { mode })(
    {
      ...(request("write") as Extract<PermissionRequest, { kind: "write" }>),
      fileName: target,
      fileEdits: [
        {
          before: { path: "src.ts", content: "before" },
          after: { path: target, content: "after" },
        },
      ],
    },
    { sessionId: "fixture" },
  );
  expect(result).toEqual({ kind: "approve-once" });
  expect(requestApproval).toHaveBeenCalledWith(
    expect.objectContaining({ path: target }),
    mode === "supervised" ? undefined : true,
  );
});

it.each(modes)("denies an empty write in %s mode", async (mode) => {
  const paths = workspace();
  const requestApproval = vi.fn(async () => false);
  const events = {
    requestApproval,
    thinking() {},
    delta() {},
    toolStarted() {},
    toolFinished() {},
  };
  const result = await askingPermission(paths, () => events, { mode })(
    {
      ...(request("write") as Extract<PermissionRequest, { kind: "write" }>),
      fileName: join(paths.worktreePath, "src.ts"),
      diff: "",
      newFileContents: "",
    },
    { sessionId: "fixture" },
  );
  expect(result).toEqual({ kind: "reject" });
  expect(requestApproval).toHaveBeenCalledWith(
    expect.objectContaining({ reason: "This edit has no diff to show for approval." }),
    false,
  );
});

it("asks for a managed write in Auto-accept edits mode", async () => {
  const paths = workspace();
  const requestApproval = vi.fn(async () => true);
  const events = {
    requestApproval,
    thinking() {},
    delta() {},
    toolStarted() {},
    toolFinished() {},
  };
  await askingPermission(paths, () => events, { mode: "auto-accept-edits" })(
    {
      ...(request("write") as Extract<PermissionRequest, { kind: "write" }>),
      fileName: join(paths.worktreePath, "src.ts"),
      managedApprovalRequired: true,
    },
    { sessionId: "fixture" },
  );
  expect(requestApproval).toHaveBeenCalledWith(expect.any(Object), undefined);
});

it.each([
  {
    mode: "supervised",
    result: { kind: "reject" },
    resolved: false,
  },
  {
    mode: "auto-accept-edits",
    result: { kind: "approve-once" },
    resolved: true,
  },
] as const)(
  "handles a secret-shaped Supervised diff according to $mode mode",
  async ({ mode, result, resolved }) => {
    const paths = workspace();
    const database = new DatabaseSync(":memory:");
    const secret = "probe-secret-12345";
    let permission: Awaited<ReturnType<ReturnType<typeof askingPermission>>> | undefined;
    const engine = new ThreadEngine(database, {
      workspace: { resolve: () => ({ cwd: paths.worktreePath }) },
      context: { prepare: () => ({ instructions: "", attachments: [] }) },
      tools: { offer: () => [] },
      runtime: {
        async run(_input, events) {
          permission = await askingPermission(paths, () => events, { mode })(
            {
              ...(request("write") as Extract<PermissionRequest, { kind: "write" }>),
              fileName: join(paths.worktreePath, "app.yaml"),
              diff: `@@ -1 +1 @@\n-old\n+password: ${secret}\n`,
            },
            { sessionId: "fixture" },
          );
        },
      },
    });
    try {
      const id = engine.create({ scope: "partition" });
      await engine.send(id, { prompt: "Edit" });
      expect(permission).toEqual(result);
      expect(engine.eventsSince(id, 0)).toContainEqual(
        expect.objectContaining({
          type: "approval.resolved",
          approved: resolved,
        }),
      );
      if (mode === "supervised")
        expect(engine.eventsSince(id, 0)).toContainEqual(
          expect.objectContaining({
            type: "approval.requested",
            asked: false,
            reason:
              "This edit contains text that looks like a secret, so it can't be shown for approval",
          }),
        );
    } finally {
      database.close();
    }
  },
);

it("denies an unknown kind with a visible reason", async () => {
  const paths = workspace();
  const requestApproval = vi.fn(async (_request: object, _decision?: boolean) => false);
  const events = {
    requestApproval,
    thinking() {},
    delta() {},
    toolStarted() {},
    toolFinished() {},
  };
  await askingPermission(paths, () => events)(request("sdk-added-later"), { sessionId: "fixture" });
  expect(requestApproval.mock.calls[0]).toEqual([
    expect.objectContaining({
      kind: "sdk-added-later",
      reason: "Permission kind sdk-added-later is not allowed.",
    }),
    false,
  ]);
});

it.each(["supervised", "auto-accept-edits"] as const)(
  "denies commands with their exact text and a visible reason in %s mode",
  async (mode: AccessMode) => {
    const paths = workspace();
    const requestApproval = vi.fn(async (_request: object, _decision?: boolean) => false);
    const events = {
      requestApproval,
      thinking() {},
      delta() {},
      toolStarted() {},
      toolFinished() {},
    };
    await askingPermission(paths, () => events, { mode })(request("shell"), {
      sessionId: "fixture",
    });
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: "pnpm test",
        reason: "Commands are not offered in threads yet. Use the host actions instead.",
      }),
      false,
    );
  },
);
