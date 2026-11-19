// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { constants } from "node:fs";
import { access, copyFile, lstat, mkdir, readFile, realpath } from "node:fs/promises";
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

export type GitOptions = Pick<ExecOptions, "onOutput" | "signal" | "timeoutMs">;

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
}

export interface PushRequest {
  readonly remote: string;
  readonly source: string;
  /** A ref under refs/ on the remote. */
  readonly destination: string;
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

/** HEAD, a full object id or a full ref name: never a range, a reflog entry or an option. */
function revision(name: string): string {
  return name === "HEAD" || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(name) ? name : fullRef(name);
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
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  await directDirectory(cwd);
  for (const directory of [empty, temp]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await directDirectory(directory);
  }
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
    // The sandbox cannot read the runner's own directory, only its empty one.
    env: { ...env, PATH: capturedPath, HOME: empty, USERPROFILE: empty, XDG_CONFIG_HOME: empty },
    exec,
  };
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
      ...(common === undefined ? {} : { env: { GIT_COMMON_DIR: common } }),
    },
  );
  if (!output.error && output.exit !== 0) {
    const diagnostic = output.stderr.split(/[\r\n]/u).find((line) => /^(fatal|error):/u.test(line));
    if (diagnostic) return { ok: false, error: diagnostic.slice(0, 500), code: output.exit };
  }
  return textResult(output, options);
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

  /** The working tree against HEAD or a named ref, as a patch. */
  async diff(
    target: GitTarget,
    against = "HEAD",
    options: GitOptions = {},
  ): Promise<ExecResult<string>> {
    return this.#run(
      target,
      [
        "diff",
        submodulesOff,
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--end-of-options",
        revision(against),
        "--",
      ],
      options,
    );
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
    const cwd = join((await this.#getRuntime()).appData, "worktrees", name);
    const result = await this.#run(
      { clone },
      ["worktree", "add", "--detach", "--", cwd, at],
      options,
    );
    return result.ok ? { ok: true, data: { clone, worktree: { id, cwd } } } : result;
  }

  /** Porcelain with NUL separators. */
  async listWorktrees(clone: string, options: GitOptions = {}): Promise<ExecResult<string>> {
    return this.#run({ clone }, ["worktree", "list", "--porcelain", "-z"], options);
  }

  /** A fast-forward push of one ref; there is no force or delete form. */
  async push(
    target: GitTarget,
    request: PushRequest,
    options: GitOptions = {},
  ): Promise<ExecResult<string>> {
    return this.#run(
      target,
      [
        "push",
        "--porcelain",
        "--no-recurse-submodules",
        ...(request.dryRun ? ["--dry-run"] : []),
        "--",
        remoteName(request.remote),
        `${revision(request.source)}:${fullRef(request.destination)}`,
      ],
      options,
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
