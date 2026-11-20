// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { KNOWN_SERVICES } from "@spi-code/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MxcApi } from "../scopes/confined.js";
import { PrivilegedGit, type PrivilegedGitOptions, type WorktreeTarget } from "../scopes/git.js";
import { ScopeRegistry } from "../scopes/registry.js";
import { ScopeWorkspaces } from "../scopes/workspace.js";
import { commitChanges, readChanges, readFileDiff } from "./changes.js";
import { operatorIdentity, parseUserIdentity } from "./identity.js";

const exec = promisify(execFile);
const capturedPath = process.env.PATH ?? process.env.Path ?? "";
const macOnly = process.platform !== "darwin";
const identity = { name: "Fixture Operator", email: "operator@example.invalid" };
const found = new ScopeRegistry().lookup(KNOWN_SERVICES[0]?.id ?? "");
if (found?.kind !== "service") throw new Error("Expected a service scope");
const scope = found;

let root: string;
let db: DatabaseSync;

async function fixtureGit(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    windowsHide: true,
    env: {
      PATH: capturedPath,
      ...(process.platform === "win32"
        ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" }
        : {}),
      HOME: root,
      USERPROFILE: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(root, "empty-config"),
      GIT_ALLOW_PROTOCOL: "file",
    },
  });
  return stdout.trim();
}

/** A thread landed on Fork main, as spicode-xia.10 lands one, with its git and base. */
async function landed() {
  const seed = join(root, "seed");
  const origin = join(root, "github.git");
  await fixtureGit(root, "init", "--initial-branch", "main", seed);
  await writeFile(join(seed, "answer.txt"), "one\ntwo\nthree\n");
  await fixtureGit(seed, "add", "--", "answer.txt");
  await fixtureGit(
    seed,
    "-c",
    "user.name=F",
    "-c",
    "user.email=f@example.invalid",
    "commit",
    "-m",
    "First",
  );
  await fixtureGit(root, "clone", "--bare", seed, origin);
  const git = new PrivilegedGit({
    appData: join(root, "app data"),
    capturedPath,
    allowLocalRemotes: true,
  });
  const workspaces = new ScopeWorkspaces(git, () => pathToFileURL(origin).href);
  const result = await workspaces.land(db, scope, "t1", { target: "fork-main" });
  if (!result.ok || result.landsIn.target === "asking") throw new Error("Expected a worktree");
  const prepared = await workspaces.prepareThread(db, scope, "t1", result.landsIn);
  if (!prepared.ok || prepared.workspace.kind !== "worktree") throw new Error("Not prepared");
  const target: WorktreeTarget = {
    clone: prepared.workspace.clonePath,
    worktree: { id: prepared.workspace.worktreeId, cwd: prepared.workspace.cwd },
  };
  return { git, target, base: result.landsIn.head, cwd: target.worktree.cwd };
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "spi-changes-test-")));
  db = new DatabaseSync(":memory:");
});

afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

describe("a thread's changes", { timeout: 120_000 }, () => {
  it("shows a tool's new file and an outside edit after refresh, each with its diff", async () => {
    const { git, target, base, cwd } = await landed();
    expect(await readChanges(git, target, base)).toEqual({
      state: "read",
      head: base,
      ahead: 0,
      uncommitted: false,
      files: [],
    });

    // Hand edit: the file a Copilot write tool creates in the worktree (no recorded scenario writes one).
    await mkdir(join(cwd, "notes"));
    await writeFile(join(cwd, "notes", "new.txt"), "alpha\nbeta\n");
    // An edit made outside the app.
    await writeFile(join(cwd, "answer.txt"), "one\n2\nthree\nfour\n");

    expect(await readChanges(git, target, base)).toEqual({
      state: "read",
      head: base,
      ahead: 0,
      uncommitted: true,
      files: [
        { path: "answer.txt", added: 2, removed: 1, untracked: false },
        { path: "notes/new.txt", added: 2, removed: 0, untracked: true },
      ],
    });
    expect(await readFileDiff(git, target, base, "answer.txt")).toMatchObject({
      state: "read",
      patch: expect.stringContaining("-two\n+2\n three\n+four\n"),
      truncated: false,
    });
    expect(await readFileDiff(git, target, base, "notes/new.txt")).toEqual({
      state: "read",
      patch: "--- /dev/null\n+++ b/notes/new.txt\n@@ -0,0 +1,2 @@\n+alpha\n+beta\n",
      truncated: false,
    });
  });

  it("reads no untracked file through a link, at the leaf or in a parent", async ({ skip }) => {
    skip(process.platform === "win32", "symlinks need privileges on Windows");
    const { git, target, base, cwd } = await landed();
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "fixture-secret\n");
    await symlink(join(outside, "secret.txt"), join(cwd, "leaf"));
    await symlink(outside, join(cwd, "parent"));

    const read = await readChanges(git, target, base);
    expect(read).toMatchObject({
      files: [
        { path: "leaf", added: null, removed: null, untracked: true },
        { path: "parent", added: null, removed: null, untracked: true },
      ],
    });
    for (const path of ["leaf", "parent/secret.txt"]) {
      const diff = await readFileDiff(git, target, base, path);
      expect(JSON.stringify(diff)).not.toContain("fixture-secret");
    }
  });

  it("says why it read nothing when the worktree's .git is repointed", async () => {
    const { git, target, base, cwd } = await landed();
    await rm(join(cwd, ".git"));
    await writeFile(join(cwd, ".git"), `gitdir: ${join(root, "elsewhere")}\n`);
    await expect(readChanges(git, target, base)).rejects.toThrow(
      "Worktree .git file does not point to its recorded Git directory.",
    );
  });

  it.skipIf(macOnly)("commits everything confined, then lists the files as committed", async () => {
    const { git, target, base, cwd } = await landed();
    expect(await commitChanges(git, target, "Nothing yet", identity)).toEqual({
      outcome: "refused",
      reason: "Nothing to commit.",
    });
    await writeFile(join(cwd, "answer.txt"), "changed\n");
    await writeFile(join(cwd, "added.txt"), "new\n");

    const committed = await commitChanges(git, target, "Change the answer", identity);
    expect(committed).toEqual({
      outcome: "committed",
      head: expect.stringMatching(/^[0-9a-f]{40}$/u),
    });
    expect(await fixtureGit(cwd, "log", "-1", "--format=%s|%an <%ae>")).toBe(
      "Change the answer|Fixture Operator <operator@example.invalid>",
    );
    expect(await readChanges(git, target, base)).toMatchObject({
      ahead: 1,
      uncommitted: false,
      files: [
        { path: "added.txt", added: 1, removed: 0, untracked: false },
        { path: "answer.txt", added: 1, removed: 3, untracked: false },
      ],
    });
  });
});

