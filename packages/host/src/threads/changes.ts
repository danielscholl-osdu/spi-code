// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { ExecResult } from "@spi-code/core";
import type { ConfinedResult } from "../scopes/confined.js";
import type { CommitIdentity, PrivilegedGit, WorktreeTarget } from "../scopes/git.js";

export type ChangedFile = {
  path: string;
  /** Null for a binary file or one the host did not count. */
  added: number | null;
  removed: number | null;
  /** New and not yet added: the host read it, git has no diff for it. */
  untracked: boolean;
};

export type ThreadChanges =
  | { state: "asking" }
  | { state: "read"; head: string; ahead: number; uncommitted: boolean; files: ChangedFile[] }
  | { state: "not read"; reason: string };

export type FileDiff =
  | { state: "read"; patch: string; truncated: boolean }
  | { state: "not read"; reason: string };

export type CommitOutcome =
  | { outcome: "committed"; head: string }
  | { outcome: "refused" | "failed" | "not known"; reason: string };

const PATCH_LIMIT = 256 * 1024;
const FILE_LIMIT = 1024 * 1024;

function data<T>(result: ExecResult<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

const count = (value: string) => (/^\d+$/u.test(value) ? Number(value) : null);

/** `git diff --numstat -z --no-renames`: binary files count as null. */
export function parseNumstat(text: string): ChangedFile[] {
  return text
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const [added = "", removed = "", ...rest] = entry.split("\t");
      return {
        path: rest.join("\t"),
        added: count(added),
        removed: count(removed),
        untracked: false,
      };
    })
    .filter(({ path }) => path !== "");
}

/** Porcelain v1 with NUL separators: whether anything differs from HEAD, and the untracked paths. */
export function parseStatus(text: string): { uncommitted: boolean; untracked: string[] } {
  const fields = text.split("\0");
  const untracked: string[] = [];
  let uncommitted = false;
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? "";
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    if (/[RC]/u.test(code)) index += 1;
    if (code === "!!") continue;
    uncommitted = true;
    if (code === "??") untracked.push(field.slice(3));
  }
  return { uncommitted, untracked };
}

/** A regular file at the path, not a link; a display filter, since the sandbox holds the read. */
async function plainFile(worktree: string, path: string): Promise<boolean> {
  try {
    const info = await lstat(join(worktree, path));
    return info.isFile() && info.size <= FILE_LIMIT;
  } catch {
    return false;
  }
}

/** Untracked files written to the object store by a confined read; their ids, or why none. */
async function hashNew(
  git: PrivilegedGit,
  target: WorktreeTarget,
  paths: readonly string[],
): Promise<Map<string, string> | string> {
  const plain = await Promise.all(paths.map((path) => plainFile(target.worktree.cwd, path)));
  const files = paths.filter((_, index) => plain[index]);
  if (files.length === 0) return "The new file could not be read.";
  const hashed = await git.hashFiles(target, files);
  if (!hashed.ok) return hashed.error;
  const ids = hashed.data.split("\n").filter(Boolean);
  if (ids.length !== files.length) return "The new file could not be read.";
  return new Map(files.map((path, index) => [path, ids[index] ?? ""]));
}

const isBinary = (text: string) => text.slice(0, 8000).includes("\0");

function lines(text: string): string[] {
  const all = text.split("\n");
  if (all.at(-1) === "") all.pop();
  return all;
}

async function newFile(
  git: PrivilegedGit,
  target: WorktreeTarget,
  path: string,
  id: string | undefined,
): Promise<ChangedFile> {
  const text = id ? await git.blob(target, id, FILE_LIMIT) : undefined;
  const added = text?.ok && !isBinary(text.data) ? lines(text.data).length : null;
  return { path, added, removed: added === null ? null : 0, untracked: true };
}

/** A file the base holds that is untracked now, as after a staged delete: the base against it. */
async function againstBase(
  git: PrivilegedGit,
  target: WorktreeTarget,
  base: string,
  path: string,
  id: string | undefined,
): Promise<ChangedFile> {
  const counted = id ? await git.diffBlob(target, base, path, id, "numstat") : undefined;
  const [added, removed] = counted?.ok ? counted.data.split("\t") : [];
  return added !== undefined && removed !== undefined
    ? { path, added: count(added), removed: count(removed), untracked: false }
    : { path, added: null, removed: null, untracked: true };
}

