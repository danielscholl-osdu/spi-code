// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { KNOWN_SERVICES } from "@spi-code/core";
import { afterEach, beforeEach, describe, expect, it, type TestContext } from "vitest";
import { PrivilegedGit } from "./git.js";
import { ScopeRegistry } from "./registry.js";
import { ScopeWorkspaces, type WorkspaceProgress, type WorkspaceResult } from "./workspace.js";

const exec = promisify(execFile);
let root: string;
let appData: string;
let seed: string;
let origin: string;
let upstream: string;
const capturedPath = process.env.PATH ?? process.env.Path ?? "";
const registry = new ScopeRegistry();
const firstScope = registry.lookup(KNOWN_SERVICES[0]?.id ?? "");
if (firstScope?.kind !== "service") throw new Error("Expected a service scope");
const scope = firstScope;

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

function gitRunner(env?: NodeJS.ProcessEnv): PrivilegedGit {
  return new PrivilegedGit({
    appData,
    capturedPath,
    allowLocalRemotes: true,
    ...(env ? { env } : {}),
  });
}

function workspaces(git = gitRunner()): ScopeWorkspaces {
  return new ScopeWorkspaces(
    git,
    ({ repo }) => pathToFileURL(repo === scope.origin.repo ? origin : upstream).href,
  );
}

async function commit(text: string): Promise<string> {
  await writeFile(join(seed, "answer.txt"), text);
  await fixtureGit(seed, "add", "--", "answer.txt");
  await fixtureGit(
    seed,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Fixture change",
  );
  return fixtureGit(seed, "rev-parse", "HEAD");
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "spi-scope-test-")));
  appData = join(root, "app data");
  seed = join(root, "seed");
  origin = join(root, "github.git");
  upstream = join(root, "gitlab.git");
  await fixtureGit(root, "init", "--initial-branch", "main", seed);
  await commit("first");
  for (const bare of [origin, upstream]) {
    await fixtureGit(root, "clone", "--bare", seed, bare);
  }
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function getClone(result: WorkspaceResult) {
  if (!result.ok) throw new Error(result.error);
  if (result.workspace.kind !== "clone") throw new Error("Expected a checkout");
  return result.workspace;
}

async function checkout(git: PrivilegedGit) {
  return getClone(await workspaces(git).prepareAsking(scope));
}

async function linkedWorktree(git: PrivilegedGit, clone: string, id = "thread-1") {
  const cwd = join(appData, "worktrees", id);
  const result = await git.run({ clone }, "worktree", ["add", "--detach", cwd, "HEAD"]);
  expect(result).toMatchObject({ ok: true });
  return { clone, worktree: { id, cwd } };
}

function progressStates(progress: WorkspaceProgress[]) {
  return progress.flatMap((event) =>
    event.phase === "output"
      ? []
      : [event.operation === "clone" ? `clone:${event.phase}` : `${event.remote}:${event.phase}`],
  );
}

