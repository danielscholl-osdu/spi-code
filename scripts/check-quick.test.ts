// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

// A repository whose package scripts only record that they ran, and with what.
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "spi code quick-"));
  directories.push(directory);
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        directory,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=f@example.test",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { encoding: "utf8" },
    ).trim();
  const script = (name: string) => `node record.mjs ${name}`;
  cpSync(join(root, "scripts/check"), join(directory, "check"));
  mkdirSync(join(directory, "node_modules"));
  mkdirSync(join(directory, "scripts"));
  cpSync(
    join(root, "scripts/check-dependents.mjs"),
    join(directory, "scripts/check-dependents.mjs"),
  );
  mkdirSync(join(directory, "apps"));
  mkdirSync(join(directory, "packages"));
  writeFileSync(join(directory, ".gitignore"), "node_modules\ncalls.log\n");
  writeFileSync(
    join(directory, "record.mjs"),
    `import { appendFileSync } from "node:fs";
appendFileSync("calls.log", JSON.stringify({ args: process.argv.slice(2), shifted: process.env.SPI_TEST_CLOCK_SHIFT ?? "" }) + "\\n");
if (process.env.RECORD_FAILS && process.env.RECORD_FAILS === process.argv[2]) process.exit(1);
`,
  );
  writeFileSync(join(directory, "scripts/third-party-notices.mjs"), 'import "../record.mjs";\n');
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: Object.fromEntries(
        ["check", "lint", "typecheck", "check:headers", "test"].map((name) => [name, script(name)]),
      ),
    }),
  );
  git("init", "--quiet", "-b", "main");
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  const base = git("rev-parse", "HEAD");
  git("switch", "--quiet", "-c", "bead/fixture");
  const run = (env: Record<string, string>, args: string[]) =>
    spawnSync("bash", ["check", ...args], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        SPI_TEST_CLOCK_SHIFT: "",
        SPI_TEST_ZONE: "",
        SPI_CHECK_REPORT_DIR: "",
        ...env,
      },
      timeout: 60_000,
    });
  return {
    base,
    write(path: string, contents = "changed\n") {
      mkdirSync(join(directory, path, ".."), { recursive: true });
      writeFileSync(join(directory, path), contents);
    },
    copy: (path: string) => cpSync(join(root, path), join(directory, path)),
    commit() {
      git("add", ".");
      git("commit", "--quiet", "-m", "change");
    },
    // Commits what is written so far on main, as if it had landed before the bead began.
    land() {
      git("switch", "--quiet", "main");
      git("add", ".");
      git("commit", "--quiet", "-m", "landed");
      git("switch", "--quiet", "bead/fixture");
      git("merge", "--quiet", "--ff-only", "main");
      return git("rev-parse", "main");
    },
    checkWith: (env: Record<string, string>, ...args: string[]) => run(env, args),
    check: (...args: string[]) => run({}, args),
    calls: (): { args: string[]; shifted: string }[] =>
      existsSync(join(directory, "calls.log"))
        ? readFileSync(join(directory, "calls.log"), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [],
  };
}

it("--quick lints, typechecks, checks headers and runs once the tests the diff against main reaches", () => {
  const repo = fixture();
  repo.write("scripts/tool.ts");
  repo.commit();

  const result = repo.check("--quick");

  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(repo.calls()).toEqual([
    { args: ["lint"], shifted: "" },
    { args: ["typecheck"], shifted: "" },
    { args: ["check:headers"], shifted: "" },
    { args: ["test", "--changed", repo.base, "--passWithNoTests"], shifted: "" },
  ]);
  expect(result.stdout).toContain("CI runs every test");
}, 90_000);

it("--quick runs the scripts project whole for a changed script, and the test beside any other file no test imports", () => {
  const repo = fixture();
  repo.write("scripts/land.test.ts");
  repo.write("scripts/land");
  repo.write("styles/panel.test.ts");
  repo.commit();
  repo.write("styles/panel.css");

  const result = repo.check("--quick");

  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(repo.calls().slice(3)).toEqual([
    { args: ["test", "--project", "scripts"], shifted: "" },
    { args: ["test", "styles/panel.test.ts"], shifted: "" },
  ]);
}, 90_000);

