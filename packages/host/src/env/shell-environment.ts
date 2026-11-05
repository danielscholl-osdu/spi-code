// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT
//
// Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { basename } from "node:path";

const pathStart = "__SPICODE_ENV_PATH_START__";
const pathEnd = "__SPICODE_ENV_PATH_END__";
const tokenNames = ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN"] as const;
type TokenName = (typeof tokenNames)[number];
type Failure = "failed" | "timeout" | "invalid-output" | "output-limit";

export interface LoginShellPathOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly shells?: readonly string[];
  readonly timeoutMs?: number;
}

export interface LoginShellPath {
  readonly path: string;
  readonly captured: boolean;
  readonly failures: readonly Failure[];
}

export interface ToolEnvironmentOptions {
  readonly toolsDir: string;
  readonly capturedPath: string;
  readonly kubeconfig: string;
  readonly azureConfigDir: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly configuredTokens?: Partial<Record<TokenName, string>>;
}

function isGuardBypass(name: string): boolean {
  return /(?:SKIP|BYPASS|DISABLE).*GUARD|GUARD.*(?:SKIP|BYPASS|DISABLE)/u.test(name.toUpperCase());
}

function scrubEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name, value]) => {
      const upper = name.toUpperCase();
      return (
        value !== undefined && !tokenNames.some((token) => upper === token) && !isGuardBypass(name)
      );
    }),
  );
}

function readPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  if (platform === "win32") {
    return Object.entries(env).find(([name]) => name.toUpperCase() === "PATH")?.[1];
  }
  return env.PATH ?? env.Path ?? env.path;
}

function mergePaths(platform: NodeJS.Platform, ...paths: (string | undefined)[]): string {
  const delimiter = platform === "win32" ? ";" : ":";
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (!path || /[\r\n\0]/u.test(path)) continue;
    for (const entry of path.split(delimiter)) {
      const trimmed = entry.trim();
      const value = platform === "win32" ? trimmed.replaceAll('"', "") : trimmed;
      const key = platform === "win32" ? value.toLowerCase() : value;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      entries.push(value);
    }
  }
  return entries.join(delimiter);
}

export function parseLoginShellPath(output: string): string | undefined {
  const start = output.indexOf(pathStart);
  if (start < 0) return undefined;
  const valueStart = start + pathStart.length;
  const end = output.indexOf(pathEnd, valueStart);
  if (end < 0) return undefined;
  const path = output
    .slice(valueStart, end)
    .replace(/^\r?\n/u, "")
    .replace(/\r?\n$/u, "");
  return path?.trim() && !/[\r\n\0]/u.test(path) ? path : undefined;
}

function captureCommand(shell: string): string {
  if (basename(shell).toLowerCase().startsWith("nu")) {
    const value =
      "if $env.PATH? == null { '' } else if " +
      "$env.ENV_CONVERSIONS?.PATH?.to_string? != null { " +
      "$env.PATH | do $env.ENV_CONVERSIONS.PATH.to_string $env.PATH " +
      "} else if ($env.PATH? | describe | str starts-with 'list') { " +
      "$env.PATH | each {|p| if ($p | str starts-with '~') { " +
      "$p | path expand --no-symlink } else { $p } } | str join (char esep) " +
      "} else { $env.PATH? | default '' }";
    return `print '${pathStart}'; print (${value}); print '${pathEnd}'`;
  }
  return `printf '%s\\n' '${pathStart}'; printenv PATH || true; printf '%s\\n' '${pathEnd}'`;
}

function loginShells(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  let userShell: string | undefined;
  try {
    userShell = userInfo().shell ?? undefined;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ERR_SYSTEM_ERROR") {
      throw new Error("Could not determine the login shell.");
    }
  }
  return [
    ...new Set(
      [env.SHELL, userShell, platform === "darwin" ? "/bin/zsh" : "/bin/bash"].flatMap((shell) =>
        shell?.trim() ? [shell.trim()] : [],
      ),
    ),
  ];
}

class CommandError extends Error {
  constructor(readonly reason: Failure) {
    super(`Environment command ${reason}.`);
  }
}

function commandOutput(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    return Promise.reject(new Error("Invalid command timeout."));
  }
  return new Promise((resolve, reject) => {
    const child = (() => {
      try {
        return spawn(command, args, {
          env,
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        // Node validation errors can include an environment value.
        throw new CommandError("failed");
      }
    })();
    let output = "";
    let bytes = 0;
    let settled = false;
    const terminate = () => {
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          // Kill the probe's group too: shell descendants can keep stdout open.
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") {
            child.kill("SIGKILL");
          }
        }
      } else {
        child.kill("SIGKILL");
      }
      child.stdout.destroy();
    };
    const fail = (reason: Failure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      output = "";
      terminate();
      reject(new CommandError(reason));
    };
    const timer = setTimeout(() => fail("timeout"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) {
        fail("output-limit");
      } else {
        output += chunk;
      }
    });
    child.stdout.on("error", () => fail("failed"));
    child.on("error", () => fail("failed"));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) return fail("failed");
      settled = true;
      clearTimeout(timer);
      resolve(output);
      output = "";
    });
  });
}

export async function captureLoginShellPath(
  options: LoginShellPathOptions = {},
): Promise<LoginShellPath> {
  const platform = options.platform ?? process.platform;
  const env = scrubEnvironment(options.env ?? process.env);
  const baseline =
    mergePaths(platform, readPath(env, platform)) || (platform === "win32" ? "" : "/usr/bin:/bin");
  const failures: Failure[] = [];
  if (platform === "win32") return { path: baseline, captured: false, failures };
  for (const shell of options.shells ?? loginShells(platform, env)) {
    try {
      const output = await commandOutput(
        shell,
        ["-ilc", captureCommand(shell)],
        env,
        options.timeoutMs ?? 5000,
      );
      const path = parseLoginShellPath(output);
      const captured = mergePaths(platform, path);
      if (captured) {
        return { path: mergePaths(platform, captured, baseline), captured: true, failures };
      }
      failures.push("invalid-output");
    } catch (error) {
      if (!(error instanceof CommandError)) throw error;
      failures.push(error.reason);
    }
  }
  return { path: baseline, captured: false, failures };
}

export function buildToolEnvironment(options: ToolEnvironmentOptions): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const env = scrubEnvironment(options.env ?? process.env);
  for (const name of Object.keys(env)) {
    if (["PATH", "KUBECONFIG", "AZURE_CONFIG_DIR"].includes(name.toUpperCase())) delete env[name];
  }
  env.PATH = mergePaths(platform, options.toolsDir, options.capturedPath);
  env.KUBECONFIG = options.kubeconfig;
  env.AZURE_CONFIG_DIR = options.azureConfigDir;
  for (const name of tokenNames) {
    const value = options.configuredTokens?.[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export async function ghAuthToken(
  env: NodeJS.ProcessEnv,
  options: { readonly timeoutMs?: number } = {},
): Promise<string> {
  let output: string;
  try {
    const toolEnv = Object.fromEntries(
      Object.entries(env).filter(([name]) => !isGuardBypass(name)),
    );
    output = await commandOutput("gh", ["auth", "token"], toolEnv, options.timeoutMs ?? 5000);
  } catch (error) {
    if (!(error instanceof CommandError)) throw error;
    throw new Error(
      error.reason === "timeout" ? "gh auth token timed out." : "gh auth token failed.",
    );
  }
  const token = output.trim();
  if (!token) throw new Error("gh auth token returned no token.");
  return token;
}
