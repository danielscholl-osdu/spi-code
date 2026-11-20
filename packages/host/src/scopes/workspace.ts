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
  readonly files?: string[];
};
export type WorktreeDisposition =
  | { readonly worktree: "removed"; readonly reason: string }
  | { readonly worktree: "kept"; readonly reason: string; readonly files?: string[] };

interface PrepareOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: WorkspaceProgress) => void;
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

function statusPaths(value: string): string[] {
  const records = value.split("\0").filter(Boolean);
  const files: string[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index] ?? "";
    const path = record.slice(3);
    if (path) files.push(path);
    if (/[CR]/u.test(record.slice(0, 2))) {
      const renamed = records[++index];
      if (renamed) files.push(renamed);
    }
  }
  return [...new Set(files)].sort();
}

function requestHeads(value: string): { readonly ref: string; readonly sha: string }[] {
  return value.split(/[\r\n]+/u).flatMap((line) => {
    const [sha, ref] = line.split(/\s+/u, 2);
    return sha && ref ? [{ sha, ref }] : [];
  });
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
             (thread_id, repository, clone_path, path, worktree_id, branch, base_ref, head_sha, target, source_repository, source_branch, forge, request_number, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        request.target === "request" ? request.forge : null,
        request.target === "request" ? request.requestNumber : null,
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
    db.prepare(
      "UPDATE thread_workspaces SET deleted_at = ?, reason = ?, files = NULL WHERE thread_id = ?",
    ).run(Date.now(), reason, threadId);
    return { worktree: "kept", reason };
  }

  async reclaimWorktree(
    db: DatabaseSync,
    threadId: string,
    confirmedFiles: readonly string[] = [],
  ): Promise<WorktreeDisposition | undefined> {
    return this.claim(`reclaim\0${threadId}`, async () => {
      const stored = this.keptStoredWorktree(db, threadId);
      if (!stored) return undefined;
      const target: {
        readonly clone: string;
        readonly worktree: { readonly id: string; readonly cwd: string };
      } = {
        clone: stored.clonePath,
        worktree: { id: stored.worktreeId, cwd: stored.path },
      };
      try {
        const status = await this.git.statusAll(target);
        if (!status.ok)
          return this.keepFor(db, stored, `Its files could not be read: ${status.error}`);
        const files = statusPaths(status.data);
        const confirmation = [...confirmedFiles].sort();
        const expected = [...files].sort();
        if (
          files.length > 0 &&
          (confirmation.length !== expected.length ||
            confirmation.some((file, index) => file !== expected[index]))
        ) {
          return this.keepFor(
            db,
            stored,
            "Uncommitted, untracked or ignored files would be lost.",
            files,
          );
        }

        const remote =
          stored.target === "upstream" ||
          (stored.target === "request" && stored.sourceRepository !== stored.repository)
            ? "upstream"
            : "origin";
        const refRoot = `refs/spi/reclaim/${stored.worktreeId}`;
        const remoteBranch = `${refRoot}/branch`;
        const branch = `refs/heads/${stored.branch}`;
        const fetched = await this.git.fetchRef(target, remote, branch, remoteBranch);
        if (!fetched.ok)
          return this.keepFor(
            db,
            stored,
            `Its pushed branch could not be read fresh from ${remote}: ${fetched.error}`,
          );
        const ancestor = await this.git.headIsAncestorOf(target, remoteBranch);
        if (!ancestor.ok)
          return this.keepFor(
            db,
            stored,
            `Its pushed branch could not be compared: ${ancestor.error}`,
          );
        if (!ancestor.data)
          return this.keepFor(
            db,
            stored,
            "Local commits have not been proven on the pushed branch.",
          );

        const forge =
          stored.forge === "github" || stored.forge === "gitlab"
            ? stored.forge
            : remote === "origin"
              ? "github"
              : "gitlab";
        const requests = await this.git.requestRefs(target, remote, forge);
        if (!requests.ok)
          return this.keepFor(
            db,
            stored,
            `Open requests for its branch could not be read: ${requests.error}`,
          );
        const remoteHead = await this.git.resolveRef(target, remoteBranch);
        if (!remoteHead.ok)
          return this.keepFor(
            db,
            stored,
            `The fresh pushed branch could not be resolved: ${remoteHead.error}`,
          );
        const requestedHead = remoteHead.data.trim();
        const matchingRequests = requestHeads(requests.data).filter(
          ({ sha }) => sha === requestedHead,
        );
        if (matchingRequests.length > 0) {
          const defaultBranch = `${refRoot}/default`;
          const freshDefault = await this.git.fetch(target, {
            remote,
            tags: false,
            head: defaultBranch,
          });
          if (!freshDefault.ok)
            return this.keepFor(
              db,
              stored,
              `The request's target branch could not be read fresh: ${freshDefault.error}`,
            );
          const merged = await this.git.isAncestorOf(target, remoteBranch, defaultBranch);
          if (!merged.ok)
            return this.keepFor(
              db,
              stored,
              `The request's merge state could not be proved: ${merged.error}`,
            );
          if (!merged.data)
            return this.keepFor(
              db,
              stored,
              "An open request still names the pushed branch and is not proven merged.",
            );
        }

        const removed = await this.git.removeWorktree(target);
        if (!removed.ok)
          return this.keepFor(db, stored, `The worktree could not be removed: ${removed.error}`);
        db.prepare("DELETE FROM thread_workspaces WHERE thread_id = ?").run(threadId);
        return {
          worktree: "removed",
          reason: "The worktree was removed; its pushed branch was retained.",
        };
      } catch (error) {
        return this.keepFor(
          db,
          stored,
          `The worktree could not be read safely: ${redactError(String(error))}`,
        );
      }
    });
  }

  restoreWorktree(db: DatabaseSync, threadId: string): void {
    this.storage(db);
    db.prepare(
      "UPDATE thread_workspaces SET deleted_at = NULL, reason = NULL, files = NULL WHERE thread_id = ?",
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
        `SELECT thread_id, repository, branch, path, reason, files
           FROM thread_workspaces WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`,
      )
      .all()
      .map((row) => ({
        threadId: String(row.thread_id),
        repository: String(row.repository),
        branch: String(row.branch),
        path: String(row.path),
        reason: String(row.reason ?? "The worktree was kept for review."),
        ...(row.files === null ? {} : { files: JSON.parse(String(row.files)) as string[] }),
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
    const signal = options.signal ? { signal: options.signal } : {};
    const target = { clone: join(directory, "checkout") };
    const existed = await exists(directory);
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
        forge TEXT,
        request_number INTEGER,
        created_at INTEGER NOT NULL,
        deleted_at INTEGER,
        reason TEXT,
        files TEXT
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS thread_workspaces_branch
        ON thread_workspaces(repository, branch) WHERE deleted_at IS NULL;
    `);
    const columns = new Set(
      db
        .prepare("PRAGMA table_info(thread_workspaces)")
        .all()
        .map((row) => String(row.name)),
    );
    for (const [name, type] of [
      ["forge", "TEXT"],
      ["request_number", "INTEGER"],
      ["files", "TEXT"],
    ] as const) {
      if (!columns.has(name)) db.exec(`ALTER TABLE thread_workspaces ADD COLUMN ${name} ${type}`);
    }
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

  private keptStoredWorktree(db: DatabaseSync, threadId: string) {
    this.storage(db);
    const row = db
      .prepare(
        `SELECT repository, clone_path, path, worktree_id, branch, base_ref, target,
                source_repository, forge, request_number, deleted_at
         FROM thread_workspaces WHERE thread_id = ?`,
      )
      .get(threadId);
    if (!row || row.deleted_at === null) return undefined;
    return {
      repository: String(row.repository),
      clonePath: String(row.clone_path),
      path: String(row.path),
      worktreeId: String(row.worktree_id),
      branch: String(row.branch),
      baseRef: String(row.base_ref),
      target: String(row.target),
      sourceRepository: row.source_repository === null ? undefined : String(row.source_repository),
      forge: row.forge === null ? undefined : String(row.forge),
      requestNumber: row.request_number === null ? undefined : Number(row.request_number),
    };
  }

  private keepFor(
    db: DatabaseSync,
    stored: { readonly worktreeId: string },
    reason: string,
    files?: readonly string[],
  ): Extract<WorktreeDisposition, { readonly worktree: "kept" }> {
    db.prepare(
      `UPDATE thread_workspaces
       SET reason = ?, files = ? WHERE worktree_id = ? AND deleted_at IS NOT NULL`,
    ).run(reason, files === undefined ? null : JSON.stringify(files), stored.worktreeId);
    return { worktree: "kept", reason, ...(files === undefined ? {} : { files: [...files] }) };
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
