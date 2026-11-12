// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { wholeProjects, workspaceDependencies } from "./check-dependents.mjs";

const dependencies = workspaceDependencies(fileURLToPath(new URL("..", import.meta.url)));

it("reads which workspace packages depend on which", () => {
  expect(dependencies.get("packages/host")).toEqual(
    expect.arrayContaining(["packages/contracts", "packages/core", "packages/tools"]),
  );
  expect(dependencies.get("packages/contracts")).toEqual([]);
});

it("runs whole every package that depends, directly or not, on a changed one", () => {
  expect(wholeProjects(["packages/core/src/brief/places.ts"], dependencies)).toEqual([
    "apps/desktop",
    "packages/host",
  ]);
  expect(wholeProjects(["packages/contracts/src/watch/today.ts"], dependencies)).toEqual([
    "apps/desktop",
    "apps/window",
    "packages/core",
    "packages/host",
    "packages/tools",
  ]);
});

it("runs nothing whole for a change no other package depends on", () => {
  expect(wholeProjects(["apps/window/src/views/today/Band.tsx"], dependencies)).toEqual([]);
  expect(wholeProjects(["scripts/land", "docs/sdlc.md"], dependencies)).toEqual([]);
});

it("runs every package whole when a fixture changes", () => {
  expect(wholeProjects(["fixtures/watch/snapshot-calm.json"], dependencies)).toEqual(
    [...dependencies.keys()].sort(),
  );
});
