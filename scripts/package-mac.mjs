// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateNotices } from "./third-party-notices.mjs";

/** @param {NodeJS.ProcessEnv} inherited */
export function packagingEnvironment(inherited) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...inherited, CSC_IDENTITY_AUTO_DISCOVERY: "false" };
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
    "SPI_CODE_STUB_MODEL",
  ])
    delete env[key];
  return env;
}

/**
 * @param {{hostPid: number}} report
 * @param {unknown} evidence
 * @param {string} resources
 */
export function assertRuntimeEvidence(report, evidence, resources) {
  const runtime = record(evidence);
  assert.equal(runtime.hostPid, report.hostPid, "Handshake must run in the packaged host");
  assert.equal(runtime.transport, "stdio");
  const expected = join(
    resources,
    "app.asar.unpacked/node_modules/@github/copilot-sdk-darwin-arm64/prebuilds/darwin-arm64/copilot-runtime",
  );
  assert.equal(runtime.runtimePath, expected, "Runtime must be the shipped unpacked binary");
  const ping = record(runtime.ping);
  const status = record(runtime.status);
  assert.equal(ping.message, "pong: spi-code-packaged-smoke");
  assert(typeof ping.timestamp === "string" && !Number.isNaN(Date.parse(ping.timestamp)));
  assert(
    typeof status.protocolVersion === "number" &&
      Number.isSafeInteger(status.protocolVersion) &&
      status.protocolVersion > 0,
  );
  assert(typeof status.version === "string" && status.version.length > 0);
}

/** @param {unknown} value */
function record(value) {
  assert(value && typeof value === "object" && !Array.isArray(value), "Expected a report object");
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @typedef {{name: string, version: string, description: string, author: string,
 * license: string, dependencies: Record<string, string>,
 * devDependencies: Record<string, string>, build: Record<string, unknown>}} Manifest
 */

async function packageMac() {
  assert(
    process.platform === "darwin" && process.arch === "arm64",
    "package:mac requires macOS arm64",
  );
  const root = fileURLToPath(new URL("..", import.meta.url));
  const output = join(root, "build/package-mac");
  await mkdir(output, { recursive: true });
  const stage = await mkdtemp(join(output, "stage-"));
  const artifacts = join(output, "artifacts");
  const env = packagingEnvironment(process.env);
  /** @param {string[]} args @param {string} [cwd] */
  const run = (args, cwd = root) =>
    execFileSync("pnpm", args, { cwd, env, stdio: "inherit", timeout: 600000 });
  /** @param {string} path @returns {Promise<unknown>} */
  const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
  /** @param {string} path @param {unknown} value */
  const json = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  try {
    run(["--filter", "@spi-code/desktop", "build"]);
    const desktop = /** @type {Manifest} */ (
      await readJson(join(root, "apps/desktop/package.json"))
    );
    /** @type {Record<string, string>} */
    const dependencies = {};
    for (const name of ["contracts", "core", "tools", "host"]) {
      const manifest = /** @type {Manifest} */ (
        await readJson(join(root, "packages", name, "package.json"))
      );
      for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
        if (version.startsWith("workspace:")) continue;
        assert(
          !dependencies[dependency] || dependencies[dependency] === version,
          `Conflicting pin: ${dependency}`,
        );
        dependencies[dependency] = version;
      }
      dependencies[manifest.name] = `file:packages/${name}`;
      const destination = join(stage, "packages", name);
      await cp(join(root, "packages", name, "dist"), join(destination, "dist"), {
        recursive: true,
      });
      await json(join(destination, "package.json"), {
        ...manifest,
        dependencies: Object.fromEntries(
          Object.entries(manifest.dependencies ?? {}).map(([dependency, version]) => [
            dependency,
            version.startsWith("workspace:")
              ? `file:../${dependency.slice("@spi-code/".length)}`
              : version,
          ]),
        ),
      });
    }
    const manifest = {
      name: "spi-code",
      version: desktop.version,
      description: desktop.description,
      author: desktop.author,
      license: desktop.license,
      type: "module",
      main: "apps/desktop/dist/index.js",
      dependencies,
    };
    await json(join(stage, "package.json"), manifest);
    await writeFile(join(stage, "pnpm-workspace.yaml"), "packages: []\nnodeLinker: hoisted\n");
    run(["install", "--prod", "--ignore-scripts", "--config.auto-install-peers=false"], stage);
    assert(desktop.devDependencies.electron, "Electron must have a pinned version");
    await writeFile(
      join(stage, "THIRD_PARTY_NOTICES.md"),
      await generateNotices([stage, join(root, "apps/window")], desktop.devDependencies.electron),
    );
    for (const path of [
      "apps/desktop/dist",
      "apps/desktop/src/preload.cjs",
      "apps/window/build",
      "scripts/packaged-host.mjs",
    ]) {
      await mkdir(dirname(join(stage, path)), { recursive: true });
      await cp(join(root, path), join(stage, path), { recursive: true });
    }
    await rm(artifacts, { recursive: true, force: true });
    await json(join(stage, "electron-builder.json"), {
      ...desktop.build,
      electronVersion: desktop.devDependencies.electron,
      directories: { output: artifacts },
    });
    run([
      "exec",
      "electron-builder",
      "--projectDir",
      stage,
      "--config",
      join(stage, "electron-builder.json"),
      "--mac",
      "--arm64",
      "--publish",
      "never",
    ]);
    for (const extension of [".dmg", ".zip"]) {
      const files = (await readdir(artifacts)).filter((name) => name.endsWith(extension));
      assert.equal(files.length, 1, `Expected one ${extension} artifact`);
      assert(files[0]);
      assert((await stat(join(artifacts, files[0]))).size > 0);
    }
    const bundle = join(artifacts, "mac-arm64/SPI Code.app/Contents");
    const reportPath = join(output, "smoke.json");
    const runtimeReportPath = join(output, "runtime.json");
    for (const path of [reportPath, runtimeReportPath]) await rm(path, { force: true });
    execFileSync(join(bundle, "MacOS/SPI Code"), ["--smoke", "--smoke-report", reportPath], {
      env: { ...env, SPI_CODE_RUNTIME_REPORT: runtimeReportPath },
      stdio: "inherit",
      timeout: 60000,
    });
    const report = await readJson(reportPath);
    /** @type {(value: unknown) => asserts value is import("../apps/desktop/dist/smoke-report.js").SmokeReport} */
    const assertSmokeReport = (await import("../apps/desktop/dist/smoke-report.js"))
      .assertSmokeReport;
    assertSmokeReport(report);
    const runtime = await readJson(runtimeReportPath);
    assertRuntimeEvidence(report, runtime, join(bundle, "Resources"));
    const combined = { ...report, runtime };
    await json(reportPath, combined);
    const written = await readJson(reportPath);
    assertSmokeReport(written);
    assertRuntimeEvidence(written, record(written).runtime, join(bundle, "Resources"));
    console.log(`Packaged smoke passed: ${reportPath}`);
    console.log(JSON.stringify(combined, null, 2));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await packageMac();
}