it("shows a refused commit as refused, one that may have run as not known, and a git exit as failed", {
  timeout: 120_000,
}, async () => {
  const { target, cwd } = await landed();
  await writeFile(join(cwd, "answer.txt"), "changed\n");
  const proof = (command: string) => `${/spi-confined-[\da-f-]{36}/u.exec(command)?.[0]}:EPERM\n`;
  const result = (stdout: string, exitCode: number) => ({
    stdout,
    stderr: exitCode ? "error: pathspec did not match" : "",
    exitCode,
    timedOut: false,
    warnings: [],
  });
  const sandbox = (run: MxcApi["run"]): Pick<PrivilegedGitOptions, "mxc" | "platform"> => ({
    platform: "darwin",
    mxc: async () => ({
      getPlatformSupport: () => ({ isSupported: true, availableMethods: ["seatbelt"] }),
      run,
    }),
  });
  const rows: [string, Pick<PrivilegedGitOptions, "mxc" | "platform">, object][] = [
    [
      "Windows",
      { platform: "win32" },
      { outcome: "refused", reason: "Confined Git is not available on this platform yet." },
    ],
    [
      "a sandbox that rejects after it was asked",
      sandbox(() => Promise.reject(new Error("spawn mxc-exec-mac ENOENT"))),
      { outcome: "not known" },
    ],
    ["a sandbox that proves nothing", sandbox(async () => result("", 0)), { outcome: "not known" }],
    [
      "git exiting with an error",
      sandbox(async (request) => result(proof(request.command), 1)),
      { outcome: "failed", reason: "error: pathspec did not match" },
    ],
  ];
  for (const [label, confinement, expected] of rows) {
    const git = new PrivilegedGit({
      appData: join(root, "app data"),
      capturedPath,
      allowLocalRemotes: true,
      ...confinement,
    });
    expect(await commitChanges(git, target, "Change it", identity), label).toMatchObject(expected);
  }
});

describe("the operator's identity", () => {
  it.each([
    ["[user]\n\tname = Fixture Operator\n\temail = operator@example.invalid\n", identity],
    [
      '[User]\n  Name = "Fixture Operator" # a comment\n  EMAIL=operator@example.invalid ; another\n',
      identity,
    ],
    ["[user]\n\tname = Earlier\n\tname = Fixture Operator\n", { name: "Fixture Operator" }],
    ['[user "work"]\n\tname = Not this\n[core]\n\tname = Nor this\n', {}],
    ["[user] name = Fixture Operator\n[include]\n\tpath = other\n", { name: "Fixture Operator" }],
    ["[user]\n\tname =\n\temail\n", {}],
  ])("reads %j", (text, expected) => {
    expect(parseUserIdentity(text)).toEqual(expected);
  });

  it("takes ~/.gitconfig first and the XDG file for what it lacks, and is not known without both", async () => {
    const home = join(root, "home");
    const xdg = join(root, "xdg");
    await mkdir(join(xdg, "git"), { recursive: true });
    await mkdir(home);
    expect(await operatorIdentity({ XDG_CONFIG_HOME: xdg }, home)).toBeUndefined();
    await writeFile(
      join(xdg, "git", "config"),
      "[user]\n\tname = Other\n\temail = operator@example.invalid\n",
    );
    await writeFile(join(home, ".gitconfig"), "[user]\n\tname = Fixture Operator\n");
    expect(await operatorIdentity({ XDG_CONFIG_HOME: xdg }, home)).toEqual(identity);
    expect(await operatorIdentity({}, home)).toBeUndefined();
  });
});
