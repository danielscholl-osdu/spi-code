// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { GENERATOR_ROOT, generatorInputs, generatorModules } from "./watch-inputs.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function tree(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "spi-watch-inputs-"));
  directories.push(directory);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text);
  }
  return directory;
}

it("finds every workspace module the generator loads when it runs", () => {
  // Loads the built generator root as scripts/watch-snapshot.mjs does, sending the builders' imports
  // of host source to its built output, and maps each module back to the source it is built from.
  const host = pathToFileURL(join(root, "packages/host/")).href;
  const loaded = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--no-warnings",
      "-e",
      `import { registerHooks } from "node:module";
const host = ${JSON.stringify(host)};
const urls = new Set();
registerHooks({
  resolve(specifier, context, next) {
    let target = specifier;
    if (specifier.startsWith(".") && context.parentURL?.startsWith(host + "build/")) {
      const url = new URL(specifier, context.parentURL).href;
      if (url.startsWith(host + "src/")) target = host + "dist/" + url.slice(host.length + 4);
    }
    const resolved = next(target, context);
    urls.add(resolved.url);
    return resolved;
  },
});
await import(${JSON.stringify(`${host}build/watch/outputs.js`)});
console.log(JSON.stringify([...urls]));`,
    ],
    { cwd: root, encoding: "utf8", env: { ...process.env, TZ: "UTC" } },
  );
  const sources = (JSON.parse(loaded) as string[])
    .filter((url) => url.startsWith("file:"))
    .map((url) => fileURLToPath(url).slice(root.length).split("\\").join("/"))
    .flatMap((path) => {
      const built = /^(packages\/[^/]+)\/(dist|build)\/(.+)\.js$/.exec(path);
      if (!built) return [];
      const [, pkg, folder, rest] = built;
      return [`${pkg}/${folder === "dist" ? "src" : "test"}/${rest}.ts`];
    })
    .sort();

  expect(sources).toContain(GENERATOR_ROOT);
  expect([...generatorModules(root)].sort()).toEqual(sources);
});

it("follows value imports and re-exports into workspace sources, and skips type-only ones", () => {
  const directory = tree({
    "packages/core/package.json": JSON.stringify({
      name: "@x/core",
      exports: { ".": { import: "./dist/index.js" } },
    }),
    "packages/core/src/index.ts": 'export * from "./a.js";\nexport type { T } from "./types.js";\n',
    "packages/core/src/a.ts": 'import {\n  b,\n  type C,\n} from "./b.js";\nexport const a = b;\n',
    "packages/core/src/b.ts": 'import "./side.js";\nexport const b = 1;\n',
    "packages/core/src/side.ts": "",
    "packages/core/src/types.ts": "export type T = 1;\n",
    "packages/core/src/unused.ts": "",
    [GENERATOR_ROOT]:
      'import { a } from "@x/core";\nimport type { Other } from "./other.js";\nimport { readFileSync } from "node:fs";\n',
    "packages/host/test/watch/other.ts": "",
  });

  expect([...generatorModules(directory)].sort()).toEqual([
    "packages/core/src/a.ts",
    "packages/core/src/b.ts",
    "packages/core/src/index.ts",
    "packages/core/src/side.ts",
    GENERATOR_ROOT,
  ]);
  const isInput = generatorInputs(directory);
  expect(isInput("packages/core/package.json")).toBe(true);
  expect(isInput("packages/core/src/unused.ts")).toBe(false);
  expect(isInput("packages/host/test/watch/other.ts")).toBe(false);
});
