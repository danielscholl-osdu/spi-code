// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  buildSandboxConfig,
  sandboxToolList,
  sandboxUnavailable,
} from "../packages/host/dist/copilot/sandbox.js";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const scriptPath = fileURLToPath(import.meta.url);

/**
 * @typedef {{ok: true, value: string} | {ok: false, error: string}} Fact
 * @typedef {{clone: string, worktree: string, temp: string, appData: string,
 * sibling: string, gitPath: string}} Workspace
 * @typedef {{check: string, observation: string, how: string, [key: string]: unknown}} Observation
 * @typedef {{platform: string, arch: string, node: string, electron: string | null,
 * host: Record<string, unknown>, mxc: Record<string, unknown>,
 * copilotSandboxConfig: unknown, copilotToolPolicy: string[],
 * copilotSandboxState: unknown, confinement: Observation[], ownership: Observation[],
 * notes: string[]}} ProbeReport
 * @typedef {{mxcBin?: string, sdkPackage?: string}} ProbeOptions
 */

/** @param {unknown} error */
function message(error) {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/\s+/gu, " ").trim().slice(0, 700);
}

/**
 * @param {string} value
 * @returns {number | undefined}
 */
export function parseProbePid(value) {
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * @param {Observation[]} rows
 * @param {readonly string[]} checks
 * @param {string} how
 * @param {unknown} error
 */
export function recordProbeFailure(rows, checks, how, error) {
  for (const check of checks) {
    if (rows.some((row) => row.check === check)) continue;
    rows.push({ check, observation: "not run", how, error: message(error) });
  }
}

/**
 * @template T
 * @param {Observation[]} rows
 * @param {readonly string[]} checks
 * @param {string} how
 * @param {() => Promise<T>} operation
 * @returns {Promise<T | undefined>}
 */
export async function runProbeSection(rows, checks, how, operation) {
  try {
    return await operation();
  } catch (error) {
    recordProbeFailure(rows, checks, how, error);
    return undefined;
  }
}

/** @param {string} command @param {string[]} args @returns {Promise<Fact>} */
async function facts(command, args) {
  try {
    const { stdout } = await exec(command, args, { windowsHide: true, timeout: 10_000 });
    return { ok: true, value: stdout.trim() };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

/** @param {string} path */
async function fileFact(path) {
  try {
    const entry = await stat(path);
    return { present: true, file: entry.isFile(), size: entry.size };
  } catch (error) {
    return { present: false, error: message(error) };
  }
}

/**
 * @template T
 * @param {() => Promise<T | undefined>} check
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
export async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for probe state");
}

/**
 * @template T
 * @param {Promise<T>} operation
 * @param {number} timeoutMs
 * @param {string} label
 */
async function bounded(operation, timeoutMs, label) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs} ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** @param {string} command */
function powershell(command) {
  return [
    "powershell.exe",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command,
  ];
}

/** @param {string} value */
function psLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

/** @param {number} pid */
async function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const result = await facts("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Get-CimInstance Win32_Process -Filter ${psLiteral(`ProcessId = ${pid}`)} | Select-Object -First 1 -ExpandProperty ProcessId`,
  ]);
  return result.ok && result.value === String(pid);
}

/** @param {number} pid */
async function cleanupProcess(pid) {
  if (!(await processAlive(pid))) return;
  await facts("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
}

/** @param {import("node:child_process").ChildProcess} child */
async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await bounded(
    new Promise((resolve) => {
      child.once("exit", resolve);
    }),
    10_000,
    "probe owner exit",
  );
}

/** @param {import("@microsoft/mxc-sdk/v1").ExecutionResult} result */
function summarizeResult(result) {
  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    warnings: result.warnings,
    stdout: result.stdout.trim().slice(0, 500),
    stderr: result.stderr.trim().slice(0, 500),
  };
}

