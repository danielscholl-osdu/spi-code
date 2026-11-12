// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect } from "vitest";

// One land run forks about 70 processes; on a machine loaded by parallel checks each can take
// over 100 ms. A hung land is still killed at the spawn budget and fails on result.error.
const landTimeout = 60_000;
export const testTimeout = landTimeout + 30_000;

export const id = "spicode-fixture";
export const branch = `bead/${id}`;
const assignee = "fixture-builder";
// Set this to a mutated copy of scripts/land to confirm a focused case notices the mutation.
const landSource =
  process.env.LAND_FIXTURE_SCRIPT ?? fileURLToPath(new URL("./land", import.meta.url));
const reviewHeadSource = fileURLToPath(new URL("./review-head", import.meta.url));
export const directories: string[] = [];
let template = "";
let base = "";

// A fixture inherits only what bash and git need to start; everything else, exported bash
// functions and any git or bd setting included, comes from the fixture or not at all.
const inheritedNames =
  process.platform === "win32"
    ? ["SystemRoot", "SYSTEMDRIVE", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP"]
    : ["TMPDIR"];
const gitConfig = `[user]
\tname = Fixture Builder
\temail = fixture@example.test
[commit]
\tgpgsign = false
`;

// Gives a fixture directory its own home with the only git configuration the fixture reads.
function prepareHome(directory: string) {
  const home = join(directory, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".gitconfig"), gitConfig);
}

function hermeticEnv(directory: string): NodeJS.ProcessEnv {
  const home = join(directory, "home");
  const env: NodeJS.ProcessEnv = {};
  const inherited = (name: string) =>
    Object.keys(process.env).find((key) => key.toUpperCase() === name.toUpperCase());
  for (const name of inheritedNames) {
    const key = inherited(name);
    if (key !== undefined) env[key] = process.env[key];
  }
  const pathKey = inherited("PATH") ?? "PATH";
  env[pathKey] = [join(directory, "bin"), process.env[pathKey]].filter(Boolean).join(delimiter);
  env.HOME = home;
  if (process.platform === "win32") env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = join(home, ".config");
  env.GIT_CONFIG_GLOBAL = join(home, ".gitconfig");
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_ALLOW_PROTOCOL = "file";
  env.LAND_FIXTURE_STATE = toGitPath(join(directory, "state"));
  env.SPI_LAND_POLL = "0";
  return env;
}

const gitIn =
  (directory: string) =>
  (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: hermeticEnv(directory),
    }).trim();

