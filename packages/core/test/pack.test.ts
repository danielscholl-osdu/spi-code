// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const core = fileURLToPath(new URL("../", import.meta.url));
const shell = process.platform === "win32";
const npm = shell ? "npm.cmd" : "npm";
const arg = (value: string) => (shell && /\s/.test(value) ? `"${value}"` : value);

it("packs a pinned, source-free tarball that installs outside the workspace", async (test) => {
  const temporary = await mkdtemp(join(tmpdir(), "spi-core-pack-test-"));
  try {
    const release = join(temporary, "release");
    const packed = await exec(process.execPath, ["scripts/pack.mjs", release], {
      cwd: core,
      timeout: 120_000,
    });
    const tarball = join(release, "spi-code-core-0.1.0.tgz");
    const sha256 = createHash("sha256")
      .update(await readFile(tarball))
      .digest("hex");
    expect(packed.stdout).toContain(`${sha256}  ${tarball}`);
    const { stdout: listing } = await exec("tar", ["-tzf", tarball]);
    const entries = listing.trim().split("\n");
    expect(entries).toContain("package/dist/index.js");
    expect(entries).toContain("package/dist/index.d.ts");
    expect(entries).toContain("package/LICENSE");
    expect(entries).toContain("package/README.md");
    expect(entries.filter((entry) => /\/(?:src|test|fixtures)\//.test(entry))).toEqual([]);
    expect(entries.filter((entry) => /\.test\.|\.map$/.test(entry))).toEqual([]);
    const { stdout: manifest } = await exec("tar", ["-xOzf", tarball, "package/package.json"]);
    const pkg = JSON.parse(manifest);
    expect(pkg.version).toBe("0.1.0");
    expect(pkg.dependencies).toEqual({ yaml: "2.9.1", zod: "4.6.7" });
    expect(pkg.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    });

    try {
      await exec(
        npm,
        ["view", "yaml@2.9.1", "version", "--fetch-retries=0", "--fetch-timeout=5000"],
        { cwd: temporary, timeout: 10_000, shell },
      );
    } catch (error) {
      test.skip(`npm registry unreachable; isolated tarball install not run: ${String(error)}`);
    }
    await exec(
      npm,
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--fetch-retries=0",
        "--fetch-timeout=15000",
        "--cache",
        arg(join(temporary, "cache")),
        arg(tarball),
      ],
      { cwd: temporary, timeout: 60_000, shell },
    );
    expect(await realpath(join(temporary, "node_modules/@spi-code/core"))).toBe(
      join(await realpath(temporary), "node_modules/@spi-code/core"),
    );
    const installed = JSON.parse(
      await readFile(join(temporary, "node_modules/@spi-code/core/package.json"), "utf8"),
    );
    expect(installed.version).toBe("0.1.0");
    await exec(
      process.execPath,
      [
        "-e",
        "import('@spi-code/core').then(m=>{if(typeof m.buildBriefing!=='function')process.exit(1)})",
      ],
      { cwd: temporary, env: { ...process.env, NODE_PATH: "" }, timeout: 10_000 },
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 180_000);
