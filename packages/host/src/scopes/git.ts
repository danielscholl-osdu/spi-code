// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type ExecOptions, type ExecResult, textResult } from "@spi-code/core";
import { HostExec } from "../exec/host-exec.js";
import {
  type ConfinedResult,
  installRoot,
  loadMxc,
  type MxcApi,
  refuse,
  runConfined,
} from "./confined.js";

export interface PrivilegedGitOptions {
  readonly appData: string;
  readonly capturedPath: string;
  /** Supply Setup's installed Git bin directory on Windows. */
  readonly managedGitBinDir?: () => Promise<string | undefined>;
  /** Supply the installed gh or glab directory for a push credential helper. */
  readonly managedToolBinDir?: (tool: "gh" | "glab") => Promise<string | undefined>;
  readonly env?: NodeJS.ProcessEnv;
  /** Local bare repositories used by offline fixtures. */
  readonly allowLocalRemotes?: boolean;
  /** Loads the sandbox that add and commit run in. */
  readonly mxc?: () => Promise<MxcApi>;
  readonly platform?: NodeJS.Platform;
}

export interface GitTarget {
  /** The checkout returned by ScopeWorkspaces. */
  readonly clone: string;
  /** The caller supplies the host-recorded id and path independently of the .git file. */
  readonly worktree?: { readonly id: string; readonly cwd: string };
}

export type GitOptions = Pick<ExecOptions, "env" | "onOutput" | "signal" | "timeoutMs">;

export interface CloneRemotes {
  readonly origin: string;
  readonly upstream?: string;
}

export interface FetchRequest {
  readonly remote: string;
  /** Fetch tags the remote's branches point at. */
  readonly tags: boolean;
  /** A ref under refs/ that receives the remote's HEAD. */
  readonly head?: string;
  readonly ref?: { readonly source: string; readonly destination: string };
}

export interface PushRequest {
  readonly remote: string;
  readonly source: string;
  /** A ref under refs/ on the remote. */
  readonly destination: string;
  /** The exact remote head observed before the ancestor check; the only force form allowed. */
  readonly expectedHead?: string | null;
  readonly dryRun?: boolean;
}

export type WorktreeTarget = Required<GitTarget>;

export interface CommitIdentity {
  readonly name: string;
  readonly email: string;
}

export interface ConfinedGitOptions {
  readonly timeoutMs?: number;
}

export interface CommitOptions extends ConfinedGitOptions {
  /** Stage changes to tracked files first, as commit -a does. */
  readonly all?: boolean;
}

const upstreamRefspec = "+refs/heads/*:refs/remotes/upstream/*";
const timeoutMs = 180_000;
const submodulesOff = "--ignore-submodules=all";

function remoteName(name: string): string {
  if (!/^[A-Za-z0-9][\w-]*$/u.test(name)) throw new Error("Invalid Git remote name.");
  return name;
}

function fullRef(name: string): string {
  const parts = name.split("/");
  if (
    parts[0] !== "refs" ||
    parts.length < 3 ||
    !parts.every((part) => /^\w[\w.-]*$/u.test(part) && !/(\.\.|\.lock$|\.$)/u.test(part))
  ) {
    throw new Error("Invalid Git ref.");
  }
  return name;
}

function branchName(name: string): string {
  const ref = fullRef(`refs/heads/${name}`);
  return ref.slice("refs/heads/".length);
}

/** HEAD, a full object id or a full ref name: never a range, a reflog entry or an option. */
function revision(name: string): string {
  return name === "HEAD" || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(name) ? name : fullRef(name);
}

const diffFlags = [submodulesOff, "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color"];

function diffArgs(against: string): string[] {
  return [...diffFlags, "--end-of-options", revision(against), "--"];
}

function objectId(id: string): string {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(id)) throw new Error("Invalid object id.");
  return id;
}

export type GitObjectFormat = "sha1" | "sha256";
const ancestryLimit = 50_000;

type CommitReader = (id: string) => Promise<ExecResult<Buffer>>;

export function gitCommitId(format: GitObjectFormat, raw: Buffer): string {
  return createHash(format)
    .update(Buffer.from(`commit ${raw.length}\0`, "utf8"))
    .update(raw)
    .digest("hex");
}

