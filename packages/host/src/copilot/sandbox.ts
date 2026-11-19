// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import type { CopilotSession, SandboxConfig } from "@github/copilot-sdk";

export interface SandboxWorkspace {
  readonly clonePath?: string;
  readonly worktreePath?: string;
  readonly tempPath: string;
  readonly toolchainPaths?: readonly string[];
}

export interface SandboxRuntimePaths {
  readonly canaryRoot: string;
  readonly tempPath: string;
}

// OSDU's GitLab also hosts its Maven package registry.
export const copilotSandboxHosts = Object.freeze([
  "github.com",
  "api.github.com",
  "community.opengroup.org",
  "repo.maven.apache.org",
  "repo1.maven.org",
]);

function contains(directory: string, path: string): boolean {
  const fromDirectory = relative(directory, path);
  return (
    !isAbsolute(fromDirectory) && fromDirectory !== ".." && !fromDirectory.startsWith(`..${sep}`)
  );
}

function checkWorkspace(workspace: SandboxWorkspace): void {
  const { worktreePath, clonePath, tempPath, toolchainPaths = [] } = workspace;
  const paths = [clonePath, worktreePath, tempPath, ...toolchainPaths];
  if (
    !tempPath ||
    paths.some((path) => path !== undefined && (!isAbsolute(path) || path.includes("\0"))) ||
    (worktreePath && !clonePath)
  ) {
    throw new Error(
      "Copilot requires absolute workspace paths and the clone for a linked worktree.",
    );
  }
  const siblingPaths = [clonePath, worktreePath, tempPath].filter(
    (path): path is string => path !== undefined,
  );
  if (
    siblingPaths.some((first, index) =>
      siblingPaths
        .slice(index + 1)
        .some((second) => contains(first, second) || contains(second, first)),
    )
  ) {
    throw new Error("Copilot clone, worktree and temporary paths must be separate directories.");
  }
}

export async function canonicalSandboxWorkspace(
  workspace: SandboxWorkspace,
): Promise<SandboxWorkspace> {
  checkWorkspace(workspace);
  const { clonePath, worktreePath, tempPath, toolchainPaths = [] } = workspace;
  const [clone, worktree, temp, tools] = await Promise.all([
    clonePath === undefined ? undefined : realpath(clonePath),
    worktreePath === undefined ? undefined : realpath(worktreePath),
    realpath(tempPath),
    Promise.all(toolchainPaths.map((path) => realpath(path))),
  ]);
  const canonical = {
    ...(clone === undefined ? {} : { clonePath: clone }),
    ...(worktree === undefined ? {} : { worktreePath: worktree }),
    tempPath: temp,
    toolchainPaths: tools,
  };
  checkWorkspace(canonical);
  return canonical;
}

export function buildSandboxConfig(
  workspace: SandboxWorkspace,
  runtimeTemp?: string,
): SandboxConfig {
  checkWorkspace(workspace);
  const { clonePath, worktreePath, tempPath, toolchainPaths = [] } = workspace;
  const readwritePaths = [tempPath];
  const readonlyPaths = [...toolchainPaths];
  if (clonePath) {
    const git = join(clonePath, ".git");
    readonlyPaths.push(clonePath, join(git, "hooks"), join(git, "config"));
    if (worktreePath) {
      readwritePaths.push(worktreePath, git);
      readonlyPaths.push(join(worktreePath, ".git"));
    } else {
      readonlyPaths.push(git);
    }
  }
  return {
    enabled: true,
    allowBypass: false,
    addCurrentWorkingDirectory: false,
    allowDevToolAccess: false,
    auth: { git: false, gh: false },
    userPolicy: {
      filesystem: {
        readwritePaths,
        readonlyPaths: [...new Set(readonlyPaths)],
        ...(runtimeTemp ? { deniedPaths: [runtimeTemp] } : {}),
      },
      network: {
        allowOutbound: true,
        allowLocalNetwork: false,
        allowedHosts: [...copilotSandboxHosts],
      },
      seatbelt: { keychainAccess: false },
    },
  };
}

