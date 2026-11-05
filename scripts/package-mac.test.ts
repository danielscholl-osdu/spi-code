// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertRuntimeEvidence,
  installProductionDependencies,
  packagingEnvironment,
  stageWorkspace,
} from "./package-mac.mjs";

describe("production staging lockfile", () => {
  const fixtures: string[] = [];
  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "spi-package-lock-"));
    fixtures.push(root);
    const directories = [".", "apps/example", "modules/plugin"];
    for (const directory of [...directories, "modules/ignored"]) {
      await mkdir(join(root, directory), { recursive: true });
      await writeFile(
        join(root, directory, "package.json"),
        JSON.stringify({ name: directory.replaceAll("/", "-"), version: "1.0.0" }),
      );
    }
    await writeFile(
      join(root, "pnpm-workspace.yaml"),
      "packages:\n  - apps/*\n  - modules/*\n  - '!modules/ignored'\n",
    );
    const lockfile = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:
${directories.map((directory) => `\n  ${directory}: {}\n`).join("")}`;
    await writeFile(join(root, "pnpm-lock.yaml"), lockfile);
    const stage = join(root, "stage");
    await stageWorkspace(root, stage);
    return { stage, lockfile };
  }

  it("installs a copied workspace lockfile without rewriting it", async () => {
    const { stage, lockfile } = await fixture();
    for (const directory of ["apps/example", "modules/plugin"]) {
      expect(
        JSON.parse(await readFile(join(stage, directory, "package.json"), "utf8")),
      ).toHaveProperty("version", "1.0.0");
    }
    await expect(readFile(join(stage, "modules/ignored/package.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    installProductionDependencies(stage, { ...process.env, CI: "false" });
    expect(await readFile(join(stage, "pnpm-lock.yaml"), "utf8")).toBe(lockfile);
  });

  it("fails the staging install when its lockfile does not match a manifest", async () => {
    const { stage, lockfile } = await fixture();
    await writeFile(
      join(stage, "pnpm-lock.yaml"),
      lockfile.replace(
        "modules/plugin: {}",
        "modules/plugin:\n    dependencies:\n      zod:\n        specifier: 4.6.7\n        version: 4.6.7",
      ),
    );
    try {
      installProductionDependencies(stage, { ...process.env, CI: "false" });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).toContain("ERR_PNPM_OUTDATED_LOCKFILE");
      return;
    }
    expect.fail("A mismatched staging lockfile must fail the install");
  });
});

describe("packaged smoke gate", () => {
  it("rejects a packaging entry point for the wrong OS before building", () => {
    const script = process.platform === "win32" ? "package-mac.mjs" : "package-win.mjs";
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], {
      encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Packaging requires macOS arm64 or Windows x64 on the target OS",
    );
  });

  const resources = "/artifacts/SPI Code.app/Contents/Resources";
  const evidence = {
    hostPid: 42,
    runtimePath: `${resources}/app.asar.unpacked/node_modules/@github/copilot-sdk-darwin-arm64/prebuilds/darwin-arm64/copilot-runtime`,
    transport: "stdio",
    ping: { message: "pong: spi-code-packaged-smoke", timestamp: "2026-11-05T00:00:00Z" },
    status: { protocolVersion: 1, version: "1.0.103" },
  };
  it("accepts a protocol response from the shipped binary in the observed host", () => {
    expect(() =>
      assertRuntimeEvidence({ hostPid: 42 }, evidence, resources, "darwin", "arm64"),
    ).not.toThrow();
  });
  it("accepts only the Windows x64 unpacked executable for Windows evidence", () => {
    const windowsResources = "C:\\artifacts\\SPI Code\\resources";
    const runtimePath = win32.join(
      windowsResources,
      "app.asar.unpacked/node_modules/@github/copilot-sdk-win32-x64/prebuilds/win32-x64/copilot-runtime.exe",
    );
    const check = (path: string) =>
      assertRuntimeEvidence(
        { hostPid: 42 },
        { ...evidence, runtimePath: path },
        windowsResources,
        "win32",
        "x64",
      );
    expect(() => check(runtimePath)).not.toThrow();
    for (const path of [
      runtimePath.replace("app.asar.unpacked", "app.asar"),
      runtimePath.replaceAll("win32-x64", "darwin-arm64"),
      runtimePath.replace(".exe", ""),
      runtimePath.replace("C:\\artifacts", "C:\\external"),
    ])
      expect(() => check(path)).toThrow();
  });
  it.each([
    { ...evidence, hostPid: 43 },
    { ...evidence, runtimePath: evidence.runtimePath.replace("app.asar.unpacked", "app.asar") },
    { ...evidence, runtimePath: "/usr/local/bin/copilot-runtime" },
    { ...evidence, transport: "tcp" },
    { ...evidence, ping: undefined },
    { ...evidence, status: { protocolVersion: 0, version: "1.0.103" } },
    { ...evidence, ping: { message: "pong: spi-code-packaged-smoke", timestamp: "invalid" } },
    { ...evidence, status: { protocolVersion: 1 } },
  ])("rejects missing or mismatched runtime proof %#", (invalid) => {
    expect(() =>
      assertRuntimeEvidence({ hostPid: 42 }, invalid, resources, "darwin", "arm64"),
    ).toThrow();
  });
  it("removes Node boot and signing overrides without enabling environment stub mode", () => {
    expect(
      packagingEnvironment({
        PATH: "/bin",
        ELECTRON_RUN_AS_NODE: "1",
        CSC_LINK: "certificate",
        CSC_KEY_PASSWORD: "password",
        WIN_CSC_LINK: "certificate",
        WIN_CSC_KEY_PASSWORD: "password",
        CSC_IDENTITY_AUTO_DISCOVERY: "true",
        APPLE_API_KEY: "key",
        SPI_CODE_STUB_MODEL: "1",
      }),
    ).toEqual({ PATH: "/bin", CSC_IDENTITY_AUTO_DISCOVERY: "false" });
  });
});