/** @param {string} root @returns {Promise<Workspace>} */
async function createWorkspace(root) {
  const clone = join(root, "clone");
  const worktree = join(root, "worktree");
  const temp = join(root, "thread-temp");
  const appData = join(root, "app-data");
  const sibling = join(root, "sibling.txt");
  const gitPath = execFileSync("where.exe", ["git"], { encoding: "utf8" })
    .split(/\r?\n/u)
    .find(Boolean);
  if (!gitPath) throw new Error("Git executable was not found");
  await Promise.all([mkdir(clone), mkdir(temp), mkdir(appData)]);
  await Promise.all([mkdir(join(appData, "kube")), mkdir(join(appData, "azure"))]);
  /** @param {string[]} args */
  const git = (args) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { stdio: "ignore" });
  git(["init", "-q", "--initial-branch", "main", clone]);
  git(["-C", clone, "config", "user.name", "Probe"]);
  git(["-C", clone, "config", "user.email", "probe@example.invalid"]);
  await writeFile(join(clone, "seed.txt"), "seed\n");
  git(["-C", clone, "add", "seed.txt"]);
  git(["-C", clone, "commit", "-qm", "Seed"]);
  git(["-C", clone, "worktree", "add", "-q", "-b", "probe", worktree]);
  await Promise.all([
    writeFile(sibling, "sibling\n"),
    writeFile(join(appData, "kube", "config"), "kube\n"),
    writeFile(join(appData, "azure", "probe"), "azure\n"),
  ]);
  return { clone, worktree, temp, appData, sibling, gitPath };
}

/**
 * @param {string} root
 * @param {Workspace} workspace
 * @param {ProbeReport} report
 * @param {string} sdkPackage
 * @param {string | undefined} mxcBin
 */
