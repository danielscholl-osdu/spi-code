// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type Exec,
  type ExecOptions,
  type ExecOutput,
  type ExecResult,
  jsonResult,
  redact,
  textResult,
} from "@spi-code/core";
import {
  createManagedToolEnvironment,
  type ManagedToolEnvironmentOptions,
} from "../env/tool-environment.js";

export interface HostExecLog {
  cmd: string;
  args: string[];
  stderr: string;
  exit: number | null;
  error?: string;
}

export interface HostExecOptions extends Omit<ManagedToolEnvironmentOptions, "platform"> {
  log?: (entry: HostExecLog) => void;
}

async function killTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    await promisify(execFile)(taskkill, ["/pid", String(pid), "/T", "/F"], { timeout: 5000 });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

export class HostExec implements Exec {
  constructor(private readonly options: HostExecOptions) {}

  async runText(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult<string>> {
    return textResult(await this.run(cmd, args, opts), opts);
  }

  async runJSON<T = unknown>(
    cmd: string,
    args: string[],
    opts: ExecOptions = {},
  ): Promise<ExecResult<T>> {
    return jsonResult<T>(await this.runText(cmd, args, opts));
  }

  // Can also be passed to core's RecordingExec.
  readonly run = async (
    cmd: string,
    args: string[],
    opts: ExecOptions = {},
  ): Promise<ExecOutput> => {
    const inherited = { ...(this.options.env ?? process.env), ...opts.env };
    const secrets = Object.fromEntries(
      Object.entries(inherited).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const safe = (text: string) => redact(text, secrets);
    const timeoutMs = opts.timeoutMs ?? 30_000;
    let output: ExecOutput;
    try {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
        throw new Error("Invalid command timeout.");
      }
      const env = await createManagedToolEnvironment({ ...this.options, env: inherited });
      output = await new Promise<ExecOutput>((resolve) => {
        const child = spawn(cmd, args, {
          env,
          cwd: opts.cwd,
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let error: string | undefined;
        let termination: Promise<void> | undefined;
        const fail = (message: string) => {
          error ??= safe(message);
          if (child.pid !== undefined && termination === undefined) {
            termination = killTree(child.pid).catch((failure: unknown) => {
              error = `${error} Process-tree termination failed: ${safe(String(failure))}`;
              child.kill("SIGKILL");
              child.stdout.destroy();
              child.stderr.destroy();
            });
          }
        };
        const timer = setTimeout(() => fail(`Command timed out after ${timeoutMs}ms.`), timeoutMs);
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.stdout.on("error", (failure) => fail(failure.message));
        child.stderr.on("error", (failure) => fail(failure.message));
        child.stdin.on("error", (failure: NodeJS.ErrnoException) => {
          if (failure.code !== "EPIPE") fail(failure.message);
        });
        child.on("error", (failure) => {
          error = safe(failure.message);
        });
        child.on("close", async (exit) => {
          clearTimeout(timer);
          await termination;
          resolve({
            stdout,
            stderr: safe(stderr),
            exit,
            ...(error === undefined ? {} : { error }),
          });
        });
        child.stdin.end(opts.stdin);
      });
    } catch (error) {
      output = { stdout: "", stderr: "", exit: null, error: safe(String(error)) };
    }
    this.options.log?.({
      cmd: safe(cmd),
      args: args.map(safe),
      stderr: safe(output.stderr),
      exit: output.exit,
      ...(output.error === undefined ? {} : { error: safe(output.error) }),
    });
    return output;
  };
}
