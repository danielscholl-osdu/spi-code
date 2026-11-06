// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "spi-code-land-"));
  directories.push(directory);
  const root = join(directory, "main");
  const worktree = join(directory, "bead");
  const bin = join(directory, "bin");
  const id = "spicode-fixture";
  const branch = `bead/${id}`;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  mkdirSync(root);
  mkdirSync(bin);
  git(root, "init", "--quiet", "-b", "main");
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
  const base = git(root, "rev-parse", "main");
  git(root, "worktree", "add", "--quiet", "-b", branch, worktree);
  const beadFile = join(root, ".git", "bead.json");
  writeFileSync(
    beadFile,
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
  let changes = 0;
  return {
    base,
    branch,
    commit(message: string) {
      writeFileSync(join(worktree, "change.md"), `Change ${++changes}\n`);
      git(worktree, "add", "change.md");
      git(worktree, "commit", "--quiet", "-m", `${message}\nBead: ${id}`);
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
        timeout: 10_000,
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
    "Generated with Copilot",
    "  gEnErAtEd WiTh Claude",
    "\u{1f916} Generated with [Claude Code]",
  ])("refuses %s, identifies its commit and explains how to reword", (attribution) => {
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
  });

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
  ])("allows human or absent attribution: %s, ignoring historical AI trailers", (attribution) => {
    const repo = fixture();
    const head = repo.commit(`docs: update fixture\n\n${attribution}`);

    const result = repo.land();

    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("landed as");
    expect(repo.main()).toBe(head);
  });
});
