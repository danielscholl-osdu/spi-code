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
import { join, sep } from "node:path";
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
const directories: string[] = [];
let template = "";
let base = "";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
// Git may run with safe.bareRepository=explicit, so name the bare origin outright.
const bareGit = (gitDir: string, ...args: string[]) =>
  execFileSync("git", ["--git-dir", gitDir, ...args], { encoding: "utf8" }).trim();

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

function buildTemplate() {
  const directory = temporaryDirectory("spi-code-land-template-");
  const root = join(directory, "main");
  const bin = join(directory, "bin");
  const state = join(directory, "state");
  mkdirSync(root);
  mkdirSync(bin);
  mkdirSync(state);
  git(root, "init", "--quiet", "--template=", "-b", "main");
  git(root, "config", "user.name", "Fixture Builder");
  git(root, "config", "user.email", "fixture@example.test");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.hooksPath", "/dev/null");
  mkdirSync(join(root, "scripts"));
  copyFileSync(landSource, join(root, "scripts/land"));
  writeFileSync(
    join(root, "scripts/check"),
    '#!/bin/sh\necho ran >> "$LAND_FIXTURE_STATE/checks.log"\n',
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
  const root = join(directory, "main");
  const worktree = join(directory, "bead");
  const bin = join(directory, "bin");
  const state = join(directory, "state");
  const remote = join(directory, "origin");
  relocate(directory);
  if (origin) {
    git(directory, "clone", "--quiet", "--bare", "--template=", root, remote);
    mkdirSync(join(remote, "hooks"));
    bareGit(remote, "config", "core.hooksPath", toGitPath(join(remote, "hooks")));
    git(root, "remote", "add", "origin", toGitPath(remote));
  }
  const beadFile = join(state, "bead.json");
  const readBead = (): Bead => JSON.parse(readFileSync(beadFile, "utf8"));
  const writeBead = (bead: Bead) => writeFileSync(beadFile, JSON.stringify(bead));
  let changes = 0;
  return {
    base,
    branch,
    commit(message: string) {
      writeFileSync(join(worktree, "change.md"), `Change ${++changes}\n`);
      git(worktree, "commit", "--quiet", "--all", "-m", `${message}\nBead: ${id}`);
      return git(worktree, "rev-parse", "HEAD");
    },
    main: () => git(root, "rev-parse", "main"),
    originMain: () => bareGit(remote, "rev-parse", "main"),
    landedCommits: () => Number(git(root, "rev-list", "--count", `${base}..main`)),
    bead: readBead,
    // Records the review bead-review would: labels cleared and the given metadata merged in.
    review(metadata: Record<string, string>) {
      const bead = readBead();
      writeBead({ ...bead, labels: [], metadata: { ...bead.metadata, ...metadata } });
    },
    patchId() {
      const diff = execFileSync("git", [
        "-C",
        root,
        "diff",
        base,
        git(worktree, "rev-parse", "HEAD"),
      ]);
      const [patch = ""] = execFileSync("git", ["-C", root, "patch-id", "--verbatim"], {
        input: diff,
        encoding: "utf8",
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
    land: () =>
      spawnSync("bash", ["scripts/land", id], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          LAND_FIXTURE_STATE: toGitPath(state),
        },
        timeout: landTimeout,
      }),
  };
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
    const commonDir = git(
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
