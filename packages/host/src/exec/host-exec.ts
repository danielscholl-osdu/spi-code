// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFile, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type Exec,
  type ExecOptions,
  type ExecOutput,
  type ExecResult,
  execOutputDelivery,
  execRedactor,
  jsonResult,
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

const PIPE_GRACE_MS = 1000;

async function killTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    try {
      await promisify(execFile)(taskkill, ["/pid", String(pid), "/T", "/F"], { timeout: 5000 });
    } catch (error) {
      // 128: the process exited on its own before taskkill reached it.
      if (!(error instanceof Error) || !("code" in error) || error.code !== 128) throw error;
    }
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
    const safe = execRedactor(opts, secrets);
    const timeoutMs = opts.timeoutMs ?? 30_000;
    let output: ExecOutput;
    try {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
        throw new Error("Invalid command timeout.");
      }
      if (opts.signal?.aborted) throw new Error("Command aborted.");
      const env = await createManagedToolEnvironment({ ...this.options, env: inherited });
      await Promise.all([
        mkdir(join(this.options.appData, "kube"), { recursive: true }),
        mkdir(join(this.options.appData, "azure"), { recursive: true }),
      ]);
      if (opts.signal?.aborted) throw new Error("Command aborted.");
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
        let spawnFailed = false;
        let interrupted = false;
        let settled = false;
        let termination: Promise<void> | undefined;
        const delivery = execOutputDelivery(opts, secrets);
        const finish = (exit: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", abort);
          try {
            delivery.finish(interrupted ? "interrupted" : undefined);
          } catch (failure) {
            error ??= safe(String(failure));
          }
          resolve({
            // An interrupted command's output is cut, so it leaves the same snapshot it delivered.
            stdout: interrupted ? delivery.snapshot(stdout) : stdout,
            stderr: interrupted ? delivery.snapshot(stderr) : safe(stderr),
            exit: spawnFailed ? null : exit,
            ...(error === undefined ? {} : { error }),
            ...(interrupted ? { snapshot: true as const } : {}),
          });
        };
        const fail = (message: string) => {
          interrupted = true;
          error ??= safe(message);
          if (child.pid !== undefined && termination === undefined) {
            termination = killTree(child.pid)
              .catch((failure: unknown) => {
                error = `${error} Process-tree termination failed: ${safe(String(failure))}`;
                child.kill("SIGKILL");
              })
              .then(() => {
                // A descendant outside the process group can still hold the pipes open,
                // so the result cannot wait for them to close.
                child.stdout.destroy();
                child.stderr.destroy();
                setTimeout(() => finish(child.exitCode), PIPE_GRACE_MS).unref();
              });
          }
        };
        const timer = setTimeout(() => {
          fail(`Command timed out after ${timeoutMs}ms.`);
        }, timeoutMs);
        const abort = () => fail("Command aborted.");
        opts.signal?.addEventListener("abort", abort, { once: true });
        if (opts.signal?.aborted) abort();
        const deliver = (stream: "stdout" | "stderr", chunk: string) => {
          try {
            delivery.push(stream, chunk);
          } catch (failure) {
            fail(String(failure));
          }
        };
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          stdout += chunk;
          deliver("stdout", chunk);
        });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
          stderr += chunk;
          deliver("stderr", chunk);
        });
        child.stdout.on("error", (failure) => fail(failure.message));
        child.stderr.on("error", (failure) => fail(failure.message));
        child.stdin.on("error", (failure: NodeJS.ErrnoException) => {
          if (failure.code !== "EPIPE") fail(failure.message);
        });
        child.on("error", (failure) => {
          if (child.pid === undefined) spawnFailed = true;
          error ??= safe(failure.message);
        });
        child.on("close", async (exit) => {
          clearTimeout(timer);
          await termination;
          finish(exit);
        });
        child.stdin.end(opts.stdin);
      });
    } catch (error) {
      output = {
        stdout: "",
        stderr: "",
        exit: null,
        error: safe(error instanceof Error ? error.message : String(error)),
      };
    }
    this.options.log?.({
      cmd: safe(cmd),
      args: args.map(safe),
      stderr: output.stderr,
      exit: output.exit,
      ...(output.error === undefined ? {} : { error: output.error }),
    });
    return output;
  };
}
