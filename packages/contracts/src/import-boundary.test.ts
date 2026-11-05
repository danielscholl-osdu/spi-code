// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

function forbiddenSpecifier(specifier: string): boolean {
  return (
    /^(electron(?:\/|$)|node:|@spi-code\/host(?:\/|$)|host(?:\/|$))/.test(specifier) ||
    /(?:^|\/)host(?:\/|$)/.test(specifier)
  );
}

function forbiddenImports(source: string): string[] {
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
    return forbiddenSpecifier(value) ? [value] : [];
  });
}

it("keeps runtime contracts free of Electron, Node-only and host imports", () => {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const violations = readdirSync(root, { recursive: true })
    .filter(
      (file): file is string =>
        typeof file === "string" && /\.[cm]?tsx?$/.test(file) && !/\.test\.[cm]?tsx?$/.test(file),
    )
    .flatMap((file) =>
      forbiddenImports(readFileSync(`${root}/${file}`, "utf8")).map(
        (specifier) => `${file}: ${specifier}`,
      ),
    );
  expect(violations).toEqual([]);

  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const section of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    expect(Object.keys(manifest[section] ?? {}).filter(forbiddenSpecifier)).toEqual([]);
  }
});

it.each([
  ['import { app } from "electron";', "electron"],
  ['import type { X } from "electron/main";', "electron/main"],
  ['export * from "node:fs";', "node:fs"],
  ['const host = import("@spi-code/host");', "@spi-code/host"],
  ['const host = require("../../host/src/index.js");', "../../host/src/index.js"],
  ['type Host = import("@spi-code/host").Host;', "@spi-code/host"],
  ['import fs = require("node:fs");', "node:fs"],
])("detects planted forbidden imports: %s", (source, specifier) => {
  expect(forbiddenImports(source)).toEqual([specifier]);
});

it("does not mistake comments or strings for imports", () => {
  expect(
    forbiddenImports(
      '// import "electron";\nconst example = \'import "node:fs";\';\nimport { z } from "zod";',
    ),
  ).toEqual([]);
});
