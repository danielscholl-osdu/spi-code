// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, sep } from "node:path";
import type { ContainerRequest, ExecutionResult } from "@microsoft/mxc-sdk/v1";
import { buildSandboxConfig, canonicalSandboxWorkspace, quoteShell } from "../copilot/sandbox.js";

export type ConfinementReason =
  | "unsupported-platform"
  | "mxc-unavailable"
  | "mxc-failed"
  | "confinement-not-proven";

/** A program the command started may outlive it; the host cannot tell. */
export type AfterExit = "not-known";

export type ConfinedResult =
  | { readonly ok: true; readonly data: string; readonly afterExit: AfterExit }
  | {
      readonly ok: false;
      readonly error: string;
      readonly code: number | null;
      readonly afterExit: AfterExit;
    }
  | {
      readonly ok: false;
      readonly refused: ConfinementReason;
      readonly error: string;
      readonly code: null;
    };

export interface MxcApi {
  getPlatformSupport(): { readonly isSupported: boolean; readonly availableMethods: string[] };
  run(request: ContainerRequest): Promise<ExecutionResult>;
}

export const loadMxc = (): Promise<MxcApi> => import("@microsoft/mxc-sdk/v1");

export interface ConfinedCommand {
  readonly binary: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly clone: string;
  readonly worktree: string;
  /** Host-owned directory for each run's temp and check directories. */
  readonly scratch: string;
  readonly readonlyPaths: readonly string[];
  readonly timeoutMs: number;
}

const messages: Record<ConfinementReason, string> = {
  "unsupported-platform": "Confined Git is not available on this platform yet.",
  "mxc-unavailable": "The sandbox for Git is not available.",
  "mxc-failed": "The sandbox for Git failed to start.",
  "confinement-not-proven": "The sandbox for Git could not be proven.",
};

const refuse = (reason: ConfinementReason): ConfinedResult => ({
  ok: false,
  refused: reason,
  error: messages[reason],
  code: null,
});

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function within(directory: string, path: string): boolean {
  const from = relative(directory, path);
  return !isAbsolute(from) && from !== ".." && !from.startsWith(`..${sep}`);
}

/**
 * The widest read-only grant Git needs that holds none of the protected paths. Homebrew links
 * a formula's libraries from its prefix, not from the formula's own directory.
 */
export function installRoot(binary: string, protectedPaths: readonly string[]): string {
  const parts = binary.split(sep);
  const cellar = parts.lastIndexOf("Cellar");
  const prefix = cellar > 1 ? parts.slice(0, cellar).join(sep) : dirname(dirname(binary));
  return (
    [prefix, dirname(binary)].find(
      (path) =>
        parse(path).root !== path && !protectedPaths.some((guarded) => within(path, guarded)),
    ) ?? binary
  );
}

function diagnostic(stderr: string, exit: number): string {
  const lines = stderr.split(/\r?\n/u);
  const line = lines.find((text) => /^(fatal|error):/u.test(text)) ?? lines.find(Boolean);
  return (line ?? `exit ${exit}`).slice(0, 500);
}

export async function runConfined(
  command: ConfinedCommand,
  load: () => Promise<MxcApi> = loadMxc,
  platform: NodeJS.Platform = process.platform,
): Promise<ConfinedResult> {
  if (platform !== "darwin") return refuse("unsupported-platform");
  let mxc: MxcApi;
  try {
    mxc = await load();
    const support = mxc.getPlatformSupport();
    if (!support.isSupported || !support.availableMethods.includes("seatbelt")) {
      return refuse("mxc-unavailable");
    }
  } catch {
    return refuse("mxc-unavailable");
  }
  const temp = await mkdtemp(join(command.scratch, "run-"));
  const check = await mkdtemp(join(command.scratch, "check-"));
  try {
    const workspace = await canonicalSandboxWorkspace({
      clonePath: command.clone,
      worktreePath: command.worktree,
      tempPath: temp,
      toolchainPaths: command.readonlyPaths,
    });
    const filesystem = buildSandboxConfig(workspace).userPolicy?.filesystem;
    const canary = join(check, "outside");
    const writable = filesystem?.readwritePaths ?? [];
    if (!filesystem || writable.some((path) => within(path, canary))) {
      return refuse("confinement-not-proven");
    }
    const id = `spi-confined-${randomUUID()}`;
    const script = [
      `printf '%s\\n' ${quoteShell(id)}`,
      `if (printf x > ${quoteShell(canary)}) 2>/dev/null; then exit 97; fi`,
      `exec ${[command.binary, ...command.args].map(quoteShell).join(" ")}`,
    ].join("; ");
    let result: ExecutionResult;
    try {
      result = await mxc.run({
        containment: {
          type: "seatbelt",
          config: { guiAccess: false, nestedPty: false, keychainAccess: false },
        },
        filesystem: {
          readwritePaths: [...writable],
          readonlyPaths: [...(filesystem.readonlyPaths ?? [])],
        },
        network: {
          egress: { default: "deny" },
          ingress: { default: "deny", hostLoopback: "deny" },
        },
        environment: { ...command.env, TMPDIR: temp, TMP: temp, TEMP: temp },
        workingDirectory: workspace.worktreePath ?? command.worktree,
        timeoutMs: command.timeoutMs,
        command: `/bin/sh -c ${quoteShell(script)}`,
      });
    } catch {
      return refuse("mxc-failed");
    }
    const begin = `${id}\n`;
    if ((await exists(canary)) || result.exitCode === 97 || !result.stdout.startsWith(begin)) {
      return refuse("confinement-not-proven");
    }
    if (result.timedOut)
      return { ok: false, error: "Git timed out.", code: null, afterExit: "not-known" };
    if (result.exitCode !== 0) {
      return {
        ok: false,
        error: diagnostic(result.stderr, result.exitCode),
        code: result.exitCode,
        afterExit: "not-known",
      };
    }
    return { ok: true, data: result.stdout.slice(begin.length), afterExit: "not-known" };
  } finally {
    await Promise.all([
      rm(temp, { recursive: true, force: true }),
      rm(check, { recursive: true, force: true }),
    ]);
  }
}
