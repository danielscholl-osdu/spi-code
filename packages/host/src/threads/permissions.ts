// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { PermissionHandler, PermissionRequest } from "@github/copilot-sdk";
import { type AccessMode, REDACTION_MARKER, type RuntimeEvents } from "@spi-code/threads";
import type { SandboxWorkspace } from "../copilot/sandbox.js";

const nativeRealpath = promisify(realpath.native);
const nativeLstat = promisify(lstat);

export type { AccessMode } from "@spi-code/threads";
export type PermissionDecision = "pass" | "ask" | "deny";
type PermissionKind = PermissionRequest["kind"];

export const PERMISSION_POLICY = Object.freeze({
  read: { supervised: "pass", "auto-accept-edits": "pass" },
  write: { supervised: "ask", "auto-accept-edits": "pass" },
  shell: { supervised: "deny", "auto-accept-edits": "deny" },
  mcp: { supervised: "deny", "auto-accept-edits": "deny" },
  url: { supervised: "deny", "auto-accept-edits": "deny" },
  memory: { supervised: "deny", "auto-accept-edits": "deny" },
  "custom-tool": { supervised: "deny", "auto-accept-edits": "deny" },
  hook: { supervised: "deny", "auto-accept-edits": "deny" },
  "extension-management": { supervised: "deny", "auto-accept-edits": "deny" },
  workflow: { supervised: "deny", "auto-accept-edits": "deny" },
  "extension-permission-access": { supervised: "deny", "auto-accept-edits": "deny" },
  "extension-env-access": { supervised: "deny", "auto-accept-edits": "deny" },
} satisfies Record<PermissionKind, Record<AccessMode, PermissionDecision>>);

export function permissionDecision(kind: string, mode: AccessMode): PermissionDecision {
  return PERMISSION_POLICY[kind as PermissionKind]?.[mode] ?? "deny";
}

function rawPath(base: string, path: string): string | undefined {
  if (!path) return undefined;
  const absolute = isAbsolute(path);
  if (process.platform === "win32") {
    const { root } = parse(path);
    if (absolute ? root.length === 1 : root !== "") return undefined;
  }
  return absolute ? path : `${base}${sep}${path}`;
}

async function canonicalReadPath(base: string, path: string): Promise<string | undefined> {
  const raw = rawPath(base, path);
  if (!raw) return undefined;
  try {
    const [physical, lexical] = await Promise.all([
      nativeRealpath(raw),
      nativeRealpath(resolve(raw)),
    ]);
    return physical === lexical ? physical : undefined;
  } catch {
    return undefined;
  }
}

