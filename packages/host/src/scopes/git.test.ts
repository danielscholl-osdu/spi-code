// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { ExecResult } from "@spi-code/core";
import { KNOWN_SERVICES } from "@spi-code/core";
import { afterEach, beforeEach, describe, expect, it, type TestContext } from "vitest";
import type { ConfinedResult, MxcApi } from "./confined.js";
import {
  type GitOptions,
  type GitTarget,
  PrivilegedGit,
  type PrivilegedGitOptions,
  type WorktreeTarget,
} from "./git.js";
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
const identity = { name: "Fixture Operator", email: "operator@example.invalid" };

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

function gitRunner(
  env?: NodeJS.ProcessEnv,
  confinement: Pick<PrivilegedGitOptions, "mxc" | "platform"> = {},
): PrivilegedGit {
  return new PrivilegedGit({
    appData,
    capturedPath,
    allowLocalRemotes: true,
    ...(env ? { env } : {}),
    ...confinement,
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
  const result = await git.addWorktree(clone, id, "HEAD");
  if (!result.ok) throw new Error(result.error);
  expect(result.data.worktree.cwd).toBe(join(appData, "worktrees", id));
  return result.data;
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
    expect(await git.listWorktrees(workspace.cwd)).toMatchObject({
      ok: true,
      data: expect.stringMatching(/\0worktree [^\0]*thread-1\0/u),
    });
  });

  it("refuses hostile clone config before Git can run a configured program", async () => {
    const git = gitRunner();
    const workspace = await checkout(git);
    const script = join(root, "program.sh");
    const marker = join(root, "config-ran");
    await markerScript(script, marker);
    await plantConfig(join(workspace.gitDirectory, "config"), script);

    const result = await git.status({ clone: workspace.cwd }).catch((error: unknown) => error);
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

    expect(await git.status(target)).toMatchObject({ ok: true, data: "" });
    expect(await readdir(root)).not.toContain(basename(marker));

    await fixtureGit(
      root,
      "config",
      "--file",
      join(workspace.gitDirectory, "config"),
      "extensions.worktreeConfig",
      "true",
    );
    const result = await git.status(target).catch((error: unknown) => error);
    expect(await readdir(root)).not.toContain(basename(marker));
    expect(result).toEqual(new Error("Managed clone Git configuration changed."));
  });

  it("refuses a worktree whose .git file points to another valid worktree", async () => {
    const git = gitRunner();
    const workspace = await checkout(git);
    const target = await linkedWorktree(git, workspace.cwd);
    const other = await linkedWorktree(git, workspace.cwd, "thread-2");
    const dotGit = join(target.worktree.cwd, ".git");
    expect(await git.status(target)).toMatchObject({ ok: true });
    const repointed = await readFile(join(other.worktree.cwd, ".git"));
    await rm(dotGit);
    await writeFile(dotGit, repointed);

    await expect(git.status(target)).rejects.toThrow(
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

    expect(await git.status(target)).toMatchObject({ ok: true, data: "" });
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

    type Run = (target: GitTarget) => Promise<ExecResult<string>>;
    const status: Run = (target) => git.status(target);
    const quiet = async (state: string, runs: Record<string, Run>) => {
      await fixtureGit(target.worktree.cwd, "status", "--porcelain");
      await expectCanary(marker, skip, `${state}: Git without the guard runs it`);
      for (const [name, run] of Object.entries(runs)) {
        expect(await run(target)).toMatchObject({ ok: true });
        expect(await markerRan(marker), `${state}: ${name}`).toBe(false);
      }
    };
    await quiet("core.fsmonitor", {
      status,
      "diff HEAD": (target) => git.diff(target),
      "diff a named ref": (target) => git.diff(target, "refs/spi/asking"),
    });

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
    await quiet("clean filter", { status });

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
    await quiet(".git file outside the worktree", { status });
  });

  it("never looks inside a nested repository the shared clone's tree links", async ({ skip }) => {
    const script = join(root, "program.sh");
    const marker = join(root, "gitlink-ran");
    await markerScript(script, marker);
    const elsewhere = join(root, "elsewhere");
    const oid = await nestedRepository(elsewhere);
    await fixtureGit(elsewhere, "config", "core.fsmonitor", shellQuote(script));
    await fixtureGit(seed, "update-index", "--add", "--cacheinfo", `160000,${oid},sub`);
    // Without .gitmodules, Git run from outside the work tree never finds the nested repository.
    await writeFile(
      join(seed, ".gitmodules"),
      '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n\tfetchRecurseSubmodules = true\n',
    );
    await fixtureGit(seed, "add", "--", ".gitmodules");
    await commit("first");
    await fixtureGit(seed, "push", origin, "HEAD:refs/heads/main");
    const git = gitRunner();
    const workspace = await checkout(git);
    await cp(join(elsewhere, ".git"), join(workspace.cwd, "sub", ".git"), { recursive: true });
    const target = { clone: workspace.cwd };
    await fixtureGit(workspace.cwd, "status", "--porcelain");
    await expectCanary(marker, skip, "status");
    expect(await git.status(target)).toMatchObject({ ok: true });
    expect(await markerRan(marker)).toBe(false);

    await fixtureGit(workspace.cwd, "fetch", "--recurse-submodules", "origin");
    await expectCanary(marker, skip, "fetch");
    for (const remote of ["origin", "upstream"]) {
      expect(await git.fetch(target, { remote, tags: true })).toMatchObject({ ok: true });
    }
    expect(getClone(await workspaces(git).prepareAsking(scope))).toEqual(workspace);
    expect(await markerRan(marker)).toBe(false);
  });

  it("pushes one ref as a dry run without changing the remote", async () => {
    const git = gitRunner();
    const workspace = await checkout(git);
    const result = await git.push(
      { clone: workspace.cwd },
      { remote: "origin", source: "HEAD", destination: "refs/heads/spi-dry-run", dryRun: true },
    );
    expect(result).toMatchObject({
      ok: true,
      data: expect.stringContaining("refs/heads/spi-dry-run"),
    });
    expect(await fixtureGit(root, "--git-dir", origin, "for-each-ref", "--format=%(refname)")).toBe(
      "refs/heads/main",
    );
  });

  const target = { clone: "/nowhere" };
  const worktreeTarget = { clone: "/nowhere", worktree: { id: "t", cwd: "/nowhere/t" } };
  const remote = /^Invalid Git remote name\.$/u;
  const ref = /^Invalid Git ref\.$/u;
  const id = /^Worktree is outside its managed location\.$/u;
  const refusals = [
    ...[
      "-x",
      "--upload-pack=x",
      "../x",
      "file:///x",
      "https://example.invalid/x",
      "ext::sh",
      "",
    ].flatMap((name) => [
      [
        `fetch from ${name}`,
        remote,
        (git: PrivilegedGit) => git.fetch(target, { remote: name, tags: false }),
      ],
      [`get-url of ${name}`, remote, (git: PrivilegedGit) => git.remoteUrl(target, name)],
      [
        `push to ${name}`,
        remote,
        (git: PrivilegedGit) =>
          git.push(target, { remote: name, source: "HEAD", destination: "refs/heads/x" }),
      ],
    ]),
    ...[
      "-p",
      "--output=x",
      "main",
      "HEAD~1",
      "HEAD^",
      "HEAD@{1}",
      "HEAD..refs/heads/x",
      "refs/heads/a..b",
      "refs/heads/../x",
      "refs/heads/x.lock",
      "refs/heads/x.",
      "refs/heads/.x",
      "refs/stash",
      "refs/heads/x:refs/heads/y",
      ":/message",
      "abc123",
    ].flatMap((name) => [
      [`diff against ${name}`, ref, (git: PrivilegedGit) => git.diff(target, name)],
      [`checkout of ${name}`, ref, (git: PrivilegedGit) => git.checkoutDetached(target, name)],
      [
        `worktree at ${name}`,
        ref,
        (git: PrivilegedGit) => git.addWorktree(target.clone, "t", name),
      ],
      [
        `push of ${name}`,
        ref,
        (git: PrivilegedGit) =>
          git.push(target, { remote: "origin", source: name, destination: "refs/heads/x" }),
      ],
    ]),
    ...["HEAD", "+refs/heads/x", "refs/heads/x:refs/heads/y"].flatMap((name) => [
      [
        `fetch of HEAD into ${name}`,
        ref,
        (git: PrivilegedGit) => git.fetch(target, { remote: "origin", tags: false, head: name }),
      ],
      [
        `push into ${name}`,
        ref,
        (git: PrivilegedGit) =>
          git.push(target, { remote: "origin", source: "HEAD", destination: name }),
      ],
    ]),
    ...["..", "a/b", ""].map((name) => [
      `worktree id ${name}`,
      id,
      (git: PrivilegedGit) => git.addWorktree(target.clone, name, "HEAD"),
    ]),
    ...[
      "",
      "/abs",
      "../x",
      "a/../b",
      "./a",
      "a/.",
      "a//b",
      "a/",
      ".git",
      ".GIT/config",
      "a/.git/config",
      "a\\b",
      "a\0b",
    ].map((path) => [
      `add of ${JSON.stringify(path)}`,
      /^Invalid worktree path\.$/u,
      (git: PrivilegedGit) => git.add(worktreeTarget, [path]),
    ]),
    [
      "add of no paths",
      /^Invalid worktree path\.$/u,
      (git: PrivilegedGit) => git.add(worktreeTarget, []),
    ],
    ...["", " \n", "a\0b"].map((message) => [
      `commit message ${JSON.stringify(message)}`,
      /^Invalid commit message\.$/u,
      (git: PrivilegedGit) => git.commit(worktreeTarget, message, identity),
    ]),
    ...["", " ", "a\nb", "a\rb", "<a>", "a\0b", "x".repeat(257)].flatMap((value) => [
      [
        `commit name ${JSON.stringify(value)}`,
        /^Invalid commit identity\.$/u,
        (git: PrivilegedGit) => git.commit(worktreeTarget, "m", { ...identity, name: value }),
      ],
      [
        `commit email ${JSON.stringify(value)}`,
        /^Invalid commit identity\.$/u,
        (git: PrivilegedGit) => git.commit(worktreeTarget, "m", { ...identity, email: value }),
      ],
    ]),
  ] as [string, RegExp, (git: PrivilegedGit) => Promise<unknown>][];

  it("refuses an invalid remote, ref or worktree id before running Git", async () => {
    const git = gitRunner();
    for (const [label, error, operation] of refusals) {
      await expect(operation(git), label).rejects.toThrow(error);
    }
  });

  it("takes no argument list from its callers", () => {
    type Inputs<F> = F extends (...args: infer P) => unknown ? P[number] : never;
    type Fields<T> = T extends AbortSignal | ((...args: never[]) => unknown)
      ? never
      : T extends object
        ? T[keyof T]
        : never;
    // add's paths are validated worktree paths, never options.
    type Add = Parameters<PrivilegedGit["add"]>;
    type Input = Inputs<PrivilegedGit[Exclude<keyof PrivilegedGit, "add">]> | Add[0] | Add[2];
    type Lists = Extract<Input | Fields<Input> | Fields<Fields<Input>>, readonly unknown[]>;
    const noLists: [Lists] extends [never] ? true : false = true;
    type Variadic = {
      [K in keyof PrivilegedGit]: PrivilegedGit[K] extends (...args: infer P) => unknown
        ? number extends P["length"]
          ? K
          : never
        : never;
    }[keyof PrivilegedGit];
    const noRest: [Variadic] extends [never] ? true : false = true;
    const misuse = (git: PrivilegedGit, options: GitOptions) => [
      // @ts-expect-error Options are fixed by the runner.
      git.status({ clone: root }, ["--no-ignore-submodules"]),
      // @ts-expect-error Options are fixed by the runner.
      git.fetch({ clone: root }, { remote: "origin", tags: false, args: ["--recurse-submodules"] }),
      git.status({ clone: root }, options),
    ];
    expect([noLists, noRest, typeof misuse]).toEqual([true, true, "function"]);
    expect(Object.getOwnPropertyNames(PrivilegedGit.prototype).sort()).toEqual(
      [
        "add",
        "addWorktree",
        "checkoutDetached",
        "clone",
        "commit",
        "constructor",
        "dataRoot",
        "diff",
        "fetch",
        "listWorktrees",
        "push",
        "remoteUrl",
        "status",
      ].sort(),
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
    expect(await git.status({ clone: workspace.cwd })).toMatchObject({
      ok: true,
      data: "",
    });
    expect(await readdir(root)).not.toContain(basename(marker));
  });
});

const macOnly = process.platform !== "darwin";
const cleaned =
  /^(GIT_[A-Z_]+|HOME|USERPROFILE|XDG_CONFIG_HOME|TMPDIR|TMP|TEMP|LC_ALL|PATH|PWD|SHLVL|SSH_ASKPASS|_)$/u;

interface Canary {
  readonly target: WorktreeTarget;
  readonly clone: string;
  /** Written by the planted program inside the worktree: proof that it ran. */
  readonly inside: string;
  /** Outside every writable path; plain Git writes it. */
  readonly fired: string;
  readonly home: string;
  readonly protectedFiles: readonly string[];
}

async function plainGit(cwd: string, ...args: string[]): Promise<void> {
  await exec("git", args, {
    cwd,
    windowsHide: true,
    env: {
      PATH: capturedPath,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(root, "empty-config"),
      SPI_PLAIN: "1",
    },
  }).catch(() => undefined);
}

/** A nested repository in a linked worktree whose config names a program that tries to escape. */
async function plantCanary(git: PrivilegedGit, kind: "fsmonitor" | "filter"): Promise<Canary> {
  const workspace = await checkout(git);
  const target = await linkedWorktree(git, workspace.cwd);
  const worktree = target.worktree.cwd;
  const elsewhere = join(root, "elsewhere");
  const oid = await nestedRepository(elsewhere);
  const sub = join(worktree, "sub");
  await cp(elsewhere, sub, { recursive: true });
  await fixtureGit(worktree, "update-index", "--add", "--cacheinfo", `160000,${oid},sub`);
  const canary: Canary = {
    target,
    clone: workspace.cwd,
    inside: join(sub, "inside-ran"),
    fired: join(root, `${kind}-ran`),
    home: join(homedir(), `spi-canary-${randomUUID()}`),
    protectedFiles: [join(workspace.gitDirectory, "config"), join(worktree, ".git")],
  };
  const script = join(sub, "canary.sh");
  await writeFile(
    script,
    [
      "#!/bin/sh",
      `printf ran > ${shellQuote(canary.inside)}`,
      `printf ran > ${shellQuote(canary.fired)}`,
      '[ -n "$SPI_PLAIN" ] && exit 0',
      `env | cut -d= -f1 | sort -u > ${shellQuote(`${canary.inside}-env`)}`,
      `printf ran > ${shellQuote(canary.home)}`,
      ...canary.protectedFiles.map((file) => `printf x >> ${shellQuote(file)}`),
      `mkdir ${shellQuote(join(workspace.gitDirectory, "hooks"))}`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const config = join(sub, ".git", "config");
  if (kind === "fsmonitor") {
    await fixtureGit(root, "config", "--file", config, "core.fsmonitor", shellQuote(script));
  } else {
    await fixtureGit(root, "config", "--file", config, "filter.canary.clean", shellQuote(script));
    await mkdir(join(sub, ".git", "info"), { recursive: true });
    await writeFile(join(sub, ".git", "info", "attributes"), "* filter=canary\n");
    // Same size as the committed content, so only the clean filter can tell it changed.
    await writeFile(join(sub, "f"), "y");
  }
  return canary;
}

async function exists(path: string): Promise<boolean> {
  return readFile(path).then(
    () => true,
    () => false,
  );
}

async function snapshot(canary: Canary): Promise<Buffer[]> {
  return Promise.all(canary.protectedFiles.map((file) => readFile(file)));
}

describe("confined add and commit", () => {
  const _head = (canary: Canary) => fixtureGit(canary.target.worktree.cwd, "rev-parse", "HEAD");

  it.skipIf(macOnly)("commits a regular file in a linked worktree and advances HEAD", async () => {
    const git = gitRunner();
    const workspace = await checkout(git);
    const target = await linkedWorktree(git, workspace.cwd);
    const before = await fixtureGit(target.worktree.cwd, "rev-parse", "HEAD");
    const name = "it's $(touch quoted-ran) `touch ticked-ran`; x.txt";
    await writeFile(join(target.worktree.cwd, name), "new\n");
    const message = "Change it's $(touch quoted-ran)\n\n`touch ticked-ran`; done";

    const added = await git.add(target, [name]);
    expect(added).toEqual({ ok: true, data: "", afterExit: "not-known" });
    const committed = await git.commit(target, message, identity);
    expect(committed).toMatchObject({ ok: true, afterExit: "not-known" });

    const after = await fixtureGit(target.worktree.cwd, "rev-parse", "HEAD");
    expect(after).not.toBe(before);
    expect(await fixtureGit(target.worktree.cwd, "rev-parse", "HEAD~1")).toBe(before);
    expect(await fixtureGit(target.worktree.cwd, "log", "-1", "--format=%B")).toBe(message);
    expect(await fixtureGit(target.worktree.cwd, "log", "-1", "--format=%an <%ae>|%cn <%ce>")).toBe(
      "Fixture Operator <operator@example.invalid>|Fixture Operator <operator@example.invalid>",
    );
    expect(await fixtureGit(target.worktree.cwd, "show", "--name-only", "--format=")).toBe(name);
    for (const directory of [root, target.worktree.cwd, workspace.cwd]) {
      expect(await readdir(directory)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^(quoted|ticked)-ran$/u)]),
      );
    }
    expect(await git.status(target)).toMatchObject({ ok: true, data: "" });
  });

  it.skipIf(macOnly)(
    "reports a Git failure as having run, with what happens after unknown",
    async () => {
      const git = gitRunner();
      const workspace = await checkout(git);
      const target = await linkedWorktree(git, workspace.cwd);
      expect(await git.commit(target, "Nothing", identity)).toMatchObject({
        ok: false,
        code: 1,
        afterExit: "not-known",
      });
    },
  );

  const operations = {
    "add .": (git: PrivilegedGit, canary: Canary) => git.add(canary.target, ["."]),
    "commit -a": (git: PrivilegedGit, canary: Canary) =>
      git.commit(canary.target, "Confined", identity, { all: true }),
  };
  const plain = { "add .": ["add", "--", "."], "commit -a": ["commit", "-qam", "Plain"] };

  for (const kind of ["fsmonitor", "filter"] as const) {
    for (const [name, operation] of Object.entries(operations)) {
      const label = name as keyof typeof operations;
      it.skipIf(macOnly)(
        `runs a nested repository's ${kind} program confined under ${label}`,
        async () => {
          const git = gitRunner();
          const canary = await plantCanary(git, kind);
          const worktree = canary.target.worktree.cwd;
          try {
            await writeFile(join(worktree, "answer.txt"), "changed");
            await plainGit(worktree, ...plain[label]);
            expect(await exists(canary.fired), `${kind}: plain ${label} runs it`).toBe(true);
            await fixtureGit(worktree, "reset", "-q", "HEAD@{1}").catch(() => undefined);
            await rm(canary.fired);
            await rm(canary.inside);
            await writeFile(join(worktree, "answer.txt"), "changed again");
            const before = await snapshot(canary);
            const head = await fixtureGit(worktree, "rev-parse", "HEAD");

            const result = await operation(git, canary);
            expect(result).toMatchObject({ ok: true, afterExit: "not-known" });
            expect(await exists(canary.inside), "the program ran inside the sandbox").toBe(true);
            const names = (await readFile(`${canary.inside}-env`, "utf8")).split("\n");
            expect(names).toEqual(expect.arrayContaining(["GIT_CONFIG_NOSYSTEM", "HOME", "PATH"]));
            expect(names.filter((name) => name && !cleaned.test(name))).toEqual([]);
            expect(await exists(canary.fired)).toBe(false);
            expect(await exists(canary.home)).toBe(false);
            expect(await snapshot(canary)).toEqual(before);
            expect(await readdir(join(canary.clone, ".git"))).not.toContain("hooks");
            if (label === "commit -a") {
              expect(await fixtureGit(worktree, "rev-parse", "HEAD~1")).toBe(head);
            }
            expect(await git.status(canary.target)).toMatchObject({ ok: true });
          } finally {
            await rm(canary.home, { force: true });
          }
        },
      );
    }
  }

  const unavailable = (reason: string) => ({ ok: false, refused: reason, code: null });
  const result = (stdout = ""): Awaited<ReturnType<MxcApi["run"]>> => ({
    stdout,
    stderr: "",
    exitCode: 0,
    timedOut: false,
    warnings: [],
  });
  const supported = { isSupported: true, availableMethods: ["seatbelt"] };
  const failures: [string, Pick<PrivilegedGitOptions, "mxc" | "platform">, string][] = [
    ["Windows", { platform: "win32" }, "unsupported-platform"],
    ["Linux", { platform: "linux" }, "unsupported-platform"],
    [
      "a missing SDK",
      { platform: "darwin", mxc: () => Promise.reject(new Error("Cannot find module")) },
      "mxc-unavailable",
    ],
    [
      "an unsupported host",
      {
        platform: "darwin",
        mxc: async () => ({
          getPlatformSupport: () => ({ isSupported: false, availableMethods: [] }),
          run: async () => result(),
        }),
      },
      "mxc-unavailable",
    ],
    [
      "a sandbox that fails to start",
      {
        platform: "darwin",
        mxc: async () => ({
          getPlatformSupport: () => supported,
          run: () => Promise.reject(new Error("spawn mxc-exec-mac ENOENT")),
        }),
      },
      "mxc-failed",
    ],
    [
      "a sandbox that runs nothing",
      {
        platform: "darwin",
        mxc: async () => ({ getPlatformSupport: () => supported, run: async () => result() }),
      },
      "confinement-not-proven",
    ],
    ...(process.platform === "win32"
      ? []
      : ([
          [
            "a sandbox that does not confine",
            {
              platform: "darwin",
              mxc: async () => ({
                getPlatformSupport: () => supported,
                run: async (request) => {
                  const ran = spawnSync("/bin/sh", ["-c", request.command], {
                    cwd: request.workingDirectory,
                    env: request.environment,
                    encoding: "utf8",
                  });
                  return {
                    ...result(ran.stdout),
                    stderr: ran.stderr,
                    exitCode: ran.status ?? 1,
                  };
                },
              }),
            },
            "confinement-not-proven",
          ],
        ] as typeof failures)),
  ];

  it("refuses add and commit and runs nothing when the sandbox cannot be proven", async () => {
    const git = gitRunner();
    const workspace = await checkout(git);
    const target = await linkedWorktree(git, workspace.cwd);
    const worktree = target.worktree.cwd;
    const script = join(root, "program.sh");
    const marker = join(root, "fail-closed-ran");
    await markerScript(script, marker);
    const elsewhere = join(root, "elsewhere");
    const oid = await nestedRepository(elsewhere);
    await fixtureGit(elsewhere, "config", "core.fsmonitor", shellQuote(script));
    await cp(elsewhere, join(worktree, "sub"), { recursive: true });
    await fixtureGit(worktree, "update-index", "--add", "--cacheinfo", `160000,${oid},sub`);
    await writeFile(join(worktree, "answer.txt"), "changed");
    await fixtureGit(worktree, "add", "--", ".");
    if (process.platform !== "win32") expect(await markerRan(marker)).toBe(true);
    await rm(marker, { force: true });
    await writeFile(join(worktree, "answer.txt"), "changed again");
    const index = join(workspace.gitDirectory, "worktrees", target.worktree.id, "index");
    const before = [await readFile(index), await fixtureGit(worktree, "rev-parse", "HEAD")];

    for (const [label, confinement, reason] of failures) {
      const refused = gitRunner(undefined, confinement);
      const results: ConfinedResult[] = [
        await refused.add(target, ["."]),
        await refused.commit(target, "Refused", identity, { all: true }),
      ];
      for (const outcome of results) {
        expect(outcome, label).toMatchObject(unavailable(reason));
        expect(outcome, label).not.toHaveProperty("afterExit");
      }
      expect(await markerRan(marker), label).toBe(false);
      expect(
        [await readFile(index), await fixtureGit(worktree, "rev-parse", "HEAD")],
        label,
      ).toEqual(before);
    }
    if (process.platform !== "darwin") {
      expect(await gitRunner().add(target, ["."])).toMatchObject(
        unavailable("unsupported-platform"),
      );
    }
  });
});
