// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { lstat, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { type ExecOptions, type ExecResult, execRedactor } from "@spi-code/core";
import type { CloneRemotes, PrivilegedGit } from "./git.js";
import type { RepositoryScope, Scope, ScopeRemote } from "./registry.js";

type RemoteName = "origin" | "upstream";
type GitStep =
  | { readonly operation: "clone" }
  | {
      readonly operation: "fetch";
      readonly remote: RemoteName;
    };

export type WorkspaceProgress = GitStep &
  (
    | { readonly phase: "started" | "completed" }
    | { readonly phase: "output"; readonly stream: "stdout" | "stderr"; readonly text: string }
    | { readonly phase: "failed"; readonly error: string }
  );

export type AskingWorkspace =
  | { readonly kind: "program" }
  | {
      readonly kind: "clone";
      readonly cwd: string;
      readonly gitDirectory: string;
      readonly readOnly: true;
    };

export type WorkspaceResult =
  | { readonly ok: true; readonly workspace: AskingWorkspace }
  | (GitStep & { readonly ok: false; readonly error: string });

interface PrepareOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: WorkspaceProgress) => void;
}

function check(result: ExecResult<string>): string {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

const redactError = execRedactor({});

async function step(
  job: GitStep,
  options: PrepareOptions,
  action: (onOutput: NonNullable<ExecOptions["onOutput"]>) => Promise<void>,
): Promise<Extract<WorkspaceResult, { ok: false }> | undefined> {
  options.onProgress?.({ ...job, phase: "started" });
  try {
    await action((stream, text) => options.onProgress?.({ ...job, phase: "output", stream, text }));
  } catch (error) {
    const message = redactError(error instanceof Error ? error.message : String(error));
    options.onProgress?.({ ...job, phase: "failed", error: message });
    return { ...job, ok: false, error: message };
  }
  options.onProgress?.({ ...job, phase: "completed" });
}

async function exists(directory: string): Promise<boolean> {
  try {
    await lstat(directory);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function createClone(
  git: PrivilegedGit,
  directory: string,
  remotes: CloneRemotes,
  options: Parameters<PrivilegedGit["clone"]>[2],
): Promise<void> {
  const parent = dirname(directory);
  await mkdir(parent, { recursive: true });
  if (relative(parent, await realpath(parent))) {
    throw new Error("Managed repository directory is not at its recorded path.");
  }
  const staging = await mkdtemp(join(parent, ".clone-"));
  try {
    check(await git.clone(staging, remotes, options));
    await rename(staging, directory);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

const askingRef = "refs/spi/asking";

/** Keeps one shared, read-only checkout per repository. Writes are for host preparation only. */
export class ScopeWorkspaces {
  private readonly pending = new Map<string, Promise<WorkspaceResult>>();

  constructor(
    private readonly git: PrivilegedGit,
    private readonly remoteUrl: (remote: ScopeRemote) => string = (remote) => remote.url,
  ) {}

  async prepareAsking(scope: Scope, options: PrepareOptions = {}): Promise<WorkspaceResult> {
    if (scope.kind === "program") return { ok: true, workspace: { kind: "program" } };

    // Key on the repository, not the scope id. A changed fleet can reuse a repository.
    const parts = scope.origin.repo.toLowerCase().split("/");
    const [owner, repo] = parts;
    if (
      parts.length !== 2 ||
      !owner ||
      !repo ||
      !/^[a-z0-9][a-z0-9-]*$/u.test(owner) ||
      !/^[a-z0-9_][a-z0-9_.-]*$/u.test(repo) ||
      repo.endsWith(".")
    ) {
      return { ok: false, operation: "clone", error: "Scope does not name a GitHub repository." };
    }

    try {
      const directory = join(await this.git.dataRoot(), "repos", owner, repo);
      const next = (this.pending.get(directory) ?? Promise.resolve()).then(() =>
        this.prepareRepository(scope, directory, options),
      );
      this.pending.set(directory, next);
      try {
        return await next;
      } finally {
        if (this.pending.get(directory) === next) this.pending.delete(directory);
      }
    } catch (error) {
      return { ok: false, operation: "clone", error: redactError(String(error)) };
    }
  }

  private async prepareRepository(
    scope: RepositoryScope,
    directory: string,
    options: PrepareOptions,
  ): Promise<WorkspaceResult> {
    const remotes: CloneRemotes = {
      origin: this.remoteUrl(scope.origin),
      ...(scope.upstream === undefined ? {} : { upstream: this.remoteUrl(scope.upstream) }),
    };
    const signal = options.signal ? { signal: options.signal } : {};
    const target = { clone: join(directory, "checkout") };
    if (!(await exists(directory))) {
      const failed = await step({ operation: "clone" }, options, (onOutput) =>
        createClone(this.git, directory, remotes, { ...signal, onOutput }),
      );
      if (failed) return failed;
    }
    // A detached checkout follows the fork's current default even when the forge renames it.
    for (const remote of ["origin", "upstream"] as const) {
      const url = remotes[remote];
      if (url === undefined) continue;
      const failed = await step({ operation: "fetch", remote }, options, async (onOutput) => {
        const gitOptions = { ...signal, onOutput };
        if (check(await this.git.remoteUrl(target, remote, signal)).trim() !== url) {
          throw new Error(`Managed clone's ${remote} remote no longer matches the scope.`);
        }
        const origin = remote === "origin";
        check(
          await this.git.fetch(
            target,
            { remote, tags: origin, ...(origin ? { head: askingRef } : {}) },
            gitOptions,
          ),
        );
        if (origin) check(await this.git.checkoutDetached(target, askingRef, gitOptions));
      });
      if (failed) return failed;
    }
    return {
      ok: true,
      workspace: {
        kind: "clone",
        cwd: target.clone,
        gitDirectory: join(target.clone, ".git"),
        readOnly: true,
      },
    };
  }
}