export async function readChanges(
  git: PrivilegedGit,
  target: WorktreeTarget,
  base: string,
): Promise<ThreadChanges> {
  const status = parseStatus(data(await git.statusAll(target)));
  const tracked = parseNumstat(data(await git.numstat(target, base)));
  const ahead = Number(data(await git.ahead(target, base)).trim());
  const head = data(await git.head(target)).trim();
  const ids = status.untracked.length ? await hashNew(git, target, status.untracked) : new Map();
  const idOf = (path: string) => (typeof ids === "string" ? undefined : ids.get(path));
  const untracked = new Set(status.untracked);
  const inBase = new Set(tracked.map(({ path }) => path).filter((path) => untracked.has(path)));
  const files = await Promise.all([
    ...tracked.map((file) =>
      inBase.has(file.path) ? againstBase(git, target, base, file.path, idOf(file.path)) : file,
    ),
    ...status.untracked
      .filter((path) => !inBase.has(path))
      .map((path) => newFile(git, target, path, idOf(path))),
  ]);
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { state: "read", head, ahead, uncommitted: status.uncommitted, files };
}

function bounded(patch: string): FileDiff {
  return patch.length > PATCH_LIMIT
    ? { state: "read", patch: patch.slice(0, PATCH_LIMIT), truncated: true }
    : { state: "read", patch, truncated: false };
}

export async function readFileDiff(
  git: PrivilegedGit,
  target: WorktreeTarget,
  base: string,
  path: string,
): Promise<FileDiff> {
  const { untracked } = parseStatus(data(await git.statusAll(target)));
  const tracked = data(await git.diff(target, base, {}, path));
  if (!untracked.includes(path)) return bounded(tracked);
  const ids = await hashNew(git, target, [path]);
  if (typeof ids === "string") return { state: "not read", reason: ids };
  const id = ids.get(path) ?? "";
  if (tracked)
    return bounded(data(await git.diffBlob(target, base, path, id, "patch")).replaceAll(id, path));
  const read = await git.blob(target, id, FILE_LIMIT);
  if (!read.ok) return { state: "not read", reason: read.error };
  const text = read.data;
  if (isBinary(text))
    return { state: "read", patch: `Binary file ${path} is new.\n`, truncated: false };
  const added = lines(text);
  return bounded(
    [
      `--- /dev/null`,
      `+++ b/${path}`,
      `@@ -0,0 +1,${added.length} @@`,
      ...added.map((line) => `+${line}`),
      "",
    ].join("\n"),
  );
}

/** What the tab says of a confined run: refused before it ran, not known when it may have run. */
function judged(result: ConfinedResult): CommitOutcome | undefined {
  if (result.ok) return undefined;
  if ("uncertain" in result || ("refused" in result && "afterExit" in result))
    return { outcome: "not known", reason: result.error };
  if ("refused" in result) return { outcome: "refused", reason: result.error };
  return { outcome: "failed", reason: result.error };
}

const timedOut = (result: ConfinedResult) =>
  !result.ok && result.code === null && !("refused" in result) && !("uncertain" in result);

/** Git timed out and may still be running: HEAD moving is the only proof of a commit. */
async function afterTimeout(
  git: PrivilegedGit,
  target: WorktreeTarget,
  before: string,
): Promise<CommitOutcome> {
  const head = await git.head(target).catch(() => undefined);
  if (!head?.ok)
    return {
      outcome: "not known",
      reason:
        "Git timed out and the head could not be read, so the commit may have been made. Refresh to check.",
    };
  const now = head.data.trim();
  return now === before
    ? { outcome: "not known", reason: "Git timed out before the head moved. Refresh to check." }
    : { outcome: "committed", head: now };
}

/** Stages everything in the worktree and commits it, both confined. */
export async function commitChanges(
  git: PrivilegedGit,
  target: WorktreeTarget,
  message: string,
  identity: CommitIdentity,
): Promise<CommitOutcome> {
  if (!parseStatus(data(await git.statusAll(target))).uncommitted)
    return { outcome: "refused", reason: "Nothing to commit." };
  const before = data(await git.head(target)).trim();
  const staged = judged(await git.add(target, ["."]));
  if (staged) return staged;
  const result = await git.commit(target, message, identity);
  if (timedOut(result)) return afterTimeout(git, target, before);
  const committed = judged(result);
  if (committed) return committed;
  const head = await git.head(target).catch(() => undefined);
  return head?.ok
    ? { outcome: "committed", head: head.data.trim() }
    : { outcome: "not known", reason: "Committed, but the new head could not be read." };
}
