// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function forbiddenImports(source: string): string[] {
  const tokens = (
    source.match(
      /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g,
    ) ?? []
  ).filter((token) => !token.startsWith("//") && !token.startsWith("/*"));
  const found: string[] = [];
  for (const [index, token] of tokens.entries()) {
    if (!/^["'`]/.test(token)) continue;
    const previous = tokens[index - 1];
    const callable = tokens[index - 2];
    const isImport =
      previous === "from" ||
      previous === "import" ||
      (previous === "(" && (callable === "import" || callable === "require"));
    const name = token.slice(1, -1);
    if (isImport && /^(?:@keelson(?:\/|$)|bun(?:[:/]|$)|electron(?:\/|$))/.test(name)) {
      found.push(name);
    }
  }
  return found;
}

function scan(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return scan(path);
    if (!/\.[cm]?tsx?$/.test(entry.name)) return [];
    return forbiddenImports(readFileSync(path, "utf8")).map((name) => `${path}: ${name}`);
  });
}

describe("plain Node dependency boundary", () => {
  it("scans every core source file", () => {
    expect(scan(dirname(fileURLToPath(import.meta.url)))).toEqual([]);
  });

  it.each(["@keelson/shared", "bun", "bun:test", "electron"])(
    "rejects planted %s imports",
    (name) => {
      for (const source of [
        `import { value } from "${name}";`,
        `import type { Value } from "${name}";`,
        `export { value } from "${name}";`,
        `const value = import("${name}");`,
        `const value = require("${name}");`,
        `type Value = import("${name}").Value;`,
        `import value = require("${name}");`,
      ]) {
        expect(forbiddenImports(source)).toEqual([name]);
      }
    },
  );

  it("allows Node, pinned dependencies and mentions in comments or strings", () => {
    expect(
      forbiddenImports(`
        import { readFileSync } from "node:fs";
        import { z } from "zod";
        import { parse } from "yaml";
        // import { value } from "@keelson/shared";
        const example = 'import { value } from "bun:test";';
      `),
    ).toEqual([]);
  });
});