async function probeMxc(root, workspace, report, sdkPackage, mxcBin) {
  const confinement = report.confinement;
  const gitRoot = dirname(dirname(workspace.gitPath));
  const config = buildSandboxConfig(
    {
      clonePath: workspace.clone,
      worktreePath: workspace.worktree,
      tempPath: workspace.temp,
      toolchainPaths: [gitRoot],
    },
    workspace.appData,
  );
  report.copilotSandboxConfig = config;
  report.copilotToolPolicy = sandboxToolList([], sandboxUnavailable("unsupported-platform"), {
    clonePath: workspace.clone,
    worktreePath: workspace.worktree,
    tempPath: workspace.temp,
  });
  report.copilotSandboxState = sandboxUnavailable("unsupported-platform");
  confinement.push(
    {
      check: "sandbox attestation",
      observation: "not engaged",
      how: "production Copilot preflight returns unsupported-platform on Windows",
    },
    {
      check: "stopped model command output",
      observation: "not run",
      how: "Copilot seat unavailable in CI",
    },
    {
      check: "cold resume",
      observation: "not run",
      how: "Copilot seat unavailable in CI",
    },
  );
  /** @type {typeof import("@microsoft/mxc-sdk/v1")} */
  let sdk;
  /** @type {{_resetWxcExecutableCache: () => void, findWxcExecutable: () => string | null}} */
  let platform;
  try {
    sdk = await import("@microsoft/mxc-sdk/v1");
    const packageRoot = dirname(require.resolve("@microsoft/mxc-sdk/package.json"));
    platform = await import(pathToFileURL(join(packageRoot, "dist", "v1", "platform.js")).href);
    report.mxc.version = require("@microsoft/mxc-sdk/package.json").version;
  } catch (error) {
    report.mxc.load = { ok: false, error: message(error) };
    for (const check of ["MXC load", "write", "read", "environment", "network", "git"])
      confinement.push({ check, observation: "not run", how: "MXC module did not load" });
    return;
  }

  const packageRoot = dirname(require.resolve("@microsoft/mxc-sdk/package.json"));
  const sdkBin = join(packageRoot, "bin");
  const unpackedBin = mxcBin || sdkBin;
  const native = join(unpackedBin, process.arch);
  const wxcPath = join(native, "wxc-exec.exe");
  report.mxc.binaries = {
    wxc: await fileFact(wxcPath),
    ffi: await fileFact(join(native, "mxc_ffi.dll")),
    daemon: await fileFact(join(native, "wxc-windows-sandbox-daemon.exe")),
    dotnetDirectory: await (async () => {
      try {
        return { present: true, files: await readdir(join(native, "dotnet")) };
      } catch (error) {
        return { present: false, error: message(error) };
      }
    })(),
  };
  platform._resetWxcExecutableCache();
  report.mxc.wxcDefault = platform.findWxcExecutable();
  const previousBin = process.env.MXC_BIN_DIR;
  process.env.MXC_BIN_DIR = unpackedBin;
  platform._resetWxcExecutableCache();
  report.mxc.wxcOverride = platform.findWxcExecutable();
  if (previousBin === undefined) delete process.env.MXC_BIN_DIR;
  else process.env.MXC_BIN_DIR = previousBin;
  platform._resetWxcExecutableCache();

  const readers =
    /** @type {readonly [keyof ProbeReport["mxc"], () => unknown | Promise<unknown>][]} */ ([
      ["support", () => sdk.getPlatformSupport()],
      ["backends", () => sdk.getAvailableBackends()],
      ["telemetry", () => sdk.getTelemetryConsentStatus()],
    ]);
  for (const [name, read] of readers) {
    try {
      report.mxc[name] = await bounded(Promise.resolve(read()), 10_000, `MXC ${name}`);
    } catch (error) {
      report.mxc[name] = { error: message(error) };
    }
  }

  const psFile = join(workspace.worktree, "windows-probe.ps1");
  await writeFile(
    psFile,
    [
      "param([string]$Scenario, [string]$Target, [string]$Source, [string]$PidFile)",
      "$ErrorActionPreference = 'Stop'",
      "switch ($Scenario) {",
      "  'write-inside' { Set-Content -LiteralPath $Target -Value 'inside'; Write-Output 'wrote' }",
      "  'write-outside' { try { Set-Content -LiteralPath $Target -Value 'outside'; Write-Output 'wrote' } catch { Write-Output 'blocked' } }",
      "  'mkdir-outside' { try { New-Item -ItemType Directory -LiteralPath $Target -Force | Out-Null; Write-Output 'wrote' } catch { Write-Output 'blocked' } }",
      "  'read-outside' { try { [void](Get-Content -LiteralPath $Target -Raw); Write-Output 'read' } catch { Write-Output 'blocked' } }",
      "  'environment' { $names = [Environment]::GetEnvironmentVariables().Keys | Sort-Object; $unsafe = @($names | Where-Object { $_ -eq 'SPI_CODE_WINDOWS_PROBE_CANARY' }); Write-Output (\"names:\" + ($names -join ',')); Write-Output (\"canary:\" + $unsafe.Count) }",
      "  'network' { try { [void](Invoke-WebRequest -UseBasicParsing -Uri $Target -TimeoutSec 5); Write-Output 'reached' } catch { Write-Output 'blocked' } }",
      "  'git-config' { try { & $Source -c commit.gpgsign=false -C $Target config probe.value changed *> $null; if ($LASTEXITCODE) { throw 'git failed' }; Write-Output 'wrote' } catch { Write-Output 'blocked' } }",
      "  'git-commit' { & $Source -c commit.gpgsign=false -C $Target add seed.txt; & $Source -c commit.gpgsign=false -C $Target commit --allow-empty -qm 'MXC probe'; Write-Output (\"head:\" + (& $Source -c commit.gpgsign=false -C $Target rev-parse --short HEAD)) }",
      "  'sleep' { Set-Content -LiteralPath $PidFile -Value $PID; Write-Output \"pid:$PID\"; Start-Sleep -Seconds 120 }",
      '  default { throw "Unknown scenario: $Scenario" }',
      "}",
    ].join("\n"),
  );

  /** @param {string} scenario @param {string} [target] @param {string} [pidFile] */
  const invoke = (scenario, target = "", pidFile = "") =>
    [
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      `"${psFile}"`,
      "-Scenario",
      scenario,
      "-Target",
      `"${target}"`,
      "-Source",
      `"${workspace.gitPath}"`,
      "-PidFile",
      `"${pidFile}"`,
    ].join(" ");
  process.env.SPI_CODE_WINDOWS_PROBE_CANARY = "probe-only";
  /** @type {Omit<import("@microsoft/mxc-sdk/v1").ContainerRequest, "command">} */
  const request = {
    containment: { type: "processcontainer" },
    filesystem: {
      readwritePaths: config.userPolicy?.filesystem?.readwritePaths ?? [],
      readonlyPaths: config.userPolicy?.filesystem?.readonlyPaths ?? [],
      deniedPaths: config.userPolicy?.filesystem?.deniedPaths ?? [],
    },
    network: {
      egress: { default: "deny" },
      ingress: { default: "deny", hostLoopback: "deny" },
    },
    ui: { disable: true },
    workingDirectory: workspace.worktree,
    environment: {
      SystemRoot: process.env.SystemRoot ?? String.raw`C:\Windows`,
      PATH: `${join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32")};${dirname(workspace.gitPath)}`,
      LOCALAPPDATA: workspace.temp,
      TEMP: workspace.temp,
      TMP: workspace.temp,
    },
    inheritDefaultEnvironment: false,
    timeoutMs: 15_000,
  };
  report.mxc.requestProbe = (() => {
    try {
      return sdk.probe({
        ...request,
        command: invoke("write-inside", join(workspace.worktree, "probe-probed.txt")),
      });
    } catch (error) {
      return { error: message(error) };
    }
  })();

  /**
   * @param {string} scenario
   * @param {string} [target]
   * @param {number} [timeoutMs]
   */
  const mxcRun = async (scenario, target = "", timeoutMs = 15_000) =>
    bounded(
      sdk.run(
        { ...request, command: invoke(scenario, target), timeoutMs },
        { telemetry: { enabled: false } },
      ),
      timeoutMs + 10_000,
      `MXC ${scenario}`,
    );
  /**
   * @param {string} name
   * @param {() => Promise<import("@microsoft/mxc-sdk/v1").ExecutionResult>} run
   * @param {(result: import("@microsoft/mxc-sdk/v1").ExecutionResult) => string} judge
   */
  const check = async (name, run, judge) => {
    if (mxcRunsFailed) {
      confinement.push({
        check: name,
        observation: "not run",
        how: "earlier packaged MXC execution did not complete",
      });
      return "not run";
    }
    try {
      const result = await run();
      const observation = judge(result);
      confinement.push({
        check: name,
        observation,
        how: "packaged MXC run",
        result: summarizeResult(result),
      });
    } catch (error) {
      mxcRunsFailed = true;
      confinement.push({
        check: name,
        observation: "not run",
        how: "MXC failed",
        error: message(error),
      });
    }
  };
  let mxcRunsFailed = false;

  const outside = join(root, "outside.txt");
  const kube = join(workspace.appData, "kube", "config");
  const azure = join(workspace.appData, "azure", "probe");
  await check(
    "write: worktree",
    () => mxcRun("write-inside", join(workspace.worktree, "inside.txt")),
    (r) => (r.exitCode === 0 && r.stdout.includes("wrote") ? "allowed" : "unexpected"),
  );
  await check(
    "write: thread temp",
    () => mxcRun("write-inside", join(workspace.temp, "inside.txt")),
    (r) => (r.exitCode === 0 && r.stdout.includes("wrote") ? "allowed" : "unexpected"),
  );
  await check(
    "write: outside",
    () => mxcRun("write-outside", outside),
    (r) => (r.exitCode === 0 && r.stdout.includes("blocked") ? "blocked" : "unexpected"),
  );
  await check(
    "read: sibling",
    () => mxcRun("read-outside", workspace.sibling),
    (r) => (r.exitCode === 0 && r.stdout.includes("blocked") ? "blocked" : "unexpected"),
  );
  const appDataReads = /** @type {readonly [string, string][]} */ ([
    ["read: appData/kube/config", kube],
    ["read: appData/azure/probe", azure],
  ]);
  for (const [name, target] of appDataReads)
    await check(
      name,
      () => mxcRun("read-outside", target),
      (r) => (r.exitCode === 0 && r.stdout.includes("blocked") ? "blocked" : "unexpected"),
    );
  await check(
    "environment",
    () => mxcRun("environment"),
    (r) =>
      r.exitCode === 0 && r.stdout.includes("canary:0") ? "launch canary absent" : "unexpected",
  );
  await check(
    "network",
    () => mxcRun("network", "https://github.com"),
    (r) => (r.exitCode === 0 && r.stdout.includes("blocked") ? "blocked" : "unexpected"),
  );
  await check(
    "git: commit",
    () => mxcRun("git-commit", workspace.worktree),
    (r) => (r.exitCode === 0 && r.stdout.includes("head:") ? "allowed" : "unexpected"),
  );
  await check(
    "git: clone config write",
    () => mxcRun("git-config", workspace.clone),
    (r) => (r.exitCode === 0 && r.stdout.includes("blocked") ? "blocked" : "unexpected"),
  );
  await check(
    "git: worktree pointer write",
    () => mxcRun("write-outside", join(workspace.worktree, ".git")),
    (r) => (r.exitCode === 0 && r.stdout.includes("blocked") ? "blocked" : "unexpected"),
  );
  await check(
    "git: clone hooks write",
    () => mxcRun("mkdir-outside", join(workspace.clone, ".git", "hooks", "probe")),
    (r) => (r.exitCode === 0 && r.stdout.includes("blocked") ? "blocked" : "unexpected"),
  );

  const sleepPid = join(workspace.temp, "sleep.pid");
  try {
    if (mxcRunsFailed) throw new Error("An earlier packaged MXC execution did not complete");
    const timed = await mxcRun("sleep", "", 500);
    const pid = parseProbePid(await readFile(sleepPid, "utf8"));
    if (pid === undefined) throw new Error("Probe PID file did not contain a valid PID");
    confinement.push({
      check: "timed-out command",
      observation: timed.timedOut ? "timed out" : "unexpected",
      how: "packaged MXC timeout",
      result: summarizeResult(timed),
    });
    report.ownership.push({
      check: "timeout descendant",
      observation: (await processAlive(pid)) ? "survived" : "ended",
      how: "PowerShell workload PID checked by host",
      pid,
    });
  } catch (error) {
    confinement.push({
      check: "timed-out command",
      observation: "not run",
      how: "MXC failed",
      error: message(error),
    });
  }

  const killPid = join(workspace.temp, "kill.pid");
  try {
    if (mxcRunsFailed) throw new Error("An earlier packaged MXC execution did not complete");
    const child = await bounded(
      sdk.spawn({ ...request, command: invoke("sleep", "", killPid) }),
      25_000,
      "MXC spawn",
    );
    child.standardOutput?.resume();
    child.standardError?.resume();
    const pid = await waitFor(async () =>
      parseProbePid(await readFile(killPid, "utf8").catch(() => "")),
    );
    child.kill();
    const waited = await bounded(child.wait(), 15_000, "MXC process wait");
    child.dispose();
    report.ownership.push({
      check: "MxcProcess.kill",
      observation: (await processAlive(pid)) ? "descendant survived" : "descendant ended",
      how: "packaged MXC handle, PID checked by host",
      handlePid: child.id,
      pid,
      result: waited,
    });
  } catch (error) {
    report.ownership.push({
      check: "MxcProcess.kill",
      observation: "not run",
      how: "MXC spawn failed",
      error: message(error),
    });
  }

  report.mxc.load = { ok: true };
  report.notes.push(`staged package path: ${sdkPackage}`);
}

