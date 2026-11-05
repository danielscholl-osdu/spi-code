// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { type Readiness, ToolInstaller } from "../installer.js";
import { isVersion } from "../manifest.js";

export type Runner = (
  command: string,
  args: string[],
  signal?: AbortSignal,
) => Promise<{ code: number; stdout: string }>;
const exec = promisify(execFile);
export const run: Runner = async (command, args, signal) => {
  try {
    const result = await exec(command, args, { signal, windowsHide: true });
    return { code: 0, stdout: result.stdout };
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      if (typeof error.code === "number") return { code: error.code, stdout: "" };
      if (error.code === "ENOENT") return { code: 127, stdout: "" };
    }
    throw error;
  }
};

interface GitAsset {
  url: string;
  sha256: string;
}
export interface GitPin {
  version: string;
  portable: GitAsset;
  minimal: GitAsset;
}

export async function createWindowsGitInstaller(appData: string): Promise<WindowsGitInstaller> {
  const manifest: { git: GitPin } = JSON.parse(
    await readFile(new URL("../../manifest.json", import.meta.url), "utf8"),
  );
  return new WindowsGitInstaller(appData, manifest.git);
}

export class WindowsGitInstaller {
  private readonly installers: [ToolInstaller, ToolInstaller];
  private current: ToolInstaller;
  private state: Readiness | undefined;

  constructor(appData: string, pin: GitPin, runner: Runner = run) {
    if (!isVersion(pin.version)) throw new Error("Invalid Git version");
    const create = (asset: GitAsset, portable: boolean) => {
      if (!asset || !new URL(asset.url).pathname.endsWith(portable ? ".7z.exe" : ".zip"))
        throw new Error("Invalid Git archive");
      const manifest = {
        tools: [
          {
            tool: "git",
            version: pin.version,
            platforms: { "darwin-arm64": asset, "win32-x64": asset },
          },
        ],
      };
      const installer = new ToolInstaller(appData, manifest, "win32-x64", undefined, {
        binDirectory: "cmd",
        populate: async (archive, payload, signal) => {
          const command = portable
            ? archive
            : join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
          const args = portable ? ["-y", `-o${payload}`] : ["-xf", archive, "-C", payload];
          const result = await runner(command, args, signal);
          if (result.code !== 0) throw new Error(`Git extraction exited ${result.code}`);
        },
      });
      return installer;
    };
    this.installers = [create(pin.portable, true), create(pin.minimal, false)];
    this.current = this.installers[0];
  }

  async binDir(): Promise<string | undefined> {
    return this.current.binDir("git");
  }
  async readiness(): Promise<Readiness> {
    return this.state ?? this.current.readiness("git");
  }
  async install(signal?: AbortSignal): Promise<void> {
    if (this.state?.state === "installing") throw new Error("Git install already running");
    this.state = { state: "installing" };
    const failures: unknown[] = [];
    for (const installer of this.installers) {
      try {
        await installer.install("git", signal);
        this.current = installer;
        this.state = undefined;
        return;
      } catch (error) {
        failures.push(error);
        if (signal?.aborted) break;
      }
    }
    const details = failures.map((error) =>
      error instanceof Error ? error.message : String(error),
    );
    const error = new AggregateError(
      failures,
      `PortableGit and MinGit installation failed: ${details.join("; ")}`,
    );
    this.state = { state: "failed", error: error.message };
    throw error;
  }
}

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
export class MacGitInstaller {
  private state: Readiness | undefined;
  constructor(
    private readonly runner: Runner = run,
    private readonly clock: Clock = {
      now: Date.now,
      sleep: async (ms, signal) => {
        await setTimeout(ms, undefined, { signal });
      },
    },
    private readonly deadlineMs = 15 * 60_000,
  ) {
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new Error("Invalid Git deadline");
  }
  private async probe(signal?: AbortSignal): Promise<Readiness | undefined> {
    const result = await this.runner("git", ["--version"], signal);
    const version = result.stdout.trim().match(/^git version (\d+\.\d+\.\d+)(?:\s|\.|$)/)?.[1];
    return result.code === 0 && version ? { state: "ready", version } : undefined;
  }
  async readiness(signal?: AbortSignal): Promise<Readiness> {
    if (this.state?.state === "installing") return this.state;
    const ready = await this.probe(signal);
    if (ready) {
      if (this.state?.state === "failed") this.state = undefined;
      return ready;
    }
    return this.state ?? { state: "missing" };
  }
  async install(signal?: AbortSignal): Promise<void> {
    if (this.state?.state === "installing") throw new Error("Git install already running");
    this.state = { state: "installing" };
    const bounded = AbortSignal.any([
      AbortSignal.timeout(this.deadlineMs),
      ...(signal ? [signal] : []),
    ]);
    const end = this.clock.now() + this.deadlineMs;
    try {
      bounded.throwIfAborted();
      if (await this.probe(bounded)) {
        bounded.throwIfAborted();
        this.state = undefined;
        return;
      }
      await this.runner("xcode-select", ["--install"], bounded);
      bounded.throwIfAborted();
      while (this.clock.now() < end) {
        bounded.throwIfAborted();
        const ready = await this.probe(bounded);
        bounded.throwIfAborted();
        if (ready) {
          this.state = undefined;
          return;
        }
        if (this.clock.now() >= end) break;
        await this.clock.sleep(Math.min(1000, end - this.clock.now()), bounded);
      }
      throw new Error("Timed out waiting for Command Line Tools Git");
    } catch (error) {
      this.state = {
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  }
}