function commitParents(raw: Buffer, format: GitObjectFormat): string[] | undefined {
  const separator = raw.indexOf("\n\n");
  if (separator < 0) return undefined;
  const expectedLength = format === "sha1" ? 40 : 64;
  const lines = raw.subarray(0, separator).toString("latin1").split("\n");
  const tree = lines[0]?.match(/^tree ([0-9a-f]+)$/u);
  if (tree?.[1]?.length !== expectedLength) return undefined;
  const parents: string[] = [];
  for (const line of lines.slice(1)) {
    if (!line.startsWith("parent ")) continue;
    const parent = line.slice("parent ".length);
    if (parent.length !== expectedLength || !/^[0-9a-f]+$/u.test(parent)) return undefined;
    parents.push(parent);
  }
  return parents;
}

export async function verifyGitAncestry(
  ancestor: string,
  descendant: string,
  format: GitObjectFormat,
  readCommit: CommitReader,
  limit = ancestryLimit,
): Promise<ExecResult<boolean>> {
  objectId(ancestor);
  const queue = [objectId(descendant)];
  const seen = new Set<string>();
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    if (id === undefined) return { ok: false, error: "The ancestry walk failed.", code: 1 };
    if (id === ancestor) return { ok: true, data: true };
    if (seen.has(id)) continue;
    if (seen.size >= limit)
      return { ok: false, error: "The ancestry walk exceeded its commit limit.", code: 1 };
    seen.add(id);
    const commit = await readCommit(id);
    if (!commit.ok) return commit;
    if (gitCommitId(format, commit.data) !== id)
      return {
        ok: false,
        error: `Commit ${id} did not match its object id. Refusing to push.`,
        code: 1,
      };
    const parents = commitParents(commit.data, format);
    if (!parents)
      return {
        ok: false,
        error: `Commit ${id} has invalid content. Refusing to push.`,
        code: 1,
      };
    for (const parent of parents) if (!seen.has(parent)) queue.push(parent);
  }
  return { ok: true, data: false };
}

function worktreeId(id: string): string {
  if (!/^[\w.-]+$/u.test(id) || [".", ".."].includes(id)) {
    throw new Error("Worktree is outside its managed location.");
  }
  return id;
}

/** A worktree-relative path, or "." for the whole worktree; never a pathspec or Git metadata. */
function worktreePath(path: string): string {
  const parts = path.split("/");
  if (
    path !== "." &&
    (path.length > 4096 ||
      /[\0\\]/u.test(path) ||
      parts.some((part) => ["", ".", ".."].includes(part) || part.toLowerCase() === ".git"))
  ) {
    throw new Error("Invalid worktree path.");
  }
  return path;
}

function identityPart(value: string): string {
  if (!value.trim() || value.length > 256 || /[\0\r\n<>]/u.test(value)) {
    throw new Error("Invalid commit identity.");
  }
  return value;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isWithin(root: string, child: string): boolean {
  const path = relative(root, child);
  return !!path && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

async function directDirectory(path: string): Promise<void> {
  if (relative(path, await realpath(path)) || !(await lstat(path)).isDirectory()) {
    throw new Error("Managed Git directory is not at its recorded path.");
  }
}

async function directFile(path: string): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > 64 * 1024) {
    throw new Error("Managed Git metadata is not a regular file of the expected size.");
  }
  return readFile(path);
}

async function resolveGit(capturedPath: string, managedDir?: string): Promise<string> {
  const executable = process.platform === "win32" ? "git.exe" : "git";
  for (const entry of [managedDir, ...capturedPath.split(delimiter)]) {
    const directory = entry?.replace(/^"|"$/g, "");
    if (!directory || !isAbsolute(directory)) continue;
    const path = join(directory, executable);
    try {
      const binary = await realpath(path);
      await access(binary, constants.X_OK);
      if ((await lstat(binary)).isFile()) return binary;
    } catch (error) {
      if (
        !isMissing(error) &&
        !(error instanceof Error && "code" in error && error.code === "EACCES")
      ) {
        throw error;
      }
    }
  }
  throw new Error("Git is unavailable. Check Setup before opening a repository.");
}

interface Runtime {
  readonly appData: string;
  readonly cwd: string;
  readonly empty: string;
  readonly binary: string;
  readonly credentialEnv: Readonly<Record<string, string>>;
  readonly env: Readonly<Record<string, string>>;
  readonly exec: HostExec;
}

function systemRoot(env: NodeJS.ProcessEnv): string {
  return (
    Object.entries(env).find(([name]) => name.toUpperCase() === "SYSTEMROOT")?.[1] ?? "C:\\Windows"
  );
}

