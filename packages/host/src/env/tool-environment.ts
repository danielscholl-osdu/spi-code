// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ToolInstaller } from "@spi-code/tools";
import { buildToolEnvironment } from "./shell-environment.js";

export interface ManagedToolEnvironmentOptions {
  appData: string;
  capturedPath: string;
  installer: Pick<ToolInstaller, "binDir">;
  // Add git when its installer is available; otherwise use login-shell git.
  managedTools?: readonly string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  keepToken?: "GH_TOKEN" | "GITHUB_TOKEN";
}

export async function createManagedToolEnvironment(
  options: ManagedToolEnvironmentOptions,
): Promise<NodeJS.ProcessEnv> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const bins = await Promise.all(
    (options.managedTools ?? ["gh", "glab"]).map((tool) => options.installer.binDir(tool)),
  );
  const kubeDir = join(options.appData, "kube");
  const azureConfigDir = join(options.appData, "azure");
  await Promise.all([
    mkdir(kubeDir, { recursive: true }),
    mkdir(azureConfigDir, { recursive: true }),
  ]);
  const tokenName = options.keepToken;
  const key =
    tokenName === undefined
      ? undefined
      : platform === "win32"
        ? Object.keys(env)
            .sort()
            .find((name) => name.toUpperCase() === tokenName)
        : tokenName;
  const token = key === undefined ? undefined : env[key];
  return buildToolEnvironment({
    toolsDir: bins.filter((bin) => bin !== undefined).join(platform === "win32" ? ";" : ":"),
    capturedPath: options.capturedPath,
    kubeconfig: join(kubeDir, "config"),
    azureConfigDir,
    env,
    platform,
    ...(tokenName !== undefined && token !== undefined
      ? { configuredTokens: { [tokenName]: token } }
      : {}),
  });
}
