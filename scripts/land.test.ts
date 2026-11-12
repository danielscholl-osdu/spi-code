// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { chmodSync, cpSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  directories,
  expectLanded,
  expectRefused,
  fixture,
  id,
  pointers,
  relocate,
  resolved,
  retarget,
  templateDirectory,
  temporaryDirectory,
  testTimeout,
  toGitPath,
  useLandFixtures,
} from "./land-fixture.js";

useLandFixtures();

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
    cpSync(templateDirectory(), directory, { recursive: true });
    relocate(directory);

    const { commonDir, worktrees } = resolved(directory);

    expect(commonDir).toBe(realpathSync.native(join(directory, "main", ".git")));
    expect(commonDir.startsWith(templateDirectory() + sep)).toBe(false);
    expect(worktrees).toContain(realpathSync.native(join(directory, "bead")));
    expect(worktrees.every((path) => path.startsWith(directory + sep) || path === directory)).toBe(
      true,
    );
  });

  it.skipIf(process.platform === "win32")(
    "replaces pointers it cannot open for overwrite, and round-trips them",
    () => {
      const directory = temporaryDirectory("spi-code-land-");
      directories.push(directory);
      cpSync(templateDirectory(), directory, { recursive: true });
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

// Cases in a file run in order, so the second reads what the first would have leaked.
describe("fixture isolation", () => {
  const untouched = () => ({
    calls: readFileSync(join(templateDirectory(), "state", "calls.log"), "utf8"),
    bead: JSON.parse(readFileSync(join(templateDirectory(), "state", "bead.json"), "utf8")),
  });

  it(
    "lets a landing change only its own copy",
    () => {
      const repo = fixture({ origin: true });
      repo.commit("docs: update fixture");
      const head = repo.commit("docs: update fixture again");
      repo.reviewHead();

      expectLanded(repo, repo.land(), head);
      expect(repo.originMain()).toBe(head);
      expect(repo.checks()).toEqual(["ran --static"]);
      expect(untouched().calls).toBe("");
    },
    testTimeout,
  );

  it(
    "starts the next case from the untouched template",
    () => {
      const repo = fixture();

      expect(repo.main()).toBe(repo.base);
      expect(repo.git("rev-list", "--all")).toBe(repo.base);
      expect(repo.refs("refs/")).toBe(`refs/heads/${repo.branch}\nrefs/heads/main`);
      expect(repo.git("remote")).toBe("");
      expect(repo.bead()).toEqual(untouched().bead);
      expect(repo.bead()).toMatchObject({ status: "in_progress", labels: ["review:exempt"] });
      expect(readFileSync(join(repo.directory, "state", "calls.log"), "utf8")).toBe("");
      expect(readFileSync(join(repo.directory, "state", "gh.log"), "utf8")).toBe("");
      expect(repo.checks()).toEqual([]);
      expect(existsSync(join(repo.directory, "origin"))).toBe(false);
    },
    testTimeout,
  );
});

describe("landing commit attribution", () => {
  const refused = [
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
  ];

  it.each(refused)(
    "refuses %s, identifies its commit and explains how to reword",
    (attribution) => {
      const repo = fixture();
      const offending = repo.commit(`docs: update fixture\n\n${attribution}`);
      // One case is enough to show the refusal names the offending commit, not the newest.
      if (attribution === refused[0]) repo.commit("docs: add a clean follow-up");

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

  it(
    "allows human or absent attribution in every commit, ignoring historical AI trailers",
    () => {
      const allowed = [
        "Co-authored-by: Ada Lovelace <ada@example.test>",
        "Co-authored-by: Human Contributor <12345+human@users.noreply.github.com>",
        "Co-authored-by: Elena Musetti <elena@example.test>",
        "Co-authored-by: Ada Lovelace <ada@example.test>\nCo-authored-by: Grace Hopper <grace@example.test>",
        "Co-authored-by : Ada Lovelace\n  <ada@example.test>",
        "Co-authored-by: Ada Lovelace <ada@gpt-labs.example>",
        "snapshots regenerated with vitest",
        "lockfile is generated with pnpm",
        "",
      ];
      const repo = fixture();
      const commits = allowed.map((attribution) =>
        repo.commit(`docs: update fixture\n\n${attribution}`),
      );

      const result = repo.land();

      const refusedAt = commits.findIndex((commit) => result.stderr.includes(commit));
      expect(refusedAt === -1 ? undefined : allowed[refusedAt]).toBeUndefined();
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("landed as");
      expect(repo.main()).toBe(commits.at(-1));
      expect(repo.landedCommits()).toBe(allowed.length);
    },
    testTimeout,
  );
});

describe("landing gates", () => {
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
