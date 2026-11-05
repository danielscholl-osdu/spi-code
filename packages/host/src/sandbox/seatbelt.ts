// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join } from "node:path";

export interface SeatbeltOptions {
  worktree: string;
  scratchHome: string;
  protectedHome: string;
  readonlyPaths?: string[];
  ghConfig?: string;
}

export function credentialPaths(home: string, ghConfig = join(home, ".config/gh")): string[] {
  return [
    join(home, "Library/Keychains"),
    join(home, ".ssh"),
    join(home, ".kube"),
    join(home, ".azure"),
    ghConfig,
  ];
}

function subpath(path: string): string {
  if (!path.startsWith("/") || /[\0\r\n]/u.test(path)) {
    throw new Error("Seatbelt paths must be absolute and contain no control characters");
  }
  return `(subpath ${JSON.stringify(path)})`;
}

export function seatbeltProfile(options: SeatbeltOptions): string {
  const worktree = realpathSync(options.worktree);
  const home = realpathSync(options.scratchHome);
  const read = [
    "/System",
    "/usr",
    "/bin",
    "/sbin",
    "/Library",
    "/opt/homebrew",
    "/private/var/db",
    worktree,
    home,
    ...(options.readonlyPaths ?? []).map((path) => realpathSync(path)),
  ];
  const denied = credentialPaths(options.protectedHome, options.ghConfig);
  return [
    "(version 1)",
    "(deny default)",
    "(allow process* sysctl-read mach-lookup network*)",
    "(allow file-read-metadata)",
    `(allow file-read* ${read.map(subpath).join(" ")} (literal "/") (literal "/dev/null") (literal "/dev/urandom"))`,
    `(allow file-write* ${[worktree, home].map(subpath).join(" ")} (literal "/dev/null"))`,
    `(deny file-read* file-write* ${denied.map(subpath).join(" ")})`,
  ].join("\n");
}

export function sandboxEnvironment(
  scratchHome: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: realpathSync(scratchHome),
    TMPDIR: realpathSync(scratchHome),
    XDG_CONFIG_HOME: join(realpathSync(scratchHome), ".config"),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  };
  for (const key of ["LANG", "LC_ALL", "TZ"]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

export function runSeatbelt(options: SeatbeltOptions, command: string, args: string[] = []) {
  if (process.platform !== "darwin") throw new Error("Seatbelt is only supported on macOS");
  const result = spawnSync(
    "/usr/bin/sandbox-exec",
    ["-p", seatbeltProfile(options), command, ...args],
    {
      cwd: realpathSync(options.worktree),
      env: sandboxEnvironment(options.scratchHome),
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.signal)
    throw new Error(`Sandbox command terminated by ${result.signal}: ${result.stderr}`);
  if (result.status === null) throw new Error("Sandbox command returned no exit status");
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
