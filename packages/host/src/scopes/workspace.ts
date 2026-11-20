// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { lstat, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type ExecOptions, type ExecResult, execRedactor } from "@spi-code/core";
import type { LandingRequest, ThreadLanding } from "@spi-code/threads";
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
      readonly fetchError?: FetchError;
    };

type FetchError = {
  readonly operation: "fetch";
  readonly remote: RemoteName;
  readonly error: string;
};
type WorkspaceFailure = GitStep & { readonly ok: false; readonly error: string };

export type WorkspaceResult =
  | { readonly ok: true; readonly workspace: AskingWorkspace }
  | WorkspaceFailure;
export type ThreadWorktree = {
  readonly kind: "worktree";
  readonly cwd: string;
  readonly gitDirectory: string;
  readonly readOnly: false;
  readonly clonePath: string;
  readonly worktreeId: string;
};
export type ThreadWorkspaceResult =
  | { readonly ok: true; readonly workspace: AskingWorkspace | ThreadWorktree }
  | WorkspaceFailure;
export type LandingResult =
  | { readonly ok: true; readonly landsIn: ThreadLanding }
  | { readonly ok: false; readonly error: string };
export type KeptWorktree = {
  readonly threadId: string;
  readonly repository: string;
  readonly branch: string;
  readonly path: string;
  readonly reason: string;
};

interface PrepareOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: WorkspaceProgress) => void;
  /** When the repository is being cloned or fetched for a thread, from start to end. */
  readonly onPrepare?: (event: {
    readonly phase: "started" | "finished";
    readonly operation: "clone" | "fetch";
  }) => void;
}

