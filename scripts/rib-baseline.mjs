// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtures = join(root, "packages/core/test/fixtures/rib-59d6895");
const rib = "/Users/danielscholl/keelson/keelson-rib-spi";
const keelson = "/Users/danielscholl/keelson/keelson";
const revision = "59d6895";

/** @param {string} tag */
function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
}

/** @param {string} tag */
function counts(tag) {
  const attrs = attributes(tag);
  const result = { tests: 0, assertions: 0, failures: 0, skipped: 0 };
  /** @type {(keyof typeof result)[]} */
  const keys = ["tests", "assertions", "failures", "skipped"];
  for (const key of keys) {
    assert.match(attrs[key] ?? "", /^\d+$/, `JUnit ${key} must be a count`);
    result[key] = Number(attrs[key]);
  }
  return result;
}

/**
 * @param {string} xml
 * @param {string} log
 */
export function testCounts(xml, log) {
  const total = counts(xml.match(/<testsuites\b[^>]*>/)?.[0] ?? "");
  const files = [];
  let depth = 0;
  for (const match of xml.matchAll(/<\/?testsuite\b[^>]*>/g)) {
    const tag = match[0];
    if (tag.startsWith("</")) {
      depth--;
    } else {
      if (depth === 0) {
        const file = attributes(tag).file;
        assert.ok(file && /^test\/.+\.test\.ts$/.test(file), "JUnit must name a test file");
        files.push({ file, ...counts(tag) });
      }
      depth++;
    }
    assert.ok(depth >= 0, "JUnit suite nesting is invalid");
  }
  assert.equal(depth, 0, "JUnit suites must be closed");
  assert.ok(files.length > 0, "JUnit must name test files");
  assert.equal(new Set(files.map((f) => f.file)).size, files.length);
  /** @type {(keyof typeof total)[]} */
  const keys = ["tests", "assertions", "failures", "skipped"];
  for (const key of keys) {
    assert.equal(
      files.reduce((n, f) => n + f[key], 0),
      total[key],
      `JUnit per-file ${key} must add up`,
    );
  }
  const summary = log.match(/Ran (\d+) tests across (\d+) files\./);
  assert.ok(summary, "bun test must print its summary");
  assert.equal(total.tests, Number(summary[1]), "JUnit and bun test totals must match");
  assert.equal(files.length, Number(summary[2]), "JUnit and bun test file counts must match");
  assert.equal(total.failures, 0, "The baseline suite must pass");
  files.sort((a, b) => a.file.localeCompare(b.file, "en"));
  return { files, total: { files: files.length, ...total } };
}

/** @param {string} path */
function repositoryState(path) {
  return {
    status: execFileSync("git", ["-C", path, "status", "--porcelain"], { encoding: "utf8" }),
    worktrees: execFileSync("git", ["-C", path, "worktree", "list"], { encoding: "utf8" }),
  };
}

/**
 * @param {string} path
 * @param {unknown} value
 */
function json(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** @param {string} directory */
export function fixtureHashes(directory) {
  /** @type {Record<string, string>} */
  const result = {};
  /** @param {string} folder */
  function walk(folder, prefix = "") {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name, "en"),
    )) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(join(folder, entry.name), `${relative}/`);
      else
        result[relative] = createHash("sha256")
          .update(readFileSync(join(folder, entry.name)))
          .digest("hex");
    }
  }
  walk(directory);
  return result;
}

export function baseline() {
  const before = [rib, keelson].map((path) => ({ path, ...repositoryState(path) }));
  for (const state of before) {
    console.log(
      `BEFORE ${state.path}\nstatus --porcelain:\n${state.status}worktree list:\n${state.worktrees}`,
    );
    assert.equal(state.status, "", `${state.path} must be clean before capture`);
  }
  const temporary = mkdtempSync(join(tmpdir(), "spi-code-rib-baseline-"));
  try {
    const exported = join(temporary, "rib");
    const output = join(temporary, "output");
    mkdirSync(exported);
    for (const name of ["home", "tmp", "output"]) mkdirSync(join(temporary, name));
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("RIB_SPI_") || key.startsWith("KEELSON_")) delete env[key];
    }
    Object.assign(env, {
      TZ: "UTC",
      LC_ALL: "C",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      KEELSON_HOME: join(temporary, "home"),
      TMPDIR: join(temporary, "tmp"),
    });
    execFileSync(
      "bash",
      [
        "-o",
        "pipefail",
        "-c",
        'git -C "$1" archive "$2" | tar -x -C "$3"',
        "archive",
        rib,
        revision,
        exported,
      ],
      { env },
    );
    /** @type {import("node:child_process").ExecFileSyncOptionsWithStringEncoding} */
    const options = { cwd: exported, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 };
    const bunVersion = execFileSync("bun", ["--version"], options).trim();
    assert.equal(bunVersion, "1.3.13", "The baseline requires bun 1.3.13");
    execFileSync("bun", ["install", "--frozen-lockfile"], options);
    for (const name of ["facts", "releases", "services", "rollout"]) {
      json(
        join(output, `${name}.json`),
        JSON.parse(readFileSync(join(exported, `test/fixtures/${name}.json`), "utf8")),
      );
    }
    mkdirSync(join(output, "notes"));
    copyFileSync(join(fixtures, "notes/2026-10.json"), join(output, "notes/2026-10.json"));
    const render = {
      revision: execFileSync("git", ["-C", rib, "rev-parse", revision], {
        encoding: "utf8",
      }).trim(),
      bun: bunVersion,
      now: "2026-10-21T15:00:00.000Z",
      timezone: "UTC",
      locale: "en-US",
      months: 12,
      reading: false,
      facts: "facts.json",
      releases: "releases.json",
      services: "services.json",
      rollout: "rollout.json",
      notes: "notes",
    };
    json(join(output, "render.json"), render);
    copyFileSync(
      new URL("./rib-baseline/render.mjs", import.meta.url),
      join(exported, "baseline-render.mjs"),
    );
    Object.assign(env, {
      RIB_SPI_FACTS_FILE: join(output, render.facts),
      RIB_SPI_SERVICES_FILE: join(output, render.services),
      RIB_SPI_ROLLOUT_FILE: join(output, render.rollout),
      RIB_SPI_NOTES_DIR: join(output, render.notes),
    });
    execFileSync("bun", ["baseline-render.mjs", output], options);
    for (const key of Object.keys(env)) {
      if (key.startsWith("RIB_SPI_")) delete env[key];
    }
    const report = join(temporary, "tests.xml");
    const tested = spawnSync("bun", ["test", "--reporter=junit", `--reporter-outfile=${report}`], {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (tested.error) throw tested.error;
    const log = tested.stdout + tested.stderr;
    assert.equal(tested.status, 0, `bun test failed:\n${log}`);
    console.log(log.trimEnd().split("\n").slice(-5).join("\n"));
    json(join(output, "test-count.json"), {
      revision: render.revision,
      bun: bunVersion,
      ...testCounts(readFileSync(report, "utf8"), log),
    });
    for (const [relative] of Object.entries(fixtureHashes(output))) {
      const target = join(fixtures, relative);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(output, relative), target);
    }
    console.log(JSON.stringify(fixtureHashes(output), null, 2));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    for (const state of before) {
      const after = repositoryState(state.path);
      console.log(
        `AFTER ${state.path}\nstatus --porcelain:\n${after.status}worktree list:\n${after.worktrees}`,
      );
      assert.deepEqual(
        after,
        { status: state.status, worktrees: state.worktrees },
        `${state.path} changed`,
      );
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) baseline();