async function createRuntime(options: PrivilegedGitOptions): Promise<Runtime> {
  const binary = await resolveGit(options.capturedPath, await options.managedGitBinDir?.());
  await mkdir(options.appData, { recursive: true });
  const appData = await realpath(options.appData);
  const cwd = join(appData, "scope-git");
  const empty = join(cwd, "empty");
  const temp = join(cwd, "tmp");
  const grafts = join(empty, "grafts");
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  await directDirectory(cwd);
  for (const directory of [empty, temp]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await directDirectory(directory);
  }
  await writeFile(grafts, "", { mode: 0o600 });
  const windows = process.platform === "win32";
  const root = systemRoot(options.env ?? process.env);
  const paths = windows ? [join(root, "System32"), root] : ["/usr/bin", "/bin"];
  const capturedPath = [dirname(binary), ...paths].join(delimiter);
  const env = {
    ...(windows ? { SystemRoot: root, WINDIR: root } : {}),
    HOME: cwd,
    USERPROFILE: cwd,
    XDG_CONFIG_HOME: cwd,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    LC_ALL: "C",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(empty, "gitconfig"),
    GIT_GRAFT_FILE: grafts,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: appData,
    GIT_ALLOW_PROTOCOL: options.allowLocalRemotes ? "file" : "https",
  };
  const exec = new HostExec({
    appData: cwd,
    capturedPath,
    installer: { binDir: async () => undefined },
    managedTools: [],
    env,
  });
  return {
    appData,
    cwd,
    empty,
    binary,
    credentialEnv: Object.fromEntries(
      Object.entries(options.env ?? process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined &&
          /^(?:APPDATA|GH_CONFIG_DIR|GLAB_CONFIG_DIR|HOME|LOCALAPPDATA|USERPROFILE|XDG_CONFIG_HOME)$/iu.test(
            entry[0],
          ),
      ),
    ),
    // The sandbox cannot read the runner's own directory, only its empty one.
    env: { ...env, PATH: capturedPath, HOME: empty, USERPROFILE: empty, XDG_CONFIG_HOME: empty },
    exec,
  };
}

function shellQuote(path: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? `"${path.replaceAll('"', '""')}"`
    : `'${path.replaceAll("'", "'\\''")}'`;
}

async function managedExecutable(
  options: PrivilegedGitOptions,
  tool: "gh" | "glab",
): Promise<ExecResult<string>> {
  const directory = await options.managedToolBinDir?.(tool);
  if (!directory)
    return { ok: false, error: `Managed ${tool} is unavailable. Check Setup.`, code: null };
  const path = join(directory, process.platform === "win32" ? `${tool}.exe` : tool);
  try {
    const binary = await realpath(path);
    await access(binary, constants.X_OK);
    if (!(await lstat(binary)).isFile()) throw new Error("not a file");
    return { ok: true, data: binary, exitCode: 0 };
  } catch {
    return { ok: false, error: `Managed ${tool} is unavailable. Check Setup.`, code: null };
  }
}

function worktreePointer(text: string): string | undefined {
  return /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(text)?.[1];
}

async function validateWorktree(
  runtime: Runtime,
  common: string,
  worktree: NonNullable<GitTarget["worktree"]>,
): Promise<string> {
  worktreeId(worktree.id);
  if (!isWithin(join(runtime.appData, "worktrees"), worktree.cwd)) {
    throw new Error("Worktree is outside its managed location.");
  }
  await directDirectory(worktree.cwd);
  const admin = join(common, "worktrees", worktree.id);
  await directDirectory(admin);
  const dotGit = join(worktree.cwd, ".git");
  const pointer = worktreePointer((await directFile(dotGit)).toString("utf8"));
  if (!pointer || relative(admin, resolve(worktree.cwd, pointer))) {
    throw new Error("Worktree .git file does not point to its recorded Git directory.");
  }
  const reverse = (await directFile(join(admin, "gitdir"))).toString("utf8").replace(/\r?\n$/u, "");
  if (!reverse || relative(dotGit, resolve(admin, reverse))) {
    throw new Error("Git directory does not point back to its recorded worktree.");
  }
  return admin;
}

