// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
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
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { ExecResult } from "@spi-code/core";
import { KNOWN_SERVICES } from "@spi-code/core";
import { afterEach, beforeEach, describe, expect, it, type TestContext, vi } from "vitest";
import { type ConfinedResult, loadMxc, type MxcApi } from "./confined.js";
import {
  type GitOptions,
  type GitTarget,
  PrivilegedGit,
  type PrivilegedGitOptions,
  type WorktreeTarget,
} from "./git.js";
import { ScopeRegistry } from "./registry.js";
import { ScopeWorkspaces, type WorkspaceProgress, type WorkspaceResult } from "./workspace.js";

const faults = vi.hoisted(() => ({
  mkdtemp: undefined as RegExp | undefined,
  rm: undefined as RegExp | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const mkdtemp = (async (prefix: string, options?: Parameters<typeof actual.mkdtemp>[1]) => {
    if (faults.mkdtemp?.test(prefix)) {
      throw Object.assign(new Error("ENOSPC: no space left on device, mkdtemp"), {
        code: "ENOSPC",
      });
    }
    return actual.mkdtemp(prefix, options);
  }) as typeof actual.mkdtemp;
  const rm = (async (
    path: Parameters<typeof actual.rm>[0],
    options?: Parameters<typeof actual.rm>[1],
  ) => {
    if (faults.rm?.test(String(path))) {
      throw Object.assign(new Error("EBUSY: resource busy or locked, rmdir"), { code: "EBUSY" });
    }
    return actual.rm(path, options);
  }) as typeof actual.rm;
  return { ...actual, mkdtemp, rm, default: { ...actual, mkdtemp, rm } };
});

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
const helperToken = "fixture-helper-secret";

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

  it("clones once and fetches both remotes for concurrent threads", async () => {
    const first: WorkspaceProgress[] = [];
    const second: WorkspaceProgress[] = [];
    const prepared: [string[], string[]] = [[], []];
    const service = workspaces();
    const prepare = (progress: WorkspaceProgress[], log: string[]) =>
      service.prepareAsking(scope, {
        onProgress: (event) => progress.push(event),
        onPrepare: ({ operation, phase }) => log.push(`${operation}:${phase}`),
      });
    const [a, b] = await Promise.all([prepare(first, prepared[0]), prepare(second, prepared[1])]);
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
    expect(prepared).toEqual(
      expect.arrayContaining([
        ["clone:started", "clone:finished"],
        ["fetch:started", "fetch:finished"],
      ]),
    );
  });

  it("follows a renamed default branch and refreshes upstream before a later read", async () => {
    const workspace = await checkout(gitRunner());
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

  it("preserves the checkout as stale on a fetch failure and clears it on recovery", async () => {
    const before = await checkout(gitRunner());
    await rename(upstream, `${upstream}.offline`);
    const progress: WorkspaceProgress[] = [];
    const service = workspaces();
    expect(
      await service.prepareAsking(scope, { onProgress: (event) => progress.push(event) }),
    ).toMatchObject({
      ok: true,
      workspace: {
        ...before,
        fetchError: { operation: "fetch", remote: "upstream", error: /repository|fatal:/i },
      },
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

describe("thread worktrees", () => {
  it("gives each destination its settled base and two threads two worktrees", async () => {
    await fixtureGit(seed, "checkout", "-b", "fork_integration");
    const integration = await commit("integration");
    await fixtureGit(seed, "push", origin, "HEAD:refs/heads/fork_integration");
    await fixtureGit(seed, "checkout", "main");
    const main = await fixtureGit(origin, "rev-parse", "refs/heads/main");
    const upstreamHead = await fixtureGit(upstream, "rev-parse", "HEAD");
    const db = new DatabaseSync(":memory:");
    const service = workspaces();
    try {
      const cases = [
        ["main-thread", "fork-main", main],
        ["integration-thread", "fork-integration", integration],
        ["upstream-thread", "upstream", upstreamHead],
      ] as const;
      for (const [threadId, target, expected] of cases) {
        const landed = await service.land(db, scope, threadId, { target });
        expect(landed).toMatchObject({
          ok: true,
          landsIn: { target, branch: `spi/${threadId}`, head: expected },
        });
        if (!landed.ok || landed.landsIn.target === "asking")
          throw new Error(landed.ok ? "Expected a worktree" : landed.error);
        expect(await fixtureGit(landed.landsIn.worktree, "branch", "--show-current")).toBe(
          `spi/${threadId}`,
        );
      }
      expect(db.prepare("SELECT COUNT(*) AS count FROM thread_workspaces").get()?.count).toBe(3);
      expect(new Set(cases.map(([id]) => `thread-${id}`)).size).toBe(3);
      const clone = getClone(await service.prepareAsking(scope));
      expect(await readFile(join(clone.gitDirectory, "config"))).toEqual(
        await readFile(join(dirname(clone.cwd), "clone.config")),
      );
    } finally {
      db.close();
    }
  }, 120_000);

  it("fetches a fork request head, serializes its branch and reuses it after release", async () => {
    await fixtureGit(seed, "checkout", "-b", "review/port-42");
    const head = await commit("request");
    await fixtureGit(seed, "push", origin, "HEAD:refs/pull/42/head");
    await fixtureGit(seed, "checkout", "main");
    const db = new DatabaseSync(":memory:");
    const git = gitRunner();
    const service = workspaces(git);
    try {
      const request = {
        target: "request" as const,
        forge: "github" as const,
        repository: scope.origin.repo,
        requestNumber: 42,
        branch: "contributor/port-42",
        head,
      };
      const [first, second] = await Promise.all([
        service.land(db, scope, "request-one", request),
        service.land(db, scope, "request-two", request),
      ]);
      expect(first).toMatchObject({
        ok: true,
        landsIn: {
          target: "request",
          branch: request.branch,
          head,
          forge: "github",
          repository: scope.origin.repo,
          requestNumber: 42,
          sourceBranch: request.branch,
        },
      });
      expect(second).toMatchObject({
        ok: false,
        error: expect.stringMatching(/contributor\/port-42.*request-one/u),
      });
      const firstResult = first;
      if (!firstResult.ok || firstResult.landsIn.target === "asking")
        throw new Error(firstResult.ok ? "Expected a worktree" : firstResult.error);
      const clone = getClone(await service.prepareAsking(scope)).cwd;
      expect(await fixtureGit(clone, "rev-parse", "refs/spi/requests/github/42")).toBe(head);
      await git.rollbackWorktree({
        clone,
        worktree: { id: "thread-request-one", cwd: firstResult.landsIn.worktree },
      });
      db.prepare("DELETE FROM thread_workspaces WHERE thread_id = ?").run("request-one");
      await fixtureGit(
        clone,
        "update-ref",
        `refs/heads/${request.branch}`,
        "refs/remotes/origin/main",
      );
      expect(await service.land(db, scope, "request-mismatch", request)).toMatchObject({
        ok: false,
        error: expect.stringMatching(/no longer points.*observed request head/u),
      });
      await fixtureGit(clone, "update-ref", `refs/heads/${request.branch}`, head);
      expect(await service.land(db, scope, "request-three", request)).toMatchObject({
        ok: true,
        landsIn: { target: "request", branch: request.branch, head },
      });
    } finally {
      db.close();
    }
  }, 120_000);

  it("fetches a GitLab merge request ref and refuses an observed-head mismatch", async () => {
    await fixtureGit(seed, "checkout", "-b", "review/gitlab-7");
    const head = await commit("gitlab request");
    await fixtureGit(seed, "push", upstream, "HEAD:refs/merge-requests/7/head");
    await fixtureGit(seed, "checkout", "main");
    const db = new DatabaseSync(":memory:");
    const service = workspaces();
    try {
      const request = {
        target: "request" as const,
        forge: "gitlab" as const,
        repository: scope.upstream?.repo ?? "",
        requestNumber: 7,
        branch: "review/gitlab-7",
      };
      expect(
        await service.land(db, scope, "request-wrong-head", { ...request, head: "a".repeat(40) }),
      ).toMatchObject({ ok: false, error: expect.stringMatching(/does not match/u) });
      expect(
        await service.land(db, scope, "request-right-head", { ...request, head }),
      ).toMatchObject({
        ok: true,
        landsIn: {
          target: "request",
          forge: "gitlab",
          repository: request.repository,
          requestNumber: 7,
          head,
        },
      });
    } finally {
      db.close();
    }
  }, 120_000);

  it("leaves a failed writable landing without a worktree and says why", async () => {
    const db = new DatabaseSync(":memory:");
    const service = workspaces();
    try {
      const result = await service.land(db, scope, "missing-base", {
        target: "fork-integration",
      });
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringMatching(/fork_integration/u),
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM thread_workspaces").get()?.count).toBe(0);
    } finally {
      db.close();
    }
  });

  it("marks a deleted thread's worktree as kept without reading or removing it", async () => {
    const db = new DatabaseSync(":memory:");
    const git = gitRunner();
    const service = workspaces(git);
    try {
      const landed = await service.land(db, scope, "delete-ignored", { target: "fork-main" });
      if (!landed.ok || landed.landsIn.target === "asking")
        throw new Error(landed.ok ? "Expected a worktree" : landed.error);
      const path = landed.landsIn.worktree;
      await writeFile(join(path, "local-only.txt"), "local");
      const status = vi.spyOn(git, "statusAll");
      const rollback = vi.spyOn(git, "rollbackWorktree");
      expect(await service.keepWorktree(db, "delete-ignored")).toMatchObject({
        worktree: "kept",
        reason: expect.stringContaining("kept"),
      });
      expect(status).not.toHaveBeenCalled();
      expect(rollback).not.toHaveBeenCalled();
      expect(await readFile(join(path, "local-only.txt"), "utf8")).toBe("local");
      expect(await fixtureGit(path, "branch", "--show-current")).toBe("spi/delete-ignored");
      expect(service.keptWorktrees(db)).toEqual([
        expect.objectContaining({
          threadId: "delete-ignored",
          branch: "spi/delete-ignored",
          path,
        }),
      ]);
      expect((await lstat(path)).isDirectory()).toBe(true);
      expect(
        db
          .prepare("SELECT deleted_at, reason FROM thread_workspaces WHERE thread_id = ?")
          .get("delete-ignored"),
      ).toMatchObject({
        deleted_at: expect.any(Number),
        reason: expect.stringContaining("kept"),
      });
    } finally {
      db.close();
    }
  });

  it("rolls back a newly allocated landing when the journal cannot record it", async () => {
    const db = new DatabaseSync(":memory:");
    const service = workspaces();
    try {
      const landed = await service.land(db, scope, "rollback-journal", { target: "fork-main" });
      if (!landed.ok || landed.landsIn.target === "asking")
        throw new Error(landed.ok ? "Expected a worktree" : landed.error);
      await service.rollbackLanding(db, "rollback-journal");
      await expect(lstat(landed.landsIn.worktree)).rejects.toMatchObject({ code: "ENOENT" });
      expect(db.prepare("SELECT COUNT(*) AS count FROM thread_workspaces").get()?.count).toBe(0);
    } finally {
      db.close();
    }
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

type Read = (git: PrivilegedGit, target: WorktreeTarget) => Promise<ExecResult<unknown>>;
/** Every read the Thread tab makes, each with the guards of the commit beside it. */
const reads: Record<string, Read> = {
  status: (git, target) => git.status(target),
  "status of all": (git, target) => git.statusAll(target),
  diff: (git, target) => git.diff(target),
  "diff of one path": (git, target) => git.diff(target, "HEAD", {}, "answer.txt"),
  numstat: (git, target) => git.numstat(target, "HEAD"),
};

describe("privileged Git", () => {
  it("runs no hook planted in the clone on a read or a commit", async ({ skip }) => {
    const git = gitRunner();
    const workspace = await checkout(git);
    const target = await linkedWorktree(git, workspace.cwd);
    const marker = join(root, "hook-ran");
    const hooks = join(workspace.gitDirectory, "hooks");
    await mkdir(hooks, { recursive: true });
    for (const name of [
      "pre-commit",
      "prepare-commit-msg",
      "commit-msg",
      "post-commit",
      "post-index-change",
      "reference-transaction",
    ])
      await markerScript(join(hooks, name), marker);
    await writeFile(join(target.worktree.cwd, "answer.txt"), "changed");
    for (const [name, read] of Object.entries(reads)) {
      expect(await read(git, target), name).toMatchObject({ ok: true });
      expect(await markerRan(marker), name).toBe(false);
    }
    if (macOnly) return;
    await plainGit(
      target.worktree.cwd,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qam",
      "Plain",
    );
    await expectCanary(marker, skip, "plain commit runs the hooks");
    await writeFile(join(target.worktree.cwd, "answer.txt"), "changed again");
    expect(await git.add(target, ["."])).toMatchObject({ ok: true });
    expect(await git.commit(target, "Confined", identity)).toMatchObject({ ok: true });
    expect(await markerRan(marker)).toBe(false);
  });

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

  it("refuses every read and the commit on hostile clone config", async () => {
    const git = gitRunner();
    const workspace = await checkout(git);
    const target = await linkedWorktree(git, workspace.cwd);
    const script = join(root, "program.sh");
    const marker = join(root, "config-ran");
    await markerScript(script, marker);
    await plantConfig(join(workspace.gitDirectory, "config"), script);

    for (const [name, read] of Object.entries(reads)) {
      await expect(read(git, target), name).rejects.toThrow(
        "Managed clone Git configuration changed.",
      );
    }
    expect(await git.commit(target, "Hostile", identity, { all: true })).toMatchObject({
      ok: false,
      refused: "workspace-not-trusted",
    });
    expect(await readdir(root)).not.toContain(basename(marker));
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

    for (const [name, read] of Object.entries(reads)) {
      await expect(read(git, target), name).rejects.toThrow(
        "Worktree .git file does not point to its recorded Git directory.",
      );
    }
    expect(await git.commit(target, "Repointed", identity, { all: true })).toEqual(
      expect.objectContaining({ ok: false, refused: "workspace-not-trusted" }),
    );
    expect(await fixtureGit(other.worktree.cwd, "log", "-1", "--format=%s")).toBe("Fixture change");
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

    for (const [name, read] of Object.entries(reads)) {
      expect(await read(git, target), name).toMatchObject({ ok: true });
      expect(await markerRan(marker), name).toBe(false);
    }
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
      "diff of the nested path": (target) => git.diff(target, "HEAD", {}, "sub"),
      numstat: (target) => git.numstat(target, "HEAD"),
      "status of all": () => git.statusAll(target),
      "push dry run": () =>
        git.push(target, {
          remote: "origin",
          source: "HEAD",
          destination: "refs/heads/spi-hostile-config",
          dryRun: true,
        }),
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
    await quiet("clean filter", {
      status,
      numstat: (target) => git.numstat(target, "HEAD"),
      "status of all": () => git.statusAll(target),
      "push dry run": () =>
        git.push(target, {
          remote: "origin",
          source: "HEAD",
          destination: "refs/heads/spi-hostile-config",
          dryRun: true,
        }),
    });

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
    await quiet(".git file outside the worktree", {
      status,
      numstat: (target) => git.numstat(target, "HEAD"),
      "status of all": () => git.statusAll(target),
      "push dry run": () =>
        git.push(target, {
          remote: "origin",
          source: "HEAD",
          destination: "refs/heads/spi-hostile-config",
          dryRun: true,
        }),
    });
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

  it.each(["replace", "graft"] as const)(
    "ignores a planted %s when checking the remote ancestor",
    async (kind) => {
      const git = gitRunner();
      const workspace = await checkout(git);
      const base = await fixtureGit(workspace.cwd, "rev-parse", "HEAD");
      await writeFile(join(workspace.cwd, "remote.txt"), "remote");
      await fixtureGit(workspace.cwd, "add", "--", "remote.txt");
      await fixtureGit(
        workspace.cwd,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "Remote side",
      );
      const remoteHead = await fixtureGit(workspace.cwd, "rev-parse", "HEAD");
      await fixtureGit(workspace.cwd, "push", origin, `${remoteHead}:refs/heads/spi/replace-guard`);
      await fixtureGit(workspace.cwd, "checkout", "--detach", base);
      await writeFile(join(workspace.cwd, "local.txt"), "local");
      await fixtureGit(workspace.cwd, "add", "--", "local.txt");
      await fixtureGit(
        workspace.cwd,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "Local side",
      );
      const localHead = await fixtureGit(workspace.cwd, "rev-parse", "HEAD");
      if (kind === "replace") {
        const replacement = await fixtureGit(
          workspace.cwd,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit-tree",
          `${localHead}^{tree}`,
          "-p",
          remoteHead,
          "-m",
          "Planted replacement",
        );
        await fixtureGit(workspace.cwd, "replace", localHead, replacement);
      } else {
        await mkdir(join(workspace.gitDirectory, "info"), { recursive: true });
        await writeFile(
          join(workspace.gitDirectory, "info", "grafts"),
          `${localHead} ${remoteHead}\n`,
        );
      }
      const target = { clone: workspace.cwd };
      const ancestor = await git.isAncestor(target, remoteHead, localHead);
      if (ancestor.ok && ancestor.data)
        await git.push(target, {
          remote: "origin",
          source: localHead,
          destination: "refs/heads/spi/replace-guard",
          expectedHead: remoteHead,
        });
      expect(ancestor).toEqual({ ok: true, data: false });
      expect(
        await fixtureGit(root, "--git-dir", origin, "rev-parse", "refs/heads/spi/replace-guard"),
      ).toBe(remoteHead);
    },
  );

  it.each([
    ["github.com", "gh"],
    ["gitlab.example.invalid", "glab"],
  ] as const)("scopes the push credential helper to %s through managed %s", async (host, tool) => {
    if (process.platform === "win32") return;
    const setup = gitRunner();
    const workspace = await checkout(setup);
    const target = { clone: workspace.cwd };
    const remote = "credential";
    const url = `https://${host}/fixture/repository.git`;
    expect(await setup.addRemote(target, remote, url)).toMatchObject({ ok: true });

    const tools = join(root, "credential-tools");
    const wrappers = join(root, "credential-git");
    const operatorHome = join(root, "operator-home");
    const argumentsFile = join(root, "credential-argv");
    const helperFile = join(root, "credential-helper");
    await Promise.all([
      mkdir(tools, { recursive: true }),
      mkdir(wrappers, { recursive: true }),
      mkdir(operatorHome, { recursive: true }),
    ]);
    await writeFile(
      join(tools, tool),
      `#!/bin/sh
cat >/dev/null
printf 'username=x-access-token\\npassword=${helperToken}\\n'
`,
      { mode: 0o755 },
    );
    const { stdout: realGit } = await exec("which", ["git"]);
    await writeFile(
      join(wrappers, "git"),
      `#!/bin/sh
is_push=
helper=
for arg in "$@"; do
  [ "$arg" = push ] && is_push=1
  case "$arg" in
    credential.*.helper=\\!*) helper=\${arg#*=!} ;;
  esac
done
if [ -n "$is_push" ]; then
  printf '%s\\n' "$@" > ${shellQuote(argumentsFile)}
  printf 'HOME=%s\\n' "$HOME" >> ${shellQuote(argumentsFile)}
  printf 'protocol=https\\nhost=${host}\\n\\n' | sh -c "$helper get" > ${shellQuote(helperFile)}
  exit 0
fi
exec ${shellQuote(realGit.trim())} "$@"
`,
      { mode: 0o755 },
    );
    const git = new PrivilegedGit({
      appData,
      capturedPath: wrappers,
      allowLocalRemotes: true,
      env: { ...process.env, HOME: operatorHome },
      managedToolBinDir: async () => tools,
    });
    expect(
      await git.push(target, {
        remote,
        source: "HEAD",
        destination: "refs/heads/spi/credential",
        expectedHead: null,
      }),
    ).toMatchObject({ ok: true });
    const argumentsText = await readFile(argumentsFile, "utf8");
    expect(argumentsText).toContain(
      `credential.https://${host}.helper=!${shellQuote(join(tools, tool))} auth git-credential`,
    );
    expect(argumentsText).toContain(`HOME=${operatorHome}`);
    expect(argumentsText).not.toContain(helperToken);
    expect(await readFile(helperFile, "utf8")).toContain(`password=${helperToken}`);
  });

  it("leases an existing branch to the observed head so a move between check and push is refused", async () => {
    const git = gitRunner();
    const workspace = await checkout(git);
    const base = await fixtureGit(seed, "rev-parse", "HEAD");
    await fixtureGit(seed, "push", origin, "HEAD:refs/heads/spi/race");
    const added = await git.addBranchWorktree(
      workspace.cwd,
      "race",
      "spi/race",
      "refs/remotes/origin/main",
    );
    if (!added.ok) throw new Error(added.error);
    const moved = await commit("remote moved");
    const local = await commit("local after remote");
    await fixtureGit(seed, "push", origin, `${moved}:refs/heads/spi/staged`);
    await fixtureGit(seed, "push", origin, `${local}:refs/heads/spi/local`);
    await fixtureGit(
      added.data.worktree.cwd,
      "fetch",
      "origin",
      `+refs/heads/spi/local:refs/remotes/origin/spi/local`,
    );
    await fixtureGit(added.data.worktree.cwd, "reset", "--hard", "refs/remotes/origin/spi/local");
    expect(await git.remoteHead(added.data, "origin", "spi/race")).toEqual({
      ok: true,
      data: base,
    });
    expect(await git.isAncestor(added.data, base, local)).toEqual({ ok: true, data: true });
    expect(await git.isAncestor(added.data, moved, local)).toEqual({ ok: true, data: true });

    expect(
      await git.push(added.data, {
        remote: "origin",
        source: local,
        destination: "refs/heads/spi/race",
        dryRun: true,
      }),
    ).toMatchObject({ ok: true });
    await fixtureGit(seed, "push", origin, `${moved}:refs/heads/spi/race`);
    expect(await fixtureGit(seed, "rev-parse", "HEAD")).toBe(local);
    const pushed = await git.push(added.data, {
      remote: "origin",
      source: local,
      destination: "refs/heads/spi/race",
      expectedHead: base,
    });
    expect(pushed).toMatchObject({ ok: false });
    expect(await fixtureGit(root, "--git-dir", origin, "rev-parse", "refs/heads/spi/race")).toBe(
      moved,
    );
  }, 60_000);

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
      [`numstat against ${name}`, ref, (git: PrivilegedGit) => git.numstat(target, name)],
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
    ].flatMap((path) => [
      [
        `add of ${JSON.stringify(path)}`,
        /^Invalid worktree path\.$/u,
        (git: PrivilegedGit) => git.add(worktreeTarget, [path]),
      ],
      [
        `diff of ${JSON.stringify(path)}`,
        /^Invalid worktree path\.$/u,
        (git: PrivilegedGit) => git.diff(target, "HEAD", {}, path),
      ],
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
    // add's and hashFiles' paths are validated worktree paths, never options.
    type Paths = "add" | "hashFiles";
    type Add = Parameters<PrivilegedGit[Paths]>;
    type Input = Inputs<PrivilegedGit[Exclude<keyof PrivilegedGit, Paths>]> | Add[0] | Add[2];
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
        "addBranchWorktree",
        "addRemote",
        "addWorktree",
        "ahead",
        "blob",
        "checkoutDetached",
        "clone",
        "commit",
        "constructor",
        "dataRoot",
        "diff",
        "diffBlob",
        "fetch",
        "hashFiles",
        "head",
        "headIsAncestorOf",
        "isAncestor",
        "listWorktrees",
        "numstat",
        "push",
        "remoteHead",
        "remoteUrl",
        "resolveRef",
        "rollbackWorktree",
        "status",
        "statusAll",
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
            expect(await fixtureGit(worktree, "ls-files", "--stage", "--", "sub")).toMatch(
              /^160000 /u,
            );
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

  const result = (stdout = ""): Awaited<ReturnType<MxcApi["run"]>> => ({
    stdout,
    stderr: "",
    exitCode: 0,
    timedOut: false,
    warnings: [],
  });
  const supported = { isSupported: true, availableMethods: ["seatbelt"] };
  const sandbox = (run: MxcApi["run"]): Pick<PrivilegedGitOptions, "mxc" | "platform"> => ({
    platform: "darwin",
    mxc: async () => ({ getPlatformSupport: () => supported, run }),
  });
  /** Runs the request's script with no sandbox, after the caller's changes to the host. */
  const unconfined =
    (before: (command: string) => Promise<void> = async () => undefined): MxcApi["run"] =>
    async (request) => {
      await before(request.command);
      const ran = spawnSync("/bin/sh", ["-c", request.command], {
        cwd: request.workingDirectory,
        env: request.environment,
        encoding: "utf8",
      });
      return { ...result(ran.stdout), stderr: ran.stderr, exitCode: ran.status ?? 1 };
    };
  const refused = (reason: string) => ({ ok: false, refused: reason, code: null });
  const notProven = { ...refused("confinement-not-proven"), afterExit: "not-known" };
  const uncertain = {
    ok: false,
    uncertain: "outcome-not-known",
    code: null,
    afterExit: "not-known",
  };
  type Row = [string, Pick<PrivilegedGitOptions, "mxc" | "platform">, object];
  const failures: Row[] = [
    ["Windows", { platform: "win32" }, refused("unsupported-platform")],
    ["Linux", { platform: "linux" }, refused("unsupported-platform")],
    [
      "a missing SDK",
      { platform: "darwin", mxc: () => Promise.reject(new Error("Cannot find module")) },
      refused("mxc-unavailable"),
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
      refused("mxc-unavailable"),
    ],
    [
      "a sandbox that rejects",
      sandbox(() => Promise.reject(new Error("spawn mxc-exec-mac ENOENT"))),
      uncertain,
    ],
    ["a sandbox that runs nothing", sandbox(async () => result()), notProven],
    [
      "a sandbox that returns only the run's id",
      sandbox(async (request) => result(`${/spi-confined-[\da-f-]{36}/u.exec(request.command)}\n`)),
      notProven,
    ],
    [
      "a sandbox that returns no result",
      sandbox(async () => undefined as unknown as Awaited<ReturnType<MxcApi["run"]>>),
      notProven,
    ],
    ...(process.platform === "win32"
      ? []
      : ([
          ["a sandbox that does not confine", sandbox(unconfined()), notProven],
          [
            "a canary write that fails for a reason other than a denial",
            sandbox(
              unconfined(async (command) => {
                const check = /\/[^']*\/check-[^/']+/u.exec(command)?.[0];
                if (!check) throw new Error("No check directory in the command.");
                await rm(check, { recursive: true });
              }),
            ),
            notProven,
          ],
        ] as Row[])),
  ];

  async function fsmonitorFixture(git: PrivilegedGit) {
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
    const state = async () => [
      await readFile(index),
      await fixtureGit(worktree, "rev-parse", "HEAD"),
    ];
    return { workspace, target, marker, before: await state(), state };
  }

  const scratchLeft = async () =>
    (await readdir(join(await realpath(appData), "scope-git"))).filter((name) =>
      /^(run|check)-/u.test(name),
    );

  it("refuses add and commit, or reports them uncertain, when the sandbox cannot be proven", async () => {
    const git = gitRunner();
    const { target, marker, before, state } = await fsmonitorFixture(git);

    for (const [label, confinement, expected] of failures) {
      const runner = gitRunner(undefined, confinement);
      const results: ConfinedResult[] = [
        await runner.add(target, ["."]),
        await runner.commit(target, "Refused", identity, { all: true }),
      ];
      for (const outcome of results) {
        expect(outcome, label).toMatchObject(expected);
        if (!("afterExit" in expected)) expect(outcome, label).not.toHaveProperty("afterExit");
        expect(outcome.ok ? "" : outcome.error, label).not.toMatch(/start/u);
      }
      expect(await markerRan(marker), label).toBe(false);
      expect(await state(), label).toEqual(before);
      expect(await scratchLeft(), label).toEqual([]);
    }
    if (process.platform !== "darwin") {
      expect(await gitRunner().add(target, ["."])).toMatchObject(refused("unsupported-platform"));
    }
  });

  it("refuses add and commit before launch when setup fails, leaving no scratch folder", async () => {
    const git = gitRunner();
    const { workspace, target, marker, before, state } = await fsmonitorFixture(git);
    const run = vi.fn(unconfined());
    const runner = gitRunner(undefined, sandbox(run));
    const config = join(workspace.gitDirectory, "config");
    const pointer = join(target.worktree.cwd, ".git");
    const other = await linkedWorktree(git, workspace.cwd, "thread-2");
    const otherPointer = await readFile(join(other.worktree.cwd, ".git"));
    const setups: [string, () => Promise<() => Promise<void>>, string][] = [
      [
        "no space for the second scratch folder",
        async () => {
          faults.mkdtemp = /[/\\]check-$/u;
          return async () => {
            faults.mkdtemp = undefined;
          };
        },
        "setup-failed",
      ],
      [
        "a changed clone config",
        async () => {
          const original = await readFile(config);
          await writeFile(
            config,
            Buffer.concat([original, Buffer.from("[core]\n\tbare = false\n")]),
          );
          return () => writeFile(config, original);
        },
        "workspace-not-trusted",
      ],
      [
        "a repointed worktree pointer",
        async () => {
          const original = await readFile(pointer);
          // Git for Windows hides the .git file, and a hidden file cannot be opened for writing.
          const plant = async (content: Buffer) => {
            await rm(pointer);
            await writeFile(pointer, content);
          };
          await plant(otherPointer);
          return () => plant(original);
        },
        "workspace-not-trusted",
      ],
    ];
    for (const [label, arrange, reason] of setups) {
      const restore = await arrange();
      try {
        const results = [
          await runner.add(target, ["."]),
          await runner.commit(target, "Refused", identity, { all: true }),
        ];
        for (const outcome of results) {
          expect(outcome, label).toMatchObject(refused(reason));
          expect(outcome, label).not.toHaveProperty("afterExit");
        }
      } finally {
        await restore();
      }
      expect(run, label).not.toHaveBeenCalled();
      expect(await markerRan(marker), label).toBe(false);
      expect(await state(), label).toEqual(before);
      expect(await scratchLeft(), label).toEqual([]);
    }
  });

  it.skipIf(macOnly)(
    "reports add and commit as uncertain when the sandbox rejects after running them",
    async () => {
      const git = gitRunner();
      const workspace = await checkout(git);
      const target = await linkedWorktree(git, workspace.cwd);
      const worktree = target.worktree.cwd;
      const real = await loadMxc();
      const runner = gitRunner(
        undefined,
        sandbox(async (request) => {
          await real.run(request);
          throw new Error("Could not decode the execution result.");
        }),
      );
      const head = await fixtureGit(worktree, "rev-parse", "HEAD");
      await writeFile(join(worktree, "late.txt"), "late\n");

      const added = await runner.add(target, ["late.txt"]);
      expect(added).toMatchObject(uncertain);
      expect(added.ok ? "" : added.error).not.toMatch(/start/u);
      expect(await fixtureGit(worktree, "diff", "--cached", "--name-only")).toBe("late.txt");

      const committed = await runner.commit(target, "Late", identity);
      expect(committed).toMatchObject(uncertain);
      expect(await fixtureGit(worktree, "rev-parse", "HEAD~1")).toBe(head);
      expect(await scratchLeft()).toEqual([]);
    },
  );

  /** Answers like a sandbox that held: the proof line, no canary, exit 0. */
  const proven =
    (shape: (genuine: Record<string, unknown>) => Record<string, unknown>): MxcApi["run"] =>
    async (request) => {
      const id = /spi-confined-[\da-f-]{36}/u.exec(request.command)?.[0];
      if (!id) throw new Error("No run id in the command.");
      return shape({ ...result(`${id}:EPERM\n`) }) as unknown as Awaited<ReturnType<MxcApi["run"]>>;
    };

  it("refuses a result missing or mistyping any field of the SDK's result", async () => {
    const git = gitRunner();
    const workspace = await checkout(git);
    const target = await linkedWorktree(git, workspace.cwd);
    const accepted = await gitRunner(undefined, sandbox(proven((genuine) => genuine))).add(target, [
      ".",
    ]);
    expect(accepted).toMatchObject({ ok: true, data: "", afterExit: "not-known" });
    expect(accepted).not.toHaveProperty("cleanup");

    const shapes: [string, (genuine: Record<string, unknown>) => Record<string, unknown>][] = [
      ["no warnings", ({ warnings: _, ...rest }) => rest],
      ["warnings not an array", (genuine) => ({ ...genuine, warnings: "none" })],
      ["a warning not a string", (genuine) => ({ ...genuine, warnings: [1] })],
      ["no stdout", ({ stdout: _, ...rest }) => rest],
      ["stderr not a string", (genuine) => ({ ...genuine, stderr: null })],
      ["exitCode not a number", (genuine) => ({ ...genuine, exitCode: "0" })],
      ["no timedOut", ({ timedOut: _, ...rest }) => rest],
    ];
    for (const [label, shape] of shapes) {
      const run = vi.fn(proven(shape));
      const runner = gitRunner(undefined, sandbox(run));
      expect(await runner.add(target, ["."]), label).toMatchObject(notProven);
      expect(run, label).toHaveBeenCalledOnce();
    }
    expect(await scratchLeft()).toEqual([]);
  });

  it.skipIf(macOnly)("refuses a genuine MXC result with its warnings removed", async () => {
    const git = gitRunner();
    const workspace = await checkout(git);
    const target = await linkedWorktree(git, workspace.cwd);
    const real = await loadMxc();
    const runner = gitRunner(
      undefined,
      sandbox(async (request) => {
        const { warnings: _, ...rest } = await real.run(request);
        return rest as Awaited<ReturnType<MxcApi["run"]>>;
      }),
    );
    expect(await gitRunner().status(target)).toMatchObject({ ok: true });
    expect(await runner.add(target, ["."])).toMatchObject(notProven);
  });

  it("keeps the run's outcome and reports a scratch folder it could not remove", async () => {
    const git = gitRunner();
    const workspace = await checkout(git);
    const target = await linkedWorktree(git, workspace.cwd);
    const scratch = join(await realpath(appData), "scope-git");
    const cases: [string, MxcApi["run"], object][] = [
      [
        "a proven run",
        proven((genuine) => genuine),
        { ok: true, data: "", afterExit: "not-known" },
      ],
      [
        "a sandbox that rejects after launch",
        () => Promise.reject(new Error("Could not decode the execution result.")),
        uncertain,
      ],
    ];
    for (const [label, run, expected] of cases) {
      faults.rm = /[/\\]run-[^/\\]+$/u;
      let outcome: ConfinedResult;
      try {
        outcome = await gitRunner(undefined, sandbox(run)).add(target, ["."]);
      } finally {
        faults.rm = undefined;
      }
      const left = await scratchLeft();
      expect(left, label).toEqual([expect.stringMatching(/^run-/u)]);
      expect(outcome, label).toMatchObject({
        ...expected,
        cleanup: { failed: [join(scratch, left[0] ?? "")] },
      });
      await rm(join(scratch, left[0] ?? ""), { recursive: true });
    }
  });
});
