// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isVersion, parseManifest, type ToolPin, type ToolPlatform } from "./manifest.js";

const exec = promisify(execFile);
export type Readiness =
  | { state: "missing" }
  | { state: "installing" }
  | { state: "ready" | "needs-update"; version: string }
  | { state: "failed"; error: string };
export type Extractor = (archive: string, binary: string, signal?: AbortSignal) => Promise<Buffer>;

export const extractBinary: Extractor = async (archive, binary, signal) => {
  const { stdout } = await exec("tar", ["-tf", archive], { signal });
  const entries = stdout
    .split(/\r?\n/)
    .filter(
      (entry) => entry === binary || entry === `bin/${binary}` || entry.endsWith(`/bin/${binary}`),
    );
  const entry = entries[0];
  if (entries.length !== 1 || !entry || entry.startsWith("-") || entry.split("/").includes("..")) {
    throw new Error(`Archive must contain exactly one ${binary} executable`);
  }
  // Extract only the executable to stdout: archive paths never become filesystem writes.
  const result = await exec("tar", ["-xOf", archive, entry], {
    signal,
    encoding: "buffer",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (!result.stdout.length) throw new Error(`Archive executable ${binary} is empty`);
  return result.stdout;
};

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function createToolInstaller(
  appData: string,
  platform?: string,
): Promise<ToolInstaller> {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  return new ToolInstaller(appData, manifest, platform);
}

export class ToolInstaller {
  private readonly states = new Map<string, Readiness>();
  private readonly active = new Set<string>();
  private readonly pins: ToolPin[];
  readonly platform: ToolPlatform;

  constructor(
    readonly appData: string,
    manifest: unknown,
    platform = `${process.platform}-${process.arch}`,
    private readonly extract: Extractor = extractBinary,
  ) {
    if (platform !== "darwin-arm64" && platform !== "win32-x64") {
      throw new Error(`Unsupported tool platform: ${platform}`);
    }
    this.platform = platform;
    this.pins = parseManifest(manifest);
  }

  private pin(tool: string): ToolPin {
    const pin = this.pins.find((pin) => pin.tool === tool);
    if (!pin) throw new Error(`Unknown tool: ${tool}`);
    return pin;
  }

  private root(tool: string): string {
    this.pin(tool);
    return join(this.appData, "tools", tool);
  }

  private async version(tool: string): Promise<string | undefined> {
    const current = join(this.root(tool), "current");
    try {
      const version =
        this.platform === "win32-x64"
          ? (await readFile(current, "utf8")).trim()
          : await readlink(current);
      if (!isVersion(version)) throw new Error(`Invalid current pointer for ${tool}`);
      await access(join(this.root(tool), version, "bin", this.binary(tool)));
      return version;
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }

  private binary(tool: string): string {
    return `${tool}${this.platform === "win32-x64" ? ".exe" : ""}`;
  }

  async binDir(tool: string): Promise<string | undefined> {
    const version = await this.version(tool);
    return version ? join(this.root(tool), version, "bin") : undefined;
  }

  async readiness(tool: string): Promise<Readiness> {
    const pin = this.pin(tool);
    const state = this.states.get(tool);
    if (state) return state;
    const version = await this.version(tool);
    return version
      ? { state: version === pin.version ? "ready" : "needs-update", version }
      : { state: "missing" };
  }

  async install(tool: string, signal?: AbortSignal): Promise<void> {
    const pin = this.pin(tool);
    if (this.active.has(tool)) throw new Error(`Install already running for ${tool}`);
    this.active.add(tool);
    this.states.set(tool, { state: "installing" });
    let staging: string | undefined;
    let pointer: string | undefined;
    try {
      await mkdir(this.appData, { recursive: true });
      staging = await mkdtemp(join(this.appData, ".install-"));
      const asset = pin.platforms[this.platform];
      const archive = join(
        staging,
        new URL(asset.url).pathname.endsWith(".zip") ? "archive.zip" : "archive.tar.gz",
      );
      const hash = createHash("sha256");
      const url = new URL(asset.url);
      const response =
        url.protocol === "file:" ? undefined : await fetch(url, { signal: signal ?? null });
      if (response && (!response.ok || !response.body))
        throw new Error(`Download failed: HTTP ${response.status}`);
      const body = response?.body;
      const source = body
        ? Readable.from(
            (async function* () {
              const reader = body.getReader();
              try {
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done) return;
                  yield value;
                }
              } finally {
                reader.releaseLock();
              }
            })(),
          )
        : createReadStream(fileURLToPath(url));
      await pipeline(
        source,
        new Transform({
          transform(chunk, _encoding, callback) {
            hash.update(chunk);
            callback(null, chunk);
          },
        }),
        createWriteStream(archive),
        { signal },
      );
      if (hash.digest("hex") !== asset.sha256) throw new Error(`SHA-256 mismatch for ${tool}`);
      const payload = join(staging, "payload");
      await mkdir(join(payload, "bin"), { recursive: true });
      const binary = await this.extract(archive, this.binary(tool), signal);
      await writeFile(join(payload, "bin", this.binary(tool)), binary, { mode: 0o755 });
      signal?.throwIfAborted();
      const root = this.root(tool);
      await mkdir(root, { recursive: true });
      const target = join(root, pin.version);
      try {
        await rename(payload, target);
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            ["EEXIST", "ENOTEMPTY"].includes(String(error.code))
          )
        )
          throw error;
        const existing = await readFile(join(target, "bin", this.binary(tool)));
        if (!existing.equals(binary))
          throw new Error(`Installed ${tool} ${pin.version} differs from verified archive`);
      }
      pointer = join(root, `.current-${staging.split(/[\\/]/).pop()}`);
      if (this.platform === "win32-x64") await writeFile(pointer, pin.version);
      else await symlink(pin.version, pointer);
      signal?.throwIfAborted();
      await rename(pointer, join(root, "current"));
      this.states.delete(tool);
    } catch (error) {
      this.states.set(tool, {
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.active.delete(tool);
      if (pointer) await rm(pointer, { force: true });
      if (staging) await rm(staging, { recursive: true, force: true });
    }
  }
}