/** @param {string} root @param {ProbeReport} report */
async function probeHostOwnership(root, report) {
  const ownerFile = join(root, "owner.ps1");
  const outputFile = join(root, "owner.log");
  const script = [
    "param([string]$Mode, [string]$PidFile, [string]$Output)",
    "$ErrorActionPreference = 'Stop'",
    "$arguments = @('-NoLogo','-NoProfile','-NonInteractive','-Command', 'Write-Output $PID; Start-Sleep -Seconds 120')",
    "$child = $null",
    "if ($Mode -eq 'foreground') { $child = Start-Process powershell.exe -ArgumentList $arguments -NoNewWindow -PassThru }",
    "if ($Mode -eq 'redirected') { $child = Start-Process powershell.exe -ArgumentList $arguments -NoNewWindow -RedirectStandardOutput $Output -RedirectStandardError ($Output + '.err') -PassThru }",
    "if ($Mode -eq 'detached') { $child = Start-Process powershell.exe -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardOutput $Output -RedirectStandardError ($Output + '.err') -PassThru }",
    "Set-Content -LiteralPath $PidFile -Value $child.Id",
    "if ($Mode -ne 'detached') { Wait-Process -Id $child.Id }",
  ].join("\n");
  await writeFile(ownerFile, script);

  for (const mode of ["foreground", "redirected", "detached"]) {
    const check = `${mode} descendant after owner ${mode === "detached" ? "exit" : "kill"}`;
    await runProbeSection(report.ownership, [check], "host ownership probe failed", async () => {
      const pidFile = join(root, `${mode}.pid`);
      const [command, ...args] = powershell(
        `& ${psLiteral(ownerFile)} -Mode ${psLiteral(mode)} -PidFile ${psLiteral(pidFile)} -Output ${psLiteral(outputFile)}`,
      );
      if (!command) throw new Error("PowerShell command was not constructed");
      const parent = /** @type {import("node:child_process").ChildProcess} */ (
        spawn(command, args, { stdio: "ignore", windowsHide: true })
      );
      try {
        const pid = await waitFor(async () =>
          parseProbePid(await readFile(pidFile, "utf8").catch(() => "")),
        );
        const ownerExit = waitForExit(parent);
        if (mode !== "detached") parent.kill("SIGTERM");
        await ownerExit;
        const beforeRestart = await processAlive(pid);
        const restartedObserver = await facts("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `[bool](Get-CimInstance Win32_Process -Filter ${psLiteral(`ProcessId = ${pid}`)})`,
        ]);
        report.ownership.push({
          check,
          observation: beforeRestart ? "survived" : "ended",
          restartObservation:
            restartedObserver.ok && restartedObserver.value.toLowerCase() === "true"
              ? "survived"
              : "not found",
          how: "host PowerShell owner; PID checked by host and a fresh observer",
          pid,
        });
        await cleanupProcess(pid);
      } finally {
        if (parent.exitCode === null) parent.kill("SIGTERM");
      }
    });
  }
}

