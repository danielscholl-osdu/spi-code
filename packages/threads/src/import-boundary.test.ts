// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../package.json", import.meta.url));
const directory = dirname(root);

function forbidden(specifier: string, file: string): boolean {
  if (/^(?:@spi-code\/|electron(?:$|\/|:)|node:electron(?:$|\/))/.test(specifier)) return true;
  if (!specifier.startsWith(".")) return false;
  const target = resolve(dirname(file), specifier);
  return target !== directory && !target.startsWith(`${directory}${sep}`);
}

function imports(source: string): string[] {
  const tokens =
    source.match(
      /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[\w$]+|[^\s]/g,
    ) ?? [];
  const code = tokens.filter((token) => !token.startsWith("//") && !token.startsWith("/*"));
  return code.flatMap((token, i) => {
    const next = code[i + 1];
    const value =
      (token === "import" || token === "require") && next === "("
        ? code[i + 2]
        : token === "import" || token === "from"
          ? next
          : undefined;
    return value && /^["'`]/.test(value) ? [value.slice(1, -1)] : [];
  });
}

function* sources(dir: string): Iterable<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !["node_modules", "dist", "build"].includes(entry.name))
      yield* sources(path);
    if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) yield path;
  }
}

it("keeps threads independent of SPI Code and Electron", () => {
  const violations = [...sources(directory)].flatMap((file) =>
    imports(readFileSync(file, "utf8"))
      .filter((specifier) => forbidden(specifier, file))
      .map((specifier) => `${file}: ${specifier}`),
  );
  expect(violations).toEqual([]);
  const manifest = JSON.parse(readFileSync(root, "utf8"));
  for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"])
    expect(
      Object.keys(manifest[key] ?? {}).filter((specifier) => forbidden(specifier, root)),
    ).toEqual([]);
});