async function missing(path: string): Promise<boolean> {
  try {
    await nativeLstat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function canonicalWritePath(base: string, path: string): Promise<string | undefined> {
  const raw = rawPath(base, path);
  if (!raw) return undefined;
  let physicalSpelling = raw;
  let lexicalSpelling = resolve(raw);
  const physicalSuffix: string[] = [];
  const lexicalSuffix: string[] = [];
  while (true) {
    try {
      const [physical, lexical] = await Promise.all([
        nativeRealpath(physicalSpelling),
        nativeRealpath(lexicalSpelling),
      ]);
      const candidate = resolve(physical, ...physicalSuffix);
      return candidate === resolve(lexical, ...lexicalSuffix) ? candidate : undefined;
    } catch {
      if (!(await missing(physicalSpelling)) || !(await missing(lexicalSpelling))) return undefined;
      const physicalParent = dirname(physicalSpelling);
      const lexicalParent = dirname(lexicalSpelling);
      if (physicalParent === physicalSpelling || lexicalParent === lexicalSpelling)
        return undefined;
      physicalSuffix.unshift(basename(physicalSpelling));
      lexicalSuffix.unshift(basename(lexicalSpelling));
      physicalSpelling = physicalParent;
      lexicalSpelling = lexicalParent;
    }
  }
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

async function readIsAllowed(workspace: SandboxWorkspace, request: PermissionRequest) {
  if (request.kind !== "read" || carriesEscalation(request) || request.managedApprovalRequired)
    return false;
  const base = workspace.worktreePath ?? workspace.clonePath;
  if (!base) return false;
  const allowed = [
    workspace.clonePath,
    workspace.worktreePath,
    ...(workspace.toolchainPaths ?? []),
  ].filter((path): path is string => path !== undefined);
  const [path, attested, roots] = await Promise.all([
    canonicalReadPath(base, request.path),
    request.resolvedPath === undefined ? undefined : canonicalReadPath(base, request.resolvedPath),
    Promise.all(allowed.map((root) => nativeRealpath(root).catch(() => undefined))),
  ]);
  return (
    path !== undefined &&
    (request.resolvedPath === undefined || path === attested) &&
    roots.some((root) => root !== undefined && inside(root, path))
  );
}

async function writeIsAllowed(workspace: SandboxWorkspace, request: PermissionRequest) {
  if (request.kind !== "write" || !workspace.worktreePath) return false;
  const base = workspace.worktreePath;
  const edits = (request.fileEdits ?? []).flatMap((edit) =>
    [edit.before?.path, edit.after?.path].filter((path): path is string => path !== undefined),
  );
  const paths = [
    request.fileName,
    ...(request.resolvedPath === undefined ? [] : [request.resolvedPath]),
    ...edits,
  ];
  const [root, forbidden, canonical] = await Promise.all([
    nativeRealpath(base).catch(() => undefined),
    Promise.all(
      [
        join(base, ".git"),
        ...(workspace.clonePath === undefined ? [] : [join(workspace.clonePath, ".git")]),
      ].map((path) => nativeRealpath(path).catch(() => undefined)),
    ),
    Promise.all(paths.map((path) => canonicalWritePath(base, path))),
  ]);
  const [fileName, ...attested] = canonical;
  return (
    root !== undefined &&
    fileName !== undefined &&
    (request.resolvedPath === undefined || fileName === canonical[1]) &&
    attested.every((path) => path !== undefined) &&
    canonical.every(
      (path) =>
        path !== undefined &&
        inside(root, path) &&
        !forbidden.some((root) => root !== undefined && inside(root, path)),
    )
  );
}

function carriesEscalation(request: PermissionRequest): boolean {
  return (
    ("requestSandboxBypass" in request && request.requestSandboxBypass === true) ||
    ("requestSandboxPermissive" in request && request.requestSandboxPermissive === true) ||
    ("sandboxPathGrant" in request && request.sandboxPathGrant !== undefined)
  );
}

function carriesRedactionMarker(request: PermissionRequest): boolean {
  return request.kind === "write" && JSON.stringify(request).includes(REDACTION_MARKER);
}

function addedDiff(contents: string): string {
  const trailingNewline = contents.endsWith("\n");
  const lines = contents.split(/\r?\n/);
  if (trailingNewline) lines.pop();
  return `${lines.map((line) => `+${line}`).join("\n")}${trailingNewline ? "\n" : ""}`;
}

function writeDiff(request: Extract<PermissionRequest, { kind: "write" }>): string | undefined {
  if (request.diff) return request.diff;
  if (request.newFileContents) return addedDiff(request.newFileContents);
  return undefined;
}

function presentation(request: PermissionRequest) {
  switch (request.kind) {
    case "write": {
      const diff = writeDiff(request);
      return {
        detail: request.fileName,
        path: request.fileName,
        ...(diff === undefined ? {} : { diff }),
      };
    }
    case "read":
      return { detail: request.path, path: request.path };
    case "shell":
      return { detail: request.fullCommandText };
    case "custom-tool":
      return { detail: request.toolName };
    default:
      return { detail: request.kind };
  }
}

function deniedReason(
  request: PermissionRequest,
  gateDenied: boolean,
  writePathDenied: boolean,
): string {
  if (carriesEscalation(request)) return "Sandbox bypasses and path grants are not allowed.";
  if (carriesRedactionMarker(request))
    return "This edit contains redacted text and cannot be written back.";
  if (gateDenied || writePathDenied)
    return request.kind === "write"
      ? "This thread is not allowed to edit this path."
      : "The sandbox denied this request.";
  if (request.kind === "write" && writeDiff(request) === undefined)
    return "This edit has no diff to show for approval.";
  if (request.kind === "write") return "This thread is Asking and cannot edit files.";
  if (request.kind === "shell")
    return "Commands are not offered in threads yet. Use the host actions instead.";
  if (request.kind === "read") return "The requested path is not an approved read path.";
  if (request.kind === "custom-tool") return "This tool is not an approved SPI read tool.";
  return `Permission kind ${request.kind} is not allowed.`;
}

export function askingPermission(
  workspace: SandboxWorkspace,
  current: () => RuntimeEvents | undefined,
  {
    gateDenied = false,
    spiReads,
    mode = "supervised",
  }: {
    gateDenied?: boolean;
    spiReads?: ReadonlySet<string>;
    mode?: AccessMode;
  } = {},
): PermissionHandler {
  return async (request) => {
    const events = current();
    if (!events) return { kind: "reject" };
    const table = permissionDecision(request.kind, mode);
    let decision: PermissionDecision = gateDenied || carriesEscalation(request) ? "deny" : table;
    let writePathDenied = false;
    if (request.kind === "write" && decision !== "deny") {
      writePathDenied = !(await writeIsAllowed(workspace, request));
      if (writePathDenied || carriesRedactionMarker(request) || writeDiff(request) === undefined)
        decision = "deny";
      else if (request.managedApprovalRequired) decision = "ask";
    }
    if (request.kind === "read" && decision !== "deny")
      decision = (await readIsAllowed(workspace, request)) ? "pass" : "deny";
    if (
      decision === "deny" &&
      request.kind === "custom-tool" &&
      !gateDenied &&
      !carriesEscalation(request) &&
      spiReads?.has(request.toolName)
    )
      decision = "pass";
    if (events !== current()) return { kind: "reject" };
    const shown = presentation(request);
    const approved = await events.requestApproval(
      {
        approvalId: randomUUID(),
        kind: request.kind,
        ...shown,
        ...(decision === "deny"
          ? { reason: deniedReason(request, gateDenied, writePathDenied) }
          : {}),
      },
      decision === "ask" ? undefined : decision === "pass",
    );
    return approved ? { kind: "approve-once" } : { kind: "reject" };
  };
}