export type CopilotSandboxReason =
  | "unsupported-platform"
  | "preflight-not-run"
  | "preflight-failed"
  | "write-not-blocked"
  | "credential-environment"
  | "sandbox-not-attested"
  | "session-released";

export type CopilotSandboxState =
  | { readonly kind: "confined"; readonly backend: "seatbelt" }
  | { readonly kind: "not-confined"; readonly reason: CopilotSandboxReason };

export const sandboxUnavailable = (reason: CopilotSandboxReason): CopilotSandboxState => ({
  kind: "not-confined",
  reason,
});

const fileReadTools = ["view", "glob", "grep"];
const worktreeTools = ["create", "edit", "apply_patch", "bash"];

export function sandboxToolList(
  customTools: readonly string[],
  state: CopilotSandboxState,
  workspace: SandboxWorkspace,
): string[] {
  const custom = customTools.map((name) => `custom:${name}`);
  if (state.kind !== "confined") return custom;
  const reads = workspace.clonePath ? fileReadTools : [];
  const writes = workspace.worktreePath ? worktreeTools : [];
  return [...custom, ...[...reads, ...writes].map((name) => `builtin:${name}`)];
}

// The runtime appends its keys after the launcher's credential.helper override.
const gitConfigKeys = [
  "credential.helper",
  "safe.bareRepository",
  "credential.interactive",
  "core.fsmonitor",
];
const shellEnvironmentNames = new Set([
  "ALL_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "COPILOT_AGENT_SESSION_ID",
  "COPILOT_CLI",
  "COPILOT_DISABLE_KEYTAR",
  "COPILOT_HOME",
  "GCM_INTERACTIVE",
  "GH_PROMPT_DISABLED",
  "GIT_ASKPASS",
  "GIT_CONFIG_COUNT",
  ...gitConfigKeys.flatMap((_, index) => [`GIT_CONFIG_KEY_${index}`, `GIT_CONFIG_VALUE_${index}`]),
  "GIT_CONFIG_NOSYSTEM",
  "GIT_OPTIONAL_LOCKS",
  "GIT_TERMINAL_PROMPT",
  "SSH_ASKPASS",
  "HOME",
  "USERPROFILE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_DATA_HOME",
  "LOCALAPPDATA",
  "APPDATA",
  "PATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_COLLATE",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_MONETARY",
  "NODE_USE_ENV_PROXY",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "__CF_USER_TEXT_ENCODING",
  "_",
]);
const namePattern = /^[A-Za-z_][A-Za-z_0-9]*$/;
const probeTimeoutMs = 15_000;

export type PreflightInvocation = { readonly id: string; readonly command: string };

export function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildPreflight(path: string): PreflightInvocation {
  const id = `spi-sandbox-${randomUUID()}`;
  const gitConfigChecks = [
    `\${GIT_CONFIG_COUNT-} == ${gitConfigKeys.length}`,
    ...gitConfigKeys.map((key, index) => `\${GIT_CONFIG_KEY_${index}-} == ${quoteShell(key)}`),
  ].join(" && ");
  // Bash lists exported names directly. "env | cut" can treat a newline in a value as a name.
  const command = [
    `printf '%s\\n' '${id}:begin'`,
    `if (printf x > ${quoteShell(path)}) 2>/dev/null; then printf 'wrote\\n'; else printf 'blocked\\n'; fi`,
    `if [[ ${gitConfigChecks} ]]; then printf 'yes\\n'; else printf 'no\\n'; fi`,
    "compgen -e",
    `printf '%s\\n' '${id}:end'`,
  ].join("; ");
  return { id, command };
}