describe("Asking workspace", () => {
  it("opens Program without touching the filesystem", async () => {
    const program = registry.lookup("program");
    if (!program) throw new Error("Expected Program");
    const git = new PrivilegedGit({ appData, capturedPath: "" });
    expect(await workspaces(git).prepareAsking(program)).toEqual({
      ok: true,
      workspace: { kind: "program" },
    });
    expect(await readdir(root)).not.toContain(basename(appData));
  });

  it("clones once for concurrent threads, then fetches both remotes before a later read", async () => {
    const first: WorkspaceProgress[] = [];
    const second: WorkspaceProgress[] = [];
    const service = workspaces();
    const [a, b] = await Promise.all([
      service.prepareAsking(scope, { onProgress: (event) => first.push(event) }),
      service.prepareAsking(scope, { onProgress: (event) => second.push(event) }),
    ]);
    const workspace = getClone(a);
    expect(workspace.readOnly).toBe(true);
    expect(getClone(b)).toEqual(workspace);
    expect(await fixtureGit(workspace.cwd, "remote", "get-url", "origin")).toBe(
      pathToFileURL(origin).href,
    );
    expect(await fixtureGit(workspace.cwd, "remote", "get-url", "upstream")).toBe(
      pathToFileURL(upstream).href,
    );
    expect([progressStates(first), progressStates(second)]).toEqual(
      expect.arrayContaining([
        [
          "clone:started",
          "clone:completed",
          "origin:started",
          "origin:completed",
          "upstream:started",
          "upstream:completed",
        ],
        ["origin:started", "origin:completed", "upstream:started", "upstream:completed"],
      ]),
    );
    expect([...first, ...second]).toContainEqual(
      expect.objectContaining({ operation: "clone", phase: "output" }),
    );

    await fixtureGit(seed, "checkout", "-b", "new-default");
    const oid = await commit("fresh");
    await fixtureGit(seed, "push", origin, "HEAD:refs/heads/new-default");
    await fixtureGit(root, "--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/new-default");
    await fixtureGit(seed, "push", upstream, "HEAD:refs/heads/main");
    expect(getClone(await workspaces().prepareAsking(scope))).toEqual(workspace);
    expect(await readFile(join(workspace.cwd, "answer.txt"), "utf8")).toBe("fresh");
    expect(await fixtureGit(workspace.cwd, "rev-parse", "refs/remotes/upstream/main")).toBe(oid);
  });

  it("reports a failed clone with the Git error and cleans up before retry", async () => {
    await rename(origin, `${origin}.offline`);
    const progress: WorkspaceProgress[] = [];
    const service = workspaces();
    const result = await service.prepareAsking(scope, {
      onProgress: (event) => progress.push(event),
    });
    expect(result).toMatchObject({ ok: false, operation: "clone", error: /repository|fatal:/i });
    expect(result).not.toHaveProperty("workspace");
    expect(progress.at(-1)).toEqual({
      operation: "clone",
      phase: "failed",
      error: result.ok ? undefined : result.error,
    });
    const owner = scope.origin.repo.split("/")[0]?.toLowerCase() ?? "";
    expect(await readdir(join(appData, "repos", owner))).toEqual([]);

    await rename(`${origin}.offline`, origin);
    const workspace = getClone(await service.prepareAsking(scope));
    expect(await readFile(join(workspace.cwd, "answer.txt"), "utf8")).toBe("first");
  });

  it("returns a fetch failure instead of a workspace and reuses the clone on recovery", async () => {
    const before = await checkout(gitRunner());
    await rename(upstream, `${upstream}.offline`);
    const progress: WorkspaceProgress[] = [];
    const service = workspaces();
    expect(
      await service.prepareAsking(scope, { onProgress: (event) => progress.push(event) }),
    ).toMatchObject({
      ok: false,
      operation: "fetch",
      remote: "upstream",
      error: /repository|fatal:/i,
    });
    expect(progressStates(progress)).toEqual([
      "origin:started",
      "origin:completed",
      "upstream:started",
      "upstream:failed",
    ]);
    await rename(`${upstream}.offline`, upstream);
    expect(getClone(await service.prepareAsking(scope))).toEqual(before);
  });
});

function shellQuote(path: string): string {
  return `'${path.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
}

async function markerScript(script: string, marker: string): Promise<void> {
  await writeFile(script, `#!/bin/sh\nprintf ran > ${shellQuote(marker)}\n`, { mode: 0o755 });
}

async function markerRan(marker: string): Promise<boolean> {
  return (await readdir(root)).includes(basename(marker));
}

/** Proves the canary fires without the guard, so its absence afterwards means something. */
async function expectCanary(marker: string, skip: TestContext["skip"], label?: string) {
  const ran = await markerRan(marker);
  skip(
    process.platform === "win32" && !ran,
    "Git for Windows did not run the shell canary, so its absence would prove nothing.",
  );
  expect(ran, label).toBe(true);
  await rm(marker);
}

async function nestedRepository(directory: string): Promise<string> {
  await fixtureGit(root, "init", "--initial-branch", "main", directory);
  await writeFile(join(directory, "f"), "x");
  await fixtureGit(directory, "add", "--", "f");
  await fixtureGit(
    directory,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Nested",
  );
  return fixtureGit(directory, "rev-parse", "HEAD");
}

async function plantConfig(config: string, script: string): Promise<void> {
  for (const [key, value] of [
    ["core.fsmonitor", shellQuote(script)],
    ["core.sshCommand", shellQuote(script)],
    ["alias.status", `!${shellQuote(script)}`],
    ["credential.helper", `!${shellQuote(script)}`],
  ] as const) {
    await fixtureGit(root, "config", "--file", config, key, value);
  }
}

