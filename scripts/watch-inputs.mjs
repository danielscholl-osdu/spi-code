// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

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

/**
 * @param {string} path repository-relative, forward slashes
 * @returns {boolean} whether a change to the file can change the generated watch fixtures
 */
export function isWatchInput(path) {
  return INPUTS.some(
    (input) =>
      path === input ||
      (path.startsWith(`${input}/`) && !notInput(path.slice(path.lastIndexOf("/") + 1))),
  );
}
