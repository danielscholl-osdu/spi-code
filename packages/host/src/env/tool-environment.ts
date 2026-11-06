// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

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
  const bins = await Promise.all(
    (options.managedTools ?? ["gh", "glab"]).map((tool) => options.installer.binDir(tool)),
  );
  return buildManagedToolEnvironment({
    ...options,
    toolsDir: bins.filter((bin) => bin !== undefined).join(platform === "win32" ? ";" : ":"),
  });
}

export function buildManagedToolEnvironment(
  options: Omit<ManagedToolEnvironmentOptions, "installer" | "managedTools"> & {
    toolsDir: string;
  },
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
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
    toolsDir: options.toolsDir,
    capturedPath: options.capturedPath,
    kubeconfig: join(options.appData, "kube", "config"),
    azureConfigDir: join(options.appData, "azure"),
    env,
    platform,
    ...(tokenName !== undefined && token !== undefined
      ? { configuredTokens: { [tokenName]: token } }
      : {}),
  });
}