function fixedArgs(runtime: Runtime): string[] {
  return [
    "--no-pager",
    "-c",
    `core.hooksPath=${runtime.empty}`,
    "-c",
    "maintenance.auto=false",
    "-c",
    "gc.auto=0",
    "-c",
    "core.commitGraph=false",
    "-c",
    "submodule.recurse=false",
    "-c",
    "commit.gpgSign=false",
    ...(process.platform === "win32" ? ["-c", "http.sslBackend=schannel"] : []),
  ];
}

async function execGit(
  runtime: Runtime,
  repository: string[],
  args: string[],
  options: GitOptions,
  common?: string,
): Promise<ExecResult<string>> {
  const output = await runtime.exec.run(
    runtime.binary,
    [...fixedArgs(runtime), ...repository, ...args],
    {
      timeoutMs,
      ...options,
      cwd: runtime.cwd,
      // Pin the common directory; Git must not consult a worktree's commondir file.
      ...(common === undefined ? {} : { env: { ...options.env, GIT_COMMON_DIR: common } }),
    },
  );
  if (!output.error && output.exit !== 0) {
    const diagnostic = output.stderr.split(/[\r\n]/u).find((line) => /^(fatal|error):/u.test(line));
    if (diagnostic) return { ok: false, error: diagnostic.slice(0, 500), code: output.exit };
  }
  return textResult(output, options);
}

async function execGitRaw(
  runtime: Runtime,
  repository: string[],
  args: string[],
  options: GitOptions,
  common?: string,
): Promise<ExecResult<Buffer>> {
  const silentOptions = { ...options };
  delete silentOptions.onOutput;
  const output = await runtime.exec.runRaw(
    runtime.binary,
    [...fixedArgs(runtime), ...repository, ...args],
    {
      timeoutMs,
      ...silentOptions,
      cwd: runtime.cwd,
      ...(common === undefined ? {} : { env: { ...options.env, GIT_COMMON_DIR: common } }),
    },
  );
  if (output.error !== undefined) return { ok: false, error: output.error, code: output.exit };
  if (output.exit !== 0) {
    const diagnostic = output.stderr.split(/[\r\n]/u).find((line) => /^(fatal|error):/u.test(line));
    return {
      ok: false,
      error: diagnostic?.slice(0, 500) ?? `Git exited with ${output.exit}.`,
      code: output.exit,
    };
  }
  return { ok: true, data: output.stdout, exitCode: output.exit };
}

// Each operation fixes its own arguments: a nested repository's config names programs
// that Git runs whenever an option lets it look inside one.
export class PrivilegedGit {
  #runtime: Promise<Runtime> | undefined;
  readonly #options: PrivilegedGitOptions;

  constructor(options: PrivilegedGitOptions) {
    this.#options = options;
  }

