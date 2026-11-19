// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

// Live check for docs/notes/confined-git.md: a confined commit in a linked worktree, with a
// nested repository's core.fsmonitor trying to write where the sandbox must not let it.
// Run after `pnpm --filter @spi-code/host build`: node scripts/confined-git-probe.mjs

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { KNOWN_SERVICES } from "../packages/core/dist/index.js";
import { PrivilegedGit } from "../packages/host/dist/scopes/git.js";
import { ScopeRegistry } from "../packages/host/dist/scopes/registry.js";
import { ScopeWorkspaces } from "../packages/host/dist/scopes/workspace.js";

const root = await realpath(await mkdtemp(join(tmpdir(), "spi-confined-probe-")));
const capturedPath = process.env.PATH ?? "";
/** @param {string} cwd @param {string[]} args */
const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: capturedPath,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(root, "empty"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "maintenance.auto",
      GIT_CONFIG_VALUE_0: "false",
      GIT_AUTHOR_NAME: "Probe",
      GIT_AUTHOR_EMAIL: "probe@example.invalid",
      GIT_COMMITTER_NAME: "Probe",
      GIT_COMMITTER_EMAIL: "probe@example.invalid",
    },
  }).trim();
/** @param {string} path */
const quote = (path) => `'${path.replaceAll("'", "'\\''")}'`;
const home = join(homedir(), `spi-confined-probe-${randomUUID()}`);

try {
  const seed = join(root, "seed");
  git(root, "init", "-q", "--initial-branch", "main", seed);
  await writeFile(join(seed, "answer.txt"), "first\n");
  git(seed, "add", "answer.txt");
  git(seed, "commit", "-qm", "Seed");
  const origin = join(root, "origin.git");
  git(root, "clone", "-q", "--bare", seed, origin);

  const scope = new ScopeRegistry().lookup(KNOWN_SERVICES[0]?.id ?? "");
  if (scope?.kind !== "service") throw new Error("Expected a service scope");
  const runner = new PrivilegedGit({
    appData: join(root, "app"),
    capturedPath,
    allowLocalRemotes: true,
  });
  const prepared = await new ScopeWorkspaces(
    runner,
    () => pathToFileURL(origin).href,
  ).prepareAsking(scope);
  if (!prepared.ok || prepared.workspace.kind !== "clone") throw new Error("No clone");
  const clone = prepared.workspace.cwd;
  const added = await runner.addWorktree(clone, "probe", "HEAD");
  if (!added.ok) throw new Error(added.error);
  const target = added.data;
  const worktree = target.worktree.cwd;

  const nested = join(root, "nested");
  git(root, "init", "-q", "--initial-branch", "main", nested);
  await writeFile(join(nested, "f"), "x");
  git(nested, "add", "f");
  git(nested, "commit", "-qm", "Nested");
  const sub = join(worktree, "sub");
  await cp(nested, sub, { recursive: true });
  git(
    worktree,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${git(nested, "rev-parse", "HEAD")},sub`,
  );
  const log = join(sub, "canary.log");
  const attempts = {
    "operator home": home,
    "temp root": join(root, "outside"),
    "clone .git/config": join(clone, ".git", "config"),
    "worktree .git pointer": join(worktree, ".git"),
    "clone checkout": join(clone, "answer.txt"),
  };
  const script = join(sub, "canary.sh");
  await writeFile(
    script,
    [
      "#!/bin/sh",
      `echo "ran as fsmonitor $1" >> ${quote(log)}`,
      ...Object.entries(attempts).map(
        ([name, path]) =>
          `if (printf x >> ${quote(path)}) 2>/dev/null; then echo "${name}: WROTE"; else echo "${name}: blocked"; fi >> ${quote(log)}`,
      ),
      `if mkdir ${quote(join(clone, ".git", "hooks"))} 2>/dev/null; then echo "clone .git/hooks: WROTE"; else echo "clone .git/hooks: blocked"; fi >> ${quote(log)}`,
      `if /usr/bin/curl -sS -m 5 -o /dev/null https://github.com 2>/dev/null; then echo "network: REACHED"; else echo "network: blocked"; fi >> ${quote(log)}`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  git(sub, "config", "core.fsmonitor", quote(script));
  const config = await readFile(join(clone, ".git", "config"));
  await writeFile(join(worktree, "answer.txt"), "second\n");

  const before = git(worktree, "rev-parse", "HEAD");
  const result = await runner.commit(
    target,
    "Confined commit",
    { name: "Probe", email: "probe@example.invalid" },
    { all: true },
  );
  console.log(`platform: ${process.platform} ${process.arch}, ${git(root, "--version")}`);
  console.log("commit result:", JSON.stringify({ ...result, data: undefined }));
  console.log(`HEAD: ${before.slice(0, 12)} -> ${git(worktree, "rev-parse", "HEAD").slice(0, 12)}`);
  console.log(`committed: ${git(worktree, "show", "--name-only", "--format=%s")}`);
  console.log("canary log (written from inside the sandbox):");
  console.log((await readFile(log, "utf8")).trim().replace(/^/gmu, "  "));
  console.log(
    "host check: home marker",
    await readFile(home).then(
      () => "PRESENT",
      () => "absent",
    ),
    "| clone config",
    (await readFile(join(clone, ".git", "config"))).equals(config) ? "unchanged" : "CHANGED",
  );
} finally {
  await rm(home, { force: true });
  await rm(root, { recursive: true, force: true });
}
