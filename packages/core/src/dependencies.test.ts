// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportTypeNode,
  isLiteralTypeNode,
  isStringLiteralLikeNode,
  type Node,
  SyntaxKind,
} from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/sync";
import { describe, expect, it } from "vitest";

function forbiddenImports(source: string, jsx = false): string[] {
  const directory = dirname(fileURLToPath(import.meta.url));
  const configPath = join(directory, "dependency-lint.virtual.json");
  const path = join(directory, jsx ? "dependency-lint.virtual.tsx" : "dependency-lint.virtual.ts");
  const api = new API({
    fs: createVirtualFileSystem({
      [configPath]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true, types: [] },
        files: [path],
      }),
      [path]: source,
    }),
  });
  try {
    using snapshot = api.updateSnapshot({ openProjects: [configPath] });
    const file = snapshot.getProject(configPath)?.program.getSourceFile(path);
    if (!file) throw new Error(`Could not parse dependency-lint source: ${path}`);
    const found: string[] = [];
    function visit(node: Node): void {
      let specifier: Node | undefined;
      if (isImportDeclaration(node) || isExportDeclaration(node)) {
        specifier = node.moduleSpecifier;
      } else if (
        isImportEqualsDeclaration(node) &&
        isExternalModuleReference(node.moduleReference)
      ) {
        specifier = node.moduleReference.expression;
      } else if (
        isCallExpression(node) &&
        (node.expression.kind === SyntaxKind.ImportKeyword ||
          (isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        specifier = node.arguments[0];
      } else if (isImportTypeNode(node) && isLiteralTypeNode(node.argument)) {
        specifier = node.argument.literal;
      }
      if (
        specifier &&
        isStringLiteralLikeNode(specifier) &&
        /^(?:@keelson(?:\/|$)|keelson(?:\/|$)|bun(?:[:/]|$)|electron(?:\/|$))/.test(specifier.text)
      ) {
        found.push(specifier.text);
      }
      node.forEachChild(visit);
    }
    visit(file);
    return found;
  } finally {
    api.close();
  }
}

function scan(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return scan(path);
    if (!/\.[cm]?tsx?$/.test(entry.name)) return [];
    return forbiddenImports(readFileSync(path, "utf8"), entry.name.endsWith(".tsx")).map(
      (name) => `${path}: ${name}`,
    );
  });
}

describe("plain Node dependency boundary", () => {
  it("scans every core source file", () => {
    expect(scan(dirname(fileURLToPath(import.meta.url)))).toEqual([]);
  });

  it.each(["@keelson/shared", "keelson", "bun", "bun:test", "electron"])(
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

  it("decodes escaped module specifiers", () => {
    expect(forbiddenImports(String.raw`import { value } from "@keelson\u002fshared";`)).toEqual([
      "@keelson/shared",
    ]);
  });

  it("walks executable template-literal interpolations", () => {
    expect(forbiddenImports(`const value = \`loaded \${import("electron")}\`;`)).toEqual([
      "electron",
    ]);
  });

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
