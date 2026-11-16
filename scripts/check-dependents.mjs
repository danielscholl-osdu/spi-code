// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

// Reads changed paths on stdin and prints the vitest projects scripts/check --quick runs whole,
// or with --rest the projects it leaves to vitest --changed.
// Packages import each other's built output, which vitest --changed does not follow, and tests
// read fixtures and shell scripts from disk.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generatorInputs } from "./watch-inputs.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));

/**
 * @param {string} root
 * @returns {Map<string, string[]>} workspace directory to the workspace directories it depends on
 */
export function workspaceDependencies(root) {
  /** @type {Map<string, { directory: string, needs: string[] }>} */
  const byName = new Map();
  for (const group of ["apps", "packages"]) {
    for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = `${group}/${entry.name}`;
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8"));
      } catch {
        continue;
      }
      const needs = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
      byName.set(manifest.name, { directory, needs });
    }
  }
  return new Map(
    [...byName.values()].map(({ directory, needs }) => [
      directory,
      needs.flatMap((name) => byName.get(name)?.directory ?? []),
    ]),
  );
}

/**
 * @param {string} root
 * @returns {Map<string, string[]>} each design/ file a workspace test names to the projects of those tests
 */
export function designReaders(root) {
  const tests = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", "apps", "packages"],
    { cwd: root, encoding: "utf8" },
  );
  /** @type {Map<string, Set<string>>} */
  const readers = new Map();
  for (const test of tests.split("\n").filter((path) => /\.test\.tsx?$/.test(path))) {
    const project = test.split("/").slice(0, 2).join("/");
    // The index still lists a test deleted or renamed in the working tree.
    if (!existsSync(join(root, test))) continue;
    for (const [read] of readFileSync(join(root, test), "utf8").matchAll(/\bdesign\/[\w.-]+/g)) {
      readers.set(read, (readers.get(read) ?? new Set()).add(project));
    }
  }
  return new Map([...readers].map(([read, projects]) => [read, [...projects]]));
}

/**
 * @param {string[]} changed repository-relative paths, forward slashes
 * @param {Map<string, string[]>} dependencies
 * @param {(path: string) => boolean} [isGeneratorInput] whether a change to the path can change the generated watch fixtures
 * @param {Map<string, string[]>} [readersOfDesign] each design/ file a test reads to the projects of those tests
 * @returns {string[]} vitest project names to run whole, sorted
 */
export function wholeProjects(
  changed,
  dependencies,
  isGeneratorInput = generatorInputs(repository),
  readersOfDesign = designReaders(repository),
) {
  const directories = [...dependencies.keys()];
  if (changed.some((path) => path.startsWith("fixtures/") || isGeneratorInput(path)))
    return [...directories, "scripts"].sort();
  const touched = directories.filter((directory) =>
    changed.some((path) => path.startsWith(`${directory}/`)),
  );
  // A dependent runs whole even when it has changes of its own: those select only what
  // imports them, not what reads the package it depends on.
  const whole = new Set();
  for (let frontier = touched; frontier.length > 0; ) {
    const next = [];
    for (const [directory, needs] of dependencies) {
      if (!whole.has(directory) && needs.some((need) => frontier.includes(need))) {
        whole.add(directory);
        next.push(directory);
      }
    }
    frontier = next;
  }
  if (changed.some((path) => path.startsWith("scripts/") && !/\.tsx?$/.test(path))) {
    whole.add("scripts");
  }
  for (const path of changed)
    for (const project of readersOfDesign.get(path) ?? []) whole.add(project);
  return [...whole].sort();
}

/**
 * The projects left for the import-following run: every one that does not run whole.
 * @param {string[]} whole
 * @param {Map<string, string[]>} dependencies
 * @returns {string[]} sorted
 */
export function restProjects(whole, dependencies) {
  return [...dependencies.keys(), "scripts"].filter((project) => !whole.includes(project)).sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const changed = readFileSync(0, "utf8").split("\n").filter(Boolean);
  const dependencies = workspaceDependencies(repository);
  const whole = wholeProjects(
    changed,
    dependencies,
    generatorInputs(repository),
    designReaders(repository),
  );
  for (const project of process.argv[2] === "--rest" ? restProjects(whole, dependencies) : whole) {
    console.log(project);
  }
}
