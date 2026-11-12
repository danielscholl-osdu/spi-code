// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
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
import { delimiter, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// One land run forks about 70 processes; on a machine loaded by parallel checks each can take
// over 100 ms. A hung land is still killed at the spawn budget and fails on result.error.
const landTimeout = 60_000;
const testTimeout = landTimeout + 30_000;

const id = "spicode-fixture";
const branch = `bead/${id}`;
const assignee = "fixture-builder";
// Set this to a mutated copy of scripts/land to confirm a focused case notices the mutation.
const landSource =
  process.env.LAND_FIXTURE_SCRIPT ?? fileURLToPath(new URL("./land", import.meta.url));
const reviewHeadSource = fileURLToPath(new URL("./review-head", import.meta.url));
const directories: string[] = [];
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

function temporaryDirectory(prefix: string) {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

// Git for Windows writes long paths with forward slashes, while the temp directory can come back
// as an 8.3 short name with backslashes. Canonicalise with realpathSync.native, then write in
// git's form.
function toGitPath(path: string, platform: NodeJS.Platform = process.platform) {
  return platform === "win32" ? path.replaceAll("\\", "/") : path;
}

const pointers = [
  { file: ["bead", ".git"], suffix: "/main/.git/worktrees/bead" },
  { file: ["main", ".git", "worktrees", "bead", "gitdir"], suffix: "/bead/.git" },
] as const;

// Repoints a worktree pointer at a copy of the template. It keys on the suffix git wrote below
// the fixture directory, never on how the template's own path was spelled.
function retarget(contents: string, suffix: string, directory: string) {
  const prefix = contents.startsWith("gitdir: ") ? "gitdir: " : "";
  const named = contents.slice(prefix.length).trimEnd();
  if (!named.replaceAll("\\", "/").endsWith(suffix)) {
    throw new Error(`pointer does not end in ${suffix}: ${contents}`);
  }
  return `${prefix}${directory}${suffix}${contents.slice(prefix.length + named.length)}`;
}

const samePath = (a: string, b: string) => realpathSync.native(a) === realpathSync.native(b);

// The bd stand-in keeps its state in files under the fixture's state directory: bead.json for
// show, update and close; list.json (or list.<n>.json for the nth list call) for list; and
// slot-held, naming another holder, to make merge-slot acquire fail. It logs every call.
const bdStub = `#!/bin/sh
set -eu
state=$LAND_FIXTURE_STATE
printf '%s\\n' "$*" >> "$state/calls.log"
rewrite() {
  jq "$@" "$state/bead.json" > "$state/bead.next"
  mv -f "$state/bead.next" "$state/bead.json"
}
case "$1" in
  show) cat "$state/bead.json" ;;
  list)
    n=$(grep -c '^list ' "$state/calls.log")
    if [ -e "$state/list.$n.json" ]; then cat "$state/list.$n.json"; else cat "$state/list.json"; fi
    ;;
  merge-slot)
    if [ "$2" = check ]; then
      if [ -e "$state/slot-held" ]; then
        printf '{"available":false,"holder":"%s"}\\n' "$(cat "$state/slot-held")"
      else
        echo '{"available":true,"holder":null}'
      fi
      exit 0
    fi
    if [ "$2" = acquire ] && [ -e "$state/slot-error" ]; then
      cat "$state/slot-error" >&2
      exit 1
    fi
    if [ "$2" = acquire ] && [ -e "$state/slot-frees-after" ] &&
      [ "$(grep -c '^merge-slot acquire ' "$state/calls.log")" -gt "$(cat "$state/slot-frees-after")" ]; then
      exit 0
    fi
    if [ "$2" = acquire ] && [ -e "$state/slot-held" ]; then
      printf 'merge slot is held by %s\\n' "$(cat "$state/slot-held")" >&2
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
set -eu
state=$LAND_FIXTURE_STATE
printf '%s\\n' "$*" >> "$state/gh.log"
case "$1 $2" in
  "run list")
    n=$(grep -c '^run list ' "$state/gh.log")
    if [ -e "$state/gh.$n.json" ]; then cat "$state/gh.$n.json"; else cat "$state/gh.json"; fi
    ;;
  "run rerun") ;;
  *) printf 'Unexpected gh command: %s\\n' "$*" >&2; exit 1 ;;
esac
`;
const run = (status: string, conclusion: string, headBranch = `land/${id}`, attempt = 1) => ({
  databaseId: 7,
  attempt,
  status,
  conclusion,
  headBranch,
  url: "https://ci.example.test/runs/7",
});
const green = [run("completed", "success", branch)];

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

function relocate(directory: string) {
  for (const { file, suffix } of pointers) {
    const path = join(directory, ...file);
    const contents = retarget(readFileSync(path, "utf8"), suffix, toGitPath(directory));
    // Git for Windows marks the worktree's .git file hidden, and opening a hidden file for
    // overwrite fails with EPERM, so replace the file instead.
    unlinkSync(path);
    writeFileSync(path, contents);
  }
  const git = gitIn(directory);
  const root = join(directory, "main");
  const worktree = join(directory, "bead");
  const commonDir = git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (!samePath(commonDir, join(root, ".git"))) {
    throw new Error(`${worktree} still resolves to ${commonDir}, not the copy in ${directory}`);
  }
  const listed = git(root, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  if (!listed.some((path) => samePath(path, worktree))) {
    throw new Error(`${root} does not list ${worktree}: ${listed.join(", ")}`);
  }
}

type Bead = {
  id: string;
  status: string;
  assignee: string;
  labels: string[];
  metadata: Record<string, string>;
};

function fixture({ origin = false } = {}) {
  const directory = temporaryDirectory("spi-code-land-");
  directories.push(directory);
  cpSync(template, directory, { recursive: true });
  const git = gitIn(directory);
  const root = join(directory, "main");
  const worktree = join(directory, "bead");
  const state = join(directory, "state");
  const remote = join(directory, "origin");
  const originUrl = toGitPath(remote);
  relocate(directory);
  if (origin) {
    git(directory, "clone", "--quiet", "--bare", "--template=", root, remote);
    mkdirSync(join(remote, "hooks"));
    git(root, "remote", "add", "origin", originUrl);
  }
  const beadFile = join(state, "bead.json");
  const readBead = (): Bead => JSON.parse(readFileSync(beadFile, "utf8"));
  const writeBead = (bead: Bead) => writeFileSync(beadFile, JSON.stringify(bead));
  let changes = 0;
  return {
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
function outsideCanary() {
  const path = temporaryDirectory("spi-code-land-canary-");
  directories.push(path);
  prepareHome(path);
  const git = gitIn(path);
  git(path, "init", "--quiet", "--bare", "--template=");
  return { path, url: toGitPath(path), refs: () => git(path, "--git-dir", path, "for-each-ref") };
}

// Runs with variables set in this process, as a caller's shell would hand them to the test.
function withInheritedEnv<T>(variables: Record<string, string>, run: () => T): T {
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

type Fixture = ReturnType<typeof fixture>;
type Result = ReturnType<Fixture["land"]>;

function expectRefused(repo: Fixture, result: Result, reason: string) {
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stderr).toContain(reason);
  expect(repo.main()).toBe(repo.base);
  expect(repo.calls("update")).toEqual([]);
  expect(repo.calls("close")).toEqual([]);
  expect(repo.bead().status).toBe("in_progress");
}

function expectLanded(repo: Fixture, result: Result, head: string) {
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

describe("fixture relocation", () => {
  const short = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\spi-code-land-template-abc";
  const long = "C:/Users/runneradmin/AppData/Local/Temp/spi-code-land-template-abc";
  const copy = "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\spi-code-land-xyz";

  it("writes Windows paths in git's forward-slash form", () => {
    expect(toGitPath(copy, "win32")).toBe(
      "C:/Users/runneradmin/AppData/Local/Temp/spi-code-land-xyz",
    );
    expect(toGitPath("/tmp/a\\b", "darwin")).toBe("/tmp/a\\b");
  });

  it("repoints Windows pointers git wrote in long form, whatever the template's short spelling", () => {
    const pointer = `gitdir: ${long}/main/.git/worktrees/bead\n`;
    expect(pointer.includes(short)).toBe(false);
    const target = toGitPath(copy, "win32");
    expect(retarget(pointer, pointers[0].suffix, target)).toBe(
      "gitdir: C:/Users/runneradmin/AppData/Local/Temp/spi-code-land-xyz/main/.git/worktrees/bead\n",
    );
    expect(retarget(`${long}/bead/.git\r\n`, pointers[1].suffix, target)).toBe(
      "C:/Users/runneradmin/AppData/Local/Temp/spi-code-land-xyz/bead/.git\r\n",
    );
    expect(retarget(`${short}\\bead\\.git\n`, pointers[1].suffix, target)).toBe(
      "C:/Users/runneradmin/AppData/Local/Temp/spi-code-land-xyz/bead/.git\n",
    );
  });

  it("repoints POSIX pointers and refuses one that names something else", () => {
    expect(
      retarget("gitdir: /private/tmp/t/main/.git/worktrees/bead\n", pointers[0].suffix, "/tmp/c"),
    ).toBe("gitdir: /tmp/c/main/.git/worktrees/bead\n");
    expect(retarget("/private/tmp/t/bead/.git\n", pointers[1].suffix, "/tmp/c")).toBe(
      "/tmp/c/bead/.git\n",
    );
    expect(() =>
      retarget("gitdir: /private/tmp/t/other/.git\n", pointers[0].suffix, "/tmp/c"),
    ).toThrow("does not end in");
  });

  it("leaves a copied fixture resolving inside the copy, not the template", () => {
    const directory = temporaryDirectory("spi-code-land-");
    directories.push(directory);
    cpSync(template, directory, { recursive: true });
    relocate(directory);
    const commonDir = gitIn(directory)(
      join(directory, "bead"),
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    );
    expect(realpathSync.native(commonDir).startsWith(directory + sep)).toBe(true);
    expect(realpathSync.native(commonDir).startsWith(template + sep)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "replaces pointers it cannot open for overwrite, and round-trips them",
    () => {
      const directory = temporaryDirectory("spi-code-land-");
      directories.push(directory);
      cpSync(template, directory, { recursive: true });
      for (const { file } of pointers) chmodSync(join(directory, ...file), 0o444);
      relocate(directory);
      expect(readFileSync(join(directory, "bead", ".git"), "utf8")).toBe(
        `gitdir: ${directory}/main/.git/worktrees/bead\n`,
      );
      expect(
        readFileSync(join(directory, "main", ".git", "worktrees", "bead", "gitdir"), "utf8"),
      ).toBe(`${directory}/bead/.git\n`);
    },
  );
});

describe("landing commit attribution", () => {
  it.each([
    "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>",
    "Co-Authored-By: Claude <claude@example.test>",
    "co-AUTHORED-by: cOdEx <agent@example.test>",
    "Co-authored-by: GPT <agent@example.test>",
    "Co-authored-by: Gemini <agent@example.test>",
    "Co-authored-by: Muse <agent@example.test>",
    "Co-authored-by: Assistant <noreply@anthropic.com>",
    "Co-authored-by: Assistant <noreply@openai.com>",
    "Co-authored-by: Assistant <223556219+Copilot@users.noreply.github.com>",
    "Co-authored-by: Ada Lovelace <ada@example.test>\nCo-authored-by: Copilot <agent@example.test>",
    "Co-authored-by: Someone\n  Copilot <copilot@users.noreply.github.com>",
    "Co-authored-by : Copilot <copilot@example.test>",
    "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>\n",
    "Bead: spicode-fixture\nCo-authored-by: Copilot <copilot@example.test>\nA prose line.",
    "Generated with Copilot",
    "  gEnErAtEd WiTh Claude",
    "\u{1f916} Generated with [Claude Code]",
  ])(
    "refuses %s, identifies its commit and explains how to reword",
    (attribution) => {
      const repo = fixture();
      const offending = repo.commit(`docs: update fixture\n\n${attribution}`);
      repo.commit("docs: add a clean follow-up");

      const result = repo.land();

      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain(offending);
      expect(result.stderr).toContain("AI attribution");
      expect(result.stderr).toContain(`git rebase -i main`);
      expect(result.stderr).toContain("reword");
      expect(result.stderr).toContain(repo.branch);
      expect(repo.main()).toBe(repo.base);
    },
    testTimeout,
  );

  it.each([
    "Co-authored-by: Ada Lovelace <ada@example.test>",
    "Co-authored-by: Human Contributor <12345+human@users.noreply.github.com>",
    "Co-authored-by: Elena Musetti <elena@example.test>",
    "Co-authored-by: Ada Lovelace <ada@example.test>\nCo-authored-by: Grace Hopper <grace@example.test>",
    "Co-authored-by : Ada Lovelace\n  <ada@example.test>",
    "Co-authored-by: Ada Lovelace <ada@gpt-labs.example>",
    "snapshots regenerated with vitest",
    "lockfile is generated with pnpm",
    "",
  ])(
    "allows human or absent attribution: %s, ignoring historical AI trailers",
    (attribution) => {
      const repo = fixture();
      const head = repo.commit(`docs: update fixture\n\n${attribution}`);

      const result = repo.land();

      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("landed as");
      expect(repo.main()).toBe(head);
    },
    testTimeout,
  );
});

describe("landing gates", () => {
  const anthropicBuild = { "build.provider": "anthropic", "build.model": "claude-opus-5.5" };

  it(
    "refuses while another bead is main-broken, before running checks, and releases the slot",
    () => {
      const repo = fixture();
      repo.commit("docs: update fixture");
      repo.openMainBroken(["spicode-broken"]);

      const result = repo.land();

      expectRefused(repo, result, "main is broken (spicode-broken");
      expect(result.stderr).toContain("only its fix may land");
      expect(repo.checkRuns()).toBe(0);
      expect(repo.calls("merge-slot release")).toEqual([
        expect.stringMatching(new RegExp(`^merge-slot release --holder land:${id}:\\d+$`)),
      ]);
    },
    testTimeout,
  );

  it(
    "refuses when main breaks while checks run",
    () => {
      const repo = fixture();
      repo.commit("docs: update fixture");
      repo.openMainBroken(["spicode-broken"], 2);

      const result = repo.land();

      expectRefused(repo, result, "main is broken (spicode-broken");
      expect(repo.checkRuns()).toBe(1);
      expect(repo.calls("list")).toHaveLength(2);
    },
    testTimeout,
  );

  it(
    "lands the main-broken fix itself",
    () => {
      const repo = fixture();
      const head = repo.commit("docs: fix main");
      repo.openMainBroken([id]);

      expectLanded(repo, repo.land(), head);
    },
    testTimeout,
  );

  it(
    "refuses while another lander holds the merge slot, and leaves that slot alone",
    () => {
      const repo = fixture();
      repo.commit("docs: update fixture");
      repo.holdSlot("land:spicode-other:1");

      const result = repo.land();

      expectRefused(repo, result, "the merge slot is held");
      expect(repo.calls("merge-slot release")).toEqual([]);
      expect(repo.slotHolder()).toBe("land:spicode-other:1");
      expect(repo.calls("list")).toEqual([]);
      expect(repo.checkRuns()).toBe(0);
    },
    testTimeout,
  );

  it.each([
    ["absent", {}],
    ["failing", { "review.verdict": "fail", "review.provider": "openai" }],
  ])(
    "refuses a bead whose review is %s",
    (_name, review) => {
      const repo = fixture();
      repo.commit("docs: update fixture");
      repo.review({ ...anthropicBuild, ...review });

      expectRefused(repo, repo.land(), `${id} has no passing review`);
    },
    testTimeout,
  );

  it(
    "refuses a review whose patch-id no longer matches the diff",
    () => {
      const repo = fixture();
      repo.commit("docs: update fixture");
      const reviewed = repo.patchId();
      repo.review({
        ...anthropicBuild,
        "review.verdict": "pass",
        "review.provider": "openai",
        "review.patch_id": reviewed,
      });
      repo.commit("docs: change after review");
      const current = repo.patchId();
      expect(current).not.toBe(reviewed);

      expectRefused(
        repo,
        repo.land(),
        `the diff changed since review (${current} vs ${reviewed}); review again`,
      );
    },
    testTimeout,
  );

  const lines = (changed: Record<number, string> = {}) =>
    Array.from({ length: 9 }, (_, index) => `${changed[index + 1] ?? `line ${index + 1}`}\n`).join(
      "",
    );
  const pass = { ...anthropicBuild, "review.verdict": "pass", "review.provider": "openai" };
  const passedAt = (head: string) => ({ ...pass, "review.head": head });
  // A bead that changes line 5 of a nine-line file main already holds.
  function notesBead() {
    const repo = fixture();
    repo.write("main", "notes.md", lines());
    repo.rebase();
    repo.write("bead", "notes.md", lines({ 5: "the bead's line" }));
    return repo;
  }

  it(
    "keeps a review when main gains an edit beside the bead's lines, and drops the pin",
    () => {
      const repo = notesBead();
      repo.review(passedAt(repo.reviewHead()));
      expect(repo.refs("refs/reviewed")).toBe(`refs/reviewed/${id}`);
      repo.write("main", "notes.md", lines({ 3: "a neighbour's line" }));

      const result = repo.land();

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(repo.bead().status).toBe("closed");
      expect(repo.refs("refs/reviewed")).toBe("");
    },
    testTimeout,
  );

  it(
    "refuses the same neighbour's edit for a pass recorded against the whole diff",
    () => {
      const repo = notesBead();
      repo.review({ ...pass, "review.patch_id": repo.patchId() });
      repo.write("main", "notes.md", lines({ 3: "a neighbour's line" }));

      const result = repo.land();

      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain("the diff changed since review");
    },
    testTimeout,
  );

  it(
    "keeps a review when the builder rebases cleanly after it",
    () => {
      const repo = notesBead();
      repo.review(passedAt(repo.reviewHead()));
      repo.write("main", "notes.md", lines({ 3: "a neighbour's line" }));
      repo.rebase();

      const result = repo.land();

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(repo.bead().status).toBe("closed");
    },
    testTimeout,
  );

  it(
    "refuses the reviewed edit moved to an identical line elsewhere",
    () => {
      const repo = fixture();
      const same = { 2: "return false;", 7: "return false;" };
      repo.write("main", "notes.md", lines(same));
      repo.rebase();
      repo.write("bead", "notes.md", lines({ ...same, 2: "return true;" }));
      const reviewed = repo.reviewHead();
      repo.review(passedAt(reviewed));
      repo.amend("notes.md", lines({ ...same, 7: "return true;" }));

      const result = repo.land();

      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain(`differs from the reviewed commit ${reviewed}`);
      expect(repo.bead().status).toBe("in_progress");
    },
    testTimeout,
  );

  it(
    "refuses a commit added after the review",
    () => {
      const repo = fixture();
      repo.commit("docs: update fixture");
      const reviewed = repo.reviewHead();
      repo.review(passedAt(reviewed));
      repo.commit("docs: change after review");

      expectRefused(repo, repo.land(), `differs from the reviewed commit ${reviewed}`);
    },
    testTimeout,
  );

  it(
    "refuses when the reviewed commit conflicts with what main has since gained",
    () => {
      const repo = notesBead();
      const reviewed = repo.reviewHead();
      repo.review(passedAt(reviewed));
      repo.write("main", "notes.md", lines({ 5: "a neighbour took the same line" }));
      repo.amend("notes.md", lines({ 9: "the bead moved out of the way" }));

      const result = repo.land();

      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain(`${reviewed} no longer merges cleanly with main`);
    },
    testTimeout,
  );

  it(
    "keeps a review when only a generated watch fixture changes, and still runs the checks",
    () => {
      const repo = fixture();
      repo.commit("docs: update fixture");
      repo.review(passedAt(repo.reviewHead()));
      const head = repo.write("bead", "fixtures/watch/snapshot-calm.json", "{}\n");

      expectLanded(repo, repo.land(), head);
      expect(repo.checkRuns()).toBe(1);
    },
    testTimeout,
  );

  it(
    "refuses a review after a fixture no test regenerates changes",
    () => {
      const repo = fixture();
      repo.commit("docs: update fixture");
      const reviewed = repo.reviewHead();
      repo.review(passedAt(reviewed));
      repo.write("bead", "fixtures/watch/inspect-stations-legal-59d6895.json", "{}\n");

      expectRefused(repo, repo.land(), `differs from the reviewed commit ${reviewed}`);
    },
    testTimeout,
  );

  it.each([
    ["the bead's branch", branch],
    ["HEAD", "HEAD"],
    ["a short id", (head: string) => head.slice(0, 12)],
  ] as const)(
    "refuses a pass recorded against %s, which a later commit would move",
    (_name, recorded) => {
      const repo = fixture();
      const head = repo.commit("docs: update fixture");
      repo.review(passedAt(typeof recorded === "string" ? recorded : recorded(head)));

      expectRefused(repo, repo.land(), "review.head must be a full commit id");
    },
    testTimeout,
  );

  it(
    "refuses a submodule moved after the review, even where git is told to ignore submodules",
    () => {
      const repo = fixture();
      repo.write(
        "main",
        ".gitmodules",
        '[submodule "vendored"]\n\tpath = vendored\n\turl = ./vendored\n\tignore = all\n',
      );
      repo.gitlink("main", "vendored", repo.base);
      repo.rebase();
      repo.commit("docs: update fixture");
      const reviewed = repo.reviewHead();
      repo.review(passedAt(reviewed));
      repo.gitlink("bead", "vendored", reviewed);

      const result = repo.land();

      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain(`differs from the reviewed commit ${reviewed}`);
    },
    testTimeout,
  );

  it(
    "refuses a later commit even when a replacement object stands in for the reviewed tree",
    () => {
      const repo = fixture();
      repo.commit("docs: update fixture");
      const reviewed = repo.reviewHead();
      repo.review(passedAt(reviewed));
      const head = repo.commit("docs: change after review");
      repo.git(
        "replace",
        repo.git("rev-parse", `${reviewed}^{tree}`),
        repo.git("rev-parse", `${head}^{tree}`),
      );

      const result = repo.land();

      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain(`differs from the reviewed commit ${reviewed}`);
    },
    testTimeout,
  );

  it(
    "refuses a reviewed commit the repository does not hold",
    () => {
      const repo = fixture();
      repo.commit("docs: update fixture");
      repo.review(passedAt("0123456789abcdef0123456789abcdef01234567"));

      expectRefused(repo, repo.land(), "is not in this repository; review again");
    },
    testTimeout,
  );

  it(
    "refuses a pass that records neither a reviewed commit nor an id",
    () => {
      const repo = fixture();
      repo.commit("docs: update fixture");
      repo.review({ ...pass, "review.head": "", "review.patch_id": "" });

      expectRefused(repo, repo.land(), "review again");
    },
    testTimeout,
  );

  it(
    "refuses a review from the author's own provider",
    () => {
      const repo = fixture();
      repo.commit("docs: update fixture");
      repo.review({
        ...anthropicBuild,
        "review.verdict": "pass",
        "review.provider": "anthropic",
        "review.patch_id": repo.patchId(),
      });

      expectRefused(repo, repo.land(), "the reviewer's provider (anthropic) is the author's");
    },
    testTimeout,
  );

  it(
    "lands a matching review from a different provider and pushes it to origin",
    () => {
      const repo = fixture({ origin: true });
      const head = repo.commit("docs: update fixture");
      repo.review({
        ...anthropicBuild,
        "review.verdict": "pass",
        "review.provider": "openai",
        "review.patch_id": repo.patchId(),
      });

      expectLanded(repo, repo.land(), head);
      expect(repo.originMain()).toBe(head);
      expect(repo.landedCommits()).toBe(1);
    },
    testTimeout,
  );

  it(
    "pushes to the fixture origin whatever push URL or rewrite the caller's git config names",
    () => {
      const canary = outsideCanary();
      const repo = fixture({ origin: true });
      const head = repo.commit("docs: update fixture");

      const result = withInheritedEnv(
        {
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "remote.origin.pushurl",
          GIT_CONFIG_VALUE_0: canary.url,
          GIT_CONFIG_KEY_1: `url.${canary.url}.insteadOf`,
          GIT_CONFIG_VALUE_1: repo.originUrl,
        },
        () => repo.land(),
      );

      expectLanded(repo, result, head);
      expect(repo.originMain()).toBe(head);
      expect(canary.refs()).toBe("");
    },
    testTimeout,
  );

  it(
    "ignores an inherited bash function named git that pushes elsewhere",
    () => {
      const canary = outsideCanary();
      const repo = fixture({ origin: true });
      const head = repo.commit("docs: update fixture");

      const result = withInheritedEnv(
        {
          "BASH_FUNC_git%%": `() { if [ "$3" = push ]; then command git -C "$2" push --quiet '${canary.url}' main; else command git "$@"; fi; }`,
        },
        () => repo.land(),
      );

      expectLanded(repo, result, head);
      expect(repo.originMain()).toBe(head);
      expect(canary.refs()).toBe("");
    },
    testTimeout,
  );

  it(
    "ignores an inherited bash function named bd",
    () => {
      const canary = outsideCanary();
      const marker = join(canary.path, "bd-function-ran");
      const repo = fixture({ origin: true });
      const head = repo.commit("docs: update fixture");

      const result = withInheritedEnv(
        {
          "BASH_FUNC_bd%%": `() { echo ran >> '${toGitPath(marker)}'; command bd "$@"; }`,
        },
        () => repo.land(),
      );

      expectLanded(repo, result, head);
      expect(repo.originMain()).toBe(head);
      expect(existsSync(marker)).toBe(false);
    },
    testTimeout,
  );

  it(
    "keeps the bead open when the push fails, and a rerun finishes the same landing once",
    () => {
      const repo = fixture({ origin: true });
      const head = repo.commit("docs: update fixture");
      repo.rejectPushes(true);

      const failed = repo.land();

      expect(failed.error).toBeUndefined();
      expect(failed.status, failed.stdout + failed.stderr).toBe(1);
      expect(failed.stderr).toContain("the push failed");
      expect(failed.stderr).toContain(`rerun scripts/land ${id}`);
      expect(repo.main()).toBe(head);
      expect(repo.originMain()).toBe(repo.base);
      expect(repo.bead().status).toBe("in_progress");
      expect(repo.bead().metadata["land.sha"]).toBe(head);
      expect(repo.calls("close")).toEqual([]);
      expect(repo.calls("merge-slot release")).toHaveLength(1);
      expect(repo.checkRuns()).toBe(1);

      repo.rejectPushes(false);
      expectLanded(repo, repo.land(), head);
      expect(repo.originMain()).toBe(head);
      expect(repo.landedCommits()).toBe(1);
      expect(repo.calls("update")).toHaveLength(1);
      expect(repo.checkRuns()).toBe(1);
      expect(repo.calls("merge-slot release")).toHaveLength(2);
    },
    testTimeout,
  );
});

describe("landing through CI", () => {
  const landRef = `refs/heads/land/${id}`;
  const gone = "0".repeat(40);
  function withOrigin() {
    const repo = fixture({ origin: true });
    repo.recordPushes();
    return { repo, head: repo.commit("docs: update fixture") };
  }

  it(
    "pushes the commit to land/<id>, waits for its run, lands it and removes the branch",
    () => {
      const { repo, head } = withOrigin();
      repo.ci([], 1);
      repo.ci([], 2);
      repo.ci([run("in_progress", "")], 3);
      repo.ci([run("completed", "success")]);

      expectLanded(repo, repo.land(), head);
      expect(repo.originMain()).toBe(head);
      expect(repo.pushed()).toEqual([
        `${landRef} ${head}`,
        `refs/heads/main ${head}`,
        `${landRef} ${gone}`,
      ]);
      expect(repo.checks()).toEqual(["ran --quick"]);
      expect(repo.ghCalls("run list")).toHaveLength(4);
      expect(repo.ghCalls("run list")[0]).toContain(`--commit ${head}`);
      expect(repo.ghCalls("run rerun")).toEqual([]);
    },
    testTimeout,
  );

  it(
    "lands on a run the bead's own branch already passed, without a land branch",
    () => {
      const { repo, head } = withOrigin();

      expectLanded(repo, repo.land(), head);
      expect(repo.pushed()).toEqual([`refs/heads/main ${head}`]);
      expect(repo.ghCalls("run list")).toHaveLength(1);
    },
    testTimeout,
  );

  it(
    "ignores a failed run from the bead's branch and gets its own",
    () => {
      const { repo, head } = withOrigin();
      repo.ci([run("completed", "failure", branch)], 1);
      repo.ci([run("completed", "failure", branch), run("completed", "success")]);

      expectLanded(repo, repo.land(), head);
      expect(repo.pushed()[0]).toBe(`${landRef} ${head}`);
      expect(repo.ghCalls("run rerun")).toEqual([]);
    },
    testTimeout,
  );

  it(
    "reruns a failed run's failed jobs once, and lands when they pass",
    () => {
      const { repo, head } = withOrigin();
      repo.ci([], 1);
      repo.ci([run("completed", "failure")], 2);
      repo.ci([run("completed", "failure")], 3);
      repo.ci([run("queued", "", undefined, 2)], 4);
      repo.ci([run("completed", "success", undefined, 2)]);

      expectLanded(repo, repo.land(), head);
      expect(repo.ghCalls("run rerun")).toEqual(["run rerun 7 --failed"]);
      expect(repo.ghCalls("run list")).toHaveLength(5);
    },
    testTimeout,
  );

  it(
    "refuses after a second failure, leaving main alone and the land branch removed",
    () => {
      const { repo, head } = withOrigin();
      repo.ci([], 1);
      repo.ci([run("completed", "failure")], 2);
      repo.ci([run("completed", "failure", undefined, 2)]);

      const result = repo.land();

      expectRefused(repo, result, `CI failed twice on ${head}: https://ci.example.test/runs/7`);
      expect(repo.originMain()).toBe(repo.base);
      expect(repo.ghCalls("run rerun")).toEqual(["run rerun 7 --failed"]);
      expect(repo.pushed()).toEqual([`${landRef} ${head}`, `${landRef} ${gone}`]);
      expect(repo.calls("merge-slot release")).toHaveLength(1);
    },
    testTimeout,
  );

  it(
    "adopts the land branch an interrupted landing left, and removes it",
    () => {
      const { repo, head } = withOrigin();
      repo.git("push", "--quiet", "origin", `${head}:${landRef}`);
      repo.ci([run("completed", "success")]);
      expect(repo.originRefs()).toContain(landRef);

      expectLanded(repo, repo.land(), head);
      expect(repo.originRefs()).not.toContain(landRef);
    },
    testTimeout,
  );

  it(
    "replaces a leftover land branch that points at an older commit",
    () => {
      const { repo, head } = withOrigin();
      repo.git("push", "--quiet", "origin", `${repo.base}:${landRef}`);
      repo.ci([], 1);
      repo.ci([run("completed", "success")]);

      expectLanded(repo, repo.land(), head);
      expect(repo.pushed()).toContain(`${landRef} ${head}`);
      expect(repo.originRefs()).not.toContain(landRef);
    },
    testTimeout,
  );

  it(
    "recreates a leftover land branch that already points at this commit but has no run",
    () => {
      const { repo, head } = withOrigin();
      repo.git("push", "--quiet", "origin", `${head}:${landRef}`);
      repo.ci([], 1);
      repo.ci([run("completed", "success")]);

      expectLanded(repo, repo.land(), head);
      expect(repo.pushed()).toEqual([
        `${landRef} ${head}`,
        `${landRef} ${gone}`,
        `${landRef} ${head}`,
        `refs/heads/main ${head}`,
        `${landRef} ${gone}`,
      ]);
    },
    testTimeout,
  );

  it(
    "refuses a run that does not finish by the deadline",
    () => {
      const { repo, head } = withOrigin();
      repo.ci([run("in_progress", "", branch)]);

      const result = repo.land({ SPI_LAND_CI_TIMEOUT: "0" });

      expectRefused(repo, result, `CI did not finish on ${head} within 0s`);
      expect(repo.pushed()).toEqual([]);
    },
    testTimeout,
  );

  it(
    "refuses before asking CI when the review does not hold",
    () => {
      const { repo } = withOrigin();
      repo.review({ "build.provider": "anthropic" });

      expectRefused(repo, repo.land(), "has no passing review");
      expect(repo.ghCalls("run")).toEqual([]);
    },
    testTimeout,
  );

  it(
    "runs the whole check here and asks CI nothing when there is no remote",
    () => {
      const repo = fixture();
      const head = repo.commit("docs: update fixture");

      expectLanded(repo, repo.land(), head);
      expect(repo.checks()).toEqual(["ran "]);
      expect(repo.ghCalls("run")).toEqual([]);
    },
    testTimeout,
  );

  it(
    "runs the whole check here, asks CI nothing and says so under SPI_LAND_LOCAL",
    () => {
      const { repo, head } = withOrigin();

      const result = repo.land({ SPI_LAND_LOCAL: "1" });

      expectLanded(repo, result, head);
      expect(result.stdout).toContain("checked on this machine only");
      expect(repo.checks()).toEqual(["ran "]);
      expect(repo.ghCalls("run")).toEqual([]);
      expect(repo.pushed()).toEqual([`refs/heads/main ${head}`]);
    },
    testTimeout,
  );
});

describe("queueing for the merge slot", () => {
  it(
    "--wait keeps asking until the slot frees, then lands",
    () => {
      const repo = fixture();
      const head = repo.commit("docs: update fixture");
      repo.holdSlot("land:spicode-other:1");
      repo.slotFreesAfter(2);

      expectLanded(repo, repo.land({}, "--wait"), head);
      expect(repo.calls("merge-slot acquire")).toHaveLength(3);
    },
    testTimeout,
  );

  it(
    "--wait shows an error from bd at once instead of waiting on it",
    () => {
      const repo = fixture();
      repo.commit("docs: update fixture");
      repo.slotError("Error: database is locked");

      const result = repo.land({}, "--wait");

      expectRefused(repo, result, "cannot take the merge slot: Error: database is locked");
      expect(repo.calls("merge-slot acquire")).toHaveLength(1);
    },
    testTimeout,
  );

  it(
    "--wait gives up at its deadline without touching the other lander's slot",
    () => {
      const repo = fixture();
      repo.commit("docs: update fixture");
      repo.holdSlot("land:spicode-other:1");

      const result = repo.land({ SPI_LAND_SLOT_TIMEOUT: "0" }, "--wait");

      expectRefused(repo, result, "the merge slot is still held after 0s");
      expect(repo.calls("merge-slot release")).toEqual([]);
    },
    testTimeout,
  );
});
