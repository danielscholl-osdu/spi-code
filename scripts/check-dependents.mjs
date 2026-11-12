// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

// Reads changed paths on stdin and prints the vitest projects scripts/check --quick runs whole.
// Packages import each other's built output, which vitest --changed does not follow, and tests
// read fixtures and shell scripts from disk.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
 * @param {string[]} changed repository-relative paths, forward slashes
 * @param {Map<string, string[]>} dependencies
 * @returns {string[]} vitest project names to run whole, sorted
 */
export function wholeProjects(changed, dependencies) {
  const directories = [...dependencies.keys()];
  if (changed.some((path) => path.startsWith("fixtures/")))
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
  return [...whole].sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const changed = readFileSync(0, "utf8").split("\n").filter(Boolean);
  const root = fileURLToPath(new URL("..", import.meta.url));
  for (const directory of wholeProjects(changed, workspaceDependencies(root))) {
    console.log(directory);
  }
}
