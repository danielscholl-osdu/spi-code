// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import * as ts from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/sync";
import { afterAll, beforeAll, expect, it } from "vitest";
import { directoryPaths } from "./directory-paths.test.js";

const directoryApis = new Set([
  "readdir",
  "readdirSync",
  "glob",
  "globSync",
  "opendir",
  "opendirSync",
]);
const fsModules = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);
const virtualRoot = `${process.cwd().replaceAll("\\", "/")}/build/window-scan-guard`;
const configPath = `${virtualRoot}/tsconfig.json`;
const fs = createVirtualFileSystem({
  [configPath]: JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, types: [], jsx: "preserve" },
    files: ["scan.test.ts", "scan.test.tsx"],
  }),
  [`${virtualRoot}/scan.test.ts`]: "",
  [`${virtualRoot}/scan.test.tsx`]: "",
});
let api: API;

beforeAll(() => {
  api = new API({ fs });
  api.updateSnapshot({ openProjects: [configPath] }).dispose();
});
afterAll(() => api.close());

/** Ban enumeration primitives, including shallow reads that could form a recursive walk. */
function directDirectoryApis(source: string, extension = ".tsx"): string[] {
  const sourcePath = `${virtualRoot}/scan.test${extension}`;
  fs.writeFile?.(sourcePath, source);
  const snapshot = api.updateSnapshot({ fileChanges: { changed: [sourcePath] } });
  api.clearSourceFileCache();
  const found = new Set<string>();
  function record(name: string): void {
    if (directoryApis.has(name)) found.add(name);
  }
  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      fsModules.has(node.moduleSpecifier.text)
    ) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements)
          record((specifier.propertyName ?? specifier.name).text);
      }
    }
    // Check references too: assigning a method to an alias must not hide a later call.
    if (ts.isPropertyAccessExpression(node)) record(node.name.text);
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLikeNode(node.argumentExpression)) {
      record(node.argumentExpression.text);
    }
    if (ts.isBindingElement(node)) {
      let name: ts.Node | undefined = node.propertyName ?? node.name;
      if (name && ts.isComputedPropertyName(name)) name = name.expression;
      if (name && (ts.isIdentifier(name) || ts.isStringLiteralLikeNode(name))) record(name.text);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) record(node.expression.text);
    node.forEachChild(visit);
  }
  try {
    const project = snapshot.getProject(configPath);
    const file = project?.program.getSourceFile(sourcePath);
    if (!file) throw new Error("Missing scan guard source file");
    expect(file.text).toBe(source);
    expect(project?.program.getSyntacticDiagnostics(sourcePath)).toEqual([]);
    visit(file);
    return [...found].sort();
  } finally {
    snapshot.dispose();
  }
}

it("keeps window directory enumeration in the portable directoryPaths helper", () => {
  const root = "apps/window/src";
  const violations = directoryPaths(root)
    .filter((file) => /\.tsx?$/.test(file) && file !== "test-utils/directory-paths.test.ts")
    .flatMap((file) =>
      directDirectoryApis(
        readFileSync(`${root}/${file}`, "utf8"),
        file.endsWith(".tsx") ? ".tsx" : ".ts",
      ).map((api) => `${file}: ${api}`),
    );
  expect(violations).toEqual([]);
});

it.each([
  [
    "recursive readdirSync",
    'import { readdirSync } from "node:fs"; readdirSync(src, { recursive: true });',
    "readdirSync",
  ],
  ["raw fs.globSync", 'import fs from "node:fs"; fs.globSync("**/*.tsx");', "globSync"],
  [
    "hand-written recursion",
    `
    import * as fs from "node:fs";
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
      }
    }
    walk(src);
  `,
    "readdirSync",
  ],
  [
    "unrelated normalization comment",
    `
    import { readdirSync } from 'node:fs';
    // split(sep).join('/') normalizes an unrelated path.
    readdirSync(src, { recursive: true });
  `,
    "readdirSync",
  ],
  [
    "renamed import",
    'import { readdirSync as scan } from "fs"; scan(src, { recursive: true });',
    "readdirSync",
  ],
  [
    "promise import",
    'import { readdir as scan } from "node:fs/promises"; await scan(src);',
    "readdir",
  ],
  [
    "opendir walk",
    'import { opendir } from "fs/promises"; for await (const entry of await opendir(src)) {}',
    "opendir",
  ],
  ["synchronous opendir", 'const fs = require("node:fs"); fs.opendirSync(src);', "opendirSync"],
  [
    "computed method alias",
    'import * as fs from "node:fs"; const scan = fs["globSync"]; scan("**/*");',
    "globSync",
  ],
  ["destructured alias", 'const { readdirSync: scan } = require("fs"); scan(src);', "readdirSync"],
  [
    "computed destructuring",
    'const { ["opendirSync"]: scan } = require("fs"); scan(src);',
    "opendirSync",
  ],
  [
    "dynamic import",
    'const fs = await import("node:fs"); await fs.promises.readdir(src);',
    "readdir",
  ],
  [
    "promise glob",
    'const fs = await import("node:fs/promises"); for await (const file of fs.glob("**/*")) {}',
    "glob",
  ],
])("rejects %s", (_shape, source, api) => {
  expect(directDirectoryApis(source)).toEqual([api]);
});

it.each([
  'import { directoryPaths } from "./directory-paths.test.js"; directoryPaths(src);',
  "import { directoryPaths as scan } from './directory-paths.test.js'; scan(src);",
  'import fs from "node:fs"; fs.readFileSync(path, "utf8");',
  `// fs.globSync("**/*"); readdirSync(src, { recursive: true });
   const example = 'fs.opendirSync(src)';`,
])("allows helper use, file reads and examples: %s", (source) => {
  expect(directDirectoryApis(source)).toEqual([]);
});

it("parses TypeScript files with their own grammar", () => {
  expect(directDirectoryApis("const identity = <T>(value: T) => value;", ".ts")).toEqual([]);
});
