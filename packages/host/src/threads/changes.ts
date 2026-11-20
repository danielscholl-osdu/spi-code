// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
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

/** `git diff --numstat -z --no-renames`: binary files count as null. */
export function parseNumstat(text: string): ChangedFile[] {
  return text
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const [added = "", removed = "", ...rest] = entry.split("\t");
      const count = (value: string) => (/^\d+$/u.test(value) ? Number(value) : null);
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

/** An untracked regular file at its own path in the worktree, never through a link, or undefined. */
async function readNew(worktree: string, path: string): Promise<Buffer | undefined> {
  try {
    const root = await realpath(worktree);
    const real = await realpath(join(root, path));
    if (relative(root, real) !== path.split("/").join(sep)) return undefined;
    const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > FILE_LIMIT) return undefined;
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

const isBinary = (bytes: Buffer) => bytes.subarray(0, 8000).includes(0);

function lines(text: string): string[] {
  const all = text.split("\n");
  if (all.at(-1) === "") all.pop();
  return all;
}

async function untrackedFile(worktree: string, path: string): Promise<ChangedFile> {
  const bytes = await readNew(worktree, path);
  const added = bytes && !isBinary(bytes) ? lines(bytes.toString("utf8")).length : null;
  return { path, added, removed: added === null ? null : 0, untracked: true };
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
  const known = new Set(tracked.map(({ path }) => path));
  const fresh = await Promise.all(
    status.untracked
      .filter((path) => !known.has(path))
      .map((path) => untrackedFile(target.worktree.cwd, path)),
  );
  const files = [...tracked, ...fresh].sort((a, b) => (a.path < b.path ? -1 : 1));
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
  if (!untracked.includes(path)) return bounded(data(await git.diff(target, base, {}, path)));
  const bytes = await readNew(target.worktree.cwd, path);
  if (!bytes) return { state: "not read", reason: "The new file could not be read." };
  if (isBinary(bytes))
    return { state: "read", patch: `Binary file ${path} is new.\n`, truncated: false };
  const added = lines(bytes.toString("utf8"));
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

/** Stages everything in the worktree and commits it, both confined. */
export async function commitChanges(
  git: PrivilegedGit,
  target: WorktreeTarget,
  message: string,
  identity: CommitIdentity,
): Promise<CommitOutcome> {
  if (!parseStatus(data(await git.statusAll(target))).uncommitted)
    return { outcome: "refused", reason: "Nothing to commit." };
  const staged = judged(await git.add(target, ["."]));
  if (staged) return staged;
  const committed = judged(await git.commit(target, message, identity));
  if (committed) return committed;
  const head = await git.head(target).catch(() => undefined);
  return head?.ok
    ? { outcome: "committed", head: head.data.trim() }
    : { outcome: "not known", reason: "Committed, but the new head could not be read." };
}
