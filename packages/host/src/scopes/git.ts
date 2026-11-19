// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { constants } from "node:fs";
import { access, copyFile, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type ExecOptions, type ExecResult, textResult } from "@spi-code/core";
import { HostExec } from "../exec/host-exec.js";

export interface PrivilegedGitOptions {
  readonly appData: string;
  readonly capturedPath: string;
  /** Supply Setup's installed Git bin directory on Windows. */
  readonly managedGitBinDir?: () => Promise<string | undefined>;
  readonly env?: NodeJS.ProcessEnv;
  /** Local bare repositories used by offline fixtures. */
  readonly allowLocalRemotes?: boolean;
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
  const exec = new HostExec({
    appData: cwd,
    capturedPath: [dirname(binary), ...paths].join(delimiter),
    installer: { binDir: async () => undefined },
    managedTools: [],
    env: {
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
    },
  });
  return { appData, cwd, empty, binary, exec };
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

async function execGit(
  runtime: Runtime,
  repository: string[],
  args: string[],
  options: GitOptions,
  common?: string,
): Promise<ExecResult<string>> {
  const output = await runtime.exec.run(
    runtime.binary,
    [
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
      ...repository,
      ...args,
    ],
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
    const runtime = await this.#getRuntime();
    const cwd = join(runtime.appData, "worktrees", worktreeId(id));
    const result = await this.#run(
      { clone },
      ["worktree", "add", "--detach", "--", cwd, revision(ref)],
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

  async #run(target: GitTarget, args: string[], options: GitOptions): Promise<ExecResult<string>> {
    const runtime = await this.#getRuntime();
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
    return execGit(
      runtime,
      [`--git-dir=${admin}`, `--work-tree=${target.worktree?.cwd ?? target.clone}`],
      args,
      options,
      common,
    );
  }
}