it("--quick runs whole the packages that depend on a changed one", () => {
  const repo = fixture();
  repo.write("apps/window/package.json", JSON.stringify({ name: "@fixture/window" }));
  repo.write("packages/core/package.json", JSON.stringify({ name: "@fixture/core" }));
  repo.write(
    "packages/host/package.json",
    JSON.stringify({ name: "@fixture/host", dependencies: { "@fixture/core": "workspace:*" } }),
  );
  const base = repo.land();
  repo.write("packages/core/src.ts");

  const result = repo.check("--quick");

  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(repo.calls().slice(3)).toEqual([
    {
      args: [
        "test",
        "--changed",
        base,
        "--passWithNoTests",
        "--project",
        "apps/window",
        "--project",
        "packages/core",
        "--project",
        "scripts",
      ],
      shifted: "",
    },
    { args: ["test", "--project", "packages/host"], shifted: "" },
  ]);
}, 90_000);

it("with no option runs the whole check, the shifted pass and the notices", () => {
  const repo = fixture();

  const result = repo.check();

  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(repo.calls()).toEqual([
    { args: ["check"], shifted: "" },
    { args: ["test"], shifted: "1" },
    { args: [], shifted: "" },
  ]);
}, 90_000);

it("refuses an option it does not know, before running anything", () => {
  const repo = fixture();

  const result = repo.check("--fast");

  expect(result.status).toBe(2);
  expect(result.stderr).toContain("unknown option --fast");
  expect(repo.calls()).toEqual([]);
});

it("fails when the project helper fails, before running any test", () => {
  const repo = fixture();
  repo.write("scripts/check-dependents.mjs", "process.exit(3);\n");

  const result = repo.check("--quick");

  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(repo.calls().filter((call) => call.args[0] === "test")).toEqual([]);
  expect(result.stdout).not.toContain("quick pass only");
}, 90_000);

it("refuses a second option, before running anything", () => {
  const repo = fixture();

  const result = repo.check("--quick", "--typo");

  expect(result.status).toBe(2);
  expect(result.stderr).toContain("unexpected option --typo");
  expect(repo.calls()).toEqual([]);
});

it("--static lints, typechecks and checks headers, and runs no test", () => {
  const repo = fixture();
  repo.write("scripts/tool.ts");
  repo.commit();

  const result = repo.check("--static");

  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(repo.calls()).toEqual([
    { args: ["lint"], shifted: "" },
    { args: ["typecheck"], shifted: "" },
    { args: ["check:headers"], shifted: "" },
  ]);
  expect(result.stdout).toContain("no test ran");
}, 90_000);

const reporter = (pass: number) => [
  "test",
  "--reporter=default",
  "--reporter=json",
  `--outputFile.json=reports/pass-${pass}.json`,
];

it("with a report directory runs the same steps in the same order, with a JSON report of each pass", () => {
  const repo = fixture();

  const result = repo.checkWith({ SPI_CHECK_REPORT_DIR: "reports" });

  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(repo.calls()).toEqual([
    { args: ["lint"], shifted: "" },
    { args: ["typecheck"], shifted: "" },
    { args: reporter(1), shifted: "" },
    { args: ["check:headers"], shifted: "" },
    { args: reporter(2), shifted: "1" },
    { args: [], shifted: "" },
  ]);
}, 90_000);

it("still fails when a test fails under a report directory", () => {
  const repo = fixture();

  const result = repo.checkWith({ SPI_CHECK_REPORT_DIR: "reports", RECORD_FAILS: "test" });

  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(repo.calls().map((call) => call.args[0])).toEqual(["lint", "typecheck", "test"]);
}, 90_000);

it("spells out exactly the steps of the package's check script, so the two cannot drift", () => {
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;

  expect(scripts.check).toBe(
    "pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run check:headers",
  );
});
