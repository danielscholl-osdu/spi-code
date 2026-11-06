// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ExecFileOptions, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);
async function exec(file: string, args: string[], options: ExecFileOptions & { timeout: number }) {
  const execution = execFileAsync(file, args, { ...options, encoding: "utf8" });
  const closed = new Promise<void>((resolve) => {
    execution.child.once("close", () => resolve());
  });
  try {
    return await execution;
  } finally {
    await closed;
  }
}
const core = fileURLToPath(new URL("../", import.meta.url));
const shell = process.platform === "win32";
const npm = shell ? "npm.cmd" : "npm";
const arg = (value: string) => {
  if (!shell) return value;
  if (/["%]/.test(value)) throw new Error(`Cannot pass ${value} through cmd.exe`);
  return `"${value}"`;
};

async function cleanup(
  temporary: string,
  platform: NodeJS.Platform = process.platform,
  remove = rm,
) {
  try {
    await remove(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    if (
      platform !== "win32" ||
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EBUSY"
    ) {
      throw error;
    }
    console.warn(
      `Could not remove temporary pack-test directory ${temporary} after retries:`,
      error,
    );
  }
}

it("warns instead of failing when Windows pack-test cleanup exhausts EBUSY retries", async () => {
  const temporary = join(tmpdir(), "spi core pack-test-locked");
  const error = Object.assign(new Error("Directory is busy"), { code: "EBUSY" });
  const remove = vi.fn<typeof rm>().mockRejectedValue(error);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expect(cleanup(temporary, "win32", remove)).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledWith(
      `Could not remove temporary pack-test directory ${temporary} after retries:`,
      error,
    );
  } finally {
    warning.mockRestore();
  }
});

it.each<[NodeJS.Platform, string]>([
  ["linux", "EBUSY"],
  ["win32", "EACCES"],
])("preserves %s cleanup failures with code %s", async (platform, code) => {
  const error = Object.assign(new Error("Cleanup failed"), { code });
  const remove = vi.fn<typeof rm>().mockRejectedValue(error);
  await expect(cleanup("unused", platform, remove)).rejects.toBe(error);
});

it("keeps the README vendoring version aligned with the package manifest", async () => {
  const manifest = JSON.parse(await readFile(join(core, "package.json"), "utf8"));
  const readme = await readFile(join(core, "README.md"), "utf8");
  const vendoring = readme
    .split(/^## /m)
    .find((section) => section.startsWith("Vendoring version "));
  expect(vendoring?.split("\n")[0]).toBe(`Vendoring version ${manifest.version}`);
  expect(vendoring).toContain(`spi-code-core-${manifest.version}.tgz`);
});

it("packs a pinned, source-free tarball that installs outside the workspace", async (test) => {
  const temporary = await mkdtemp(join(tmpdir(), "spi core pack-test-"));
  try {
    const release = join(temporary, "release");
    const packed = await exec(process.execPath, ["scripts/pack.mjs", release], {
      cwd: core,
      timeout: 120_000,
    });
    const { version } = JSON.parse(await readFile(join(core, "package.json"), "utf8"));
    const filename = `spi-code-core-${version}.tgz`;
    const tarball = join(release, filename);
    const bytes = await readFile(tarball);
    expect(bytes[9]).toBe(19);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(packed.stdout).toContain(`${sha256}  ${tarball}`);
    const vendored: Record<string, string> = JSON.parse(
      await readFile(join(core, "pack-shas.json"), "utf8"),
    );
    const recorded = vendored[version];
    if (recorded !== undefined && sha256 !== recorded) {
      expect.fail(`core ${version} was vendored as ${recorded}; bump the version`);
    }
    const { stdout: listing } = await exec("tar", ["-tzf", filename], {
      cwd: release,
      timeout: 10_000,
    });
    const entries = listing.trim().split("\n");
    expect(entries).toContain("package/dist/index.js");
    expect(entries).toContain("package/dist/index.d.ts");
    expect(entries).toContain("package/LICENSE");
    expect(entries).toContain("package/README.md");
    expect(entries.filter((entry) => /\/(?:src|test|fixtures)\//.test(entry))).toEqual([]);
    expect(entries.filter((entry) => /\.test\.|\.map$/.test(entry))).toEqual([]);
    const { stdout: manifest } = await exec("tar", ["-xOzf", filename, "package/package.json"], {
      cwd: release,
      timeout: 10_000,
    });
    const pkg = JSON.parse(manifest);
    expect(pkg.version).toBe(version);
    expect(pkg.dependencies).toEqual({ yaml: "2.9.1", zod: "4.6.7" });
    expect(pkg.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    });

    const npmProject = [
      "--global=false",
      "--location=project",
      "--prefix",
      arg(temporary),
      "--cache",
      arg(join(temporary, "cache")),
    ];
    try {
      await exec(
        npm,
        [
          "view",
          "yaml@2.9.1",
          "version",
          "--fetch-retries=0",
          "--fetch-timeout=5000",
          ...npmProject,
        ],
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
        ...npmProject,
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
    expect(installed.version).toBe(version);
    await exec(
      process.execPath,
      [
        "-e",
        "import('@spi-code/core').then(m=>{if(typeof m.buildBriefing!=='function')process.exit(1)})",
      ],
      { cwd: temporary, env: { ...process.env, NODE_PATH: "" }, timeout: 10_000 },
    );
  } finally {
    await cleanup(temporary);
  }
}, 240_000);
