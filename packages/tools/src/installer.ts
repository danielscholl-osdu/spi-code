// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, type Dirent } from "node:fs";
import {
  access,
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isVersion, parseManifest, type ToolPin, type ToolPlatform } from "./manifest.js";
import { pinnedManifest } from "./pinned-manifest.js";

const exec = promisify(execFile);
// GNU tar from Git or MSYS can come first on a Windows PATH and cannot read C:\ paths or zips.
const tar =
  process.platform === "win32"
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";
export type Readiness =
  | { state: "missing" }
  | { state: "installing" }
  | { state: "ready" | "needs-update"; version: string }
  | { state: "failed"; error: string };
export type Extractor = (archive: string, binary: string, signal?: AbortSignal) => Promise<Buffer>;
export interface PayloadOptions {
  binDirectory: "cmd";
  populate: (archive: string, payload: string, signal?: AbortSignal) => Promise<void>;
}

export const extractBinary: Extractor = async (archive, binary, signal) => {
  const { stdout } = await exec(tar, ["-tf", archive], { signal });
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
  const result = await exec(tar, ["-xOf", archive, entry], {
    signal,
    encoding: "buffer",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (!result.stdout.length) throw new Error(`Archive executable ${binary} is empty`);
  return result.stdout;
};

// A pointer that is missing, a regular file or directory where a symlink belongs (EINVAL, EISDIR),
// or leads into a symlink loop (ELOOP) or through a file (ENOTDIR) means the tool is not installed.
function torn(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ["ENOENT", "EINVAL", "EISDIR", "ELOOP", "ENOTDIR"].includes(String(error.code))
  );
}

// Flush before the caller renames, so a power loss cannot leave an empty file in place.
async function writeDurable(path: string, data: string | Buffer, mode?: number): Promise<void> {
  const handle = await open(path, "w", mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

type FileOpener = (path: string, flags: "r" | "r+") => Promise<Pick<FileHandle, "sync" | "close">>;

export async function flushPayloadFile(
  path: string,
  platform: string = process.platform,
  opener: FileOpener = open,
): Promise<void> {
  async function sync(flags: "r" | "r+"): Promise<void> {
    const handle = await opener(path, flags);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  if (platform !== "win32") {
    try {
      await sync("r");
      return;
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          (error.code === "EPERM" || error.code === "EACCES")
        )
      )
        throw error;
    }
  }
  // FlushFileBuffers needs write access on Windows. Temporarily lift read-only
  // permissions, then restore them even if opening or flushing the file fails.
  const mode = (await stat(path)).mode & 0o7777;
  const readOnly = (mode & 0o200) === 0;
  try {
    if (readOnly) await chmod(path, mode | 0o200);
    await sync("r+");
  } finally {
    if (readOnly) await chmod(path, mode);
  }
}

export async function createToolInstaller(
  appData: string,
  platform?: string,
): Promise<ToolInstaller> {
  return new ToolInstaller(appData, pinnedManifest, platform);
}

// A recent entry may belong to another process still downloading or extracting.
const staleAfterMs = 24 * 60 * 60_000;

async function reclaimStale(
  directory: string,
  matches: (name: string) => boolean,
  cutoff: number,
  descend: (path: string) => boolean = () => false,
): Promise<void> {
  // Reclaim is best effort: a locked or unreadable leftover must never block an install.
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    try {
      if (matches(entry.name)) {
        // lstat ages the temporary symlink itself, never its installed target.
        if ((await lstat(path)).mtimeMs < cutoff) {
          await rm(path, { recursive: entry.isDirectory(), force: true });
        }
      } else if (entry.isDirectory() && descend(path)) {
        await reclaimStale(path, matches, cutoff, descend);
      }
    } catch {
      // Leave it for a later install to retry.
    }
  }
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
    private readonly payloadOptions?: PayloadOptions,
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
      // A torn or foreign pointer reads as missing, so Setup offers Install and reinstall repairs it.
      if (!isVersion(version)) return undefined;
      await access(join(this.root(tool), version, this.binDirectory(), this.binary(tool)));
      return version;
    } catch (error) {
      if (torn(error)) return undefined;
      throw error;
    }
  }

  private binary(tool: string): string {
    return `${tool}${this.platform === "win32-x64" ? ".exe" : ""}`;
  }

  private binDirectory(): string {
    return this.payloadOptions?.binDirectory ?? "bin";
  }

  async binDir(tool: string): Promise<string | undefined> {
    const version = await this.version(tool);
    return version ? join(this.root(tool), version, this.binDirectory()) : undefined;
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
      const cutoff = Date.now() - staleAfterMs;
      const stagingName = new RegExp(`^\\.install-(?:${tool}-)?[A-Za-z0-9]{6}$`);
      await reclaimStale(this.appData, (name) => stagingName.test(name), cutoff);
      await reclaimStale(this.root(tool), (name) => name.startsWith(".current-"), cutoff);
      staging = await mkdtemp(join(this.appData, `.install-${tool}-`));
      const asset = pin.platforms[this.platform];
      const archive = join(
        staging,
        new URL(asset.url).pathname.endsWith(".exe")
          ? "archive.exe"
          : new URL(asset.url).pathname.endsWith(".zip")
            ? "archive.zip"
            : "archive.tar.gz",
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
      await mkdir(join(payload, this.binDirectory()), { recursive: true });
      if (this.payloadOptions) {
        await this.payloadOptions.populate(archive, payload, signal);
      } else {
        const binary = await this.extract(archive, this.binary(tool), signal);
        await writeDurable(join(payload, "bin", this.binary(tool)), binary, 0o755);
      }
      await access(join(payload, this.binDirectory(), this.binary(tool)));
      const files: string[] = [];
      async function flush(directory: string, prefix = ""): Promise<void> {
        signal?.throwIfAborted();
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          signal?.throwIfAborted();
          const relative = join(prefix, entry.name);
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await flush(path, relative);
          else if (entry.isFile()) {
            await flushPayloadFile(path);
            files.push(relative);
          } else throw new Error(`Unsupported payload entry: ${relative}`);
        }
      }
      await flush(payload);
      signal?.throwIfAborted();
      const root = this.root(tool);
      await mkdir(root, { recursive: true });
      const target = join(root, pin.version);
      const repairDirectories = new Set([target]);
      for (const file of files) {
        for (
          let directory = dirname(join(target, file));
          directory !== target;
          directory = dirname(directory)
        ) {
          repairDirectories.add(directory);
        }
      }
      await reclaimStale(
        root,
        (name) => name.startsWith(".repair-"),
        cutoff,
        (path) => repairDirectories.has(path),
      );
      try {
        await rename(payload, target);
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            // Windows reports a directory rename onto an existing directory as EPERM or EACCES.
            ["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(String(error.code))
          )
        )
          throw error;
        for (const file of files) {
          signal?.throwIfAborted();
          const binary = await readFile(join(payload, file));
          const existing = await readFile(join(target, file)).catch(() => undefined);
          if (!existing?.equals(binary)) {
            // The installed copy is damaged. Swap in the binary that just passed SHA-256 with a
            // file rename, so `current` never points at a missing directory, even after a crash.
            const bin = join(target, file, "..");
            await mkdir(bin, { recursive: true });
            const repair = join(bin, `.repair-${staging.split(/[\\/]/).pop()}`);
            try {
              await writeDurable(repair, binary, 0o755);
              signal?.throwIfAborted();
              await rename(repair, join(target, file));
            } finally {
              await rm(repair, { force: true });
            }
          }
        }
      }
      pointer = join(root, `.current-${staging.split(/[\\/]/).pop()}`);
      if (this.platform === "win32-x64") await writeDurable(pointer, pin.version);
      else await symlink(pin.version, pointer);
      signal?.throwIfAborted();
      const current = join(root, "current");
      // A file rename cannot replace a directory, so a torn directory pointer is removed first.
      if ((await lstat(current).catch(() => undefined))?.isDirectory()) {
        await rm(current, { recursive: true, force: true });
      }
      await rename(pointer, current);
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
