// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { watchOutputs } from "../packages/host/test/watch/outputs.js";
import { staleBuild } from "./watch-snapshot.mjs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const generator = fileURLToPath(new URL("./watch-snapshot.mjs", import.meta.url));
const tsc = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
const manifest = [...new Set(watchOutputs.map(({ path }) => path))].sort();

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function scratch(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "spi-watch-snapshot-")));
  directories.push(directory);
  return directory;
}
const filesUnder = (root: string) =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(root.length + 1)
        .replaceAll("\\", "/"),
    )
    .sort();

it("lets land without review exactly the files the watch fixture manifest names", () => {
  const unreviewed = /generated=\(\n([^)]*)\)/.exec(read("./land"))?.[1]?.trim().split(/\s+/);

  expect(manifest.length).toBeGreaterThan(0);
  expect(unreviewed).toEqual(manifest);
});

it("writes exactly the files in the manifest", () => {
  const root = scratch();
  execFileSync(process.execPath, [generator, root], {
    env: { ...process.env, TZ: "UTC" },
    stdio: "pipe",
  });

  expect(filesUnder(root)).toEqual(manifest);
});

describe("a stale build", () => {
  /**
   * The five projects the generator loads, built by tsc, whose manifest writes one file holding
   * what the host's built source exports.
   */
  function tree(): string {
    const root = scratch();
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    const project = (rootDir: string, outDir: string, references: string[] = []) =>
      JSON.stringify({
        compilerOptions: {
          composite: true,
          rootDir,
          outDir,
          module: "NodeNext",
          target: "ES2022",
          types: [],
        },
        include: [`${rootDir}/**/*.ts`],
        references: references.map((path) => ({ path })),
      });
    write("package.json", JSON.stringify({ type: "module" }));
    for (const name of ["contracts", "tools"]) {
      write(`packages/${name}/tsconfig.json`, project("src", "dist"));
      write(`packages/${name}/src/index.ts`, "export {};\n");
    }
    write("packages/core/tsconfig.build.json", project("src", "dist"));
    write("packages/core/src/index.ts", "export {};\n");
    write(
      "packages/host/tsconfig.build.json",
      project("src", "dist", ["../contracts", "../core/tsconfig.build.json", "../tools"]),
    );
    write("packages/host/src/index.ts", "export const value = 1;\n");
    write("packages/host/test/tsconfig.json", project(".", "../build", ["../tsconfig.build.json"]));
    write(
      "packages/host/test/watch/outputs.ts",
      `import { value } from "../../src/index.js";
export const watchOutputs = [{ path: "fixtures/watch/x.json", value: () => value }];\n`,
    );
    execFileSync(process.execPath, [tsc, "-b", "packages/host/test"], { cwd: root, stdio: "pipe" });
    return root;
  }

  function generate(build: string) {
    const out = scratch();
    const run = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { generate } = await import(${JSON.stringify(new URL("./watch-snapshot.mjs", import.meta.url).href)});
await generate(${JSON.stringify(out)}, ${JSON.stringify(build)});`,
      ],
      { encoding: "utf8", env: { ...process.env, TZ: "UTC" } },
    );
    return { status: run.status, stderr: run.stderr, written: filesUnder(out), out };
  }

  it("writes from a build tsc reports current, through the host's built modules", () => {
    const build = tree();

    expect(staleBuild(build)).toBeUndefined();
    const { status, written, out } = generate(build);
    expect(status).toBe(0);
    expect(written).toEqual(["fixtures/watch/x.json"]);
    expect(readFileSync(join(out, "fixtures/watch/x.json"), "utf8")).toBe("1\n");
  });

  it.each([
    ["packages/host/src/index.ts", "export const value = 2;\n"],
    ["packages/host/test/watch/outputs.ts", "export const watchOutputs = [];\n"],
  ])("refuses, naming pnpm build, when %s changed after the build", (path, text) => {
    const build = tree();
    writeFileSync(join(build, path), text);

    expect(staleBuild(build)).toMatch(/would build/);
    const { status, stderr, written } = generate(build);
    expect(status).not.toBe(0);
    expect(stderr).toContain("pnpm build");
    expect(written).toEqual([]);
  });

  it("refuses, naming pnpm build, when an older emitted module is restored after a build", () => {
    const build = tree();
    const module = join(build, "packages/host/dist/index.js");
    const older = { text: readFileSync(module), time: statSync(module).mtime };
    writeFileSync(join(build, "packages/host/src/index.ts"), "export const value = 2;\n");
    execFileSync(process.execPath, [tsc, "-b", "packages/host/test"], {
      cwd: build,
      stdio: "pipe",
    });
    writeFileSync(module, older.text);
    utimesSync(module, older.time, older.time);

    expect(staleBuild(build)).toMatch(/dist\/index\.js is not built from the current/);
    const { status, stderr, written } = generate(build);
    expect(status).not.toBe(0);
    expect(stderr).toContain("pnpm build");
    expect(written).toEqual([]);
  });

  it("refuses, naming pnpm build, when a source changed after the build keeps its old mtime", () => {
    const build = tree();
    const source = join(build, "packages/host/src/index.ts");
    const { atime, mtime } = statSync(source);
    writeFileSync(source, "export const value = 2;\n");
    utimesSync(source, atime, mtime);

    expect(staleBuild(build)).toMatch(/dist\/index\.js is not built from the current/);
    const { status, stderr, written } = generate(build);
    expect(status).not.toBe(0);
    expect(stderr).toContain("pnpm build");
    expect(written).toEqual([]);
  });

  it.each([
    "packages/host/dist/index.js",
    "packages/core/dist/index.js",
    "packages/host/build/watch/outputs.js",
  ])("refuses, naming pnpm build, when %s is missing", (path) => {
    const build = tree();
    rmSync(join(build, path));

    expect(existsSync(join(build, path))).toBe(false);
    expect(staleBuild(build)).toMatch(/has no built module/);
    const { status, stderr, written } = generate(build);
    expect(status).not.toBe(0);
    expect(stderr).toContain("pnpm build");
    expect(written).toEqual([]);
  });
});
