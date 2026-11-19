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
  | "setup-failed"
  | "workspace-not-trusted"
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
  /** Refused before the sandbox was asked to run anything. */
  | {
      readonly ok: false;
      readonly refused: ConfinementReason;
      readonly error: string;
      readonly code: null;
    }
  /** The sandbox ran, but its result does not prove it held; Git may have run. */
  | {
      readonly ok: false;
      readonly refused: "confinement-not-proven";
      readonly error: string;
      readonly code: null;
      readonly afterExit: AfterExit;
    }
  /** The sandbox was asked to run and gave no usable result; Git may have run. */
  | {
      readonly ok: false;
      readonly uncertain: "outcome-not-known";
      readonly error: string;
      readonly code: null;
      readonly afterExit: AfterExit;
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
  "setup-failed": "The sandbox for Git could not be set up.",
  "workspace-not-trusted": "The worktree's Git files are not the ones the host recorded.",
  "confinement-not-proven": "The sandbox for Git could not be proven.",
};

export const refuse = (reason: ConfinementReason): ConfinedResult => ({
  ok: false,
  refused: reason,
  error: messages[reason],
  code: null,
});

const notProven: ConfinedResult = {
  ok: false,
  refused: "confinement-not-proven",
  error: messages["confinement-not-proven"],
  code: null,
  afterExit: "not-known",
};

const uncertain: ConfinedResult = {
  ok: false,
  uncertain: "outcome-not-known",
  error: "The sandbox for Git gave no usable result. Git may have run.",
  code: null,
  afterExit: "not-known",
};

/** The wrapper's own exits, before Git starts. */
const canaryWritten = 97;
const canaryNotDenied = 98;

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

function isExecutionResult(value: unknown): value is ExecutionResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.stdout === "string" &&
    typeof result.stderr === "string" &&
    Number.isInteger(result.exitCode) &&
    typeof result.timedOut === "boolean"
  );
}

async function judge(value: unknown, proof: string, canary: string): Promise<ConfinedResult> {
  if (
    !isExecutionResult(value) ||
    !value.stdout.startsWith(proof) ||
    value.exitCode === canaryWritten ||
    value.exitCode === canaryNotDenied ||
    (await exists(canary))
  ) {
    return notProven;
  }
  if (value.timedOut) {
    return { ok: false, error: "Git timed out.", code: null, afterExit: "not-known" };
  }
  if (value.exitCode !== 0) {
    return {
      ok: false,
      error: diagnostic(value.stderr, value.exitCode),
      code: value.exitCode,
      afterExit: "not-known",
    };
  }
  return { ok: true, data: value.stdout.slice(proof.length), afterExit: "not-known" };
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
  const allocated: string[] = [];
  const allocate = async (prefix: string) => {
    const directory = await mkdtemp(join(command.scratch, prefix));
    allocated.push(directory);
    return directory;
  };
  let launched = false;
  try {
    const temp = await allocate("run-");
    const check = await allocate("check-");
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
    // Seatbelt denies the write with EPERM; any other failure proves nothing about the policy.
    const script = [
      `denied=$( { printf x > ${quoteShell(canary)}; } 2>&1 ) && exit ${canaryWritten}`,
      `case $denied in *${quoteShell(`${canary}: Operation not permitted`)}) ;; *) exit ${canaryNotDenied} ;; esac`,
      `printf '%s\\n' ${quoteShell(`${id}:EPERM`)}`,
      `exec ${[command.binary, ...command.args].map(quoteShell).join(" ")}`,
    ].join("; ");
    launched = true;
    const result: unknown = await mxc.run({
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
    return await judge(result, `${id}:EPERM\n`, canary);
  } catch {
    return launched ? uncertain : refuse("setup-failed");
  } finally {
    await Promise.allSettled(
      allocated.map((directory) => rm(directory, { recursive: true, force: true })),
    );
  }
}
