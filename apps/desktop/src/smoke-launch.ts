// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SMOKE_TIMEOUT_MS, smokeElapsed } from "./smoke-report.js";

export function launchSmoke(
  executable: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): void {
  const directory = mkdtempSync(join(tmpdir(), "spi-code-electron-smoke-"));
  const inherited = Object.fromEntries(
    Object.entries(env).filter(([key]) => key.toUpperCase() !== "ELECTRON_RUN_AS_NODE"),
  );
  const launched = performance.now();
  try {
    execFileSync(executable, [...args, "--smoke", `--user-data-dir=${directory}`], {
      env: inherited,
      stdio: "inherit",
      timeout: SMOKE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    // The app's report can end mid-line when it exits, so the verdict starts its own line.
    console.log(`\nPackaged smoke passed in ${smokeElapsed(performance.now() - launched)}`);
  } catch (error) {
    console.log(`\nPackaged smoke failed after ${smokeElapsed(performance.now() - launched)}`);
    throw error;
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { default: electron } = await import("electron");
  launchSmoke(String(electron), [".", ...process.argv.slice(2)]);
}
