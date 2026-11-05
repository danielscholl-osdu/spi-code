// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isArrayLiteralExpression,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isExportDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isVariableStatement,
  type Node,
  NodeFlags,
  SyntaxKind,
} from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/sync";
import { describe, expect, test } from "vitest";

function violations(source: string): string[] {
  const path = join(dirname(fileURLToPath(import.meta.url)), "boundary.virtual.ts");
  const config = `${path}.json`;
  const api = new API({
    fs: createVirtualFileSystem({
      [config]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true, types: [] },
        files: [path],
      }),
      [path]: source,
    }),
  });
  try {
    using snapshot = api.updateSnapshot({ openProjects: [config] });
    const file = snapshot.getProject(config)?.program.getSourceFile(path);
    if (!file) throw new Error(`Could not parse context boundary: ${path}`);
    const found: string[] = [];
    const bindings = new Set<string>();
    function unwrap(node: Node): Node {
      return isAsExpression(node) || isParenthesizedExpression(node)
        ? unwrap(node.expression)
        : node;
    }
    function root(node: Node): string | undefined {
      if (isIdentifier(node)) return node.text;
      return isPropertyAccessExpression(node) || isElementAccessExpression(node)
        ? root(node.expression)
        : undefined;
    }
    for (const statement of file.statements) {
      const exported =
        (isFunctionDeclaration(statement) || isVariableStatement(statement)) &&
        statement.modifiers?.some((m) => m.kind === SyntaxKind.ExportKeyword);
      if (
        isExportDeclaration(statement) &&
        /\bset[A-Z]/.test(statement.exportClause?.getText(file) ?? "")
      ) {
        found.push("exported setter alias");
      }
      if (
        exported &&
        isFunctionDeclaration(statement) &&
        /^set[A-Z]/.test(statement.name?.text ?? "")
      ) {
        found.push(`exported setter: ${statement.name?.text}`);
      }
      if (!isVariableStatement(statement)) continue;
      if (!(statement.declarationList.flags & NodeFlags.Const)) found.push("module-scope let/var");
      for (const declaration of statement.declarationList.declarations) {
        if (!isIdentifier(declaration.name)) continue;
        const name = declaration.name.text;
        bindings.add(name);
        if (exported && /^set[A-Z]/.test(name)) found.push(`exported setter: ${name}`);
        const initializer = declaration.initializer && unwrap(declaration.initializer);
        if (!initializer) continue;
        const frozen =
          isCallExpression(initializer) && initializer.expression.getText(file) === "Object.freeze";
        const value =
          frozen && initializer.arguments[0] ? unwrap(initializer.arguments[0]) : initializer;
        const collection =
          frozen ||
          isArrayLiteralExpression(value) ||
          isObjectLiteralExpression(value) ||
          (isNewExpression(value) &&
            /^(Map|Set|Array|Object)$/.test(value.expression.getText(file)));
        if (!collection) continue;
        const readonly = /\breadonly\b|\bReadonly(Array|Map|Set)\b/.test(
          declaration.type?.getText(file) ?? "",
        );
        if (!frozen && !readonly) found.push(`mutable module collection: ${name}`);
      }
    }
    function visit(node: Node): void {
      if (isPropertyAccessExpression(node)) {
        const text = node.getText(file);
        if (text === "process.env" || text === "Date.now") found.push(text);
      }
      if (
        isNewExpression(node) &&
        node.expression.getText(file) === "Date" &&
        !node.arguments?.length
      ) {
        found.push("ambient new Date()");
      }
      if (
        isCallExpression(node) &&
        isPropertyAccessExpression(node.expression) &&
        /^(push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin|set|add|delete|clear)$/.test(
          node.expression.name.text,
        ) &&
        bindings.has(root(node.expression.expression) ?? "")
      ) {
        found.push(`module collection mutation: ${node.expression.getText(file)}`);
      }
      if (
        isBinaryExpression(node) &&
        node.operatorToken.kind >= SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= SyntaxKind.LastAssignment &&
        bindings.has(root(node.left) ?? "")
      ) {
        found.push(`module collection assignment: ${node.left.getText(file)}`);
      }
      if (
        (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)) &&
        (node.operator === SyntaxKind.PlusPlusToken ||
          node.operator === SyntaxKind.MinusMinusToken) &&
        bindings.has(root(node.operand) ?? "")
      )
        found.push("module collection increment");
      node.forEachChild(visit);
    }
    visit(file);
    return found;
  } finally {
    api.close();
  }
}

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("core context static boundary", () => {
  test("scans every source except the clock and environment adapters", () => {
    const root = fileURLToPath(new URL("../src/", import.meta.url));
    const files = sources(root).filter(
      (path) => !["clock.ts", "environment.ts"].some((adapter) => path === join(root, adapter)),
    );
    expect(files.length).toBeGreaterThanOrEqual(35);
    expect(
      files.flatMap((path) => violations(readFileSync(path, "utf8")).map((v) => `${path}: ${v}`)),
    ).toEqual([]);
  });

  test.each([
    ["let active = 1;", "module-scope let/var"],
    ["var active = 1;", "module-scope let/var"],
    ["export function setFleet() {}", "exported setter: setFleet"],
    ["export const setFleet = () => {};", "exported setter: setFleet"],
    ["function update() {} export { update as setFleet };", "exported setter alias"],
    ["const fleet = []; ", "mutable module collection: fleet"],
    [
      "const fleet: ReadonlyArray<string> = []; export function append() { fleet.push('a'); }",
      "module collection mutation: fleet.push",
    ],
    [
      "const fleet: ReadonlyMap<string, string> = new Map(); fleet.set('a', 'b');",
      "module collection mutation: fleet.set",
    ],
    [
      "const fleet: ReadonlySet<string> = new Set(); export function append() { fleet.add('a'); }",
      "module collection mutation: fleet.add",
    ],
    [
      "const fleet = Object.freeze({ count: 1 }); export function write() { fleet.count = 2; }",
      "module collection assignment: fleet.count",
    ],
    [
      "function makeState() { return { count: 0 }; } const state = makeState(); export function update() { state.count++; return state.count; }",
      "module collection increment",
    ],
    [
      "function makeState() { return { count: 0 }; } const state = makeState(); export function update() { state.count = 1; }",
      "module collection assignment: state.count",
    ],
    [
      "function makeState() { return []; } const state = makeState(); export function update() { state.push('a'); }",
      "module collection mutation: state.push",
    ],
    ["const env = process.env;", "process.env"],
    ["export function now() { return Date.now(); }", "Date.now"],
    ["export function now() { return new Date(); }", "ambient new Date()"],
  ])("rejects a planted violation: %s", (source, expected) => {
    expect(violations(source)).toContain(expected);
  });

  test("allows local state, frozen constants and explicitly supplied dates", () => {
    expect(
      violations(`
      const fleet = Object.freeze(['a']);
      const states: ReadonlySet<string> = new Set(['ok']);
      function makeState() { return { count: 0 }; }
      const state = Object.freeze(makeState());
      export function build(at: string) {
        let n = 0; const list = []; list.push(fleet[0]); n++;
        return [list, new Date(at), n, states.has('ok'), state.count];
      }
    `),
    ).toEqual([]);
  });
});
