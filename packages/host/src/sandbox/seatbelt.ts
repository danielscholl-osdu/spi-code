// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, opendirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

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

function canonicalPath(path: string): string {
  let ancestor = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`Cannot canonicalize protected path: ${path}`);
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...suffix);
}

function refuseCredentialHardLinks(paths: Iterable<string>): void {
  const visited = new Set<string>();
  function visit(path: string, depth: number): void {
    if (visited.has(path)) return;
    if (depth > 16 || visited.size >= 100_000) {
      throw new Error(
        `Refusing sandbox launch: protected credential scan limit exceeded at ${path}`,
      );
    }
    visited.add(path);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      visit(realpathSync(path), depth);
    } else if (stat.isFile() && stat.nlink > 1) {
      throw new Error(
        `Refusing sandbox launch: protected credential file has multiple hard links: ${path}`,
      );
    } else if (stat.isDirectory()) {
      const directory = opendirSync(path);
      try {
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          visit(join(path, entry.name), depth + 1);
        }
      } finally {
        directory.closeSync();
      }
    }
  }
  for (const path of paths) visit(path, 0);
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
  const protectedHome = resolve(options.protectedHome);
  const protectedHomes = new Set([protectedHome]);
  protectedHomes.add(canonicalPath(protectedHome));
  const denied = new Set<string>();
  for (const protectedPath of protectedHomes) {
    for (const path of credentialPaths(protectedPath, options.ghConfig)) {
      const lexical = resolve(path);
      denied.add(lexical);
      denied.add(canonicalPath(lexical));
    }
  }
  refuseCredentialHardLinks(denied);
  return [
    "(version 1)",
    "(deny default)",
    "(allow process* sysctl-read mach-lookup)",
    "(allow system-socket)",
    "(allow network-outbound (remote ip))",
    "(allow network-inbound (local ip))",
    '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
    "(allow file-read-metadata)",
    `(allow file-read* ${read.map(subpath).join(" ")} (literal "/") (literal "/dev/null") (literal "/dev/urandom"))`,
    `(allow file-write* ${[worktree, home].map(subpath).join(" ")} (literal "/dev/null"))`,
    `(deny file-read* file-write* ${[...denied].map(subpath).join(" ")})`,
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
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
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
