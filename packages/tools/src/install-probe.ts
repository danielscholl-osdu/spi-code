// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { installTool } from "./install.js";
import { uvManifest } from "./manifest.js";

export function installEnvironment(scratch: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: join(scratch, "home"),
    TMPDIR: join(scratch, "tmp"),
    XDG_CONFIG_HOME: join(scratch, "config"),
    XDG_CACHE_HOME: join(scratch, "cache"),
    UV_PYTHON_INSTALL_DIR: join(scratch, "uv_python_install_dir"),
    UV_TOOL_DIR: join(scratch, "uv_tool_dir"),
    UV_TOOL_BIN_DIR: join(scratch, "uv_tool_bin_dir"),
    UV_CACHE_DIR: join(scratch, "uv_cache_dir"),
    UV_PYTHON_PREFERENCE: "only-managed",
    UV_PYTHON_DOWNLOADS: "manual",
    UV_NO_CONFIG: "1",
    AZURE_CONFIG_DIR: join(scratch, "azure"),
    AZURE_CORE_COLLECT_TELEMETRY: "false",
    AZURE_EXTENSION_USE_DYNAMIC_INSTALL: "no",
    PIP_CACHE_DIR: join(scratch, "pip-cache"),
    PIP_CONFIG_FILE: process.platform === "win32" ? "NUL" : "/dev/null",
  };
}

export async function resolveInside(scratch: string, path: string): Promise<string> {
  const resolved = await realpath(path);
  const child = relative(await realpath(scratch), resolved);
  if (!child || isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`)) {
    throw new Error(`Executable outside scratch: ${path} resolves to ${resolved}`);
  }
  return resolved;
}

export async function installProbe(directory: string) {
  await mkdir(resolve(directory), { recursive: true });
  const scratch = await realpath(resolve(directory));
  const env = installEnvironment(scratch);
  for (const key of [
    "HOME",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "UV_PYTHON_INSTALL_DIR",
    "UV_TOOL_DIR",
    "UV_TOOL_BIN_DIR",
    "UV_CACHE_DIR",
    "AZURE_CONFIG_DIR",
    "PIP_CACHE_DIR",
  ]) {
    const path = env[key];
    if (!path) throw new Error(`Missing installer environment: ${key}`);
    await mkdir(path, { recursive: true });
    await resolveInside(scratch, path);
  }
  const tools = join(scratch, "tools");
  await mkdir(tools, { recursive: true });
  await resolveInside(scratch, tools);
  const uv = await resolveInside(scratch, await installTool(uvManifest, tools));
  env.PATH = [dirname(uv), env.UV_TOOL_BIN_DIR, env.PATH].join(delimiter);
  const run = async (binary: string, args: string[]) =>
    (
      await promisify(execFile)(binary, args, {
        env,
        timeout: 600_000,
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout.trim();
  await run(uv, ["python", "install", "3.12"]);
  const python = await resolveInside(scratch, await run(uv, ["python", "find", "3.12"]));
  await run(uv, ["tool", "install", "--python", python, "azure-cli==2.92.0", "--with", "pip"]);
  const az = await resolveInside(scratch, join(env.UV_TOOL_BIN_DIR ?? "", "az"));
  await run(az, ["extension", "add", "-n", "k8s-configuration", "--only-show-errors"]);
  const version: unknown = JSON.parse(await run(az, ["version", "--output", "json"]));
  const extension: unknown = JSON.parse(
    await run(az, ["extension", "show", "-n", "k8s-configuration", "--output", "json"]),
  );
  if (
    !version ||
    typeof version !== "object" ||
    !("azure-cli" in version) ||
    !extension ||
    typeof extension !== "object" ||
    !("name" in extension) ||
    extension.name !== "k8s-configuration"
  )
    throw new Error("Azure CLI or k8s-configuration verification failed");
  return {
    scratchDir: scratch,
    platform: `${process.platform}-${process.arch}`,
    uv: { path: uv, version: await run(uv, ["--version"]) },
    python: { path: python, version: await run(python, ["--version"]) },
    az: { path: az, version },
    extension,
    environment: env,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const scratch = process.argv[2];
  if (!scratch) {
    console.error("Usage: pnpm --filter @spi-code/tools probe:install <scratch-dir>");
    process.exitCode = 1;
  } else {
    installProbe(scratch).then(
      (report) => console.log(JSON.stringify(report, null, 2)),
      (error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      },
    );
  }
}
