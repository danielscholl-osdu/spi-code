// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

// pnpm build && node scripts/watch-generated.mjs
// Writes the watch fixtures that are not committed into fixtures/watch/generated, with a digest of
// the sources they come from. Tests read them only while that digest matches the checkout.
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Not new URL("../", import.meta.url): the DOM test environments replace URL.
const repository = join(dirname(fileURLToPath(import.meta.url)), "..");

export const GENERATED = "fixtures/watch/generated";
export const GENERATOR = "pnpm build && node scripts/watch-generated.mjs";
const STAMP = "inputs.sha256";

/** What the generator compiles or reads; a change to any of them makes the generated files stale. */
const INPUTS = [
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
  "scripts/watch-snapshot.mjs",
  "tsconfig.base.json",
];

/** @param {string} root @param {string} path @returns {string[]} */
function inputFiles(root, path) {
  const absolute = join(root, path);
  if (!existsSync(absolute)) return [];
  if (!statSync(absolute).isDirectory()) return [path];
  return readdirSync(absolute, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !/^\.|\.test\.tsx?$/.test(entry.name))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"));
}

/** @param {string} [root] @returns {string} a digest of every input's path and content */
export function inputsDigest(root = repository) {
  const hash = createHash("sha256");
  for (const file of INPUTS.flatMap((path) => inputFiles(root, path)).sort()) {
    const content = readFileSync(join(root, file));
    hash.update(`${file}\0${content.length}\0`).update(content);
  }
  return hash.digest("hex");
}

/**
 * Replaces fixtures/watch/generated with what the generator writes there now. On failure the
 * folder is left absent, so readers fail naming the generator instead of reading older files.
 * @param {string} [root]
 */
export async function writeGenerated(root = repository) {
  const target = join(root, GENERATED);
  rmSync(target, { recursive: true, force: true });
  const digest = inputsDigest(root);
  const out = mkdtempSync(join(tmpdir(), "spi-watch-generated-"));
  try {
    const { generate } = await import("./watch-snapshot.mjs");
    await generate(out, root);
    cpSync(join(out, GENERATED), target, { recursive: true });
    writeFileSync(join(target, STAMP), `${digest}\n`);
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** @type {Set<string>} */
const current = new Set();

/**
 * @param {string} [root]
 * @returns {string} the generated folder, once its digest matches the checkout's sources
 */
export function verifyGenerated(root = repository) {
  const directory = join(root, GENERATED);
  if (current.has(directory)) return directory;
  let recorded;
  try {
    recorded = readFileSync(join(directory, STAMP), "utf8").trim();
  } catch {
    throw new Error(`${GENERATED} is missing or its generation failed: run ${GENERATOR}`);
  }
  if (recorded !== inputsDigest(root))
    throw new Error(`${GENERATED} was generated from other sources: run ${GENERATOR}`);
  current.add(directory);
  return directory;
}

/** @param {string} name @param {string} [root] @returns {string} the current generated file's path */
export function generatedFixture(name, root = repository) {
  const path = join(verifyGenerated(root), name);
  if (!existsSync(path)) throw new Error(`${GENERATED}/${name} is not written by ${GENERATOR}`);
  return path;
}

/** @param {string} name @returns {string} the current generated file's text */
export const readGenerated = (name) => readFileSync(generatedFixture(name), "utf8");

/**
 * Reads a fixture by path, from the working directory, checking first that a generated one is
 * current.
 * @param {string} path
 * @returns {string}
 */
export function readFixture(path) {
  const generated = join(repository, GENERATED, sep);
  const absolute = resolve(path);
  return readFileSync(
    absolute.startsWith(generated) ? generatedFixture(absolute.slice(generated.length)) : absolute,
    "utf8",
  );
}

/**
 * Every JSON fixture in fixtures/watch, committed or generated, by file name.
 * @param {string} [root]
 * @returns {{name: string, path: string}[]}
 */
export function watchFixtures(root = repository) {
  const committed = join(root, "fixtures/watch");
  return [committed, verifyGenerated(root)]
    .flatMap((directory) =>
      readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(({ name }) => ({ name, path: join(directory, name) })),
    )
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await writeGenerated();
  } catch (error) {
    console.error(`watch-generated: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
