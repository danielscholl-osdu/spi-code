// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

/** What scripts/watch-generated.mjs compiles or reads; a change to any of them makes the generated files stale. */
export const INPUTS = [
  "fixtures/rib-59d6895",
  "packages/contracts/package.json",
  "packages/contracts/src",
  "packages/contracts/tsconfig.json",
  "packages/core/package.json",
  "packages/core/src",
  "packages/core/test/fixtures",
  "packages/core/tsconfig.build.json",
  "packages/host/package.json",
  "packages/host/src",
  "packages/host/test",
  "packages/host/tsconfig.build.json",
  "packages/tools/package.json",
  "packages/tools/src",
  "packages/tools/tsconfig.json",
  "pnpm-lock.yaml",
  "scripts/watch-generated.mjs",
  "scripts/watch-inputs.mjs",
  "scripts/watch-snapshot.mjs",
  "tsconfig.base.json",
];

/** @param {string} name @returns {boolean} whether a file of this name inside an input folder is not an input */
export const notInput = (name) => /^\.|\.test\.tsx?$/.test(name);

/** The module scripts/watch-snapshot.mjs loads; what it imports at run time is all the generator runs. */
export const GENERATOR_ROOT = "packages/host/test/watch/outputs.ts";

/** What the generator reads besides the modules it runs: its scripts, build settings and fixtures. */
const GENERATOR_READS = [
  "packages/core/test/fixtures/rib-59d6895/",
  "packages/host/test/tsconfig.json",
  "pnpm-lock.yaml",
  "scripts/watch-generated.mjs",
  "scripts/watch-inputs.mjs",
  "scripts/watch-snapshot.mjs",
  "tsconfig.base.json",
];

// Type-only imports and exports are erased under verbatimModuleSyntax, so they load nothing.
const IMPORT =
  /^\s*(?:import\s+(?!type\s)(?:[^;]*?\sfrom\s*)?|export\s+(?:\*|\{)[^;]*?\sfrom\s*)"([^"]+)"/gm;

/** @param {string} root @returns {Map<string, string>} workspace package name to its source entry */
function sourceEntries(root) {
  const entries = new Map();
  for (const group of ["apps", "packages"]) {
    if (!existsSync(join(root, group))) continue;
    for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(join(root, group, entry.name, "package.json"), "utf8"));
      } catch {
        continue;
      }
      const built = manifest.exports?.["."]?.import;
      if (typeof built !== "string" || !built.startsWith("./dist/")) continue;
      entries.set(
        manifest.name,
        `${group}/${entry.name}/src/${built.slice("./dist/".length).replace(/\.js$/, ".ts")}`,
      );
    }
  }
  return entries;
}

/**
 * @param {string} root
 * @param {string} from repository-relative importing file
 * @param {string} specifier
 * @param {Map<string, string>} entries
 * @returns {string | undefined} the repository-relative source file the specifier loads
 */
function resolveSource(root, from, specifier, entries) {
  if (entries.has(specifier)) return entries.get(specifier);
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
  const target = posix.join(posix.dirname(from), specifier);
  return [target.replace(/\.js$/, ".ts"), target.replace(/\.js$/, ".tsx"), target].find(
    (candidate) => existsSync(join(root, candidate)),
  );
}

/**
 * @param {string} root
 * @returns {Set<string>} every workspace source file the generator's root module loads, directly or not
 */
export function generatorModules(root) {
  const entries = sourceEntries(root);
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const pending = existsSync(join(root, GENERATOR_ROOT)) ? [GENERATOR_ROOT] : [];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, specifier = ""] of readFileSync(join(root, file), "utf8").matchAll(IMPORT)) {
      const source = resolveSource(root, file, specifier, entries);
      if (source !== undefined && !seen.has(source)) pending.push(source);
    }
  }
  return seen;
}

/**
 * The files a change to which can change what the generator writes: the modules it loads, the
 * manifest and build settings of each package they belong to, and what it reads from disk. Narrower
 * than INPUTS, which the full check digests whole.
 * @param {string} root
 * @returns {(path: string) => boolean} given a repository-relative path with forward slashes
 */
export function generatorInputs(root) {
  const files = new Set(generatorModules(root));
  for (const file of [...files]) {
    const pkg = file.split("/").slice(0, 2).join("/");
    for (const name of ["package.json", "tsconfig.json", "tsconfig.build.json"])
      files.add(`${pkg}/${name}`);
  }
  return (path) =>
    files.has(path) ||
    GENERATOR_READS.some((read) => (read.endsWith("/") ? path.startsWith(read) : path === read));
}
