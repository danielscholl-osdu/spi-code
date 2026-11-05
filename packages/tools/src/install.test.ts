// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { installTool, type ToolManifestEntry } from "./install.js";
import { installEnvironment, resolveInside } from "./install-probe.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(unsafe = false) {
  const scratch = await mkdtemp(join(tmpdir(), "spi-install-test-"));
  cleanups.push(() => rm(scratch, { recursive: true, force: true }));
  const source = join(scratch, "source");
  await mkdir(join(source, "fixture"), { recursive: true });
  await writeFile(join(source, "fixture", "tool"), "#!/bin/sh\nprintf 'fixture 1.0\\n'\n", {
    mode: 0o755,
  });
  if (unsafe) await symlink("/etc/passwd", join(source, "fixture", "escape"));
  const archive = join(scratch, "fixture.tar.gz");
  await promisify(execFile)("tar", ["-czf", archive, "-C", source, "fixture"]);
  const bytes = await readFile(archive);
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture server address");
  const entry: ToolManifestEntry = {
    tool: "fixture",
    version: "1.0",
    platforms: {
      [`${process.platform}-${process.arch}`]: {
        url: `http://127.0.0.1:${address.port}/fixture.tar.gz`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        executable: "fixture/tool",
      },
    },
  };
  return { scratch, entry, requests: () => requests };
}

test("checksum mismatch refuses installation and leaves tools empty", async () => {
  const { scratch, entry } = await fixture();
  const asset = entry.platforms[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error("Missing fixture asset");
  asset.sha256 = "0".repeat(64);
  const tools = join(scratch, "tools");
  await expect(installTool(entry, tools)).rejects.toThrow("SHA-256 mismatch");
  expect(await readdir(tools)).toEqual([]);
});

test("unknown platform errors before downloading or creating tools", async () => {
  const { scratch, entry, requests } = await fixture();
  await expect(installTool(entry, join(scratch, "tools"), "unknown", "unknown")).rejects.toThrow(
    "Unsupported platform",
  );
  expect(requests()).toBe(0);
  expect(await readdir(scratch)).not.toContain("tools");
});

test("verified local archive installs a runnable executable and removes staging", async () => {
  const { scratch, entry } = await fixture();
  const tools = join(scratch, "tools");
  const binary = await installTool(entry, tools);
  expect(binary).toBe(await realpath(join(tools, "fixture-1.0", "fixture", "tool")));
  expect((await promisify(execFile)(binary)).stdout).toBe("fixture 1.0\n");
  expect(await readdir(tools)).toEqual(["fixture-1.0"]);
});

test("archive symlinks are refused before extraction", async () => {
  const { scratch, entry } = await fixture(true);
  const tools = join(scratch, "tools");
  await expect(installTool(entry, tools)).rejects.toThrow("unsafe entries");
  expect(await readdir(tools)).toEqual([]);
});

test("probe environment owns all installer stores; real paths cannot escape scratch", async () => {
  const { scratch } = await fixture();
  const env = installEnvironment(scratch);
  for (const key of [
    "UV_PYTHON_INSTALL_DIR",
    "UV_TOOL_DIR",
    "UV_TOOL_BIN_DIR",
    "UV_CACHE_DIR",
    "AZURE_CONFIG_DIR",
  ]) {
    expect(env[key]).toBe(join(scratch, key === "AZURE_CONFIG_DIR" ? "azure" : key.toLowerCase()));
  }
  const outside = await mkdtemp(join(tmpdir(), "spi-install-outside-"));
  cleanups.push(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "binary"), "");
  await symlink(join(outside, "binary"), join(scratch, "escape"));
  await expect(resolveInside(scratch, join(scratch, "escape"))).rejects.toThrow("outside scratch");
  await expect(resolveInside(scratch, scratch)).rejects.toThrow("outside scratch");
  expect(await resolveInside(scratch, join(scratch, "source", "fixture", "tool"))).toBe(
    await realpath(join(scratch, "source", "fixture", "tool")),
  );
});
