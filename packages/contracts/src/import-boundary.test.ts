// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const graph = {
  contracts: { path: "packages/contracts", allows: [] },
  core: { path: "packages/core", allows: ["contracts"] },
  tools: { path: "packages/tools", allows: ["contracts"] },
  host: { path: "packages/host", allows: ["core", "contracts", "tools"] },
  window: { path: "apps/window", allows: ["contracts"] },
} satisfies Record<string, { path: string; allows: string[] }>;
type Package = keyof typeof graph;
const sections = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;
type Manifest = Partial<Record<(typeof sections)[number], Record<string, string>>>;

function forbiddenSpecifier(owner: Package, specifier: string, file: string): boolean {
  if (
    (owner === "contracts" || owner === "window") &&
    /^(electron(?:\/|$)|node:)/.test(specifier)
  ) {
    return true;
  }
  let target = /^@spi-code\/([^/]+)/.exec(specifier)?.[1];
  if (specifier.startsWith(".")) {
    const path = resolve(dirname(file), specifier);
    target = Object.entries(graph).find(([, config]) => {
      const packagePath = resolve(root, config.path);
      return path === packagePath || path.startsWith(`${packagePath}${sep}`);
    })?.[0];
    if (target === owner) return false;
  }
  const allows: readonly string[] = graph[owner].allows;
  return target !== undefined && !allows.includes(target);
}

function forbiddenImports(
  source: string,
  owner: Package = "contracts",
  file = resolve(root, graph[owner].path, "src/index.ts"),
): string[] {
  const tokens = (
    source.match(
      /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[\w$]+|[^\s]/g,
    ) ?? []
  ).filter((token) => !token.startsWith("//") && !token.startsWith("/*"));
  return tokens.flatMap((token, index) => {
    let specifier: string | undefined;
    if (token === "from" || token === "import") {
      specifier = tokens[index + 1];
    }
    if ((token === "import" || token === "require") && tokens[index + 1] === "(") {
      specifier = tokens[index + 2];
    }
    if (!specifier || !/^["'`]/.test(specifier)) {
      return [];
    }
    const value = specifier.slice(1, -1);
    return forbiddenSpecifier(owner, value, file) ? [value] : [];
  });
}

function forbiddenDependencies(owner: Package, manifest: Manifest): string[] {
  return sections.flatMap((section) =>
    Object.entries(manifest[section] ?? {})
      .filter(
        ([specifier, version]) =>
          forbiddenSpecifier(owner, specifier, resolve(root, graph[owner].path, "package.json")) ||
          (version.startsWith("workspace:") &&
            !graph[owner].allows.some((name) => specifier === `@spi-code/${name}`)),
      )
      .map(([specifier]) => specifier),
  );
}

it.each(Object.keys(graph) as Package[])(
  "enforces the D3 package graph for %s runtime imports and manifests",
  (owner) => {
    const sourceRoot = resolve(root, graph[owner].path, "src");
    const violations = readdirSync(sourceRoot, { recursive: true })
      .filter(
        (file): file is string =>
          typeof file === "string" &&
          /\.[cm]?[jt]sx?$/.test(file) &&
          !/\.test\.[cm]?[jt]sx?$/.test(file),
      )
      .flatMap((file) =>
        forbiddenImports(
          readFileSync(`${sourceRoot}/${file}`, "utf8"),
          owner,
          resolve(sourceRoot, file),
        ).map((specifier) => `${file}: ${specifier}`),
      );
    expect(violations).toEqual([]);

    const manifest: Manifest = JSON.parse(
      readFileSync(resolve(root, graph[owner].path, "package.json"), "utf8"),
    );
    expect(forbiddenDependencies(owner, manifest)).toEqual([]);
  },
);

it.each([
  ['import { app } from "electron";', "electron"],
  ['import type { X } from "electron/main";', "electron/main"],
  ['export * from "node:fs";', "node:fs"],
  ['const host = import("@spi-code/host");', "@spi-code/host"],
  ['const host = require("../../host/src/index.js");', "../../host/src/index.js"],
  ['type Host = import("@spi-code/host").Host;', "@spi-code/host"],
  ['import fs = require("node:fs");', "node:fs"],
  ['import { model } from "@spi-code/core";', "@spi-code/core"],
  ['export * from "../../core/src/index.js";', "../../core/src/index.js"],
  ['const core = import("@spi-code/core/model");', "@spi-code/core/model"],
])("detects planted forbidden imports: %s", (source, specifier) => {
  expect(forbiddenImports(source)).toEqual([specifier]);
});

it.each([
  ["contracts", "core"],
  ["contracts", "tools"],
  ["core", "host"],
  ["tools", "core"],
  ["window", "core"],
  ["window", "tools"],
  ["host", "window"],
] as const)("rejects planted %s-to-%s imports and dependencies", (owner, target) => {
  const specifier = `@spi-code/${target}`;
  expect(forbiddenImports(`import "${specifier}";`, owner)).toEqual([specifier]);
  expect(forbiddenDependencies(owner, { dependencies: { [specifier]: "workspace:*" } })).toEqual([
    specifier,
  ]);
});

it("allows exactly the D3 edges, including relative imports", () => {
  for (const owner of Object.keys(graph) as Package[]) {
    for (const target of Object.keys(graph) as Package[]) {
      const specifier = `@spi-code/${target}`;
      expect(forbiddenImports(`export * from "${specifier}";`, owner).length === 0).toBe(
        (graph[owner].allows as readonly string[]).includes(target),
      );
    }
  }
  expect(forbiddenImports('import "../../contracts/src/index.js";', "core")).toEqual([]);
  expect(forbiddenImports('import "./watch/index.js";')).toEqual([]);
});

it("does not mistake comments or strings for imports", () => {
  expect(
    forbiddenImports(
      '// import "electron";\nconst example = \'import "node:fs";\';\nimport { z } from "zod";',
    ),
  ).toEqual([]);
});
