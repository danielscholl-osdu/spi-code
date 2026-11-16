// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import config from "../vitest.config.js";
import {
  designReaders,
  restProjects,
  wholeProjects,
  workspaceDependencies,
} from "./check-dependents.mjs";
import { configuredProjects } from "./vitest-projects.mjs";

const dependencies = workspaceDependencies(fileURLToPath(new URL("..", import.meta.url)));

it("reads which workspace packages depend on which", () => {
  expect(dependencies.get("packages/host")).toEqual(
    expect.arrayContaining(["packages/contracts", "packages/core", "packages/tools"]),
  );
  expect(dependencies.get("packages/contracts")).toEqual([]);
});

it("runs whole every package that depends, directly or not, on a changed one", () => {
  expect(wholeProjects(["packages/core/test/releases.test.ts"], dependencies)).toEqual([
    "apps/desktop",
    "packages/host",
  ]);
  expect(wholeProjects(["packages/contracts/src/watch/today.test.ts"], dependencies)).toEqual([
    "apps/desktop",
    "apps/window",
    "packages/core",
    "packages/host",
    "packages/tools",
  ]);
});

it("runs a dependent whole even when it has changes of its own", () => {
  expect(
    wholeProjects(
      ["packages/core/README.md", "packages/host/src/watch/project.test.ts"],
      dependencies,
    ),
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

it("runs every package and the script tests whole when a file the watch fixture generator loads or reads changes", () => {
  for (const path of [
    "packages/core/src/brief/places.ts",
    "packages/core/package.json",
    "packages/core/test/fixtures/rib-59d6895/facts.json",
    "packages/host/src/watch/project.ts",
    "packages/host/test/watch/snapshot-fixture.ts",
    "pnpm-lock.yaml",
    "scripts/watch-snapshot.mjs",
  ]) {
    expect(wholeProjects([path], dependencies), path).toEqual(
      [...dependencies.keys(), "scripts"].sort(),
    );
  }
});

it("runs only the dependents of a package file the watch fixture generator neither loads nor reads", () => {
  for (const path of ["packages/tools/src/git/installer.ts", "packages/tools/package.json"])
    expect(wholeProjects([path], dependencies), path).toEqual(["apps/desktop", "packages/host"]);
  for (const path of [
    "packages/host/src/copilot/runtime.ts",
    "packages/host/src/setup/signin.ts",
    "packages/host/src/watch/README.md",
    "packages/host/src/watch/project.test.ts",
  ])
    expect(wholeProjects([path], dependencies), path).toEqual(["apps/desktop"]);
});

it("runs whole the projects whose tests read a changed design page, and no other", () => {
  expect(wholeProjects(["design/spi-code-visual-design.html"], dependencies)).toEqual([
    "apps/window",
  ]);
  expect(wholeProjects(["design/spi-code-prd.md"], dependencies)).toEqual(["packages/host"]);
});

it("runs nothing whole for a design page no test reads", () => {
  expect(wholeProjects(["design/spi-code-window-layout.html"], dependencies)).toEqual([]);
});

it("leaves to the import-following run every project that does not run whole", () => {
  const whole = wholeProjects(["packages/core/README.md"], dependencies);
  const rest = restProjects(whole, dependencies);

  expect(rest).toEqual([
    "apps/window",
    "packages/contracts",
    "packages/core",
    "packages/tools",
    "scripts",
  ]);
  expect(rest.filter((project) => whole.includes(project))).toEqual([]);
  expect(
    restProjects(wholeProjects(["fixtures/watch/snapshot-calm.json"], dependencies), dependencies),
  ).toEqual([]);
});

it("knows every project vitest is configured with, so none is left out of both runs", () => {
  const configured = configuredProjects(config.test?.projects).map((project) => project.name);

  expect([...dependencies.keys(), "scripts"].sort()).toEqual([...configured].sort());
});

it("skips a test the working tree deleted but the index still lists", () => {
  const root = mkdtempSync(join(tmpdir(), "design-readers-"));
  try {
    mkdirSync(join(root, "apps/window"), { recursive: true });
    writeFileSync(join(root, "apps/window/gone.test.ts"), 'read("design/page.html");\n');
    writeFileSync(join(root, "apps/window/kept.test.ts"), 'read("design/other.html");\n');
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    rmSync(join(root, "apps/window/gone.test.ts"));
    expect(designReaders(root)).toEqual(new Map([["design/other.html", ["apps/window"]]]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