describe("privileged Git", () => {
  it("does not run a hook planted in the clone", async () => {
    const git = gitRunner();
    const workspace = await checkout(git);
    const hook = join(workspace.gitDirectory, "hooks", "post-checkout");
    await mkdir(dirname(hook), { recursive: true });
    const marker = join(root, "hook-ran");
    await markerScript(hook, marker);

    await linkedWorktree(git, workspace.cwd);
    expect(await readdir(root)).not.toContain(basename(marker));
  });

  it("refuses hostile clone config before Git can run a configured program", async () => {
    const git = gitRunner();
    const workspace = await checkout(git);
    const script = join(root, "program.sh");
    const marker = join(root, "config-ran");
    await markerScript(script, marker);
    await plantConfig(join(workspace.gitDirectory, "config"), script);

    const result = await git
      .run({ clone: workspace.cwd }, "status", ["--porcelain"])
      .catch((error: unknown) => error);
    expect(await readdir(root)).not.toContain(basename(marker));
    expect(result).toEqual(new Error("Managed clone Git configuration changed."));
  });

  it("ignores hostile worktree config and refuses attempts to enable it", async () => {
    const git = gitRunner();
    const workspace = await checkout(git);
    const target = await linkedWorktree(git, workspace.cwd);
    const script = join(root, "program.sh");
    const marker = join(root, "worktree-config-ran");
    await markerScript(script, marker);
    await plantConfig(
      join(workspace.gitDirectory, "worktrees", target.worktree.id, "config.worktree"),
      script,
    );

    expect(await git.run(target, "status", ["--porcelain"])).toMatchObject({ ok: true, data: "" });
    expect(await readdir(root)).not.toContain(basename(marker));

    await fixtureGit(
      root,
      "config",
      "--file",
      join(workspace.gitDirectory, "config"),
      "extensions.worktreeConfig",
      "true",
    );
    const result = await git
      .run(target, "status", ["--porcelain"])
      .catch((error: unknown) => error);
    expect(await readdir(root)).not.toContain(basename(marker));
    expect(result).toEqual(new Error("Managed clone Git configuration changed."));
  });

  it("refuses a worktree whose .git file points to another valid worktree", async () => {
    const git = gitRunner();
    const workspace = await checkout(git);
    const target = await linkedWorktree(git, workspace.cwd);
    const other = await linkedWorktree(git, workspace.cwd, "thread-2");
    const dotGit = join(target.worktree.cwd, ".git");
    expect(await git.run(target, "status", ["--porcelain"])).toMatchObject({ ok: true });
    const repointed = await readFile(join(other.worktree.cwd, ".git"));
    await rm(dotGit);
    await writeFile(dotGit, repointed);

    await expect(git.run(target, "status", ["--porcelain"])).rejects.toThrow(
      "Worktree .git file does not point to its recorded Git directory.",
    );
  });

  it("pins the common directory when a worktree's commondir is repointed", async ({ skip }) => {
    const git = gitRunner();
    const workspace = await checkout(git);
    const target = await linkedWorktree(git, workspace.cwd);
    const script = join(root, "program.sh");
    const marker = join(root, "commondir-ran");
    await markerScript(script, marker);
    const hostile = join(root, "hostile");
    await fixtureGit(root, "clone", "--no-local", origin, hostile);
    await fixtureGit(hostile, "config", "core.fsmonitor", shellQuote(script));
    await writeFile(
      join(workspace.gitDirectory, "worktrees", target.worktree.id, "commondir"),
      `${join(hostile, ".git")}\n`,
    );
    await fixtureGit(target.worktree.cwd, "status", "--porcelain").catch(() => undefined);
    await expectCanary(marker, skip);

    expect(await git.run(target, "status", ["--porcelain"])).toMatchObject({ ok: true, data: "" });
    expect(await markerRan(marker)).toBe(false);
  });

  it("never looks inside a nested repository in a worktree", async ({ skip }) => {
    const git = gitRunner();
    const workspace = await checkout(git);
    const target = await linkedWorktree(git, workspace.cwd);
    const script = join(root, "program.sh");
    const marker = join(root, "nested-ran");
    await markerScript(script, marker);
    const elsewhere = join(root, "elsewhere");
    const oid = await nestedRepository(elsewhere);
    await fixtureGit(elsewhere, "config", "core.fsmonitor", shellQuote(script));
    const sub = join(target.worktree.cwd, "sub");
    await cp(elsewhere, sub, { recursive: true });
    await fixtureGit(
      target.worktree.cwd,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${oid},sub`,
    );

    const quiet = async (state: string, runs: ["status" | "diff", string[]][]) => {
      await fixtureGit(target.worktree.cwd, "status", "--porcelain");
      await expectCanary(marker, skip, `${state}: Git without the guard runs it`);
      for (const [command, args] of runs) {
        expect(await git.run(target, command, args)).toMatchObject({ ok: true });
        expect(await markerRan(marker), `${state}: ${command} ${args.join(" ")}`).toBe(false);
      }
    };
    await quiet("core.fsmonitor", [
      ["status", ["--porcelain"]],
      ["diff", []],
      ["diff", ["HEAD"]],
    ]);

    const nested = join(sub, ".git");
    await fixtureGit(root, "config", "--file", join(nested, "config"), "--unset", "core.fsmonitor");
    await fixtureGit(
      root,
      "config",
      "--file",
      join(nested, "config"),
      "filter.canary.clean",
      shellQuote(script),
    );
    await mkdir(join(nested, "info"), { recursive: true });
    await writeFile(join(nested, "info", "attributes"), "* filter=canary\n");
    await writeFile(join(sub, "f"), "y");
    await quiet("clean filter", [["status", ["--porcelain"]]]);

    const outside = join(root, "outside.git");
    await rename(nested, outside);
    await fixtureGit(
      root,
      "config",
      "--file",
      join(outside, "config"),
      "core.fsmonitor",
      shellQuote(script),
    );
    await fixtureGit(root, "config", "--file", join(outside, "config"), "core.worktree", sub);
    await writeFile(join(sub, ".git"), `gitdir: ${outside}\n`);
    await quiet(".git file outside the worktree", [["status", ["--porcelain"]]]);
  });

  it("never looks inside a nested repository the shared clone's tree links", async ({ skip }) => {
    const script = join(root, "program.sh");
    const marker = join(root, "gitlink-ran");
    await markerScript(script, marker);
    const elsewhere = join(root, "elsewhere");
    const oid = await nestedRepository(elsewhere);
    await fixtureGit(elsewhere, "config", "core.fsmonitor", shellQuote(script));
    await fixtureGit(seed, "update-index", "--add", "--cacheinfo", `160000,${oid},sub`);
    await commit("first");
    await fixtureGit(seed, "push", origin, "HEAD:refs/heads/main");
    const git = gitRunner();
    const workspace = await checkout(git);
    await cp(join(elsewhere, ".git"), join(workspace.cwd, "sub", ".git"), { recursive: true });
    await fixtureGit(workspace.cwd, "status", "--porcelain");
    await expectCanary(marker, skip);

    expect(await git.run({ clone: workspace.cwd }, "status", ["--porcelain"])).toMatchObject({
      ok: true,
    });
    expect(getClone(await workspaces(git).prepareAsking(scope))).toEqual(workspace);
    expect(await markerRan(marker)).toBe(false);
  });

  it.each([
    ["status", ["--ignore-submod=none"]],
    ["status", ["--no-ignore-submodules"]],
    ["diff", ["--ignore-submodules=dirty"]],
    ["checkout", ["HEAD"]],
    ["checkout", ["--detach", "HEAD"]],
    ["checkout", ["--force", "HEAD"]],
    ["checkout", ["--detach", "--force", "HEAD", "--", "answer.txt"]],
  ] as const)("refuses %s %j before running Git", async (command, args) => {
    await expect(gitRunner().run({ clone: root }, command, args)).rejects.toThrow(
      /^Privileged Git (controls submodule handling|checkout requires --detach --force and one ref)\.$/u,
    );
  });

  it.each(["add", "commit"])("refuses %s, which is not a privileged command", async (command) => {
    // @ts-expect-error The test passes a command outside the runner's closed list.
    await expect(gitRunner().run({ clone: root }, command, [])).rejects.toThrow(
      `Unsupported privileged Git command: ${command}.`,
    );
  });

  it("drops inherited Git overrides and uses a private home", async () => {
    const script = join(root, "program.sh");
    const marker = join(root, "ambient-config-ran");
    await markerScript(script, marker);
    await plantConfig(join(root, ".gitconfig"), script);
    const git = gitRunner({
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      GIT_CONFIG_GLOBAL: join(root, ".gitconfig"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: shellQuote(script),
      GH_TOKEN: "fixture-only",
      SSH_AUTH_SOCK: join(root, "fake-agent"),
    });
    const workspace = await checkout(git);
    expect(await git.run({ clone: workspace.cwd }, "status", ["--porcelain"])).toMatchObject({
      ok: true,
      data: "",
    });
    expect(await readdir(root)).not.toContain(basename(marker));
  });
});
