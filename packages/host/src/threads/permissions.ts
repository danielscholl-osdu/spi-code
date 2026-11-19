// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PermissionHandler } from "@github/copilot-sdk";
import type { RuntimeEvents } from "@spi-code/threads";
import type { SandboxWorkspace } from "../copilot/sandbox.js";

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

export function askingPermission(
  workspace: SandboxWorkspace,
  current: () => RuntimeEvents | undefined,
  { gateDenied = false, spiReads }: { gateDenied?: boolean; spiReads?: ReadonlySet<string> } = {},
): PermissionHandler {
  return async (request) => {
    const events = current();
    if (!events) return { kind: "reject" };
    const detail =
      request.kind === "read"
        ? request.path
        : request.kind === "write"
          ? request.fileName
          : request.kind === "shell"
            ? request.fullCommandText
            : request.kind === "custom-tool"
              ? request.toolName
              : request.kind;
    let allow =
      !gateDenied && request.kind === "custom-tool" && spiReads?.has(request.toolName) === true;
    if (
      !gateDenied &&
      request.kind === "read" &&
      workspace.clonePath &&
      !request.requestSandboxBypass &&
      !request.managedApprovalRequired
    ) {
      const path = resolve(workspace.clonePath, request.path);
      const roots = [workspace.clonePath, workspace.tempPath, ...(workspace.toolchainPaths ?? [])];
      const [canonical, ...canonicalRoots] = await Promise.all(
        [path, ...roots].map((entry) => realpath(entry).catch(() => undefined)),
      );
      allow =
        canonical !== undefined &&
        roots.some((root, index) => {
          const canonicalRoot = canonicalRoots[index];
          return (
            canonicalRoot !== undefined &&
            (inside(root, path) || inside(canonicalRoot, path)) &&
            inside(canonicalRoot, canonical)
          );
        }) &&
        (request.resolvedPath === undefined || relative(canonical, request.resolvedPath) === "");
    }
    if (events !== current()) return { kind: "reject" };
    return (await events.requestApproval(
      { approvalId: randomUUID(), kind: request.kind, detail },
      allow,
    ))
      ? { kind: "approve-once" }
      : { kind: "reject" };
  };
}