  #getRuntime(): Promise<Runtime> {
    this.#runtime ??= createRuntime(this.#options).catch((error: unknown) => {
      this.#runtime = undefined;
      throw error;
    });
    return this.#runtime;
  }

  async dataRoot(): Promise<string> {
    await mkdir(this.#options.appData, { recursive: true });
    return realpath(this.#options.appData);
  }

  /** Initialize a new checkout inside the caller's private staging directory. */
  async clone(
    directory: string,
    remotes: CloneRemotes,
    options: GitOptions = {},
  ): Promise<ExecResult<string>> {
    const runtime = await this.#getRuntime();
    if (!isWithin(join(runtime.appData, "repos"), directory)) {
      throw new Error("Clone is outside the managed repository directory.");
    }
    await directDirectory(directory);
    const checkout = join(directory, "checkout");
    const result = await execGit(
      runtime,
      [],
      [
        "clone",
        "--progress",
        "--no-local",
        "--no-recurse-submodules",
        "--origin",
        "origin",
        `--template=${runtime.empty}`,
        ...(remotes.upstream === undefined
          ? []
          : [
              "--config",
              `remote.upstream.url=${remotes.upstream}`,
              "--config",
              `remote.upstream.fetch=${upstreamRefspec}`,
            ]),
        "--",
        remotes.origin,
        checkout,
      ],
      options,
    );
    if (result.ok) {
      // The sandbox can write Git state. Only the host can write the reference copy.
      await copyFile(
        join(checkout, ".git", "config"),
        join(directory, "clone.config"),
        constants.COPYFILE_EXCL,
      );
    }
    return result;
  }

  async remoteUrl(
    target: GitTarget,
    remote: string,
    options: GitOptions = {},
  ): Promise<ExecResult<string>> {
    return this.#run(target, ["remote", "get-url", "--", remoteName(remote)], options);
  }

  /** Adds one HTTPS remote for a GitLab fork and refreshes the host's trusted config copy. */
  async addRemote(
    target: GitTarget,
    remote: string,
    url: string,
    options: GitOptions = {},
  ): Promise<ExecResult<string>> {
    const name = remoteName(remote);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("Invalid Git remote URL.");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      !parsed.hostname
    ) {
      throw new Error("Invalid Git remote URL.");
    }
    const runtime = await this.#getRuntime();
    const { common } = await this.#resolve(runtime, target);
    if (
      (await pathExists(join(common, "remotes", name))) ||
      (await pathExists(join(common, "branches", name)))
    ) {
      return { ok: false, error: `Remote ${name} has legacy Git configuration.`, code: 2 };
    }
    const existing = await this.remoteUrl(target, name, options);
    if (existing.ok) {
      return existing.data.trim() === url
        ? { ok: true, data: existing.data }
        : { ok: false, error: `Remote ${name} already has a different URL.`, code: 2 };
    }
    const added = await execGit(
      runtime,
      [`--git-dir=${common}`, `--work-tree=${target.worktree?.cwd ?? target.clone}`],
      ["remote", "add", "--", name, url],
      options,
      common,
    );
    if (added.ok) {
      await copyFile(join(common, "config"), join(dirname(target.clone), "clone.config"));
    }
    return added;
  }

  /** Fetches the remote's branches into refs/remotes/<remote>/, pruning deleted ones. */
  async fetch(
    target: GitTarget,
    request: FetchRequest,
    options: GitOptions = {},
  ): Promise<ExecResult<string>> {
    const remote = remoteName(request.remote);
    return this.#run(
      target,
      [
        "fetch",
        "--progress",
        "--prune",
        "--no-recurse-submodules",
        ...(request.tags ? [] : ["--no-tags"]),
        "--",
        remote,
        `+refs/heads/*:refs/remotes/${remote}/*`,
        ...(request.head === undefined ? [] : [`+HEAD:${fullRef(request.head)}`]),
        ...(request.ref === undefined
          ? []
          : [`+${fullRef(request.ref.source)}:${fullRef(request.ref.destination)}`]),
      ],
      options,
    );
  }

  /** Porcelain v1 with NUL separators. */
  async status(target: GitTarget, options: GitOptions = {}): Promise<ExecResult<string>> {
    return this.#run(
      target,
      ["status", "--porcelain=v1", "-z", "--untracked-files=normal", submodulesOff],
      options,
    );
  }

  async head(target: GitTarget, options: GitOptions = {}): Promise<ExecResult<string>> {
    return this.#run(target, ["rev-parse", "--verify", "HEAD"], options);
  }

  async resolveRef(
    target: GitTarget,
    ref: string,
    options: GitOptions = {},
  ): Promise<ExecResult<string>> {
    return this.#run(target, ["rev-parse", "--verify", revision(ref)], options);
  }

  async ahead(
    target: GitTarget,
    base: string,
    options: GitOptions = {},
  ): Promise<ExecResult<string>> {
    return this.#run(target, ["rev-list", "--count", `${revision(base)}..HEAD`], options);
  }

  async headIsAncestorOf(
    target: GitTarget,
    descendant: string,
    options: GitOptions = {},
  ): Promise<ExecResult<boolean>> {
    const head = await this.head(target, options);
    if (!head.ok) return head;
    const descendantHead = await this.resolveRef(target, descendant, options);
    if (!descendantHead.ok) return descendantHead;
    return this.isAncestor(target, head.data.trim(), descendantHead.data.trim(), options);
  }

  async isAncestor(
    target: GitTarget,
    ancestor: string,
    descendant: string,
    options: GitOptions = {},
  ): Promise<ExecResult<boolean>> {
    objectId(ancestor);
    objectId(descendant);
    const format = await this.#run(
      target,
      ["config", "--local", "--get", "extensions.objectFormat"],
      options,
    );
    if (!format.ok && format.code !== 1) return format;
    const objectFormat = !format.ok ? "sha1" : format.data.trim();
    if (objectFormat !== "sha1" && objectFormat !== "sha256") {
      return { ok: false, error: "The repository object format is not supported.", code: null };
    }
    return verifyGitAncestry(
      ancestor,
      descendant,
      objectFormat,
      async (id) => {
        const type = await this.#run(target, ["cat-file", "-t", objectId(id)], options);
        if (!type.ok)
          return {
            ok: false,
            error:
              type.code === null
                ? `Commit ${id} could not be read. Refusing to push.`
                : `Commit ${id} is missing. Refusing to push.`,
            code: type.code,
          };
        if (type.data.trim() !== "commit")
          return {
            ok: false,
            error: `Object ${id} is not a commit. Refusing to push.`,
            code: 1,
          };
        const runtime = await this.#getRuntime();
        const { admin, common } = await this.#resolve(runtime, target);
        const raw = await execGitRaw(
          runtime,
          [`--git-dir=${admin}`, `--work-tree=${target.worktree?.cwd ?? target.clone}`],
          ["cat-file", "commit", id],
          options,
          common,
        );
        return raw.ok
          ? raw
          : {
              ok: false,
              error: `Commit ${id} could not be read. Refusing to push.`,
              code: raw.code,
            };
      },
      ancestryLimit,
    );
  }

  /** A remote branch's exact head, or null when that ref does not exist. */
  async remoteHead(
    target: GitTarget,
    remote: string,
    branch: string,
    options: GitOptions = {},
  ): Promise<ExecResult<string | null>> {
    const ref = fullRef(`refs/heads/${branch}`);
    const result = await this.#run(
      target,
      ["ls-remote", "--refs", "--exit-code", "--", remoteName(remote), ref],
      options,
    );
    if (!result.ok && result.code === 2) return { ok: true, data: null };
    if (!result.ok) return result;
    const [head] = result.data.trim().split(/\s+/u);
    if (!head || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(head))
      return { ok: false, error: "The remote head could not be read.", code: null };
    return { ok: true, data: head };
  }

  /** The working tree against HEAD or a named ref, as a patch; one worktree path narrows it. */
  async diff(
    target: GitTarget,
    against = "HEAD",
    options: GitOptions = {},
    path?: string,
  ): Promise<ExecResult<string>> {
    return this.#run(
      target,
      [
        "--literal-pathspecs",
        "diff",
        ...diffArgs(against),
        ...(path === undefined ? [] : [worktreePath(path)]),
      ],
      options,
    );
  }

  /** Added and removed lines per tracked file against a ref: `added\tremoved\tpath` NUL-separated. */
  async numstat(
    target: GitTarget,
    against: string,
    options: GitOptions = {},
  ): Promise<ExecResult<string>> {
    return this.#run(
      target,
      ["--literal-pathspecs", "diff", "--numstat", "-z", ...diffArgs(against)],
      options,
    );
  }

  /** One path as the ref holds it against a blob, as a patch or as numstat. */
  async diffBlob(
    target: GitTarget,
    against: string,
    path: string,
    id: string,
    format: "patch" | "numstat",
    options: GitOptions = {},
  ): Promise<ExecResult<string>> {
    return this.#run(
      target,
      [
        "diff",
        ...(format === "numstat" ? ["--numstat"] : []),
        ...diffFlags,
        "--end-of-options",
        `${revision(against)}:${worktreePath(path)}`,
        objectId(id),
        "--",
      ],
      options,
    );
  }

  /** A blob's content, refused when it is larger than the limit. */
  async blob(
    target: GitTarget,
    id: string,
    limit: number,
    options: GitOptions = {},
  ): Promise<ExecResult<string>> {
    const size = await this.#run(target, ["cat-file", "-s", objectId(id)], options);
    if (!size.ok) return size;
    if (!(Number(size.data.trim()) <= limit))
      return { ok: false, error: "The file is too large to show.", code: null };
    return this.#run(target, ["cat-file", "blob", id], options);
  }

  /** Discards local changes and detaches HEAD at the ref. */
  async checkoutDetached(
    target: GitTarget,
    ref: string,
    options: GitOptions = {},
  ): Promise<ExecResult<string>> {
    return this.#run(
      target,
      [
        "checkout",
        "--detach",
        "--force",
        "--no-recurse-submodules",
        "--end-of-options",
        revision(ref),
        "--",
      ],
      options,
    );
  }

  /** Adds a detached worktree at the managed path for the id. */
  async addWorktree(
    clone: string,
    id: string,
    ref: string,
    options: GitOptions = {},
  ): Promise<ExecResult<WorktreeTarget>> {
    const at = revision(ref);
    const name = worktreeId(id);
    const root = join((await this.#getRuntime()).appData, "worktrees");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const cwd = join(root, name);
    const result = await this.#run(
      { clone },
      ["worktree", "add", "--detach", "--", cwd, at],
      options,
    );
    return result.ok ? { ok: true, data: { clone, worktree: { id, cwd } } } : result;
  }

  /** Adds a managed worktree with a branch whose config never tracks its starting ref. */
  async addBranchWorktree(
    clone: string,
    id: string,
    branch: string,
    ref: string,
    reuse = false,
    options: GitOptions = {},
  ): Promise<ExecResult<WorktreeTarget>> {
    const branchRef = branchName(branch);
    const at = revision(ref);
    const name = worktreeId(id);
    const root = join((await this.#getRuntime()).appData, "worktrees");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const cwd = join(root, name);
    const result = await this.#run(
      { clone },
      [
        "-c",
        "branch.autoSetupMerge=false",
        "worktree",
        "add",
        ...(reuse ? [] : ["-b", branchRef]),
        "--",
        cwd,
        reuse ? branchRef : at,
      ],
      options,
    );
    return result.ok ? { ok: true, data: { clone, worktree: { id, cwd } } } : result;
  }

  async rollbackWorktree(
    target: WorktreeTarget,
    options: GitOptions = {},
  ): Promise<ExecResult<string>> {
    const runtime = await this.#getRuntime();
    await this.#resolve(runtime, target);
    const common = join(target.clone, ".git");
    return execGit(
      runtime,
      [`--git-dir=${common}`, `--work-tree=${target.clone}`],
      ["worktree", "remove", "--force", "--", target.worktree.cwd],
      options,
      common,
    );
  }

  /** Includes ignored and untracked entries, for the operator's delete confirmation. */
  async statusAll(target: WorktreeTarget, options: GitOptions = {}): Promise<ExecResult<string>> {
    return this.#run(
      target,
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
        submodulesOff,
      ],
      options,
    );
  }

  /** Porcelain with NUL separators. */
  async listWorktrees(clone: string, options: GitOptions = {}): Promise<ExecResult<string>> {
    return this.#run({ clone }, ["worktree", "list", "--porcelain", "-z"], options);
  }

  /** A fast-forward push, or the one expected-old-value lease form for an existing branch. */
  async push(
    target: GitTarget,
    request: PushRequest,
    options: GitOptions = {},
  ): Promise<ExecResult<string>> {
    const remote = remoteName(request.remote);
    const source = revision(request.source);
    const destination = fullRef(request.destination);
    const expectedHead =
      request.expectedHead === null
        ? ""
        : request.expectedHead === undefined
          ? undefined
          : objectId(request.expectedHead);
    if (expectedHead) {
      const sourceHead = await this.resolveRef(target, source, options);
      if (!sourceHead.ok) return sourceHead;
      const ancestor = await this.isAncestor(target, expectedHead, sourceHead.data.trim(), options);
      if (!ancestor.ok) return { ok: false, error: ancestor.error, code: ancestor.code ?? 1 };
      if (!ancestor.data)
        return {
          ok: false,
          error: "The expected remote head is not an ancestor of the source commit.",
          code: 1,
        };
    }
    const runtime = await this.#getRuntime();
    const url = await this.remoteUrl(target, remote, options);
    if (!url.ok) return url;
    let parsed: URL;
    try {
      parsed = new URL(url.data.trim());
    } catch {
      return { ok: false, error: "The remote URL could not be read.", code: null };
    }
    let credentialArgs: string[] = [];
    let credentialEnv: Record<string, string> = {};
    if (parsed.protocol === "https:") {
      const tool = parsed.hostname.toLowerCase() === "github.com" ? "gh" : "glab";
      const helper = await managedExecutable(this.#options, tool);
      if (!helper.ok) return helper;
      const scope = `credential.https://${parsed.host}`;
      credentialArgs = [
        "-c",
        `${scope}.helper=`,
        "-c",
        `${scope}.helper=!${shellQuote(helper.data, process.platform)} auth git-credential`,
      ];
      credentialEnv = runtime.credentialEnv;
    }
    return this.#run(
      target,
      [
        ...credentialArgs,
        "push",
        "--porcelain",
        "--no-recurse-submodules",
        ...(expectedHead !== undefined
          ? [`--force-with-lease=${destination.slice("refs/heads/".length)}:${expectedHead}`]
          : []),
        ...(request.dryRun ? ["--dry-run"] : []),
        "--",
        remote,
        `${source}:${destination}`,
      ],
      { ...options, env: { ...options.env, ...credentialEnv } },
    );
  }

  /** Stages the paths, which a nested repository's config can make Git run programs for. */
  async add(
    target: WorktreeTarget,
    paths: readonly string[],
    options: ConfinedGitOptions = {},
  ): Promise<ConfinedResult> {
    if (paths.length === 0) throw new Error("Invalid worktree path.");
    const pathspecs = paths.map(worktreePath);
    return this.#confined(target, ["add", "--", ...pathspecs], {}, options);
  }

  /** Writes each worktree file to the object store, confined, and prints one id per path. */
  async hashFiles(
    target: WorktreeTarget,
    paths: readonly string[],
    options: ConfinedGitOptions = {},
  ): Promise<ConfinedResult> {
    if (paths.length === 0) throw new Error("Invalid worktree path.");
    const files = paths.map(worktreePath);
    return this.#confined(
      target,
      ["hash-object", "-w", "--no-filters", "--", ...files],
      {},
      options,
    );
  }

  async commit(
    target: WorktreeTarget,
    message: string,
    identity: CommitIdentity,
    options: CommitOptions = {},
  ): Promise<ConfinedResult> {
    if (!message.trim() || message.includes("\0")) throw new Error("Invalid commit message.");
    const name = identityPart(identity.name);
    const email = identityPart(identity.email);
    return this.#confined(
      target,
      [
        "commit",
        "--no-verify",
        "--no-gpg-sign",
        ...(options.all ? ["--all"] : []),
        "--message",
        message,
      ],
      {
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: email,
      },
      options,
    );
  }

  async #confined(
    target: WorktreeTarget,
    args: string[],
    env: Record<string, string>,
    options: ConfinedGitOptions,
  ): Promise<ConfinedResult> {
    let runtime: Runtime;
    let resolved: { admin: string; common: string };
    try {
      runtime = await this.#getRuntime();
    } catch {
      return refuse("setup-failed");
    }
    try {
      resolved = await this.#resolve(runtime, target);
    } catch {
      return refuse("workspace-not-trusted");
    }
    const { admin, common } = resolved;
    return runConfined(
      {
        binary: runtime.binary,
        args: [
          ...fixedArgs(runtime),
          "--literal-pathspecs",
          `--git-dir=${admin}`,
          `--work-tree=${target.worktree.cwd}`,
          ...args,
        ],
        env: { ...runtime.env, ...env, GIT_COMMON_DIR: common },
        clone: target.clone,
        worktree: target.worktree.cwd,
        scratch: runtime.cwd,
        readonlyPaths: [installRoot(runtime.binary, [homedir(), runtime.appData]), runtime.empty],
        timeoutMs: options.timeoutMs ?? timeoutMs,
      },
      this.#options.mxc ?? loadMxc,
      this.#options.platform,
    );
  }

  async #resolve(runtime: Runtime, target: GitTarget): Promise<{ admin: string; common: string }> {
    const common = join(target.clone, ".git");
    const directory = dirname(target.clone);
    if (
      !isWithin(join(runtime.appData, "repos"), directory) ||
      relative(target.clone, join(directory, "checkout"))
    ) {
      throw new Error("Clone is outside the managed repository directory.");
    }
    await directDirectory(common);
    const [installed, trusted] = await Promise.all([
      directFile(join(common, "config")),
      directFile(join(directory, "clone.config")),
    ]);
    // Git reads local configuration during setup, before per-command overrides apply.
    // The clone was initialized without extensions.worktreeConfig, so config.worktree is ignored.
    if (!installed.equals(trusted)) throw new Error("Managed clone Git configuration changed.");
    const admin = target.worktree
      ? await validateWorktree(runtime, common, target.worktree)
      : common;
    return { admin, common };
  }

  async #run(target: GitTarget, args: string[], options: GitOptions): Promise<ExecResult<string>> {
    const runtime = await this.#getRuntime();
    const { admin, common } = await this.#resolve(runtime, target);
    return execGit(
      runtime,
      [`--git-dir=${admin}`, `--work-tree=${target.worktree?.cwd ?? target.clone}`],
      args,
      options,
      common,
    );
  }
}
