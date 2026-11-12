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

it("runs a dependent whole even when it has changes of its own", () => {
  expect(
    wholeProjects(["packages/core/src/brief/places.ts", "packages/host/README.md"], dependencies),
  ).toEqual(["apps/desktop", "packages/host"]);
});

it("runs nothing whole for a change no other package depends on", () => {
  expect(wholeProjects(["apps/window/src/views/today/Band.tsx"], dependencies)).toEqual([]);
  expect(wholeProjects(["scripts/rib-oracle.ts", "docs/sdlc.md"], dependencies)).toEqual([]);
});

it("runs the script tests whole when a script that is not TypeScript changes", () => {
  expect(wholeProjects(["scripts/check"], dependencies)).toEqual(["scripts"]);
  expect(wholeProjects(["scripts/package.mjs"], dependencies)).toEqual(["scripts"]);
});

it("runs every package and the script tests whole when a fixture changes", () => {
  expect(wholeProjects(["fixtures/rib-59d6895/oracle/lines.json"], dependencies)).toEqual(
    [...dependencies.keys(), "scripts"].sort(),
  );
});
