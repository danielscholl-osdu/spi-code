// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { credentialPaths, runSeatbelt, sandboxEnvironment } from "./seatbelt.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function javaHome(scratch: string): Promise<{ home: string; source: string }> {
  const installed = spawnSync("/usr/libexec/java_home", [], {
    encoding: "utf8",
    env: sandboxEnvironment(scratch),
    timeout: 10_000,
  });
  if (installed.error) throw installed.error;
  if (installed.status === 0 && installed.stdout.trim()) {
    return { home: realpathSync(installed.stdout.trim()), source: "installed" };
  }
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x64" : undefined;
  if (!arch) throw new Error(`No Temurin JDK download configured for ${process.arch}`);
  const metadata = await fetch(
    `https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture=${arch}&image_type=jdk&os=mac&vendor=eclipse`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!metadata.ok) throw new Error(`Temurin metadata HTTP ${metadata.status}`);
  const assets: unknown = await metadata.json();
  const first: unknown = Array.isArray(assets) ? assets[0] : undefined;
  const binary = isRecord(first) ? first.binary : undefined;
  const archive = isRecord(binary) ? binary.package : undefined;
  if (
    !isRecord(archive) ||
    typeof archive.link !== "string" ||
    !archive.link.startsWith("https://github.com/adoptium/") ||
    typeof archive.checksum !== "string" ||
    !/^[a-f0-9]{64}$/u.test(archive.checksum)
  ) {
    throw new Error("Temurin metadata lacks a trusted archive URL and SHA-256");
  }
  const download = await fetch(archive.link, { signal: AbortSignal.timeout(180_000) });
  if (!download.ok) throw new Error(`Temurin archive HTTP ${download.status}`);
  const bytes = Buffer.from(await download.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== archive.checksum) {
    throw new Error("Temurin archive SHA-256 mismatch");
  }
  const tar = join(scratch, "jdk.tar.gz");
  const destination = join(scratch, "jdk");
  writeFileSync(tar, bytes);
  mkdirSync(destination);
  const extraction = spawnSync(
    "/usr/bin/tar",
    ["-xzf", tar, "-C", destination, "--strip-components=1"],
    {
      encoding: "utf8",
      env: sandboxEnvironment(scratch),
      timeout: 30_000,
    },
  );
  if (extraction.error) throw extraction.error;
  if (extraction.status !== 0) throw new Error(`JDK extraction failed: ${extraction.stderr}`);
  return {
    home: join(destination, "Contents/Home"),
    source: `Temurin SHA-256 ${archive.checksum}`,
  };
}

export async function runSandboxProbe() {
  if (process.platform !== "darwin") throw new Error("This probe requires macOS Seatbelt");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "spi-seatbelt-")));
  try {
    const worktree = join(root, "worktree");
    const scratchHome = join(root, "scratch-home");
    const fixtureHome = join(root, "fixture-home");
    for (const directory of [worktree, scratchHome, fixtureHome]) mkdirSync(directory);
    const jdk = await javaHome(scratchHome);
    const ghConfig =
      process.env.GH_CONFIG_DIR ??
      join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "gh");
    const options = {
      worktree,
      scratchHome,
      protectedHome: realpathSync(homedir()),
      ghConfig,
      readonlyPaths: [jdk.home],
    };
    const java = runSeatbelt(options, join(jdk.home, "bin/java"), ["-version"]);
    if (java.status !== 0) throw new Error(`Sandboxed java -version failed: ${java.stderr}`);
    const readCheck = 'if ( : < "$1" ) 2>/dev/null; then printf true; else printf false; fi';
    const actual = [
      join(homedir(), "Library/Keychains/login.keychain-db"),
      ...credentialPaths(homedir(), ghConfig).slice(1),
    ];
    const reads = actual.map((path) => {
      const result = runSeatbelt(options, "/bin/sh", ["-c", readCheck, "probe", path]);
      if (result.status !== 0 || !["true", "false"].includes(result.stdout)) {
        throw new Error("Credential readability probe failed to report a boolean");
      }
      return { path, readable: result.stdout === "true" };
    });
    const fixtureReads = credentialPaths(fixtureHome).map((directory) => {
      mkdirSync(directory, { recursive: true });
      const path = join(directory, "probe-fixture");
      writeFileSync(path, "public probe fixture");
      const unsandboxed = spawnSync("/bin/sh", ["-c", readCheck, "probe", path], {
        encoding: "utf8",
      });
      const result = runSeatbelt(
        {
          ...options,
          protectedHome: fixtureHome,
          ghConfig: join(fixtureHome, ".config/gh"),
          readonlyPaths: [...options.readonlyPaths, fixtureHome],
        },
        "/bin/sh",
        ["-c", readCheck, "probe", path],
      );
      if (
        unsandboxed.status !== 0 ||
        unsandboxed.stdout !== "true" ||
        result.status !== 0 ||
        !["true", "false"].includes(result.stdout)
      ) {
        throw new Error("Controlled credential fixture probe failed");
      }
      return {
        path: directory.slice(fixtureHome.length + 1),
        readableBefore: true,
        readable: result.stdout === "true",
      };
    });
    const writeCheck = '( printf fixture > "$1" ) 2>/dev/null';
    const outside = runSeatbelt(options, "/bin/sh", [
      "-c",
      writeCheck,
      "probe",
      join(root, "outside"),
    ]);
    const inside = runSeatbelt(options, "/bin/sh", [
      "-c",
      writeCheck,
      "probe",
      join(worktree, "inside"),
    ]);
    const env = runSeatbelt(options, "/usr/bin/env");
    if (env.status !== 0) throw new Error("Sandbox environment probe failed");
    const report = {
      platform: process.platform,
      backend: "Seatbelt",
      java: { source: jdk.source, status: java.status, version: java.stderr.trim() },
      reads,
      fixtureReads,
      writes: { outside: outside.status === 0, inside: inside.status === 0 },
      environment: env.stdout
        .trim()
        .split("\n")
        .map((line) => line.split("=")[0])
        .sort(),
      windows: "pending: no Windows runner",
    };
    if (
      reads.some((read) => read.readable) ||
      fixtureReads.some((read) => read.readable) ||
      report.writes.outside ||
      !report.writes.inside
    ) {
      throw new Error(`Sandbox confinement probe failed: ${JSON.stringify(report)}`);
    }
    return report;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await runSandboxProbe(), null, 2));
}