function check(result: ExecResult<string>): string {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

const redactError = execRedactor({});

async function step<T extends GitStep>(
  job: T,
  options: PrepareOptions,
  action: (onOutput: NonNullable<ExecOptions["onOutput"]>) => Promise<void>,
): Promise<(T & { ok: false; error: string }) | undefined> {
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
const upstreamRef = "refs/spi/upstream";

/** Keeps one shared, read-only checkout per repository. Writes are for host preparation only. */
export class ScopeWorkspaces {
  private readonly pending = new Map<string, Promise<WorkspaceResult>>();
  private readonly claims = new Map<string, Promise<void>>();

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

  async prepareThread(
    db: DatabaseSync,
    scope: Scope,
    threadId: string,
    landsIn: ThreadLanding | undefined,
    options: PrepareOptions = {},
  ): Promise<ThreadWorkspaceResult> {
    if (!landsIn || landsIn.target === "asking") return this.prepareAsking(scope, options);
    const stored = this.storedWorktree(db, threadId);
    if (!stored || stored.path !== landsIn.worktree || stored.branch !== landsIn.branch)
      return {
        ok: false,
        operation: "fetch",
        remote: "origin",
        error: "The thread's recorded worktree is unavailable.",
      };
    if (scope.kind === "program" || stored.repository !== scope.origin.repo.toLowerCase())
      return {
        ok: false,
        operation: "fetch",
        remote: "origin",
        error: "The thread's worktree does not belong to its scope.",
      };
    const clone = await this.clonePath(scope);
    if (!(await exists(stored.path)) || !(await exists(clone)))
      return {
        ok: false,
        operation: "fetch",
        remote: "origin",
        error: "The thread's recorded worktree was removed.",
      };
    return {
      ok: true,
      workspace: {
        kind: "worktree",
        cwd: stored.path,
        gitDirectory: join(clone, ".git"),
        clonePath: clone,
        worktreeId: stored.worktreeId,
        readOnly: false,
      },
    };
  }

  async land(
    db: DatabaseSync,
    scope: Scope,
    threadId: string,
    request: LandingRequest,
    options: PrepareOptions = {},
  ): Promise<LandingResult> {
    this.storage(db);
    const existing = this.storedWorktree(db, threadId);
    if (request.target === "asking") {
      return existing
        ? { ok: false, error: "Remove the thread's worktree before returning it to Asking." }
        : { ok: true, landsIn: { target: "asking" } };
    }
    if (scope.kind === "program") return { ok: false, error: "Program threads change no code." };
    const branch = request.target === "request" ? request.branch : `spi/${threadId}`;
    return this.claim(`${scope.origin.repo.toLowerCase()}\0${branch}\0landing`, () =>
      this.landClaimed(db, scope, threadId, request, options),
    );
  }

  private async landClaimed(
    db: DatabaseSync,
    scope: RepositoryScope,
    threadId: string,
    request: Exclude<LandingRequest, { readonly target: "asking" }>,
    options: PrepareOptions,
  ): Promise<LandingResult> {
    this.storage(db);
    const existing = this.storedWorktree(db, threadId);
    const prepared = await this.prepareAsking(scope, options);
    if (!prepared.ok) return { ok: false, error: prepared.error };
    const workspace = prepared.workspace;
    if (workspace.kind !== "clone")
      return { ok: false, error: "The scope has no writable repository." };
    if (workspace.fetchError)
      return { ok: false, error: `${workspace.fetchError.remote}: ${workspace.fetchError.error}` };
    const repository = scope.origin.repo.toLowerCase();
    if (existing)
      return { ok: false, error: `Thread ${threadId} already holds ${existing.branch}.` };
    let branch: string;
    let baseRef: string;
    let sourceRepository: string | undefined;
    let sourceBranch: string | undefined;
    if (request.target === "fork-main") {
      if (scope.kind === "service" || scope.kind === "template" || scope.kind === "environment") {
        branch = `spi/${threadId}`;
        baseRef = "refs/remotes/origin/main";
      } else {
        return { ok: false, error: "That scope cannot land in Fork main." };
      }
    } else if (request.target === "fork-integration") {
      if (scope.kind !== "service")
        return { ok: false, error: "Only a service can land in fork_integration." };
      branch = `spi/${threadId}`;
      baseRef = "refs/remotes/origin/fork_integration";
    } else if (request.target === "upstream") {
      if (scope.kind !== "service" || !scope.upstream)
        return { ok: false, error: "Only a service can land upstream." };
      branch = `spi/${threadId}`;
      baseRef = upstreamRef;
    } else if (request.target === "request") {
      const origin = scope.origin.repo.toLowerCase();
      const upstream = scope.upstream?.repo.toLowerCase();
      const requestRepository = request.repository.toLowerCase();
      if (requestRepository !== origin && requestRepository !== upstream)
        return { ok: false, error: "The request branch is not in this scope's repository." };
      const remote =
        request.forge === "github" && requestRepository === origin
          ? "origin"
          : request.forge === "gitlab" && requestRepository === upstream
            ? "upstream"
            : undefined;
      if (!remote)
        return { ok: false, error: "The request identity does not match this scope's forge." };
      branch = request.branch;
      baseRef = `refs/spi/requests/${request.forge}/${request.requestNumber}`;
      const requestRef =
        request.forge === "github"
          ? `refs/pull/${request.requestNumber}/head`
          : `refs/merge-requests/${request.requestNumber}/head`;
      const fetched = await this.git.fetch(
        { clone: workspace.cwd },
        {
          remote,
          tags: false,
          ref: { source: requestRef, destination: baseRef },
        },
        options,
      );
      if (!fetched.ok) return { ok: false, error: fetched.error };
      sourceRepository = request.repository;
      sourceBranch = request.branch;
      const resolved = await this.git.resolveRef({ clone: workspace.cwd }, baseRef);
      if (!resolved.ok || resolved.data.trim() !== request.head)
        return { ok: false, error: "The fetched request head does not match the observed head." };
    } else {
      return { ok: false, error: "That Lands in choice is unavailable." };
    }
    const holder = db
      .prepare(
        `SELECT thread_id FROM thread_workspaces
           WHERE repository = ? AND branch = ? AND deleted_at IS NULL`,
      )
      .get(repository, branch);
    if (holder)
      return {
        ok: false,
        error: `Branch ${branch} is already held by thread ${String(holder.thread_id)}.`,
      };
    let reuse = false;
    if (request.target === "request") {
      const existing = await this.git.resolveRef(
        { clone: workspace.cwd },
        `refs/heads/${branch}`,
        options,
      );
      if (existing.ok) {
        if (existing.data.trim() !== request.head)
          return {
            ok: false,
            error: `Branch ${branch} no longer points at the observed request head.`,
          };
        reuse = true;
      } else if (!existing.error.includes("Needed a single revision")) {
        return { ok: false, error: existing.error };
      }
    }
    const id = `thread-${threadId}`;
    const added = await this.git.addBranchWorktree(
      workspace.cwd,
      id,
      branch,
      baseRef,
      reuse,
      options,
    );
    if (!added.ok) return { ok: false, error: added.error };
    const head = await this.git.head(added.data, options);
    if (!head.ok) {
      await this.git.rollbackWorktree(added.data, options).catch(() => {});
      return { ok: false, error: head.error };
    }
    try {
      db.prepare(
        `INSERT INTO thread_workspaces
             (thread_id, repository, clone_path, path, worktree_id, branch, base_ref, head_sha, target, source_repository, source_branch, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        threadId,
        repository,
        workspace.cwd,
        added.data.worktree.cwd,
        added.data.worktree.id,
        branch,
        baseRef,
        head.data.trim(),
        request.target,
        sourceRepository ?? null,
        sourceBranch ?? null,
        Date.now(),
      );
    } catch (error) {
      await this.git.rollbackWorktree(added.data, options).catch(() => {});
      return { ok: false, error: this.databaseError(db, repository, branch, error) };
    }
    const landed: ThreadLanding =
      request.target === "request"
        ? {
            target: request.target,
            branch,
            baseRef,
            worktree: added.data.worktree.cwd,
            head: head.data.trim(),
            forge: request.forge,
            repository: request.repository,
            requestNumber: request.requestNumber,
            sourceBranch: request.branch,
          }
        : {
            target: request.target,
            branch,
            baseRef,
            worktree: added.data.worktree.cwd,
            head: head.data.trim(),
          };
    return {
      ok: true,
      landsIn: landed,
    };
  }

  async keepWorktree(
    db: DatabaseSync,
    threadId: string,
  ): Promise<{ readonly worktree: "kept"; readonly reason: string } | undefined> {
    const stored = this.storedWorktree(db, threadId);
    if (!stored) return undefined;
    const reason = "The thread was deleted; its worktree and branch were kept.";
    db.prepare("UPDATE thread_workspaces SET deleted_at = ?, reason = ? WHERE thread_id = ?").run(
      Date.now(),
      reason,
      threadId,
    );
    return { worktree: "kept", reason };
  }

  restoreWorktree(db: DatabaseSync, threadId: string): void {
    this.storage(db);
    db.prepare(
      "UPDATE thread_workspaces SET deleted_at = NULL, reason = NULL WHERE thread_id = ?",
    ).run(threadId);
  }

  async rollbackLanding(
    db: DatabaseSync,
    threadId: string,
    options: PrepareOptions = {},
  ): Promise<void> {
    const stored = this.storedWorktree(db, threadId);
    if (!stored) throw new Error("The allocated thread worktree is unavailable for rollback.");
    const removed = await this.git.rollbackWorktree(
      {
        clone: stored.clonePath,
        worktree: { id: stored.worktreeId, cwd: stored.path },
      },
      options,
    );
    if (!removed.ok) throw new Error(removed.error);
    db.prepare("DELETE FROM thread_workspaces WHERE thread_id = ?").run(threadId);
  }

  keptWorktrees(db: DatabaseSync): KeptWorktree[] {
    this.storage(db);
    return db
      .prepare(
        `SELECT thread_id, repository, branch, path, reason
           FROM thread_workspaces WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`,
      )
      .all()
      .map((row) => ({
        threadId: String(row.thread_id),
        repository: String(row.repository),
        branch: String(row.branch),
        path: String(row.path),
        reason: String(row.reason ?? "The worktree was kept for review."),
      }));
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
    const target = { clone: join(directory, "checkout") };
    const existed = await exists(directory);
    const operation = existed ? "fetch" : "clone";
    options.onPrepare?.({ phase: "started", operation });
    try {
      return await this.prepareCheckout(directory, options, remotes, target, existed);
    } finally {
      options.onPrepare?.({ phase: "finished", operation });
    }
  }

  private async prepareCheckout(
    directory: string,
    options: PrepareOptions,
    remotes: CloneRemotes,
    target: { clone: string },
    existed: boolean,
  ): Promise<WorkspaceResult> {
    const signal = options.signal ? { signal: options.signal } : {};
    if (!existed) {
      const failed = await step({ operation: "clone" }, options, (onOutput) =>
        createClone(this.git, directory, remotes, { ...signal, onOutput }),
      );
      if (failed) return failed;
    }
    const workspace = {
      kind: "clone",
      cwd: target.clone,
      gitDirectory: join(target.clone, ".git"),
      readOnly: true,
    } as const;
    // Validate the recorded remotes before allowing a stale checkout to be used.
    for (const remote of ["origin", "upstream"] as const) {
      const url = remotes[remote];
      if (
        url !== undefined &&
        check(await this.git.remoteUrl(target, remote, signal)).trim() !== url
      ) {
        throw new Error(`Managed clone's ${remote} remote no longer matches the scope.`);
      }
    }
    // A detached checkout follows the fork's current default even when the forge renames it.
    for (const remote of ["origin", "upstream"] as const) {
      const url = remotes[remote];
      if (url === undefined) continue;
      let fetched = false;
      const failed = await step({ operation: "fetch", remote }, options, async (onOutput) => {
        const gitOptions = { ...signal, onOutput };
        const origin = remote === "origin";
        check(
          await this.git.fetch(
            target,
            { remote, tags: origin, head: origin ? askingRef : upstreamRef },
            gitOptions,
          ),
        );
        fetched = true;
        if (origin) check(await this.git.checkoutDetached(target, askingRef, gitOptions));
      });
      if (failed) {
        if (fetched || !existed || options.signal?.aborted) return failed;
        const { operation, remote, error } = failed;
        return { ok: true, workspace: { ...workspace, fetchError: { operation, remote, error } } };
      }
    }
    return { ok: true, workspace };
  }

  private async clonePath(scope: RepositoryScope): Promise<string> {
    const [owner, repo] = scope.origin.repo.toLowerCase().split("/");
    return join(await this.git.dataRoot(), "repos", owner ?? "", repo ?? "", "checkout");
  }

  private storage(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_workspaces (
        thread_id TEXT PRIMARY KEY NOT NULL,
        repository TEXT NOT NULL,
        clone_path TEXT NOT NULL,
        path TEXT NOT NULL,
        worktree_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        target TEXT NOT NULL,
        source_repository TEXT,
        source_branch TEXT,
        created_at INTEGER NOT NULL,
        deleted_at INTEGER,
        reason TEXT
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS thread_workspaces_branch
        ON thread_workspaces(repository, branch) WHERE deleted_at IS NULL;
    `);
  }

  private storedWorktree(db: DatabaseSync, threadId: string) {
    this.storage(db);
    const row = db
      .prepare(
        `SELECT repository, clone_path, path, worktree_id, branch, base_ref, deleted_at
         FROM thread_workspaces WHERE thread_id = ?`,
      )
      .get(threadId);
    if (!row || row.deleted_at !== null) return undefined;
    return {
      repository: String(row.repository),
      clonePath: String(row.clone_path),
      path: String(row.path),
      worktreeId: String(row.worktree_id),
      branch: String(row.branch),
      baseRef: String(row.base_ref),
    };
  }

  private async claim<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.claims.get(key) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.claims.set(key, queued);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.claims.get(key) === queued) this.claims.delete(key);
    }
  }

  private databaseError(
    db: DatabaseSync,
    repository: string,
    branch: string,
    error: unknown,
  ): string {
    const message = error instanceof Error ? error.message : String(error);
    if (!/unique/iu.test(message)) return redactError(message);
    const holder = db
      .prepare(
        `SELECT thread_id FROM thread_workspaces
         WHERE repository = ? AND branch = ? AND deleted_at IS NULL`,
      )
      .get(repository, branch);
    return holder
      ? `Branch ${branch} is already held by thread ${String(holder.thread_id)}.`
      : "That branch is already held by another thread.";
  }
}
