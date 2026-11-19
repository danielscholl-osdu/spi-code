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

const gitCommands = [
  "check-ref-format",
  "checkout",
  "diff",
  "fetch",
  "for-each-ref",
  "ls-files",
  "ls-remote",
  "push",
  "remote",
  "reset",
  "rev-parse",
  "show-ref",
  "status",
  "symbolic-ref",
  "worktree",
] as const;

type GitCommand = (typeof gitCommands)[number];

type GitOptions = Pick<ExecOptions, "onOutput" | "signal" | "timeoutMs">;

export interface CloneRemotes {
  readonly origin: string;
  readonly upstream?: string;
}

const upstreamRefspec = "+refs/heads/*:refs/remotes/upstream/*";
const timeoutMs = 180_000;

function overridesSubmodules(arg: string): boolean {
  const name = /^--(?:no-)?([^=]*)/u.exec(arg)?.[1];
  return !!name && "ignore-submodules".startsWith(name);
}

// A nested repository's own config can name programs; Git runs them whenever it looks inside one.
function commandLine(command: GitCommand, args: readonly string[]): string[] {
  if (!(gitCommands as readonly string[]).includes(command)) {
    throw new Error(`Unsupported privileged Git command: ${command}.`);
  }
  if (command === "checkout") {
    const [detach, force, ref, ...rest] = args;
    if (
      detach !== "--detach" ||
      force !== "--force" ||
      !ref ||
      ref.startsWith("-") ||
      rest.length
    ) {
      throw new Error("Privileged Git checkout requires --detach --force and one ref.");
    }
  }
  if (command !== "status" && command !== "diff") return [command, ...args];
  if (args.some(overridesSubmodules)) {
    throw new Error("Privileged Git controls submodule handling.");
  }
  return [
    command,
    "--ignore-submodules=all",
    ...(command === "diff" ? ["--no-ext-diff", "--no-textconv"] : []),
    ...args,
  ];
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
  if (
    !/^[\w.-]+$/u.test(worktree.id) ||
    [".", ".."].includes(worktree.id) ||
    !isWithin(join(runtime.appData, "worktrees"), worktree.cwd)
  ) {
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

export class PrivilegedGit {
  private runtime: Promise<Runtime> | undefined;

  constructor(private readonly options: PrivilegedGitOptions) {}

  private getRuntime(): Promise<Runtime> {
    this.runtime ??= createRuntime(this.options).catch((error: unknown) => {
      this.runtime = undefined;
      throw error;
    });
    return this.runtime;
  }

  async dataRoot(): Promise<string> {
    await mkdir(this.options.appData, { recursive: true });
    return realpath(this.options.appData);
  }

  private async exec(
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
      const diagnostic = output.stderr
        .split(/[\r\n]/u)
        .find((line) => /^(fatal|error):/u.test(line));
      if (diagnostic) return { ok: false, error: diagnostic.slice(0, 500), code: output.exit };
    }
    return textResult(output, options);
  }

  /** Initialize a new checkout inside the caller's private staging directory. */
  async clone(
    directory: string,
    remotes: CloneRemotes,
    options: GitOptions = {},
  ): Promise<ExecResult<string>> {
    const runtime = await this.getRuntime();
    if (!isWithin(join(runtime.appData, "repos"), directory)) {
      throw new Error("Clone is outside the managed repository directory.");
    }
    await directDirectory(directory);
    const checkout = join(directory, "checkout");
    const result = await this.exec(
      runtime,
      [],
      [
        "clone",
        "--progress",
        "--no-local",
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

  async run(
    target: GitTarget,
    command: GitCommand,
    args: readonly string[] = [],
    options: GitOptions = {},
  ): Promise<ExecResult<string>> {
    const line = commandLine(command, args);
    const runtime = await this.getRuntime();
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
    return this.exec(
      runtime,
      [`--git-dir=${admin}`, `--work-tree=${target.worktree?.cwd ?? target.clone}`],
      line,
      options,
      common,
    );
  }
}
