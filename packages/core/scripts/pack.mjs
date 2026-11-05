// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const core = fileURLToPath(new URL("../", import.meta.url));
const release = resolve(core, process.argv[2] ?? "release");
const shell = process.platform === "win32";
const pnpm = shell ? "pnpm.cmd" : "pnpm";
const arg = (value) => {
  if (!shell) return value;
  if (/["%]/.test(value)) throw new Error(`Cannot pass ${value} through cmd.exe`);
  return `"${value}"`;
};
execFileSync(pnpm, ["run", "build"], { cwd: core, stdio: "inherit", shell });

const staging = mkdtempSync(join(tmpdir(), "spi-core-pack-"));
try {
  const manifest = JSON.parse(readFileSync(join(core, "package.json"), "utf8"));
  delete manifest.dependencies["@spi-code/contracts"];
  delete manifest.scripts;
  writeFileSync(join(staging, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  cpSync(join(core, "dist"), join(staging, "dist"), {
    recursive: true,
    filter: (path) =>
      !/^(?:src|test|fixtures|testing)$/.test(basename(path)) && !/\.test\.|\.map$/.test(path),
  });
  function assertNoContracts(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) assertNoContracts(path);
      else if (readFileSync(path, "utf8").includes("@spi-code/contracts")) {
        throw new Error(`Cannot omit contracts dependency: ${path} references it`);
      }
    }
  }
  assertNoContracts(join(staging, "dist"));
  for (const file of ["LICENSE", "README.md"]) {
    cpSync(join(core, file), join(staging, file));
  }
  mkdirSync(release, { recursive: true });
  execFileSync(pnpm, ["pack", "--pack-destination", arg(staging)], {
    cwd: staging,
    stdio: "inherit",
    shell,
  });
  const tarball = `spi-code-core-${manifest.version}.tgz`;
  const packed = join(staging, tarball);
  const entries = execFileSync("tar", ["-tzf", tarball], {
    cwd: staging,
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  if (entries.some((entry) => /\/(?:src|test|fixtures)\//.test(entry) || /\.test\./.test(entry))) {
    throw new Error("Release tarball contains sources, tests or fixtures");
  }
  const destination = join(release, tarball);
  cpSync(packed, destination);
  const sha256 = createHash("sha256").update(readFileSync(destination)).digest("hex");
  console.log(`${sha256}  ${destination}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
