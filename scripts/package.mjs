// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, posix, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { generateNotices } from "./third-party-notices.mjs";

const runtimePackages = ["contracts", "core", "tools", "host"];

/** @param {NodeJS.ProcessEnv} inherited */
export function packagingEnvironment(inherited) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...inherited, CSC_IDENTITY_AUTO_DISCOVERY: "false" };
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "WIN_CSC_LINK",
    "WIN_CSC_KEY_PASSWORD",
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
    "SPI_CODE_STUB_MODEL",
  ])
    delete env[key];
  return env;
}

/**
 * @param {{mainPid: number, hostPid: number}} report
 * @param {unknown} evidence
 * @param {string} resources
 * @param {NodeJS.Platform} [platform]
 * @param {string} [arch]
 */
export function assertRuntimeEvidence(
  report,
  evidence,
  resources,
  platform = process.platform,
  arch = process.arch,
) {
  const runtime = record(evidence);
  assert.equal(runtime.hostPid, report.hostPid, "Handshake must run in the packaged host");
  const listenerCheck = record(runtime.listenerCheck);
  assert.equal(listenerCheck.mainPid, report.mainPid);
  assert.equal(listenerCheck.hostPid, report.hostPid);
  const checkedPids = new Set([report.mainPid, report.hostPid]);
  for (const key of ["runtimePids", "rendererPids"]) {
    const pids = listenerCheck[key];
    assert(Array.isArray(pids) && pids.length > 0, `Missing ${key} listener evidence`);
    for (const pid of pids) {
      assert(Number.isSafeInteger(pid) && pid > 0 && !checkedPids.has(pid), `Invalid ${key}`);
      checkedPids.add(pid);
    }
  }
  const scannedPids = listenerCheck.scannedPids;
  assert(
    Array.isArray(scannedPids) && scannedPids.every((pid) => Number.isSafeInteger(pid) && pid > 0),
    "Missing scannedPids listener evidence",
  );
  for (const pid of checkedPids)
    assert(scannedPids.includes(pid), `Listener scan did not sample pid ${pid}`);
  const { scanDurationMs } = listenerCheck;
  const scanBudgetMs = platform === "win32" ? 30000 : 8000;
  assert(
    typeof scanDurationMs === "number" && scanDurationMs >= 0 && scanDurationMs < scanBudgetMs,
    `Listener scan duration is missing or outside its ${scanBudgetMs} ms budget`,
  );
  const { processQueryAttempts } = listenerCheck;
  assert(
    typeof processQueryAttempts === "number" &&
      Number.isSafeInteger(processQueryAttempts) &&
      processQueryAttempts >= 1 &&
      processQueryAttempts <= (platform === "win32" ? 3 : 1),
    "Missing or invalid process query attempt count",
  );
  assert.deepEqual(listenerCheck.listeners, [], "Packaged process tree has TCP listeners");
  assert.equal(runtime.transport, "stdio");
  assert(
    (platform === "darwin" && arch === "arm64") || (platform === "win32" && arch === "x64"),
    "Unsupported packaged runtime platform",
  );
  const target = `${platform}-${arch}`;
  const expected = (platform === "win32" ? win32.join : posix.join)(
    resources,
    "app.asar.unpacked",
    "node_modules",
    `@github/copilot-sdk-${target}`,
    "prebuilds",
    target,
    platform === "win32" ? "copilot-runtime.exe" : "copilot-runtime",
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

/** @param {string[]} args @param {import("node:child_process").ExecFileSyncOptions} options */
function pnpm(args, options) {
  if (process.platform !== "win32") return execFileSync("pnpm", args, options);
  const cli = process.env.npm_execpath;
  assert(cli, "Run packaging and its tests through pnpm so npm_execpath is available");
  return execFileSync(process.execPath, [cli, ...args], options);
}

/** @param {unknown} value */
function record(value) {
  assert(value && typeof value === "object" && !Array.isArray(value), "Expected a report object");
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {string} root @param {string} stage */
export async function stageWorkspace(root, stage) {
  root = await realpath(root);
  const projects = /** @type {{path: string}[]} */ (
    JSON.parse(
      String(
        pnpm(["list", "--recursive", "--depth", "-1", "--json"], {
          cwd: root,
          encoding: "utf8",
        }),
      ),
    )
  );
  for (const directory of new Set([
    ".",
    ...projects.map((project) => relative(root, project.path)),
  ])) {
    await mkdir(join(stage, directory), { recursive: true });
    await cp(join(root, directory, "package.json"), join(stage, directory, "package.json"));
  }
  await cp(join(root, "pnpm-lock.yaml"), join(stage, "pnpm-lock.yaml"));
  await writeFile(
    join(stage, "pnpm-workspace.yaml"),
    `${await readFile(join(root, "pnpm-workspace.yaml"), "utf8")}\nnodeLinker: hoisted\n`,
  );
}

/** @param {string} root @param {string} stage */
export async function stageRuntimeFiles(root, stage) {
  for (const path of [
    ...runtimePackages.map((name) => `packages/${name}/dist`),
    "apps/desktop/dist",
    "apps/desktop/src/preload.cjs",
    "apps/window/build",
    "scripts/packaged-host.mjs",
  ]) {
    await mkdir(dirname(join(stage, path)), { recursive: true });
    await cp(join(root, path), join(stage, path), {
      recursive: true,
      filter: (source) => !/\.test\.|^smoke-launch\./.test(basename(source)),
    });
  }
}

/** @param {string} stage @param {NodeJS.ProcessEnv} env */
export function installProductionDependencies(stage, env) {
  try {
    return pnpm(["install", "--prod", "--frozen-lockfile", "--ignore-scripts"], {
      cwd: stage,
      env,
      stdio: "pipe",
      timeout: 600000,
    });
  } catch (error) {
    const output = /** @type {{stdout?: unknown, stderr?: unknown}} */ (error);
    const text = `${String(output.stdout ?? "")}${String(output.stderr ?? "")}`.trim();
    throw new Error(`Locked production install failed in ${stage}:\n${text}`, { cause: error });
  }
}

/**
 * @typedef {{name: string, version: string, description: string, author: string,
 * license: string, dependencies: Record<string, string>,
 * devDependencies: Record<string, string>, build: Record<string, unknown>}} Manifest
 */

/** @param {NodeJS.Platform} [platform] */
export async function packageDesktop(platform = process.platform) {
  assert(
    platform === process.platform &&
      ((platform === "darwin" && process.arch === "arm64") ||
        (platform === "win32" && process.arch === "x64")),
    "Packaging requires macOS arm64 or Windows x64 on the target OS",
  );
  const windows = platform === "win32";
  const root = fileURLToPath(new URL("..", import.meta.url));
  const output = join(root, windows ? "build/package-win" : "build/package-mac");
  await mkdir(output, { recursive: true });
  const stage = await mkdtemp(join(output, "stage-"));
  const extracted = await mkdtemp(join(output, "zip-smoke-"));
  const artifacts = join(output, "artifacts");
  const env = packagingEnvironment(process.env);
  /** @param {string[]} args @param {string} [cwd] */
  const run = (args, cwd = root) => pnpm(args, { cwd, env, stdio: "inherit", timeout: 600000 });
  /** @param {string} path @returns {Promise<unknown>} */
  const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
  /** @param {string} path @param {unknown} value */
  const json = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  try {
    run(["--filter", "@spi-code/desktop", "build"]);
    await stageWorkspace(root, stage);
    process.stdout.write(installProductionDependencies(stage, env));
    const desktop = /** @type {Manifest} */ (
      await readJson(join(root, "apps/desktop/package.json"))
    );
    /** @type {Record<string, string>} */
    const dependencies = {};
    for (const name of runtimePackages) {
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
      const installed = join(stage, "node_modules", manifest.name);
      await mkdir(dirname(installed), { recursive: true });
      await rm(installed, { recursive: true, force: true });
      await symlink(
        windows ? join(stage, "packages", name) : `../../packages/${name}`,
        installed,
        windows ? "junction" : "dir",
      );
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
    assert(desktop.devDependencies.electron, "Electron must have a pinned version");
    await writeFile(
      join(stage, "THIRD_PARTY_NOTICES.md"),
      await generateNotices([stage, join(root, "apps/window")], desktop.devDependencies.electron),
    );
    await stageRuntimeFiles(root, stage);
    await rm(artifacts, { recursive: true, force: true });
    await json(join(stage, "electron-builder.json"), {
      ...desktop.build,
      ...(windows
        ? {
            win: {
              .../** @type {Record<string, unknown>} */ (desktop.build.win),
              target: [
                { target: "nsis", arch: ["x64"] },
                { target: "zip", arch: ["x64"] },
              ],
            },
          }
        : {}),
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
      windows ? "--win" : "--mac",
      windows ? "--x64" : "--arm64",
      "--publish",
      "never",
    ]);
    for (const extension of [windows ? ".exe" : ".dmg", ".zip"]) {
      const files = (await readdir(artifacts)).filter((name) => name.endsWith(extension));
      assert.equal(files.length, 1, `Expected one ${extension} artifact`);
      assert(files[0]);
      assert((await stat(join(artifacts, files[0]))).size > 0);
    }
    const zip = (await readdir(artifacts)).find((name) => name.endsWith(".zip"));
    assert(zip);
    if (windows) {
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:SPI_CODE_ZIP -DestinationPath $env:SPI_CODE_EXTRACTED",
        ],
        {
          env: { ...env, SPI_CODE_ZIP: join(artifacts, zip), SPI_CODE_EXTRACTED: extracted },
          stdio: "inherit",
          timeout: 120000,
        },
      );
    } else {
      execFileSync("ditto", ["-x", "-k", join(artifacts, zip), extracted], {
        stdio: "inherit",
        timeout: 120000,
      });
    }
    const bundle = windows ? extracted : join(extracted, "SPI Code.app/Contents");
    const resources = join(bundle, windows ? "resources" : "Resources");
    const reportPath = join(output, "smoke.json");
    const runtimeReportPath = join(output, "runtime.json");
    for (const path of [reportPath, runtimeReportPath]) await rm(path, { force: true });
    const { launchSmoke } = await import("../apps/desktop/dist/smoke-launch.js");
    launchSmoke(
      join(bundle, windows ? "SPI Code.exe" : "MacOS/SPI Code"),
      [
        "--smoke-report",
        reportPath,
        "--smoke-views-fixture",
        join(root, "fixtures/watch/snapshot-1106.json"),
        ...["calm", "busy", "bad"].flatMap((morning) => [
          `--smoke-views-${morning}-fixture`,
          join(root, `fixtures/watch/snapshot-${morning}.json`),
        ]),
        "--smoke-views-design",
        join(root, "design/spi-code-window-layout.html"),
      ],
      { ...env, SPI_CODE_RUNTIME_REPORT: runtimeReportPath },
    );
    const report = await readJson(reportPath);
    /** @type {(value: unknown) => asserts value is import("../apps/desktop/dist/smoke-report.js").SmokeReport} */
    const assertSmokeReport = (await import("../apps/desktop/dist/smoke-report.js"))
      .assertSmokeReport;
    assertSmokeReport(report);
    const runtime = await readJson(runtimeReportPath);
    assertRuntimeEvidence(report, runtime, resources);
    const combined = { ...report, runtime };
    await json(reportPath, combined);
    const written = await readJson(reportPath);
    assertSmokeReport(written);
    assertRuntimeEvidence(written, record(written).runtime, resources);
    console.log(`ZIP-extracted packaged smoke passed (${zip}): ${reportPath}`);
    console.log(JSON.stringify(combined, null, 2));
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(extracted, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await packageDesktop();
}
