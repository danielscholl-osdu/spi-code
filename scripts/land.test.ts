// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// One land run forks about 70 processes; on a machine loaded by parallel checks each can take
// over 100 ms. A hung land is still killed at the spawn budget and fails on result.error.
const landTimeout = 60_000;
const testTimeout = landTimeout + 30_000;

const id = "spicode-fixture";
const branch = `bead/${id}`;
const directories: string[] = [];
let template = "";
let base = "";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function temporaryDirectory(prefix: string) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function buildTemplate() {
  const directory = temporaryDirectory("spi-code-land-template-");
  const root = join(directory, "main");
  const bin = join(directory, "bin");
  mkdirSync(root);
  mkdirSync(bin);
  git(root, "init", "--quiet", "--template=", "-b", "main");
  git(root, "config", "user.name", "Fixture Builder");
  git(root, "config", "user.email", "fixture@example.test");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.hooksPath", "/dev/null");
  mkdirSync(join(root, "scripts"));
  copyFileSync(fileURLToPath(new URL("./land", import.meta.url)), join(root, "scripts/land"));
  writeFileSync(join(root, "scripts/check"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(root, "change.md"), "Initial content\n");
  git(root, "add", ".");
  git(
    root,
    "commit",
    "--quiet",
    "-m",
    "Historical commit\n\nCo-authored-by: Copilot <copilot@users.noreply.github.com>",
  );
  git(root, "worktree", "add", "--quiet", "-b", branch, join(directory, "bead"));
  writeFileSync(
    join(root, ".git", "bead.json"),
    JSON.stringify({
      id,
      status: "in_progress",
      assignee: "fixture-builder",
      labels: ["review:exempt"],
      metadata: {},
    }),
  );
  writeFileSync(
    join(bin, "bd"),
    `#!/bin/sh
case "$1" in
  show) cat "$LAND_FIXTURE_BEAD" ;;
  list) printf '[]\\n' ;;
  merge-slot|update|close) ;;
  *) printf 'Unexpected bd command: %s\\n' "$*" >&2; exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  base = git(root, "rev-parse", "main");
  return directory;
}

beforeAll(() => {
  template = buildTemplate();
}, testTimeout);

afterAll(() => {
  rmSync(template, { recursive: true, force: true });
});

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function relocate(file: string, directory: string) {
  const pointer = readFileSync(file, "utf8");
  if (!pointer.includes(template)) throw new Error(`${file} does not name ${template}: ${pointer}`);
  writeFileSync(file, pointer.replaceAll(template, directory));
}

function fixture() {
  const directory = temporaryDirectory("spi-code-land-");
  directories.push(directory);
  cpSync(template, directory, { recursive: true });
  const root = join(directory, "main");
  const worktree = join(directory, "bead");
  const bin = join(directory, "bin");
  relocate(join(worktree, ".git"), directory);
  relocate(join(root, ".git", "worktrees", "bead", "gitdir"), directory);
  const beadFile = join(root, ".git", "bead.json");
  let changes = 0;
  return {
    base,
    branch,
    commit(message: string) {
      writeFileSync(join(worktree, "change.md"), `Change ${++changes}\n`);
      git(worktree, "commit", "--quiet", "--all", "-m", `${message}\nBead: ${id}`);
      return git(worktree, "rev-parse", "HEAD");
    },
    main: () => git(root, "rev-parse", "main"),
    land: () =>
      spawnSync("bash", ["scripts/land", id], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          LAND_FIXTURE_BEAD: beadFile,
        },
        timeout: landTimeout,
      }),
  };
}

describe("landing commit attribution", () => {
  it.each([
    "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>",
    "Co-Authored-By: Claude <claude@example.test>",
    "co-AUTHORED-by: cOdEx <agent@example.test>",
    "Co-authored-by: GPT <agent@example.test>",
    "Co-authored-by: Gemini <agent@example.test>",
    "Co-authored-by: Muse <agent@example.test>",
    "Co-authored-by: Assistant <noreply@anthropic.com>",
    "Co-authored-by: Assistant <noreply@openai.com>",
    "Co-authored-by: Assistant <223556219+Copilot@users.noreply.github.com>",
    "Co-authored-by: Ada Lovelace <ada@example.test>\nCo-authored-by: Copilot <agent@example.test>",
    "Co-authored-by: Someone\n  Copilot <copilot@users.noreply.github.com>",
    "Co-authored-by : Copilot <copilot@example.test>",
    "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>\n",
    "Bead: spicode-fixture\nCo-authored-by: Copilot <copilot@example.test>\nA prose line.",
    "Generated with Copilot",
    "  gEnErAtEd WiTh Claude",
    "\u{1f916} Generated with [Claude Code]",
  ])(
    "refuses %s, identifies its commit and explains how to reword",
    (attribution) => {
      const repo = fixture();
      const offending = repo.commit(`docs: update fixture\n\n${attribution}`);
      repo.commit("docs: add a clean follow-up");

      const result = repo.land();

      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain(offending);
      expect(result.stderr).toContain("AI attribution");
      expect(result.stderr).toContain(`git rebase -i main`);
      expect(result.stderr).toContain("reword");
      expect(result.stderr).toContain(repo.branch);
      expect(repo.main()).toBe(repo.base);
    },
    testTimeout,
  );

  it.each([
    "Co-authored-by: Ada Lovelace <ada@example.test>",
    "Co-authored-by: Human Contributor <12345+human@users.noreply.github.com>",
    "Co-authored-by: Elena Musetti <elena@example.test>",
    "Co-authored-by: Ada Lovelace <ada@example.test>\nCo-authored-by: Grace Hopper <grace@example.test>",
    "Co-authored-by : Ada Lovelace\n  <ada@example.test>",
    "Co-authored-by: Ada Lovelace <ada@gpt-labs.example>",
    "snapshots regenerated with vitest",
    "lockfile is generated with pnpm",
    "",
  ])(
    "allows human or absent attribution: %s, ignoring historical AI trailers",
    (attribution) => {
      const repo = fixture();
      const head = repo.commit(`docs: update fixture\n\n${attribution}`);

      const result = repo.land();

      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("landed as");
      expect(repo.main()).toBe(head);
    },
    testTimeout,
  );
});
