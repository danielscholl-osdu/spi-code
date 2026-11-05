// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function launchSmoke(
  executable: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): void {
  const directory = mkdtempSync(join(tmpdir(), "spi-code-electron-smoke-"));
  const inherited = Object.fromEntries(
    Object.entries(env).filter(([key]) => key.toUpperCase() !== "ELECTRON_RUN_AS_NODE"),
  );
  try {
    execFileSync(executable, [...args, "--smoke", `--user-data-dir=${directory}`], {
      env: inherited,
      stdio: "inherit",
      timeout: 60000,
      killSignal: "SIGKILL",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { default: electron } = await import("electron");
  launchSmoke(String(electron), [".", ...process.argv.slice(2)]);
}