/** @param {ProbeOptions} [options] @returns {Promise<ProbeReport>} */
export async function probeWindowsSandbox(options = {}) {
  if (process.platform !== "win32") throw new Error("Windows sandbox probe requires Windows");
  /** @type {ProbeReport} */
  const report = {
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    electron: process.versions.electron ?? null,
    host: {},
    mxc: {},
    copilotSandboxConfig: null,
    copilotToolPolicy: [],
    copilotSandboxState: null,
    confinement: [],
    ownership: [],
    notes: [
      "No Copilot seat or model turn was used.",
      "The production host remains ask-and-read unless its own sandbox preflight attests confinement.",
    ],
  };
  const confinementChecks = [
    "sandbox attestation",
    "write: worktree",
    "write: thread temp",
    "write: outside",
    "read: sibling",
    "read: appData/kube/config",
    "read: appData/azure/probe",
    "environment",
    "network",
    "git: commit",
    "git: clone config write",
    "git: worktree pointer write",
    "git: clone hooks write",
    "timed-out command",
    "stopped model command output",
    "cold resume",
  ];
  const hostOwnershipChecks = [
    "foreground descendant after owner kill",
    "redirected descendant after owner kill",
    "detached descendant after owner exit",
  ];
  const root = await runProbeSection(
    report.confinement,
    confinementChecks,
    "probe workspace setup failed",
    async () => mkdtemp(join(tmpdir(), "spi-code-windows-probe-")),
  );
  if (!root) {
    recordProbeFailure(
      report.ownership,
      ["MxcProcess.kill", ...hostOwnershipChecks],
      "probe workspace setup failed",
      "Temporary workspace was not created",
    );
    return report;
  }
  try {
    report.host.windows = await facts("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Environment]::OSVersion.VersionString",
    ]);
    report.host.build = await facts("cmd.exe", ["/d", "/s", "/c", "ver"]);
    const workspace = await runProbeSection(
      report.confinement,
      confinementChecks,
      "probe workspace setup failed",
      async () => createWorkspace(root),
    );
    if (workspace) {
      await runProbeSection(
        report.confinement,
        confinementChecks,
        "packaged MXC section failed",
        async () => {
          try {
            await probeMxc(
              root,
              workspace,
              report,
              options.sdkPackage ?? "source package",
              options.mxcBin,
            );
          } catch (error) {
            recordProbeFailure(
              report.ownership,
              ["MxcProcess.kill"],
              "packaged MXC section failed",
              error,
            );
            throw error;
          }
        },
      );
    } else {
      recordProbeFailure(
        report.ownership,
        ["MxcProcess.kill"],
        "probe workspace setup failed",
        "Workspace was not created",
      );
    }
    await runProbeSection(
      report.ownership,
      hostOwnershipChecks,
      "host ownership section failed",
      async () => probeHostOwnership(root, report),
    );
    return report;
  } finally {
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      report.notes.push(`Probe workspace cleanup did not complete: ${message(error)}`);
    }
  }
}

if (process.argv[1] && fileURLToPath(pathToFileURL(process.argv[1]).href) === scriptPath) {
  try {
    const packagedBin = process.env.SPI_CODE_WINDOWS_MXC_BIN;
    const report = await probeWindowsSandbox(
      packagedBin ? { mxcBin: packagedBin, sdkPackage: "extracted packaged app" } : {},
    );
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(`Windows sandbox probe did not complete: ${message(error)}`);
    process.exitCode = 1;
  }
}
