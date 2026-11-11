// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

/** Files below a directory, sorted and relative to it, using '/' on every OS. */
export function directoryPaths(directory: string): string[] {
  const files: string[] = [];
  function visit(relative: string): void {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  visit("");
  return files.sort();
}

it("returns only sorted file paths with '/' separators relative to the walked directory", () => {
  const directory = mkdtempSync(join(tmpdir(), "spi-window-paths-"));
  try {
    mkdirSync(join(directory, "nested", "deeper"), { recursive: true });
    mkdirSync(join(directory, "empty"));
    writeFileSync(join(directory, "root.ts"), "");
    writeFileSync(join(directory, "nested", "deeper", "leaf.tsx"), "");
    writeFileSync(join(directory, "nested", "style.css"), "");
    expect(directoryPaths(directory)).toEqual([
      "nested/deeper/leaf.tsx",
      "nested/style.css",
      "root.ts",
    ]);
    expect(directoryPaths(join(directory, "empty"))).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