export function temporaryDirectory(prefix: string) {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

// Git for Windows writes long paths with forward slashes, while the temp directory can come back
// as an 8.3 short name with backslashes. Canonicalise with realpathSync.native, then write in
// git's form.
export function toGitPath(path: string, platform: NodeJS.Platform = process.platform) {
  return platform === "win32" ? path.replaceAll("\\", "/") : path;
}

export const pointers = [
  { file: ["bead", ".git"], suffix: "/main/.git/worktrees/bead" },
  { file: ["main", ".git", "worktrees", "bead", "gitdir"], suffix: "/bead/.git" },
] as const;

// Repoints a worktree pointer at a copy of the template. It keys on the suffix git wrote below
// the fixture directory, never on how the template's own path was spelled.
export function retarget(contents: string, suffix: string, directory: string) {
  const prefix = contents.startsWith("gitdir: ") ? "gitdir: " : "";
  const named = contents.slice(prefix.length).trimEnd();
  if (!named.replaceAll("\\", "/").endsWith(suffix)) {
    throw new Error(`pointer does not end in ${suffix}: ${contents}`);
  }
  return `${prefix}${directory}${suffix}${contents.slice(prefix.length + named.length)}`;
}

// Stand-ins read files and count calls with shell builtins only: on Windows every child
// process costs tens of milliseconds, and a landing calls bd and gh many times.
const stubPrelude = `set -eu
state=$LAND_FIXTURE_STATE
emit() { while IFS= read -r line || [ -n "$line" ]; do printf '%s\\n' "$line"; done < "$1"; }
count() { n=0; while IFS= read -r line; do case $line in "$1 "*) n=$((n + 1)) ;; esac; done < "$2"; }
`;

// The bd stand-in keeps its state in files under the fixture's state directory: bead.json for
// show, update and close; list.json (or list.<n>.json for the nth list call) for list; and
// slot-held, naming another holder, to make merge-slot acquire fail. It logs every call.
const bdStub = `#!/bin/sh
${stubPrelude}printf '%s\\n' "$*" >> "$state/calls.log"
rewrite() {
  next=$(jq "$@" "$state/bead.json")
  printf '%s\\n' "$next" > "$state/bead.json"
}
held() { IFS= read -r holder < "$state/slot-held" || :; }
case "$1" in
  show) emit "$state/bead.json" ;;
  list)
    count list "$state/calls.log"
    if [ -e "$state/list.$n.json" ]; then emit "$state/list.$n.json"; else emit "$state/list.json"; fi
    ;;
  merge-slot)
    if [ "$2" = check ]; then
      if [ -e "$state/slot-held" ]; then
        held
        printf '{"available":false,"holder":"%s"}\\n' "$holder"
      else
        echo '{"available":true,"holder":null}'
      fi
      exit 0
    fi
    if [ "$2" = acquire ] && [ -e "$state/slot-error" ]; then
      emit "$state/slot-error" >&2
      exit 1
    fi
    if [ "$2" = acquire ] && [ -e "$state/slot-frees-after" ]; then
      count "merge-slot acquire" "$state/calls.log"
      IFS= read -r frees < "$state/slot-frees-after" || :
      if [ "$n" -gt "$frees" ]; then exit 0; fi
    fi
    if [ "$2" = acquire ] && [ -e "$state/slot-held" ]; then
      held
      printf 'merge slot is held by %s\\n' "$holder" >&2
      exit 1
    fi
    ;;
  update)
    [ "$2" = ${id} ] && [ "$3" = --set-metadata ] || { printf 'Unexpected bd command: %s\\n' "$*" >&2; exit 1; }
    rewrite --arg k "\${4%%=*}" --arg v "\${4#*=}" '.metadata[$k] = $v'
    ;;
  close)
    [ "$2" = ${id} ] || { printf 'Unexpected bd command: %s\\n' "$*" >&2; exit 1; }
    rewrite '.status = "closed"'
    ;;
  *) printf 'Unexpected bd command: %s\\n' "$*" >&2; exit 1 ;;
esac
`;

// The gh stand-in answers "run list" from gh.<n>.json for the nth such call, else gh.json, and
// logs every call. It knows nothing else, so any other use of gh fails the landing.
const ghStub = `#!/bin/sh
${stubPrelude}printf '%s\\n' "$*" >> "$state/gh.log"
case "$1 $2" in
  "run list")
    count "run list" "$state/gh.log"
    if [ -e "$state/gh.$n.json" ]; then emit "$state/gh.$n.json"; else emit "$state/gh.json"; fi
    ;;
  "run rerun") ;;
  *) printf 'Unexpected gh command: %s\\n' "$*" >&2; exit 1 ;;
esac
`;
export const run = (
  status: string,
  conclusion: string,
  headBranch = `land/${id}--abc-1-1`,
  attempt = 1,
) => ({
  databaseId: 7,
  attempt,
  status,
  conclusion,
  headBranch,
  url: "https://ci.example.test/runs/7",
});
const green = [run("completed", "success", branch)];

// A bare clone of the template's main, copied in as origin by the fixtures that have one.
const originSeed = "origin-seed";

function buildTemplate() {
  const directory = temporaryDirectory("spi-code-land-template-");
  const git = gitIn(directory);
  prepareHome(directory);
  const root = join(directory, "main");
  const bin = join(directory, "bin");
  const state = join(directory, "state");
  mkdirSync(root);
  mkdirSync(bin);
  mkdirSync(state);
  git(root, "init", "--quiet", "--template=", "-b", "main");
  mkdirSync(join(root, "scripts"));
  copyFileSync(landSource, join(root, "scripts/land"));
  copyFileSync(reviewHeadSource, join(root, "scripts/review-head"));
  writeFileSync(
    join(root, "scripts/check"),
    '#!/bin/sh\necho "ran $*" >> "$LAND_FIXTURE_STATE/checks.log"\n',
    { mode: 0o755 },
  );
  writeFileSync(join(root, "change.md"), "Initial content\n");
  git(root, "add", ".");
  git(
    root,
    "commit",
    "--quiet",
    "-m",
    "Historical commit\n\nCo-authored-by: Copilot <copilot@users.noreply.github.com>",
  );
  git(root, "worktree", "add", "--quiet", "-b", branch, join(directory, "bead"));
  const seed = join(directory, originSeed);
  git(directory, "clone", "--quiet", "--bare", "--template=", root, seed);
  mkdirSync(join(seed, "hooks"));
  writeFileSync(
    join(state, "bead.json"),
    JSON.stringify({
      id,
      status: "in_progress",
      assignee,
      labels: ["review:exempt"],
      metadata: {},
    }),
  );
  writeFileSync(join(state, "list.json"), "[]\n");
  writeFileSync(join(state, "calls.log"), "");
  writeFileSync(join(bin, "bd"), bdStub, { mode: 0o755 });
  writeFileSync(join(bin, "gh"), ghStub, { mode: 0o755 });
  writeFileSync(join(state, "gh.json"), JSON.stringify(green));
  writeFileSync(join(state, "gh.log"), "");
  base = git(root, "rev-parse", "main");
  return directory;
}

// Each test file builds its own template once and copies it for every case, so a case that
// lands, reviews or writes never sees another case's changes.
export function useLandFixtures() {
  beforeAll(() => {
    template = buildTemplate();
  }, testTimeout);

  afterAll(() => {
    rmSync(template, { recursive: true, force: true });
  });

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

export const templateDirectory = () => template;

export function relocate(directory: string) {
  for (const { file, suffix } of pointers) {
    const path = join(directory, ...file);
    const contents = retarget(readFileSync(path, "utf8"), suffix, toGitPath(directory));
    // Git for Windows marks the worktree's .git file hidden, and opening a hidden file for
    // overwrite fails with EPERM, so replace the file instead.
    unlinkSync(path);
    writeFileSync(path, contents);
  }
}

// What git itself makes of a relocated copy: the worktree's common directory and the
// worktrees the copy's main checkout lists.
export function resolved(directory: string) {
  const git = gitIn(directory);
  return {
    commonDir: realpathSync.native(
      git(join(directory, "bead"), "rev-parse", "--path-format=absolute", "--git-common-dir"),
    ),
    worktrees: git(join(directory, "main"), "worktree", "list", "--porcelain")
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => realpathSync.native(line.slice("worktree ".length))),
  };
}

type Bead = {
  id: string;
  status: string;
  assignee: string;
  labels: string[];
  metadata: Record<string, string>;
};

export function fixture({ origin = false } = {}) {
  const directory = temporaryDirectory("spi-code-land-");
  directories.push(directory);
  const seed = join(template, originSeed);
  cpSync(template, directory, { recursive: true, filter: (source) => source !== seed });
  const git = gitIn(directory);
  const root = join(directory, "main");
  const worktree = join(directory, "bead");
  const state = join(directory, "state");
  const remote = join(directory, "origin");
  const originUrl = toGitPath(remote);
  relocate(directory);
  if (origin) {
    cpSync(seed, remote, { recursive: true });
    appendFileSync(
      join(root, ".git", "config"),
      `[remote "origin"]\n\turl = ${originUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
    );
  }
  const beadFile = join(state, "bead.json");
  const readBead = (): Bead => JSON.parse(readFileSync(beadFile, "utf8"));
  const writeBead = (bead: Bead) => writeFileSync(beadFile, JSON.stringify(bead));
  let changes = 0;
  return {
    directory,
    base,
    branch,
    originUrl,
    main: () => git(root, "rev-parse", "main"),
    originMain: () => git(directory, "--git-dir", remote, "rev-parse", "main"),
    landedCommits: () => Number(git(root, "rev-list", "--count", `${base}..main`)),
    bead: readBead,
    // Records the review bead-review would: labels cleared and the given metadata merged in.
    review(metadata: Record<string, string>) {
      const bead = readBead();
      writeBead({ ...bead, labels: [], metadata: { ...bead.metadata, ...metadata } });
    },
    commit(message: string) {
      writeFileSync(join(worktree, "change.md"), `Change ${++changes}\n`);
      git(worktree, "commit", "--quiet", "--all", "-m", `${message}\nBead: ${id}`);
      return git(worktree, "rev-parse", "HEAD");
    },
    // Commits one file on the bead branch, or on main when the neighbour is another landing.
    write(where: "bead" | "main", path: string, contents: string) {
      const cwd = where === "bead" ? worktree : root;
      mkdirSync(join(cwd, path, ".."), { recursive: true });
      writeFileSync(join(cwd, path), contents);
      git(cwd, "add", path);
      git(cwd, "commit", "--quiet", "-m", `docs: write ${path}\nBead: ${id}`);
      return git(cwd, "rev-parse", "HEAD");
    },
    rebase: () => git(worktree, "rebase", "--quiet", "main"),
    // What bead-review records, from the bead's worktree: pins and prints the reviewed commit.
    reviewHead: () =>
      execFileSync("bash", ["scripts/review-head", id], {
        cwd: worktree,
        encoding: "utf8",
        env: hermeticEnv(directory),
      }).trim(),
    amend(path: string, contents: string) {
      writeFileSync(join(worktree, path), contents);
      git(worktree, "commit", "--quiet", "--all", "--amend", "--no-edit");
      return git(worktree, "rev-parse", "HEAD");
    },
    // Points a submodule entry at a commit, on main or on the bead, without a checkout.
    gitlink(where: "bead" | "main", path: string, commit: string) {
      const cwd = where === "bead" ? worktree : root;
      git(cwd, "update-index", "--add", "--cacheinfo", `160000,${commit},${path}`);
      git(cwd, "commit", "--quiet", "-m", `chore: point ${path}\nBead: ${id}`);
      return git(cwd, "rev-parse", "HEAD");
    },
    git: (...args: string[]) => git(root, ...args),
    refs: (pattern: string) => git(root, "for-each-ref", "--format=%(refname)", pattern),
    // The id reviews carried before scripts/review-head: the whole diff, context included.
    patchId() {
      const env = hermeticEnv(directory);
      const head = git(worktree, "rev-parse", "HEAD");
      const from = git(worktree, "merge-base", "main", head);
      const diff = execFileSync("git", ["-C", root, "diff", from, head], { env });
      const [patch = ""] = execFileSync("git", ["-C", root, "patch-id", "--verbatim"], {
        input: diff,
        encoding: "utf8",
        env,
      }).split(" ");
      return patch;
    },
    openMainBroken(ids: string[], call?: number) {
      const file = call === undefined ? "list.json" : `list.${call}.json`;
      writeFileSync(join(state, file), JSON.stringify(ids.map((bead) => ({ id: bead }))));
    },
    holdSlot: (holder: string) => writeFileSync(join(state, "slot-held"), holder),
    slotHolder: () => readFileSync(join(state, "slot-held"), "utf8"),
    calls: (command: string) =>
      readFileSync(join(state, "calls.log"), "utf8")
        .split("\n")
        .filter((line) => line === command || line.startsWith(`${command} `)),
    checkRuns: () =>
      existsSync(join(state, "checks.log"))
        ? readFileSync(join(state, "checks.log"), "utf8").split("\n").filter(Boolean).length
        : 0,
    rejectPushes(reject: boolean) {
      const hook = join(remote, "hooks", "pre-receive");
      if (reject) {
        writeFileSync(hook, "#!/bin/sh\necho 'fixture origin rejects pushes' >&2\nexit 1\n", {
          mode: 0o755,
        });
      } else {
        unlinkSync(hook);
      }
    },
    // What CI reports for the commit: on the nth "gh run list", or on every one without n.
    ci(runs: ReturnType<typeof run>[], call?: number) {
      writeFileSync(
        join(state, call === undefined ? "gh.json" : `gh.${call}.json`),
        JSON.stringify(runs),
      );
    },
    ghCalls: (command: string) =>
      readFileSync(join(state, "gh.log"), "utf8")
        .split("\n")
        .filter((line) => line.startsWith(command)),
    checks: () =>
      existsSync(join(state, "checks.log"))
        ? readFileSync(join(state, "checks.log"), "utf8").split("\n").filter(Boolean)
        : [],
    // Records every ref origin receives, so a branch that came and went still shows.
    recordPushes() {
      writeFileSync(
        join(remote, "hooks", "post-receive"),
        '#!/bin/sh\nwhile read -r _old new ref; do echo "$ref $new" >> "$LAND_FIXTURE_STATE/pushed.log"; done\n',
        { mode: 0o755 },
      );
    },
    pushed: () =>
      existsSync(join(state, "pushed.log"))
        ? readFileSync(join(state, "pushed.log"), "utf8").split("\n").filter(Boolean)
        : [],
    slotError: (message: string) => writeFileSync(join(state, "slot-error"), message),
    originRefs: () => git(directory, "--git-dir", remote, "for-each-ref", "--format=%(refname)"),
    slotFreesAfter: (attempts: number) =>
      writeFileSync(join(state, "slot-frees-after"), String(attempts)),
    land: (env: Record<string, string> = {}, ...options: string[]) =>
      spawnSync("bash", ["scripts/land", ...options, id], {
        cwd: root,
        encoding: "utf8",
        env: { ...hermeticEnv(directory), ...env },
        timeout: landTimeout,
      }),
  };
}

// A bare repository outside every fixture, which no land run may touch.
export function outsideCanary() {
  const path = temporaryDirectory("spi-code-land-canary-");
  directories.push(path);
  prepareHome(path);
  const git = gitIn(path);
  git(path, "init", "--quiet", "--bare", "--template=");
  return { path, url: toGitPath(path), refs: () => git(path, "--git-dir", path, "for-each-ref") };
}

// Runs with variables set in this process, as a caller's shell would hand them to the test.
export function withInheritedEnv<T>(variables: Record<string, string>, run: () => T): T {
  const saved = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]));
  Object.assign(process.env, variables);
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export type Fixture = ReturnType<typeof fixture>;
type Result = ReturnType<Fixture["land"]>;

export function expectRefused(repo: Fixture, result: Result, reason: string) {
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stderr).toContain(reason);
  expect(repo.main()).toBe(repo.base);
  expect(repo.calls("update")).toEqual([]);
  expect(repo.calls("close")).toEqual([]);
  expect(repo.bead().status).toBe("in_progress");
}

export function expectLanded(repo: Fixture, result: Result, head: string) {
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("landed as");
  expect(repo.main()).toBe(head);
  expect(repo.bead().status).toBe("closed");
  expect(repo.bead().metadata["land.sha"]).toBe(head);
  expect(repo.calls("close")).toEqual([
    expect.stringMatching(
      new RegExp(`^close ${id} --actor ${assignee} --reason Landed [0-9a-f]+$`),
    ),
  ]);
}
