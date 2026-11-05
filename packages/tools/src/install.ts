// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT
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

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, lstat, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

export interface ToolManifestEntry {
  tool: string;
  version: string;
  platforms: Record<string, { url: string; sha256: string; executable: string }>;
}

const run = promisify(execFile);
const safeArchivePath = (path: string) =>
  !path.includes("\\") &&
  !path.startsWith("/") &&
  path
    .replace(/\/$/, "")
    .split("/")
    .every((part) => part && part !== "." && part !== ".." && !part.includes(":"));

export async function installTool(
  entry: ToolManifestEntry,
  toolsDirectory: string,
  platform: string = process.platform,
  arch: string = process.arch,
): Promise<string> {
  const asset = entry.platforms[`${platform}-${arch}`];
  if (!asset) throw new Error(`Unsupported platform: ${entry.tool} on ${platform}-${arch}`);
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry.tool) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry.version) ||
    !/^[a-f0-9]{64}$/i.test(asset.sha256) ||
    !safeArchivePath(asset.executable)
  ) {
    throw new Error("Invalid tool manifest entry");
  }
  await mkdir(resolve(toolsDirectory), { recursive: true });
  const tools = await realpath(resolve(toolsDirectory));
  const destination = join(tools, `${entry.tool}-${entry.version}`);
  if (
    await lstat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    })
  )
    throw new Error(`Installation already exists: ${destination}`);
  const staging = await mkdtemp(join(tools, ".install-"));
  try {
    const archive = join(staging, "download.tar.gz");
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok || !response.body) {
      throw new Error(`Download failed: HTTP ${response.status} (${asset.url})`);
    }
    const hash = createHash("sha256");
    const reader = response.body.getReader();
    async function* chunks() {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          hash.update(value);
          yield value;
        }
      } finally {
        reader.releaseLock();
      }
    }
    await pipeline(chunks(), createWriteStream(archive, { flags: "wx", mode: 0o600 }));
    if (hash.digest("hex") !== asset.sha256.toLowerCase()) {
      throw new Error(`SHA-256 mismatch for ${entry.tool}; nothing installed`);
    }
    const entries = (await run("tar", ["-tzf", archive])).stdout.trim().split(/\r?\n/);
    const types = (await run("tar", ["-tvzf", archive])).stdout.trim().split(/\r?\n/);
    if (
      entries.length > 10_000 ||
      entries.length !== types.length ||
      entries.some((path) => !safeArchivePath(path)) ||
      types.some((line) => !["-", "d"].includes(line[0] ?? ""))
    ) {
      throw new Error("The tool archive contains unsafe entries");
    }
    const runtime = join(staging, "runtime");
    await mkdir(runtime);
    await run("tar", ["-xzf", archive, "-C", runtime]);
    const executable = join(runtime, asset.executable);
    const resolved = await realpath(executable);
    const path = relative(runtime, resolved);
    if (
      isAbsolute(path) ||
      path === ".." ||
      path.startsWith(`..${sep}`) ||
      !(await lstat(resolved)).isFile()
    ) {
      throw new Error("The tool archive has no safe executable");
    }
    await access(executable, 0o1);
    await rename(runtime, destination);
    return join(destination, asset.executable);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
