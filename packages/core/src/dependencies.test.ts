// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
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
  type SourceFile,
  SyntaxKind,
} from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/sync";
import { describe, expect, it } from "vitest";

function inspect(file: SourceFile, noBuiltins: boolean): { forbidden: string[]; modules: number } {
  const found: string[] = [];
  let modules = 0;
  function visit(node: Node): void {
    let specifier: Node | undefined;
    if (isImportDeclaration(node) || isExportDeclaration(node)) {
      specifier = node.moduleSpecifier;
    } else if (isImportEqualsDeclaration(node) && isExternalModuleReference(node.moduleReference)) {
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
    if (specifier) modules += 1;
    if (
      specifier &&
      isStringLiteralLikeNode(specifier) &&
      (/^(?:@keelson(?:\/|$)|keelson(?:\/|$)|bun(?:[:/]|$)|electron(?:\/|$))/.test(
        specifier.text,
      ) ||
        (noBuiltins &&
          (specifier.text.startsWith("node:") || builtinModules.includes(specifier.text))))
    ) {
      found.push(specifier.text);
    }
    node.forEachChild(visit);
  }
  visit(file);
  return { forbidden: found, modules };
}

function analyze(
  sources: readonly { path: string; source: string }[],
  noBuiltins = false,
): { path: string; forbidden: string[]; modules: number }[] {
  const directory = dirname(fileURLToPath(import.meta.url));
  const configPath = join(directory, "dependency-lint.virtual.json").replaceAll("\\", "/");
  const files = sources.map(({ path, source }) => [path.replaceAll("\\", "/"), source] as const);
  const api = new API({
    fs: createVirtualFileSystem({
      [configPath]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true, types: [] },
        files: files.map(([path]) => path),
      }),
      ...Object.fromEntries(files),
    }),
  });
  try {
    using snapshot = api.updateSnapshot({ openProjects: [configPath] });
    const program = snapshot.getProject(configPath)?.program;
    return sources.map(({ path }) => {
      const file = program?.getSourceFile(path.replaceAll("\\", "/"));
      if (!file) throw new Error(`Could not parse dependency-lint source: ${path}`);
      return { path, ...inspect(file, noBuiltins) };
    });
  } finally {
    api.close();
  }
}

function forbiddenImports(source: string, jsx = false, noBuiltins = false): string[] {
  const directory = dirname(fileURLToPath(import.meta.url));
  const path = join(directory, jsx ? "dependency-lint.virtual.tsx" : "dependency-lint.virtual.ts");
  return analyze([{ path, source }], noBuiltins).flatMap((result) => result.forbidden);
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[cm]?tsx?$/.test(entry.name) ? [path] : [];
  });
}

function scan(files: string[]): { violations: string[]; modules: number } {
  let modules = 0;
  const results = analyze(files.map((path) => ({ path, source: readFileSync(path, "utf8") })));
  const violations = results.flatMap((result) => {
    modules += result.modules;
    return result.forbidden.map((name) => `${result.path}: ${name}`);
  });
  return { violations, modules };
}

describe("plain Node dependency boundary", () => {
  it("scans every core source file", () => {
    const root = dirname(fileURLToPath(import.meta.url));
    const files = sourceFiles(root);
    const library = files.filter((path) => !path.endsWith(".test.ts"));
    expect(library.length).toBeGreaterThanOrEqual(30);
    const result = scan(files);
    expect(result.modules).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
  });

  it("keeps notes parsing free of Node built-ins", () => {
    const path = join(dirname(fileURLToPath(import.meta.url)), "notes.ts");
    expect(forbiddenImports(readFileSync(path, "utf8"), false, true)).toEqual([]);
  });

  it.each(["node:fs", "fs", "node:path"])("rejects planted notes %s built-ins", (name) => {
    expect(forbiddenImports(`import * as io from "${name}";`, false, true)).toEqual([name]);
  });

  it.each(
    ["@keelson/shared", "keelson", "bun", "bun:test", "electron"].flatMap((name) =>
      (
        [
          ["static", `import { value } from "${name}";`],
          ["type-only", `import type { Value } from "${name}";`],
          ["re-export", `export { value } from "${name}";`],
          ["dynamic", `const value = import("${name}");`],
          ["require", `const value = require("${name}");`],
          ["import-type", `type Value = import("${name}").Value;`],
          ["import-equals", `import value = require("${name}");`],
        ] as const
      ).map(([form, source]) => ({ name, form, source })),
    ),
  )("rejects planted $name $form imports", ({ name, source }) => {
    expect(forbiddenImports(source)).toEqual([name]);
  });

  it("keeps per-file results and JSX parsing when batching sources", () => {
    const directory = dirname(fileURLToPath(import.meta.url));
    const ts = join(directory, "dependency-lint.batch.ts");
    const tsx = join(directory, "dependency-lint.batch.tsx");
    expect(
      analyze([
        { path: ts, source: 'import { readFileSync } from "node:fs"; import("bun:test");' },
        {
          path: tsx,
          source: 'const view = <div>require("bun"){import("electron")}</div>;',
        },
      ]),
    ).toEqual([
      { path: ts, forbidden: ["bun:test"], modules: 2 },
      { path: tsx, forbidden: ["electron"], modules: 1 },
    ]);
  });

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