function preflightOutput(text: string | undefined, id: string) {
  const lines = text?.split(/\r?\n/);
  if (!lines) return;
  const first = lines.indexOf(`${id}:begin`);
  const last = lines.indexOf(`${id}:end`);
  if (first < 0 || last <= first + 3) return;
  const write = lines[first + 1];
  const gitConfig = lines[first + 2];
  const names = lines.slice(first + 3, last);
  if (!names.every((name) => namePattern.test(name)) || !names.includes("PATH")) return;
  if (gitConfig !== "yes" && gitConfig !== "no") return;
  if (write === "wrote" || write === "blocked") return { write, gitConfig, names };
}

function decisionFor(event: unknown, toolCallId: string) {
  if (
    !event ||
    typeof event !== "object" ||
    !("type" in event) ||
    event.type !== "sandbox.decision"
  ) {
    return;
  }
  const data = "data" in event ? event.data : undefined;
  if (!data || typeof data !== "object") return;
  const decision = data as Record<string, unknown>;
  if (decision.toolCallId === toolCallId) return decision;
}

async function fileIsAbsent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export async function runSandboxPreflight(
  session: Pick<CopilotSession, "on" | "rpc">,
  canaryRoot: string,
  sandboxConfig: SandboxConfig,
  authorize: (invocation: PreflightInvocation | undefined) => void,
  platform: NodeJS.Platform = process.platform,
): Promise<CopilotSandboxState> {
  if (platform !== "darwin") return sandboxUnavailable("unsupported-platform");
  const canaryDir = await mkdtemp(join(canaryRoot, "check-"));
  try {
    const canary = join(await realpath(canaryDir), "outside");
    if (
      sandboxConfig.userPolicy?.filesystem?.readwritePaths?.some((path) => contains(path, canary))
    ) {
      return sandboxUnavailable("preflight-failed");
    }
    const invocation = buildPreflight(canary);
    let ownPolicy = false;
    let attested = false;
    let unexpected = false;
    const unsubscribe = session.on((event) => {
      const decision = decisionFor(event, invocation.id);
      if (!decision) return;
      if (decision.backend !== "seatbelt" || decision.platform !== "macos") unexpected = true;
      if (decision.kind === "policy_resolved") {
        ownPolicy =
          decision.policySource === "user_policy" &&
          decision.enforcementPoint === "shell" &&
          decision.allowBypass === false &&
          decision.gitAuth === false &&
          decision.ghAuth === false &&
          decision.keychainAccess === false;
      }
      if (decision.kind === "enforcement_state") {
        attested =
          decision.outcome === "engaged" &&
          decision.enforcementPoint === "shell" &&
          decision.attestation === "spawn_succeeded";
        if (!attested) unexpected = true;
      }
    });
    let cancelTimeout = () => {};
    try {
      authorize(invocation);
      const result = await Promise.race([
        session.rpc.tools.execute({
          name: "bash",
          arguments: { command: invocation.command, description: "Check sandbox", mode: "sync" },
          toolCallId: invocation.id,
        }),
        new Promise<undefined>((resolve) => {
          const timeout = setTimeout(resolve, probeTimeoutMs);
          cancelTimeout = () => clearTimeout(timeout);
        }),
      ]);
      if (!(await fileIsAbsent(canary))) return sandboxUnavailable("write-not-blocked");
      if (!result || typeof result === "string" || result.resultType !== "success") {
        return sandboxUnavailable("preflight-failed");
      }
      const output = preflightOutput(result.textResultForLlm, invocation.id);
      if (!output) return sandboxUnavailable("preflight-failed");
      if (output.write !== "blocked") return sandboxUnavailable("write-not-blocked");
      if (
        output.gitConfig !== "yes" ||
        output.names.some((name) => !shellEnvironmentNames.has(name))
      ) {
        return sandboxUnavailable("credential-environment");
      }
      if (!ownPolicy || !attested || unexpected) return sandboxUnavailable("sandbox-not-attested");
      return { kind: "confined", backend: "seatbelt" };
    } finally {
      cancelTimeout();
      authorize(undefined);
      unsubscribe();
    }
  } catch {
    return sandboxUnavailable("preflight-failed");
  } finally {
    await rm(canaryDir, { recursive: true, force: true });
  }
}
