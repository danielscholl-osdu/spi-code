// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

function packageOf(file: string): string | undefined {
  return /^(?:packages|apps)\/[^/]+/.exec(relative(root, file).split(sep).join("/"))?.[0];
}

function distImports(file: string, source: string): string[] {
  const tokens = (
    source.match(
      /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[\w$]+|[^\s]/g,
    ) ?? []
  ).filter((token) => !token.startsWith("//") && !token.startsWith("/*"));
  return tokens.flatMap((token, index) => {
    let specifier: string | undefined;
    if (token === "from" || token === "import") specifier = tokens[index + 1];
    if ((token === "import" || token === "require") && tokens[index + 1] === "(") {
      specifier = tokens[index + 2];
    }
    if (!specifier || !/^["'`]\.\.?\//.test(specifier)) return [];
    const value = specifier.slice(1, -1);
    const target = resolve(dirname(file), value);
    const targetPackage = packageOf(target);
    return targetPackage !== undefined &&
      targetPackage !== packageOf(file) &&
      /^dist(?:\/|$)/.test(relative(resolve(root, targetPackage), target).split(sep).join("/"))
      ? [value]
      : [];
  });
}

it("uses package exports instead of relative imports into another workspace's dist", () => {
  const violations = ["packages", "apps"].flatMap((container) =>
    readdirSync(join(root, container), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const directory = join(root, container, entry.name, "src");
        if (!existsSync(directory)) return [];
        return readdirSync(directory, { recursive: true })
          .filter(
            (file): file is string => typeof file === "string" && /\.[cm]?[jt]sx?$/.test(file),
          )
          .flatMap((file) => {
            const path = join(directory, file);
            return distImports(path, readFileSync(path, "utf8")).map(
              (specifier) => `${relative(root, path)}: ${specifier}`,
            );
          });
      }),
  );
  expect(violations).toEqual([]);
});

it.each([
  'import { GraphqlBudget } from "../../../core/dist/forge.js";',
  'export * from "../../../core/dist/index.js";',
  'import "../../../core/dist/index.js";',
  'const core = import("../../../core/dist/index.js");',
  'const core = require("../../../core/dist/index.js");',
  'type Budget = import("../../../core/dist/index.js").GraphqlBudget;',
])("rejects cross-package dist imports: %s", (source) => {
  expect(distImports(resolve(root, "packages/host/src/sweep/service.ts"), source)).toHaveLength(1);
});

it("also rejects imports across the apps and packages roots", () => {
  expect(
    distImports(
      resolve(root, "apps/desktop/src/index.ts"),
      'import "../../../packages/host/dist/main.js";',
    ),
  ).toEqual(["../../../packages/host/dist/main.js"]);
  expect(
    distImports(
      resolve(root, "packages/host/src/index.ts"),
      'export * from "../../../apps/window/dist/index.js";',
    ),
  ).toEqual(["../../../apps/window/dist/index.js"]);
});

it("allows package imports and same-package fixtures without matching comments or strings", () => {
  expect(
    distImports(
      resolve(root, "packages/host/src/sweep/holder.mjs"),
      `import { GraphqlBudget } from "@spi-code/core";
import { SweepService } from "../../dist/sweep/service.js";
// import "../../../core/dist/forge.js";
/* export * from "../../../core/dist/index.js"; */
const example = 'import "../../../core/dist/forge.js";';`,
    ),
  ).toEqual([]);
});
