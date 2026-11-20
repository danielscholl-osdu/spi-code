// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionRequest } from "@github/copilot-sdk";
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
  for (const path of [clonePath, worktreePath, tempPath]) mkdirSync(path);
  return { root, clonePath, worktreePath, tempPath };
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
    const events = { requestApproval, delta() {}, toolStarted() {}, toolFinished() {} };
    const handler = askingPermission({ tempPath: root, worktreePath: root }, () => events, {
      mode,
    });
    for (const kind of Object.keys(PERMISSION_POLICY)) {
      await handler(request(kind), { sessionId: "fixture" });
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
    const events = { requestApproval, delta() {}, toolStarted() {}, toolFinished() {} };
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
  const events = { requestApproval, delta() {}, toolStarted() {}, toolFinished() {} };
  const edit = request("write");
  await askingPermission(paths, () => events)(edit, { sessionId: "fixture" });
  expect(requestApproval).toHaveBeenCalledWith(
    expect.objectContaining({
      path: edit.kind === "write" ? edit.fileName : "",
      diff: edit.kind === "write" ? edit.diff : "",
    }),
    undefined,
  );
});

it("refuses a redacted write without applying it", async () => {
  const paths = workspace();
  let applied = false;
  const requestApproval = vi.fn(async (_request: object, _decision?: boolean) => false);
  const events = { requestApproval, delta() {}, toolStarted() {}, toolFinished() {} };
  const edit = request("write") as Extract<PermissionRequest, { kind: "write" }>;
  const result = await askingPermission(paths, () => events, { mode: "auto-accept-edits" })(
    { ...edit, diff: `${edit.diff}\n+[redacted]` },
    { sessionId: "fixture" },
  );
  if (result.kind === "approve-once") applied = true;
  expect(result).toEqual({ kind: "reject" });
  expect(applied).toBe(false);
  expect(requestApproval.mock.calls[0]?.[0]).toMatchObject({
    reason: "This edit contains redacted text and cannot be written back.",
  });
});

it("denies an unknown kind with a visible reason", async () => {
  const paths = workspace();
  const requestApproval = vi.fn(async (_request: object, _decision?: boolean) => false);
  const events = { requestApproval, delta() {}, toolStarted() {}, toolFinished() {} };
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
    const events = { requestApproval, delta() {}, toolStarted() {}, toolFinished() {} };
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
