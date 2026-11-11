// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { sourceFiles } from "./source-files.test-helper.js";

const root = "apps/window/src";

it("lists window sources with / separators", () => {
  const files = sourceFiles(root);
  expect(files).toContain("test-utils/source-files.test-helper.ts");
  expect(files.filter((file) => file.includes("\\"))).toEqual([]);
});

it("walks window sources only through sourceFiles, so path checks hold on Windows", () => {
  const raw = sourceFiles(root).filter(
    (file) =>
      /\.test(-helper)?\.tsx?$/.test(file) &&
      file !== "test-utils/source-files.test-helper.ts" &&
      /\breaddir(Sync)?\([^)]*\brecursive\b/.test(readFileSync(`${root}/${file}`, "utf8")),
  );
  expect(raw).toEqual([]);
});
