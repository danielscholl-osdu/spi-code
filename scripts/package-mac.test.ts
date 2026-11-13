// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { listenerScanBudget } from "../apps/desktop/src/smoke-listeners.js";
import { stageRuntimeFiles } from "./package.mjs";
import {
  assertRuntimeEvidence,
  installProductionDependencies,
  packagingEnvironment,
  stageWorkspace,
} from "./package-mac.mjs";

describe("production staging", () => {
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

  it("stages no compiled tests, fixture builders or smoke launcher while retaining in-bundle smoke modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "spi-package-runtime-"));
    fixtures.push(root);
    const stage = join(root, "stage");
    const keep = [
      "apps/desktop/src/preload.cjs",
      "apps/window/build/index.html",
      "scripts/packaged-host.mjs",
      ...["report", "messages", "listeners", "snapshot", "supervision"].map(
        (name) => `apps/desktop/dist/smoke-${name}.js`,
      ),
    ];
    const omit: string[] = [];
    for (const directory of [
      "apps/desktop/dist",
      ...["contracts", "core", "tools", "host"].map((name) => `packages/${name}/dist`),
    ]) {
      for (const extension of ["js", "js.map", "d.ts", "d.ts.map"]) {
        keep.push(`${directory}/index.${extension}`);
        omit.push(
          `${directory}/index.test.${extension}`,
          `${directory}/nested/smoke.test.${extension}`,
          `${directory}/smoke-launch.${extension}`,
          `${directory}/nested/smoke-launch.${extension}`,
        );
      }
    }
    for (const name of ["snapshot-fixture", "detail-feed"])
      for (const extension of ["js", "js.map", "d.ts", "d.ts.map"])
        omit.push(`packages/host/dist/watch/${name}.${extension}`);
    for (const path of [...keep, ...omit]) {
      const parts = path.split("/");
      await mkdir(join(root, ...parts.slice(0, -1)), { recursive: true });
      await writeFile(join(root, path), path);
    }

    await stageRuntimeFiles(root, stage);

    const staged = await readdir(stage, { recursive: true });
    expect(
      staged.filter((path) =>
        /\.test\.|smoke-launch\.|snapshot-fixture\.|detail-feed\./.test(path),
      ),
    ).toEqual([]);
    for (const path of keep) expect(await readFile(join(stage, path), "utf8")).toBe(path);
  });

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
    listenerCheck: {
      mainPid: 41,
      hostPid: 42,
      runtimePids: [43],
      rendererPids: [44, 45],
      scannedPids: [41, 42, 43, 44, 45, 46],
      scanDurationMs: 412.5,
      processQueryAttempts: 1,
      listeners: [],
    },
  };
  const withListenerCheck = (listenerCheck: Record<string, unknown>) => ({
    ...evidence,
    listenerCheck: { ...evidence.listenerCheck, ...listenerCheck },
  });
  it.each(["darwin", "win32"] as const)(
    "pins the packaged scan bound to listenerScanBudget on %s",
    (platform) => {
      const arch = platform === "win32" ? "x64" : "arm64";
      const root = platform === "win32" ? "C:\\artifacts\\resources" : resources;
      const target = `${platform}-${arch}`;
      const path = platform === "win32" ? win32.join : join;
      const runtimePath = path(
        root,
        `app.asar.unpacked/node_modules/@github/copilot-sdk-${target}/prebuilds/${target}/copilot-runtime${platform === "win32" ? ".exe" : ""}`,
      );
      const check = (scanDurationMs: number) =>
        assertRuntimeEvidence(
          { mainPid: 41, hostPid: 42 },
          {
            ...evidence,
            runtimePath,
            listenerCheck: { ...evidence.listenerCheck, scanDurationMs },
          },
          root,
          platform,
          arch,
        );
      expect(() => check(listenerScanBudget(platform) - 1)).not.toThrow();
      expect(() => check(listenerScanBudget(platform))).toThrow("Listener scan duration");
    },
  );
  it("accepts a protocol response from the shipped binary in the observed host", () => {
    expect(() =>
      assertRuntimeEvidence({ mainPid: 41, hostPid: 42 }, evidence, resources, "darwin", "arm64"),
    ).not.toThrow();
  });
  it("accepts only the Windows x64 unpacked executable for Windows evidence", () => {
    const windowsResources = "C:\\artifacts\\SPI Code\\resources";
    const runtimePath = win32.join(
      windowsResources,
      "app.asar.unpacked/node_modules/@github/copilot-sdk-win32-x64/prebuilds/win32-x64/copilot-runtime.exe",
    );
    const check = (path: string, listenerCheck = evidence.listenerCheck) =>
      assertRuntimeEvidence(
        { mainPid: 41, hostPid: 42 },
        { ...evidence, runtimePath: path, listenerCheck },
        windowsResources,
        "win32",
        "x64",
      );
    expect(() => check(runtimePath)).not.toThrow();
    expect(() =>
      check(runtimePath, {
        ...evidence.listenerCheck,
        scanDurationMs: 12000,
        processQueryAttempts: 2,
      }),
    ).not.toThrow();
    for (const invalid of [
      { scanDurationMs: 30000 },
      { processQueryAttempts: 0 },
      { processQueryAttempts: 4 },
    ])
      expect(() => check(runtimePath, { ...evidence.listenerCheck, ...invalid })).toThrow();
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
    { ...evidence, listenerCheck: undefined },
    { ...evidence, listenerCheck: { ...evidence.listenerCheck, mainPid: 40 } },
    { ...evidence, listenerCheck: { ...evidence.listenerCheck, runtimePids: [] } },
    { ...evidence, listenerCheck: { ...evidence.listenerCheck, rendererPids: [] } },
    { ...evidence, listenerCheck: { ...evidence.listenerCheck, runtimePids: [42] } },
    {
      ...evidence,
      listenerCheck: { ...evidence.listenerCheck, listeners: ["TCP *:9222 (LISTEN)"] },
    },
  ])("rejects missing or mismatched runtime proof %#", (invalid) => {
    expect(() =>
      assertRuntimeEvidence({ mainPid: 41, hostPid: 42 }, invalid, resources, "darwin", "arm64"),
    ).toThrow();
  });
  it.each([
    { scannedPids: undefined },
    { scannedPids: [42, 43, 44, 45] },
    { scannedPids: [41, 43, 44, 45] },
    { scannedPids: [41, 42, 44, 45] },
    { scannedPids: [41, 42, 43, 44] },
    { scannedPids: [41, 42, 43, 44, 45, "46"] },
    { scanDurationMs: undefined },
    { scanDurationMs: "412" },
    { scanDurationMs: Number.NaN },
    { scanDurationMs: Number.POSITIVE_INFINITY },
    { scanDurationMs: -1 },
    { scanDurationMs: 8000 },
    { processQueryAttempts: undefined },
    { processQueryAttempts: 0 },
    { processQueryAttempts: 2 },
    { processQueryAttempts: "1" },
    { processQueryAttempts: 1.5 },
  ])("rejects missing scan coverage or timing: %o", (listenerCheck) => {
    const invalid = withListenerCheck(listenerCheck);
    expect(() =>
      assertRuntimeEvidence({ mainPid: 41, hostPid: 42 }, invalid, resources, "darwin", "arm64"),
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
