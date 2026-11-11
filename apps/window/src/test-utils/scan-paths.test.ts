// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { sep } from "node:path";
import { expect, it } from "vitest";

const root = "apps/window/src";
const walk = /\breaddir(Sync)?\([^)]*\brecursive\b/;
const normalized = 'split(sep).join("/")';

it("makes every recursive source walk in window tests use / separators, as on Windows", () => {
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).map((file) =>
    file.split(sep).join("/"),
  );
  expect(files).toContain("test-utils/scan-paths.test.ts");
  const raw = files.filter((file) => {
    if (!/\.test(-helper)?\.tsx?$/.test(file)) return false;
    const source = readFileSync(`${root}/${file}`, "utf8");
    return walk.test(source) && !source.includes(normalized);
  });
  expect(raw).toEqual([]);
});
