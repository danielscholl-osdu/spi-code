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
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { watchOutputs } from "../packages/host/test/watch/outputs.js";
import { GENERATED } from "./watch-generated.mjs";
import { staleBuild } from "./watch-snapshot.mjs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const generator = fileURLToPath(new URL("./watch-snapshot.mjs", import.meta.url));
const tsc = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
const manifest = [...new Set(watchOutputs.map(({ path }) => path))].sort();
const repository = fileURLToPath(new URL("../", import.meta.url));
const committed = (paths: readonly string[]) =>
  execFileSync("git", ["ls-files", "--", ...paths], { cwd: repository, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .sort();

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

it("lets land without review exactly the committed files the watch fixture manifest names", () => {
  const unreviewed = /generated=\(\n([^)]*)\)/.exec(read("./land"))?.[1]?.trim().split(/\s+/);

  expect(committed(manifest).length).toBeGreaterThan(0);
  expect(unreviewed).toEqual(committed(manifest));
});

it("writes every manifest file it does not commit into the git-ignored generated folder", () => {
  const uncommitted = manifest.filter((path) => !committed(manifest).includes(path));
  const ignored = spawnSync("git", ["check-ignore", "--no-index", "--", ...uncommitted], {
    cwd: repository,
    encoding: "utf8",
  });

  expect(uncommitted.length).toBeGreaterThan(0);
  for (const path of uncommitted) expect(path.startsWith(`${GENERATED}/`), path).toBe(true);
  expect(ignored.stdout.split("\n").filter(Boolean).sort()).toEqual(uncommitted);
});

it("writes exactly the files in the manifest", () => {
  const root = scratch();
  execFileSync(process.execPath, [generator, root], {
    env: { ...process.env, TZ: "UTC" },
    stdio: "pipe",
  });

  expect(filesUnder(root)).toEqual(manifest);
});

describe("the build gate", () => {
  /**
   * The five projects the generator compiles, plus core's tests, built by tsc. The manifest
   * writes one file holding the host's value, which comes from @spi-code/core.
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
    write(
      "packages/core/package.json",
      JSON.stringify({
        name: "@spi-code/core",
        type: "module",
        exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
      }),
    );
    write(
      "packages/core/tsconfig.json",
      JSON.stringify({
        compilerOptions: { composite: true },
        files: [],
        references: [{ path: "./tsconfig.build.json" }, { path: "./test" }],
      }),
    );
    write("packages/core/tsconfig.build.json", project("src", "dist"));
    write("packages/core/src/index.ts", "export const core = 1;\n");
    write("packages/core/src/time.ts", "export {};\n");
    write("packages/core/test/tsconfig.json", project(".", "../build", ["../tsconfig.build.json"]));
    write("packages/core/test/fixture.ts", "export const fixture = 1;\n");
    mkdirSync(join(root, "node_modules/@spi-code"), { recursive: true });
    symlinkSync(join(root, "packages/core"), join(root, "node_modules/@spi-code/core"), "junction");
    write(
      "packages/host/tsconfig.build.json",
      project("src", "dist", ["../contracts", "../core", "../tools"]),
    );
    write(
      "packages/host/src/index.ts",
      'import { core } from "@spi-code/core";\nexport const value = core;\n',
    );
    write("packages/host/src/port.ts", "export {};\n");
    write("packages/host/test/tsconfig.json", project(".", "../build", ["../tsconfig.build.json"]));
    write(
      "packages/host/test/watch/outputs.ts",
      `import { value } from "../../src/index.js";
export const watchOutputs = [{ path: "fixtures/watch/x.json", value: () => value }];\n`,
    );
    build(root);
    return root;
  }

  const build = (root: string) =>
    execFileSync(process.execPath, [tsc, "-b", "packages/host/test"], { cwd: root, stdio: "pipe" });

  /** Runs the generator from the checkout at root in its own process and temp directory. */
  function generate(root: string) {
    const out = scratch();
    const temp = scratch();
    const run = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { generate } = await import(${JSON.stringify(new URL("./watch-snapshot.mjs", import.meta.url).href)});
await generate(${JSON.stringify(out)}, ${JSON.stringify(root)});`,
      ],
      { encoding: "utf8", env: { ...process.env, TZ: "UTC", TMPDIR: temp, TEMP: temp, TMP: temp } },
    );
    const written = filesUnder(out);
    const value = written.length > 0 ? readFileSync(join(out, written[0] ?? ""), "utf8") : "";
    return { status: run.status, stderr: run.stderr, written, value, left: readdirSync(temp) };
  }

  function expectRefusal(run: ReturnType<typeof generate>, reason: string) {
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(reason);
    expect(run.written).toEqual([]);
    expect(run.left).toEqual([]);
  }

  function expectCurrent(run: ReturnType<typeof generate>, value: string) {
    expect(run.stderr).not.toContain("watch-snapshot:");
    expect(run.status).toBe(0);
    expect(run.written).toEqual(["fixtures/watch/x.json"]);
    expect(run.value).toBe(`${value}\n`);
    expect(run.left).toEqual([]);
  }

  it("writes what the current sources compute when tsc reports the build current", () => {
    const root = tree();

    expect(staleBuild(root)).toBeUndefined();
    expectCurrent(generate(root), "1");
  });

  it.each([
    ["packages/contracts/src/index.ts", "export const changed = 1;\n"],
    ["packages/core/src/index.ts", "export const core = 2;\n"],
    ["packages/tools/src/index.ts", "export const changed = 1;\n"],
    ["packages/host/src/index.ts", "export const value = 2;\n"],
    ["packages/host/test/watch/outputs.ts", "export const watchOutputs = [];\n"],
  ])("refuses, naming pnpm build, when %s changed after the build", (path, text) => {
    const root = tree();
    writeFileSync(join(root, path), text);

    expect(staleBuild(root)).toMatch(/would build/);
    expectRefusal(generate(root), "pnpm build");
  });

  it("refuses, naming pnpm build, when the last build failed", () => {
    const root = tree();
    writeFileSync(join(root, "packages/host/src/index.ts"), "export const value: string = 2;\n");

    expect(() => build(root)).toThrow();
    expect(staleBuild(root)).toBeDefined();
    expectRefusal(generate(root), "pnpm build");
  });

  it("writes when only core's tests changed after the build", () => {
    const root = tree();
    writeFileSync(join(root, "packages/core/test/fixture.ts"), "export const fixture = 2;\n");

    expect(staleBuild(root)).toBeUndefined();
    expectCurrent(generate(root), "1");
  });

  it.each([
    ["packages/host/src/index.ts", "packages/host/dist/index.js"],
    ["packages/core/src/index.ts", "packages/core/dist/index.js"],
  ])(
    "refuses when %s was deleted and the build since succeeded, leaving its old module",
    (source, module) => {
      const root = tree();
      rmSync(join(root, source));
      build(root);

      expect(existsSync(join(root, module))).toBe(true);
      expect(staleBuild(root)).toBeUndefined();
      expectRefusal(generate(root), "is not compiled from any current source");
    },
  );

  it("writes the current value, not an older emitted module restored after a build", () => {
    const root = tree();
    const module = join(root, "packages/host/dist/index.js");
    const older = { text: readFileSync(module), time: statSync(module).mtime };
    writeFileSync(join(root, "packages/host/src/index.ts"), "export const value = 2;\n");
    build(root);
    writeFileSync(module, older.text);
    utimesSync(module, older.time, older.time);

    expectCurrent(generate(root), "2");
  });

  it("writes the current value, not the build, when a source changed with its old mtime", () => {
    const root = tree();
    const source = join(root, "packages/host/src/index.ts");
    const { atime, mtime } = statSync(source);
    writeFileSync(source, "export const value = 2;\n");
    utimesSync(source, atime, mtime);

    expectCurrent(generate(root), "2");
  });

  it.each([
    ["deleted", (path: string) => rmSync(path)],
    [
      "replaced",
      (path: string) => writeFileSync(path, 'throw new Error("built module loaded");\n'),
    ],
  ])("never loads a built module: writes the current value with every one %s", (_, change) => {
    const root = tree();
    for (const built of ["packages/core/dist", "packages/host/dist", "packages/host/build"])
      for (const file of filesUnder(join(root, built)))
        if (file.endsWith(".js")) change(join(root, built, file));

    expect(staleBuild(root)).toBeUndefined();
    expectCurrent(generate(root), "1");
  });
});
