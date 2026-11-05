// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

test("the packaged dist-only layout loads both installers and the exact pinned manifest", async () => {
  const exec = promisify(execFile);
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const stage = await mkdtemp(join(tmpdir(), "spi-tools-packaged-"));
  try {
    // pnpm is a .cmd shim on Windows, which only a shell can launch.
    await exec("pnpm", ["--filter", "@spi-code/tools", "build"], {
      cwd: root,
      shell: process.platform === "win32",
    });
    await cp(join(root, "packages/tools/dist"), join(stage, "dist"), { recursive: true });
    await writeFile(join(stage, "package.json"), '{"type":"module"}');
    const { stdout } = await exec(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { createToolInstaller } from "./dist/installer.js";
import { createWindowsGitInstaller } from "./dist/git/installer.js";
const tools = await createToolInstaller("./data", "darwin-arm64");
const git = await createWindowsGitInstaller("./data");
const { pinnedManifest } = await import("./dist/pinned-manifest.js");
console.log(JSON.stringify({
  manifest: pinnedManifest,
  tools: await Promise.all(["gh", "glab"].map(tool => tools.readiness(tool))),
  git: await git.readiness()
}));`,
      ],
      { cwd: stage },
    );
    expect(JSON.parse(stdout)).toEqual({
      manifest: JSON.parse(await readFile(join(root, "packages/tools/manifest.json"), "utf8")),
      tools: [{ state: "missing" }, { state: "missing" }],
      git: { state: "missing" },
    });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}, 30_000);
