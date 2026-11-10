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
import { basename, dirname, join, relative, resolve, sep } from "node:path";
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
  const sharedContracts = { timeUnit: "time", isStoppedFork: "stopped-forks" };
  for (const module of Object.values(sharedContracts)) {
    const target = join(staging, "dist/contracts", module);
    mkdirSync(dirname(target), { recursive: true });
    for (const extension of [".js", ".d.ts"]) {
      cpSync(resolve(core, "../contracts/dist", `${module}${extension}`), `${target}${extension}`);
    }
  }
  function linkContracts(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) linkContracts(path);
      else {
        const source = readFileSync(path, "utf8");
        let linked = source;
        for (const [name, module] of Object.entries(sharedContracts)) {
          const target = relative(dirname(path), join(staging, "dist/contracts", `${module}.js`))
            .split(sep)
            .join("/");
          linked = linked.replace(
            `import { ${name} } from "@spi-code/contracts";`,
            `import { ${name} } from "${target.startsWith(".") ? target : `./${target}`}";`,
          );
        }
        if (linked.includes("@spi-code/contracts")) {
          throw new Error(`Cannot omit contracts dependency: ${path} references it`);
        }
        if (linked !== source) writeFileSync(path, linked);
      }
    }
  }
  linkContracts(join(staging, "dist"));
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
  // zlib writes its build OS into gzip header byte 9 (19 on macOS, 10 on Windows, 3 on Linux).
  // Pin the macOS value so every OS packs the bytes vendored shas were recorded from.
  const gzip = readFileSync(packed);
  if (gzip[0] !== 0x1f || gzip[1] !== 0x8b || (gzip[3] & 0x02) !== 0) {
    throw new Error("Unexpected gzip header from pnpm pack");
  }
  gzip[9] = 19;
  writeFileSync(packed, gzip);
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
