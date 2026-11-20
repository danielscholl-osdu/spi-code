// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { realpath } from "node:fs";
import { isAbsolute, parse, sep } from "node:path";
import { promisify } from "node:util";
import type { PermissionHandler } from "@github/copilot-sdk";
import type { RuntimeEvents } from "@spi-code/threads";
import type { SandboxWorkspace } from "../copilot/sandbox.js";

const nativeRealpath = promisify(realpath.native);

function canonicalReadPath(clone: string, path: string): Promise<string | undefined> {
  if (!path) return Promise.resolve(undefined);
  const absolute = isAbsolute(path);
  if (process.platform === "win32") {
    const { root } = parse(path);
    if (absolute ? root.length === 1 : root !== "") return Promise.resolve(undefined);
  }
  return nativeRealpath(absolute ? path : `${clone}${sep}${path}`).catch(() => undefined);
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
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
      const clone = workspace.clonePath;
      const [root, path, attested] = await Promise.all([
        nativeRealpath(clone).catch(() => undefined),
        canonicalReadPath(clone, request.path),
        request.resolvedPath === undefined
          ? undefined
          : canonicalReadPath(clone, request.resolvedPath),
      ]);
      allow =
        root !== undefined &&
        path !== undefined &&
        inside(root, path) &&
        (request.resolvedPath === undefined || path === attested);
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
