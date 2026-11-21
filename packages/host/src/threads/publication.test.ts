// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Exec, ExecOptions, ExecResult } from "@spi-code/core";
import type { ThreadDefinition } from "@spi-code/threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PrivilegedGit, type PushResult } from "../scopes/git.js";
import { ScopeRegistry } from "../scopes/registry.js";
import { spiReadTools } from "../tools/spi-reads.js";
import {
  observePublication,
  type PublicationGit,
  preparePublication,
  publishChanges,
} from "./publication.js";

const execFileAsync = promisify(execFile);

const BASE = "1".repeat(40);
const OBSERVED = "2".repeat(40);
const HEAD = "3".repeat(40);
const TOKEN = "fixture-glab-secret";
const GITHUB = "Azure/osdu-spi-partition";
const GITLAB = "osdu/platform/system/partition";
const GITLAB_HOST = "community.opengroup.org";

let root: string;
let forgeCwd: string;
let record: string;

type ForgeMode =
  | "direct"
  | "fork"
  | "none"
  | "token"
  | "unparsed"
  | "timeout"
  | "bad-url"
  | "spoof-fork"
  | "source-fork";

class ForgeExec implements Exec {
  private created = false;

  constructor(readonly mode: ForgeMode) {}

  async runJSON<T = unknown>(
    cmd: string,
    args: string[],
    opts: ExecOptions = {},
  ): Promise<ExecResult<T>> {
    this.record(cmd, args, opts);
    if (cmd === "gh" && args[0] === "pr" && args[1] === "list")
      return {
        ok: true,
        data: (this.created
          ? [
              {
                url: `https://github.com/${GITHUB}/pull/42`,
                number: 42,
                isCrossRepository: false,
                headRepositoryOwner: { login: "Azure" },
              },
            ]
          : []) as T,
        exitCode: 0,
      };
    if (cmd === "glab" && args[0] === "mr" && args[1] === "list")
      return {
        ok: true,
        data: (this.created
          ? [
              {
                web_url: `https://${GITLAB_HOST}/${GITLAB}/-/merge_requests/73`,
                iid: 73,
                source_project_id:
                  this.mode === "fork" || this.mode === "source-fork" || this.mode === "spoof-fork"
                    ? 102
                    : 101,
              },
            ]
          : []) as T,
        exitCode: 0,
      };
    if (cmd !== "glab" || args[0] !== "api" || !args.includes(`--hostname`))
      return { ok: false, error: "unexpected fixture JSON command", code: 2 };
    const endpoint = args[1] ?? "";
    if (endpoint.includes("/merge_requests/")) {
      return {
        ok: true,
        data: {
          source_branch: `spi/thread-request`,
          source_project_id: this.mode === "source-fork" ? 102 : 101,
        } as T,
        exitCode: 0,
      };
    }
    if (
      endpoint === "projects/101" ||
      (endpoint.startsWith("projects/") && !endpoint.includes("?"))
    ) {
      const sourceFork = endpoint === "projects/102";
      return {
        ok: true,
        data: {
          id: sourceFork ? 102 : 101,
          path_with_namespace: sourceFork ? "operator/partition" : GITLAB,
          web_url: `https://${GITLAB_HOST}/${sourceFork ? "operator/partition" : GITLAB}`,
          default_branch: "trunk",
          permissions: {
            project_access: {
              access_level:
                sourceFork || !["fork", "none", "source-fork", "spoof-fork"].includes(this.mode)
                  ? 40
                  : 10,
            },
          },
          ...(sourceFork ? { forked_from_project: { path_with_namespace: GITLAB } } : {}),
        } as T,
        exitCode: 0,
      };
    }
    return {
      ok: true,
      data: (this.mode === "fork" || this.mode === "spoof-fork"
        ? [
            {
              id: 102,
              path_with_namespace: "operator/partition",
              web_url:
                this.mode === "spoof-fork"
                  ? `https://${GITLAB_HOST}@evil.example.invalid/operator/partition`
                  : `https://${GITLAB_HOST}/operator/partition`,
              forked_from_project: { path_with_namespace: GITLAB },
            },
          ]
        : []) as T,
      exitCode: 0,
    };
  }

  async runText(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult<string>> {
    this.record(cmd, args, opts);
    if (cmd === "gh" && args[0] === "pr" && args[1] === "create") {
      this.created = true;
      if (this.mode === "timeout")
        return { ok: false, error: "Command timed out after 30000ms.", code: null };
      return {
        ok: true,
        data:
          this.mode === "unparsed"
            ? "created, see the web UI"
            : `https://github.com/${GITHUB}/pull/42`,
        exitCode: 0,
      };
    }
    if (cmd === "glab" && args[0] === "mr" && args[1] === "create") {
      this.created = true;
      if (args.includes("--source-project"))
        return { ok: false, error: "unknown flag: --source-project", code: 2 };
      if (!args.includes("--head")) return { ok: false, error: "missing --head", code: 2 };
      if (this.mode === "token") return { ok: false, error: "<redacted>", code: 1 };
      return {
        ok: true,
        data:
          this.mode === "bad-url"
            ? `https://user:${TOKEN}@evil.example.invalid/${GITLAB}/-/merge_requests/7`
            : this.mode === "unparsed"
              ? "created, see the web UI"
              : `https://${GITLAB_HOST}/${GITLAB}/-/merge_requests/73`,
        exitCode: 0,
      };
    }
    return { ok: false, error: "unexpected fixture command", code: 2 };
  }

  private record(cmd: string, args: string[], opts: ExecOptions) {
    if (opts.cwd !== forgeCwd)
      throw new Error(`Forge fixture ran outside its host directory: ${opts.cwd ?? "none"}`);
    appendFileSync(record, `${cmd} ${JSON.stringify(args)}\n`);
  }
}

class ListedRequestExec extends ForgeExec {
  constructor(
    mode: ForgeMode,
    readonly ownership: "own" | "foreign" | "foreign-own",
  ) {
    super(mode);
  }

  override async runJSON<T = unknown>(
    cmd: string,
    args: string[],
    opts: ExecOptions = {},
  ): Promise<ExecResult<T>> {
    if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
      appendFileSync(record, `${cmd} ${JSON.stringify(args)}\n`);
      const owners = this.ownership === "foreign-own" ? ["foreign", "own"] : [this.ownership];
      return {
        ok: true,
        data: owners.map((ownership, index) => ({
          url: `https://github.com/${GITHUB}/pull/${666 + index}`,
          number: 666 + index,
          isCrossRepository: ownership === "foreign",
          headRepositoryOwner: {
            login: ownership === "foreign" ? "stranger" : "Azure",
          },
        })) as T,
        exitCode: 0,
      };
    }
    if (cmd === "glab" && args[0] === "mr" && args[1] === "list") {
      appendFileSync(record, `${cmd} ${JSON.stringify(args)}\n`);
      const owners = this.ownership === "foreign-own" ? ["foreign", "own"] : [this.ownership];
      return {
        ok: true,
        data: owners.map((ownership, index) => ({
          web_url: `https://${GITLAB_HOST}/${GITLAB}/-/merge_requests/${666 + index}`,
          iid: 666 + index,
          source_project_id: ownership === "foreign" ? 999 : 102,
        })) as T,
        exitCode: 0,
      };
    }
    return super.runJSON<T>(cmd, args, opts);
  }
}

function forge(mode: ForgeMode = "direct"): Exec {
  return new ForgeExec(mode);
}

function gitTarget() {
  return { clone: join(root, "clone"), worktree: { id: "thread-1", cwd: root } } as const;
}

function runner({
  remote = null,
  pushResult = { ok: true, data: "pushed" },
  paths = [],
  changedPathsError,
}: {
  remote?: string | null;
  pushResult?: PushResult;
  paths?: string[];
  changedPathsError?: string;
} = {}) {
  const calls = {
    remote: [] as { remote: string; url: string }[],
    push: [] as Parameters<PrivilegedGit["push"]>[1][],
    ranges: [] as { from: string; to: string }[],
  };
  const git: PublicationGit = {
    statusAll: async () => ({ ok: true, data: "" }),
    numstat: async () => ({ ok: true, data: "" }),
    ahead: async () => ({ ok: true, data: "1\n" }),
    head: async () => ({ ok: true, data: `${HEAD}\n` }),
    hashFiles: async () => {
      throw new Error("No new file should be read");
    },
    blob: async () => ({ ok: true, data: "" }),
    diff: async () => ({ ok: true, data: "" }),
    diffBlob: async () => ({ ok: true, data: "" }),
    addRemote: async (_target, remoteName, url) => {
      calls.remote.push({ remote: remoteName, url });
      return { ok: true, data: url };
    },
    changedPaths: async (_target, from, to) => {
      calls.ranges.push({ from, to });
      return changedPathsError
        ? { ok: false, error: changedPathsError, code: 128 }
        : { ok: true, data: paths };
    },
    remoteHead: async () => ({ ok: true, data: remote }),
    push: async (_target, request) => {
      calls.push.push(request);
      return pushResult;
    },
  };
  return { git, calls };
}

function landing(
  target: "fork-main" | "fork-integration" | "upstream" | "request",
  branch = `spi/thread-${target}`,
): ThreadDefinition {
  const common = { branch, baseRef: "refs/remotes/origin/main", worktree: "fixture", head: BASE };
  return {
    scope: "partition",
    title: "Retry the port",
    landsIn:
      target === "request"
        ? {
            ...common,
            target,
            forge: "github",
            repository: GITHUB,
            requestNumber: 8,
            sourceBranch: branch,
          }
        : { ...common, target },
  };
}

function gitlabRequest(): ThreadDefinition {
  const base = landing("request");
  if (base.landsIn?.target !== "request") throw new Error("Expected a request landing");
  return {
    ...base,
    landsIn: {
      ...base.landsIn,
      forge: "gitlab",
      repository: GITLAB,
      requestNumber: 8,
      sourceBranch: base.landsIn.branch,
      head: BASE,
    },
  };
}

function branchOf(thread: ThreadDefinition): string {
  if (!thread.landsIn || thread.landsIn.target === "asking") throw new Error("No branch");
  return thread.landsIn.branch;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "spi-publication-"));
  forgeCwd = join(root, "forge");
  record = join(root, "commands.txt");
  await mkdir(forgeCwd, { recursive: true });
  writeFileSync(record, "");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("publication destinations", () => {
  it.each([
    ["fork-main" as const, "main", "origin"],
    ["fork-integration" as const, "fork_integration", "origin"],
  ])("pushes %s with the recorded GitHub draft command", async (target, base, remote) => {
    const exec = forge("direct");
    const scope = new ScopeRegistry().lookup("partition");
    if (!scope) throw new Error("Missing partition");
    const thread = landing(target);
    const prepared = await preparePublication(exec, scope, thread, forgeCwd);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.publication));
    const { git, calls } = runner();
    const result = await publishChanges(
      exec,
      git,
      gitTarget(),
      "thread-1",
      thread.title,
      BASE,
      HEAD,
      null,
      prepared,
      forgeCwd,
    );
    expect(result.publication).toMatchObject({
      outcome: "published",
      head: HEAD,
      request: { forge: "github", requestNumber: 42 },
    });
    expect(calls.push).toEqual([
      {
        remote,
        source: HEAD,
        destination: `refs/heads/${branchOf(thread)}`,
        expectedHead: null,
      },
    ]);
    const commands = await readFile(record, "utf8");
    expect(commands).toContain(
      `"--repo","${GITHUB}","--head","${branchOf(thread)}","--base","${base}","--draft"`,
    );
    expect(commands).not.toMatch(/\bauth\b/u);
  });

  it("pushes an existing request branch without opening another request", async () => {
    const exec = forge("direct");
    const scope = new ScopeRegistry().lookup("partition");
    if (!scope) throw new Error("Missing partition");
    const thread = landing("request");
    const prepared = await preparePublication(exec, scope, thread, forgeCwd);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.publication));
    const { git, calls } = runner({ remote: BASE });
    const result = await publishChanges(
      exec,
      git,
      gitTarget(),
      "thread-1",
      thread.title,
      BASE,
      HEAD,
      BASE,
      prepared,
      forgeCwd,
    );
    expect(result.publication).toMatchObject({ outcome: "pushed", head: HEAD });
    expect(calls.push[0]).toEqual({
      remote: "origin",
      source: HEAD,
      destination: `refs/heads/${branchOf(thread)}`,
      expectedHead: BASE,
    });
    await expect(readFile(record, "utf8").catch(() => "")).resolves.not.toContain("pr create");
  });

  it("pushes a newly created request again without opening a duplicate", async () => {
    const exec = forge("direct");
    const scope = new ScopeRegistry().lookup("partition");
    if (!scope) throw new Error("Missing partition");
    const thread: ThreadDefinition = {
      ...landing("fork-main"),
      pushedHead: BASE,
      request: {
        forge: "github",
        repository: GITHUB,
        requestNumber: 42,
        url: `https://github.com/${GITHUB}/pull/42`,
      },
    };
    const prepared = await preparePublication(exec, scope, thread, forgeCwd);
    if (!prepared.ok) throw new Error("Expected ready");
    expect(prepared.publication.opens).toBe("none");
    const { git } = runner({ remote: BASE });
    await expect(
      publishChanges(
        exec,
        git,
        gitTarget(),
        "thread-1",
        undefined,
        BASE,
        HEAD,
        BASE,
        prepared,
        forgeCwd,
      ),
    ).resolves.toMatchObject({ publication: { outcome: "pushed", head: HEAD } });
    await expect(readFile(record, "utf8").catch(() => "")).resolves.not.toContain("pr create");
  });

  it.each(["direct", "fork"] as const)(
    "pushes upstream through %s access and opens the recorded draft merge request",
    async (mode) => {
      const exec = forge(mode);
      const scope = new ScopeRegistry().lookup("partition");
      if (!scope) throw new Error("Missing partition");
      const thread = landing("upstream");
      const prepared = await preparePublication(exec, scope, thread, forgeCwd);
      if (!prepared.ok) throw new Error(JSON.stringify(prepared.publication));
      const { git, calls } = runner();
      await expect(
        publishChanges(
          exec,
          git,
          gitTarget(),
          "thread-1",
          thread.title,
          BASE,
          HEAD,
          null,
          prepared,
          forgeCwd,
        ),
      ).resolves.toMatchObject({
        publication: {
          outcome: "published",
          request: { forge: "gitlab", requestNumber: 73 },
        },
      });
      expect(calls.push[0]?.remote).toBe(mode === "direct" ? "upstream" : "operator");
      expect(calls.remote).toEqual(
        mode === "fork"
          ? [
              {
                remote: "operator",
                url: `https://${GITLAB_HOST}/operator/partition.git`,
              },
            ]
          : [],
      );
      const commands = await readFile(record, "utf8");
      expect(commands).toContain(
        `"mr","create","--repo","https://${GITLAB_HOST}/${GITLAB}","--head","${
          mode === "direct" ? GITLAB : "operator/partition"
        }"`,
      );
      expect(commands).toContain(`"--target-branch","trunk","--draft"`);
      expect(commands).not.toMatch(/\bauth\b/u);
    },
  );

  it.each([
    ["fork-main" as const, "direct" as const],
    ["upstream" as const, "fork" as const],
  ])("does not adopt a stranger's %s request for the same branch name", async (target, mode) => {
    const scope = new ScopeRegistry().lookup("partition");
    if (!scope) throw new Error("Missing partition");
    const exec = new ListedRequestExec(mode, "foreign");
    const prepared = await preparePublication(exec, scope, landing(target), forgeCwd);
    if (!prepared.ok) throw new Error("Expected ready");
    const { git } = runner();
    const result = await publishChanges(
      exec,
      git,
      gitTarget(),
      "thread-1",
      undefined,
      BASE,
      HEAD,
      null,
      prepared,
      forgeCwd,
    );
    expect(result.publication).toMatchObject({ outcome: "not known" });
    expect(result).not.toHaveProperty("request");
    expect(await readFile(record, "utf8")).not.toMatch(/pr create|mr create/u);
  });

  it.each([
    ["fork-main" as const, "direct" as const],
    ["upstream" as const, "fork" as const],
  ])("adopts %s's own request from the branch lookup", async (target, mode) => {
    const scope = new ScopeRegistry().lookup("partition");
    if (!scope) throw new Error("Missing partition");
    const exec = new ListedRequestExec(mode, "own");
    const prepared = await preparePublication(exec, scope, landing(target), forgeCwd);
    if (!prepared.ok) throw new Error("Expected ready");
    const { git } = runner();
    await expect(
      publishChanges(
        exec,
        git,
        gitTarget(),
        "thread-1",
        undefined,
        BASE,
        HEAD,
        null,
        prepared,
        forgeCwd,
      ),
    ).resolves.toMatchObject({
      publication: { outcome: "published", request: { requestNumber: 666 } },
      request: { requestNumber: 666 },
    });
    const commands = await readFile(record, "utf8");
    if (target === "fork-main")
      expect(commands).toContain('"--json","url,number,isCrossRepository,headRepositoryOwner"');
    expect(commands).not.toMatch(/pr create|mr create/u);
  });

  it.each([
    ["fork-main" as const, "direct" as const],
    ["upstream" as const, "fork" as const],
  ])("skips a stranger and adopts %s's own request later in the lookup", async (target, mode) => {
    const scope = new ScopeRegistry().lookup("partition");
    if (!scope) throw new Error("Missing partition");
    const exec = new ListedRequestExec(mode, "foreign-own");
    const prepared = await preparePublication(exec, scope, landing(target), forgeCwd);
    if (!prepared.ok) throw new Error("Expected ready");
    const { git } = runner();
    await expect(
      publishChanges(
        exec,
        git,
        gitTarget(),
        "thread-1",
        undefined,
        BASE,
        HEAD,
        null,
        prepared,
        forgeCwd,
      ),
    ).resolves.toMatchObject({
      publication: { outcome: "published", request: { requestNumber: 667 } },
      request: { requestNumber: 667 },
    });
    expect(await readFile(record, "utf8")).not.toMatch(/pr create|mr create/u);
  });

  it("runs every forge command from the host-owned empty directory", async () => {
    const scope = new ScopeRegistry().lookup("partition");
    if (!scope) throw new Error("Missing partition");
    const exec = forge("direct");
    const prepared = await preparePublication(exec, scope, landing("upstream"), forgeCwd);
    if (!prepared.ok) throw new Error("Expected ready");
    const { git } = runner();
    await publishChanges(
      exec,
      git,
      gitTarget(),
      "thread-1",
      undefined,
      BASE,
      HEAD,
      null,
      prepared,
      forgeCwd,
    );
    expect(await readFile(record, "utf8")).toContain(`glab ["api"`);
    expect(await readFile(record, "utf8")).not.toContain(gitTarget().worktree.cwd);
  });

  it.each(["direct", "fork"] as const)(
    "names the upstream host on GitLab API reads for %s access",
    async (mode) => {
      const scope = new ScopeRegistry().lookup("partition");
      if (!scope) throw new Error("Missing partition");
      await preparePublication(forge(mode), scope, landing("upstream"), forgeCwd);
      const commands = await readFile(record, "utf8");
      expect(commands).toContain(`"--hostname","${GITLAB_HOST}"`);
      for (const line of commands.split("\n").filter((line) => line.startsWith("glab [")))
        if (line.includes('"api"')) expect(line).toContain(`"--hostname","${GITLAB_HOST}"`);
    },
  );

  it("refuses an existing GitLab request whose source is upstream and cannot be pushed", async () => {
    const scope = new ScopeRegistry().lookup("partition");
    if (!scope) throw new Error("Missing partition");
    const prepared = await preparePublication(forge("fork"), scope, gitlabRequest(), forgeCwd);
    expect(prepared).toMatchObject({
      ok: false,
      publication: {
        state: "unavailable",
        reason: expect.stringContaining("source branch is in upstream"),
      },
    });
  });

  it("selects the operator remote for an existing request sourced from that GitLab fork", async () => {
    const scope = new ScopeRegistry().lookup("partition");
    if (!scope) throw new Error("Missing partition");
    const prepared = await preparePublication(
      forge("source-fork"),
      scope,
      gitlabRequest(),
      forgeCwd,
    );
    expect(prepared).toMatchObject({
      ok: true,
      publication: { remote: "operator", opens: "none" },
      sourceRepository: "operator/partition",
      remoteUrl: `https://${GITLAB_HOST}/operator/partition.git`,
    });
  });

  it.each(["unparsed", "timeout"] as const)(
    "adopts an existing request before retrying create after %s",
    async (mode) => {
      const scope = new ScopeRegistry().lookup("partition");
      if (!scope) throw new Error("Missing partition");
      const exec = forge(mode);
      const prepared = await preparePublication(exec, scope, landing("fork-main"), forgeCwd);
      if (!prepared.ok) throw new Error("Expected ready");
      const { git } = runner();
      await expect(
        publishChanges(
          exec,
          git,
          gitTarget(),
          "thread-1",
          undefined,
          BASE,
          HEAD,
          null,
          prepared,
          forgeCwd,
        ),
      ).resolves.toMatchObject({ publication: { outcome: "not known" } });
      await expect(
        publishChanges(
          exec,
          git,
          gitTarget(),
          "thread-1",
          undefined,
          BASE,
          HEAD,
          null,
          prepared,
          forgeCwd,
        ),
      ).resolves.toMatchObject({
        publication: {
          outcome: "published",
          request: { requestNumber: 42 },
        },
      });
      const commands = await readFile(record, "utf8");
      expect(commands.match(/"pr","list"/gu)).toHaveLength(2);
      expect(commands.match(/"pr","create"/gu)).toHaveLength(1);
    },
  );

  it("refuses a protected branch before any git or forge write", async () => {
    const exec = forge("direct");
    const scope = new ScopeRegistry().lookup("partition");
    if (!scope) throw new Error("Missing partition");
    for (const branch of ["main", "fork_integration"]) {
      const thread = landing("request", branch);
      await expect(preparePublication(exec, scope, thread, forgeCwd)).resolves.toMatchObject({
        ok: false,
        publication: { state: "unavailable", reason: expect.stringContaining("protected") },
      });
    }
    await expect(readFile(record, "utf8").catch(() => "")).resolves.toBe("");
  });

  it("names the missing upstream fork and runs no push or create", async () => {
    const exec = forge("none");
    const scope = new ScopeRegistry().lookup("partition");
    if (!scope) throw new Error("Missing partition");
    const prepared = await preparePublication(exec, scope, landing("upstream"), forgeCwd);
    expect(prepared).toMatchObject({
      ok: false,
      publication: {
        state: "unavailable",
        reason:
          "You cannot push to upstream, and your sign-in has no fork of it. SPI Code did not create one.",
        url: `https://${GITLAB_HOST}/${GITLAB}`,
      },
    });
    const commands = await readFile(record, "utf8");
    expect(commands).not.toMatch(/(?:push|\bmr\b.*create|\bpr\b.*create)/u);
  });

  it("rejects a GitLab fork URL whose host is spoofed", async () => {
    const scope = new ScopeRegistry().lookup("partition");
    if (!scope) throw new Error("Missing partition");
    await expect(
      preparePublication(forge("spoof-fork"), scope, landing("upstream"), forgeCwd),
    ).resolves.toMatchObject({
      ok: false,
      publication: { state: "unavailable", reason: expect.stringContaining("has no fork") },
    });
  });
});

describe("publication gates", () => {
  it("carries the remote head the Thread tab observed into a later fast-forward push", async () => {
    const scope = new ScopeRegistry().lookup("partition");
    if (!scope) throw new Error("Missing partition");
    const exec = forge("direct");
    const prepared = await preparePublication(exec, scope, landing("fork-main"), forgeCwd);
    if (!prepared.ok) throw new Error("Expected ready");
    const { git, calls } = runner({ remote: OBSERVED });
    await expect(observePublication(git, gitTarget(), prepared, BASE)).resolves.toEqual({
      ...prepared.publication,
      observedHead: OBSERVED,
    });
    await publishChanges(
      exec,
      git,
      gitTarget(),
      "thread-1",
      undefined,
      BASE,
      HEAD,
      OBSERVED,
      prepared,
      forgeCwd,
    );
    expect(calls.push).toEqual([expect.objectContaining({ expectedHead: OBSERVED })]);
  });

  it("refuses when the worktree head differs from the Thread tab's displayed head", async () => {
    const scope = new ScopeRegistry().lookup("partition");
    if (!scope) throw new Error("Missing partition");
    const exec = forge("direct");
    const prepared = await preparePublication(exec, scope, landing("fork-main"), forgeCwd);
    if (!prepared.ok) throw new Error("Expected ready");
    const { git, calls } = runner();
    await expect(
      publishChanges(
        exec,
        git,
        gitTarget(),
        "thread-1",
        undefined,
        BASE,
        OBSERVED,
        null,
        prepared,
        forgeCwd,
      ),
    ).resolves.toMatchObject({
      publication: { outcome: "refused", reason: expect.stringContaining("branch head moved") },
    });
    expect(calls.push).toEqual([]);
  });

  it("names a remote branch deleted when the Thread tab is first observed", async () => {
    const scope = new ScopeRegistry().lookup("partition");
    if (!scope) throw new Error("Missing partition");
    const thread = { ...landing("fork-main"), pushedHead: BASE };
    const prepared = await preparePublication(forge("direct"), scope, thread, forgeCwd);
    if (!prepared.ok) throw new Error("Expected ready");
    const { git } = runner();
    await expect(observePublication(git, gitTarget(), prepared, BASE)).resolves.toEqual({
      state: "unavailable",
      reason: "The remote branch was deleted. Update the thread's landing before pushing.",
    });
  });

  it("refuses a non-fast-forward remote without sending a branch", async () => {
    const exec = forge("direct");
    const scope = new ScopeRegistry().lookup("partition");
    if (!scope) throw new Error("Missing partition");
    const prepared = await preparePublication(exec, scope, landing("fork-main"), forgeCwd);
    if (!prepared.ok) throw new Error("Expected ready");
    const { git, calls } = runner({
      remote: OBSERVED,
      pushResult: {
        ok: false,
        error: "The expected remote head is not an ancestor of the source commit.",
        code: 1,
        ancestryRefused: true,
      },
    });
    await expect(
      publishChanges(
        exec,
        git,
        gitTarget(),
        "thread-1",
        undefined,
        BASE,
        HEAD,
        OBSERVED,
        prepared,
        forgeCwd,
      ),
    ).resolves.toMatchObject({
      publication: { outcome: "refused", reason: expect.stringContaining("not an ancestor") },
    });
    expect(calls.push).toEqual([expect.objectContaining({ expectedHead: OBSERVED, source: HEAD })]);
  });

  it.each([
    "Commit abc did not match its object id. Refusing to push.",
    "Commit abc is missing. Refusing to push.",
    "Object abc is not a commit. Refusing to push.",
    "The ancestry walk exceeded its commit limit.",
  ])("puts a verified ancestry refusal on the Thread tab: %s", async (reason) => {
    const exec = forge("direct");
    const scope = new ScopeRegistry().lookup("partition");
    if (!scope) throw new Error("Missing partition");
    const prepared = await preparePublication(exec, scope, landing("fork-main"), forgeCwd);
    if (!prepared.ok) throw new Error("Expected ready");
    const { git, calls } = runner({
      remote: OBSERVED,
      pushResult: { ok: false, error: reason, code: 1, ancestryRefused: true },
    });
    await expect(
      publishChanges(
        exec,
        git,
        gitTarget(),
        "thread-1",
        undefined,
        BASE,
        HEAD,
        OBSERVED,
        prepared,
        forgeCwd,
      ),
    ).resolves.toMatchObject({
      publication: { outcome: "refused", reason },
    });
    expect(calls.push).toEqual([expect.objectContaining({ expectedHead: OBSERVED, source: HEAD })]);
  });

  it("refuses a remote that moved after the thread last observed it", async () => {
    const exec = forge("direct");
    const scope = new ScopeRegistry().lookup("partition");
    if (!scope) throw new Error("Missing partition");
    const thread = {
      ...landing("fork-main"),
      pushedHead: BASE,
    };
    const prepared = await preparePublication(exec, scope, thread, forgeCwd);
    if (!prepared.ok) throw new Error("Expected ready");
    const { git, calls } = runner({ remote: OBSERVED });
    await expect(
      publishChanges(
        exec,
        git,
        gitTarget(),
        "thread-1",
        undefined,
        BASE,
        HEAD,
        BASE,
        prepared,
        forgeCwd,
      ),
    ).resolves.toMatchObject({
      publication: { outcome: "refused", reason: expect.stringContaining("moved") },
    });
    expect(calls.push).toEqual([]);
  });

  it("refuses an existing request whose branch moved past its landing head", async () => {
    const scope = new ScopeRegistry().lookup("partition");
    if (!scope) throw new Error("Missing partition");
    const exec = forge("direct");
    const prepared = await preparePublication(exec, scope, landing("request"), forgeCwd);
    if (!prepared.ok) throw new Error("Expected ready");
    const { git, calls } = runner({ remote: OBSERVED });
    await expect(
      publishChanges(
        exec,
        git,
        gitTarget(),
        "thread-1",
        undefined,
        BASE,
        HEAD,
        BASE,
        prepared,
        forgeCwd,
      ),
    ).resolves.toMatchObject({
      publication: { outcome: "refused", reason: expect.stringContaining("moved") },
    });
    expect(calls.push).toEqual([]);
  });

  it("names a remote branch deleted after the Thread tab observed it", async () => {
    const scope = new ScopeRegistry().lookup("partition");
    if (!scope) throw new Error("Missing partition");
    const exec = forge("direct");
    const prepared = await preparePublication(exec, scope, landing("fork-main"), forgeCwd);
    if (!prepared.ok) throw new Error("Expected ready");
    const { git, calls } = runner();
    await expect(
      publishChanges(
        exec,
        git,
        gitTarget(),
        "thread-1",
        undefined,
        BASE,
        HEAD,
        BASE,
        prepared,
        forgeCwd,
      ),
    ).resolves.toMatchObject({
      publication: { outcome: "refused", reason: expect.stringContaining("was deleted") },
    });
    expect(calls.push).toEqual([]);
  });

  it("refuses a protected upstream default even after a ready plan", async () => {
    const exec = forge("direct");
    const prepared = {
      ok: true as const,
      publication: {
        state: "ready" as const,
        remote: "upstream",
        branch: "trunk",
        base: "trunk",
        opens: "merge-request" as const,
      },
      repository: GITLAB,
      repositoryUrl: `https://${GITLAB_HOST}/${GITLAB}`,
      sourceRepository: GITLAB,
      base: "trunk",
      forgeHost: GITLAB_HOST,
    };
    const { git, calls } = runner();
    await expect(
      publishChanges(
        exec,
        git,
        gitTarget(),
        "thread-1",
        undefined,
        BASE,
        HEAD,
        null,
        prepared,
        forgeCwd,
      ),
    ).resolves.toMatchObject({ publication: { outcome: "refused" } });
    expect(calls.push).toEqual([]);
  });

  it("keeps credentials out of logs and the recorded failure", async () => {
    const scope = new ScopeRegistry().lookup("partition");
    if (!scope) throw new Error("Missing partition");
    const thread = landing("upstream");
    const prepared = await preparePublication(forge("direct"), scope, thread, forgeCwd);
    if (!prepared.ok) throw new Error("Expected ready");
    const exec = forge("token");
    const { git } = runner();
    const result = await publishChanges(
      exec,
      git,
      gitTarget(),
      "thread-1",
      thread.title,
      BASE,
      HEAD,
      null,
      prepared,
      forgeCwd,
    );
    const commands = await readFile(record, "utf8");
    const recorded = JSON.stringify({ result, commands });
    expect(recorded).not.toContain(TOKEN);
    expect(result.publication).toMatchObject({ outcome: "failed" });
  });

  it("rejects merge request URLs with another host or userinfo", async () => {
    const scope = new ScopeRegistry().lookup("partition");
    if (!scope) throw new Error("Missing partition");
    const exec = forge("bad-url");
    const prepared = await preparePublication(exec, scope, landing("upstream"), forgeCwd);
    if (!prepared.ok) throw new Error("Expected ready");
    const result = await publishChanges(
      exec,
      { ...runner().git, remoteHead: async () => ({ ok: true, data: null }) },
      gitTarget(),
      "thread-1",
      undefined,
      BASE,
      HEAD,
      null,
      prepared,
      forgeCwd,
    );
    expect(result.publication).toMatchObject({ outcome: "not known" });
    expect(result).not.toHaveProperty("request");
  });

  it("does not offer a publication or push tool to Copilot", () => {
    const tools = spiReadTools(() => undefined, { value: (value) => value });
    expect(tools.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(["thread.publish", "thread.push", "publish", "push_branch"]),
    );
    expect(JSON.stringify(tools.map(({ name }) => name))).not.toMatch(/publish|push/u);
  });
});

describe(".github/ push gate", () => {
  it("refuses an existing request push that changes .github/ until the request number matches", async () => {
    const scope = new ScopeRegistry().lookup("partition");
    if (!scope) throw new Error("Missing partition");
    const exec = forge("direct");
    const prepared = await preparePublication(exec, scope, landing("request"), forgeCwd);
    if (!prepared.ok) throw new Error("Expected ready");
    const { git, calls } = runner({
      remote: OBSERVED,
      paths: [".github/workflows/validate.yml", "src/app.ts"],
    });

    await expect(observePublication(git, gitTarget(), prepared, BASE)).resolves.toEqual({
      ...prepared.publication,
      observedHead: OBSERVED,
      githubConfirmation: { kind: "request", value: "8" },
    });
    expect(calls.ranges.at(-1)).toEqual({ from: OBSERVED, to: HEAD });

    for (const wrong of [undefined, "", "   ", "9", "#8", "main"]) {
      await expect(
        publishChanges(
          exec,
          git,
          gitTarget(),
          "thread-1",
          undefined,
          BASE,
          HEAD,
          OBSERVED,
          prepared,
          forgeCwd,
          wrong,
        ),
        `value=${String(wrong)}`,
      ).resolves.toMatchObject({
        publication: {
          outcome: "refused",
          reason: "This push changes .github/. Type request number 8 to confirm.",
        },
      });
    }
    expect(calls.push).toEqual([]);

    await expect(
      publishChanges(
        exec,
        git,
        gitTarget(),
        "thread-1",
        undefined,
        BASE,
        HEAD,
        OBSERVED,
        prepared,
        forgeCwd,
        " 8 ",
      ),
    ).resolves.toMatchObject({ publication: { outcome: "pushed", head: HEAD } });
    expect(calls.push).toHaveLength(1);
  });

  it("asks for the existing request number after a thread has already opened a draft PR", async () => {
    const scope = new ScopeRegistry().lookup("partition");
    if (!scope) throw new Error("Missing partition");
    const exec = forge("direct");
    const thread: ThreadDefinition = {
      ...landing("fork-main"),
      pushedHead: OBSERVED,
      request: {
        forge: "github",
        repository: GITHUB,
        requestNumber: 42,
        url: `https://github.com/${GITHUB}/pull/42`,
      },
    };
    const prepared = await preparePublication(exec, scope, thread, forgeCwd);
    if (!prepared.ok) throw new Error("Expected ready");
    const { git, calls } = runner({
      remote: OBSERVED,
      paths: [".github/CODEOWNERS"],
    });

    await expect(observePublication(git, gitTarget(), prepared, BASE)).resolves.toMatchObject({
      githubConfirmation: { kind: "request", value: "42" },
    });
    await expect(
      publishChanges(
        exec,
        git,
        gitTarget(),
        "thread-1",
        undefined,
        BASE,
        HEAD,
        OBSERVED,
        prepared,
        forgeCwd,
        "main",
      ),
    ).resolves.toMatchObject({
      publication: {
        outcome: "refused",
        reason: "This push changes .github/. Type request number 42 to confirm.",
      },
    });
    expect(calls.push).toEqual([]);
    await expect(
      publishChanges(
        exec,
        git,
        gitTarget(),
        "thread-1",
        undefined,
        BASE,
        HEAD,
        OBSERVED,
        prepared,
        forgeCwd,
        "42",
      ),
    ).resolves.toMatchObject({ publication: { outcome: "pushed", head: HEAD } });
    expect(calls.push).toHaveLength(1);
  });

  it.each([
    ["fork-main" as const, "main", "fork_integration"],
    ["fork-integration" as const, "fork_integration", "main"],
    ["upstream" as const, "trunk", "main"],
  ])(
    "refuses a new %s request touching .github/ until target branch %s matches",
    async (target, expectedBranch, wrongBranch) => {
      const scope = new ScopeRegistry().lookup("partition");
      if (!scope) throw new Error("Missing partition");
      const exec = forge("direct");
      const prepared = await preparePublication(exec, scope, landing(target), forgeCwd);
      if (!prepared.ok) throw new Error("Expected ready");
      const { git, calls } = runner({ paths: [".github/workflows/cascade.yml"] });

      await expect(observePublication(git, gitTarget(), prepared, BASE)).resolves.toEqual({
        ...prepared.publication,
        observedHead: null,
        githubConfirmation: { kind: "branch", value: expectedBranch },
      });
      expect(calls.ranges.at(-1)).toEqual({ from: BASE, to: HEAD });

      for (const wrong of [undefined, "", wrongBranch, expectedBranch.toUpperCase(), "8"]) {
        await expect(
          publishChanges(
            exec,
            git,
            gitTarget(),
            "thread-1",
            undefined,
            BASE,
            HEAD,
            null,
            prepared,
            forgeCwd,
            wrong,
          ),
          `value=${String(wrong)}`,
        ).resolves.toMatchObject({
          publication: {
            outcome: "refused",
            reason: `This push changes .github/. New requests have no number yet; type target branch ${expectedBranch} to confirm.`,
          },
        });
      }
      expect(calls.push).toEqual([]);

      await expect(
        publishChanges(
          exec,
          git,
          gitTarget(),
          "thread-1",
          undefined,
          BASE,
          HEAD,
          null,
          prepared,
          forgeCwd,
          expectedBranch,
        ),
      ).resolves.toMatchObject({ publication: { outcome: "published", head: HEAD } });
      expect(calls.push).toHaveLength(1);
    },
  );

  it("asks for nothing when the pushed range has no .github/ change", async () => {
    const scope = new ScopeRegistry().lookup("partition");
    if (!scope) throw new Error("Missing partition");
    const exec = forge("direct");
    const prepared = await preparePublication(exec, scope, landing("fork-main"), forgeCwd);
    if (!prepared.ok) throw new Error("Expected ready");
    const { git, calls } = runner({
      paths: ["src/index.ts", ".github-notes/readme.md", "docs/.github/guide.md"],
    });

    const observed = await observePublication(git, gitTarget(), prepared, BASE);
    expect(observed).toEqual({ ...prepared.publication, observedHead: null });
    expect(observed).not.toHaveProperty("githubConfirmation");

    await expect(
      publishChanges(
        exec,
        git,
        gitTarget(),
        "thread-1",
        undefined,
        BASE,
        HEAD,
        null,
        prepared,
        forgeCwd,
      ),
    ).resolves.toMatchObject({ publication: { outcome: "published", head: HEAD } });
    expect(calls.push).toHaveLength(1);
  });

  it("reports not read and refuses to push when the pushed range cannot be read", async () => {
    const scope = new ScopeRegistry().lookup("partition");
    if (!scope) throw new Error("Missing partition");
    const exec = forge("direct");
    const prepared = await preparePublication(exec, scope, landing("fork-main"), forgeCwd);
    if (!prepared.ok) throw new Error("Expected ready");
    const { git, calls } = runner({ changedPathsError: "fatal: bad object" });

    await expect(observePublication(git, gitTarget(), prepared, BASE)).resolves.toMatchObject({
      state: "not read",
      reason: expect.stringContaining("pushed range was not read"),
    });
    await expect(
      publishChanges(
        exec,
        git,
        gitTarget(),
        "thread-1",
        undefined,
        BASE,
        HEAD,
        null,
        prepared,
        forgeCwd,
        "main",
      ),
    ).resolves.toMatchObject({ publication: { outcome: "failed" } });
    expect(calls.push).toEqual([]);
  });

  it("gates a real-git rename moving a file out of .github/", async () => {
    const physical = await realpath(root);
    const capturedPath = process.env.PATH ?? process.env.Path ?? "";
    const runFixtureGit = async (cwd: string, ...args: string[]) => {
      const { stdout } = await execFileAsync("git", args, {
        cwd,
        windowsHide: true,
        env: {
          PATH: capturedPath,
          ...(process.platform === "win32"
            ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" }
            : {}),
          HOME: physical,
          USERPROFILE: physical,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: join(physical, "empty-config"),
          GIT_ALLOW_PROTOCOL: "file",
        },
      });
      return stdout.trim();
    };
    const id = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];
    const seed = join(physical, "seed");
    const origin = join(physical, "origin.git");
    const appData = join(physical, "app-data");
    await runFixtureGit(physical, "init", "--initial-branch", "main", seed);
    await mkdir(join(seed, ".github", "workflows"), { recursive: true });
    await writeFile(join(seed, ".github", "workflows", "ci.yml"), "name: CI\non: [push]\n");
    await runFixtureGit(seed, "add", "--", ".github/workflows/ci.yml");
    await runFixtureGit(seed, ...id, "commit", "-m", "Add workflow");
    const baseHead = await runFixtureGit(seed, "rev-parse", "HEAD");
    await runFixtureGit(physical, "clone", "--bare", seed, origin);

    const scope = new ScopeRegistry().lookup("partition");
    if (scope?.kind !== "service") throw new Error("Missing partition");
    const git = new PrivilegedGit({ appData, capturedPath, allowLocalRemotes: true });
    const cloneParent = join(await git.dataRoot(), "repos", "azure", "osdu-spi-partition");
    await mkdir(cloneParent, { recursive: true });
    const cloned = await git.clone(cloneParent, { origin: pathToFileURL(origin).href });
    if (!cloned.ok) throw new Error(cloned.error);
    const worktree = await git.addBranchWorktree(
      join(cloneParent, "checkout"),
      "thread-rename",
      "spi/rename-out",
      baseHead,
    );
    if (!worktree.ok) throw new Error(worktree.error);

    await mkdir(join(worktree.data.worktree.cwd, "scripts"), { recursive: true });
    await runFixtureGit(
      worktree.data.worktree.cwd,
      "mv",
      ".github/workflows/ci.yml",
      "scripts/ci.yml",
    );
    await runFixtureGit(worktree.data.worktree.cwd, ...id, "commit", "-m", "Move workflow out");
    const renamedHead = await runFixtureGit(worktree.data.worktree.cwd, "rev-parse", "HEAD");

    const exec = forge("direct");
    const thread = landing("fork-main", "spi/rename-out");
    const prepared = await preparePublication(exec, scope, thread, forgeCwd);
    if (!prepared.ok) throw new Error("Expected ready");

    await expect(observePublication(git, worktree.data, prepared, baseHead)).resolves.toMatchObject(
      {
        state: "ready",
        observedHead: null,
        githubConfirmation: { kind: "branch", value: "main" },
      },
    );

    await expect(
      publishChanges(
        exec,
        git,
        worktree.data,
        "thread-rename",
        thread.title,
        baseHead,
        renamedHead,
        null,
        prepared,
        forgeCwd,
      ),
    ).resolves.toMatchObject({
      publication: {
        outcome: "refused",
        reason: expect.stringContaining(".github/"),
      },
    });
    expect(await git.remoteHead(worktree.data, "origin", "spi/rename-out")).toEqual({
      ok: true,
      data: null,
    });

    await expect(
      publishChanges(
        exec,
        git,
        worktree.data,
        "thread-rename",
        thread.title,
        baseHead,
        renamedHead,
        null,
        prepared,
        forgeCwd,
        "main",
      ),
    ).resolves.toMatchObject({
      publication: { outcome: "published", head: renamedHead },
    });
    expect(await git.remoteHead(worktree.data, "origin", "spi/rename-out")).toEqual({
      ok: true,
      data: renamedHead,
    });
  }, 60_000);

  it("gates a real-git push adding .github/actions as a gitlink", async () => {
    const physical = await realpath(root);
    const capturedPath = process.env.PATH ?? process.env.Path ?? "";
    const runFixtureGit = async (cwd: string, ...args: string[]) => {
      const { stdout } = await execFileAsync("git", args, {
        cwd,
        windowsHide: true,
        env: {
          PATH: capturedPath,
          ...(process.platform === "win32"
            ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" }
            : {}),
          HOME: physical,
          USERPROFILE: physical,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: join(physical, "empty-config"),
          GIT_ALLOW_PROTOCOL: "file",
        },
      });
      return stdout.trim();
    };
    const id = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];
    const seed = join(physical, "seed-gitlink");
    const origin = join(physical, "origin-gitlink.git");
    const appData = join(physical, "app-data-gitlink");
    await runFixtureGit(physical, "init", "--initial-branch", "main", seed);
    await writeFile(join(seed, "README.md"), "# Fixture\n");
    await runFixtureGit(seed, "add", "--", "README.md");
    await runFixtureGit(seed, ...id, "commit", "-m", "Initial commit");
    const baseHead = await runFixtureGit(seed, "rev-parse", "HEAD");
    await runFixtureGit(physical, "clone", "--bare", seed, origin);

    const scope = new ScopeRegistry().lookup("partition");
    if (scope?.kind !== "service") throw new Error("Missing partition");
    const git = new PrivilegedGit({ appData, capturedPath, allowLocalRemotes: true });
    const cloneParent = join(await git.dataRoot(), "repos", "azure", "osdu-spi-partition");
    await mkdir(cloneParent, { recursive: true });
    const cloned = await git.clone(cloneParent, { origin: pathToFileURL(origin).href });
    if (!cloned.ok) throw new Error(cloned.error);
    const worktree = await git.addBranchWorktree(
      join(cloneParent, "checkout"),
      "thread-gitlink",
      "spi/gitlink-add",
      baseHead,
    );
    if (!worktree.ok) throw new Error(worktree.error);

    await mkdir(join(worktree.data.worktree.cwd, ".github", "actions"), { recursive: true });
    await runFixtureGit(
      worktree.data.worktree.cwd,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${baseHead},.github/actions`,
    );
    await runFixtureGit(worktree.data.worktree.cwd, ...id, "commit", "-m", "Add actions gitlink");
    const gitlinkHead = await runFixtureGit(worktree.data.worktree.cwd, "rev-parse", "HEAD");

    const exec = forge("direct");
    const thread = landing("fork-main", "spi/gitlink-add");
    const prepared = await preparePublication(exec, scope, thread, forgeCwd);
    if (!prepared.ok) throw new Error("Expected ready");

    await expect(observePublication(git, worktree.data, prepared, baseHead)).resolves.toMatchObject(
      {
        state: "ready",
        observedHead: null,
        githubConfirmation: { kind: "branch", value: "main" },
      },
    );

    await expect(
      publishChanges(
        exec,
        git,
        worktree.data,
        "thread-gitlink",
        thread.title,
        baseHead,
        gitlinkHead,
        null,
        prepared,
        forgeCwd,
      ),
    ).resolves.toMatchObject({
      publication: {
        outcome: "refused",
        reason: expect.stringContaining(".github/"),
      },
    });
    expect(await git.remoteHead(worktree.data, "origin", "spi/gitlink-add")).toEqual({
      ok: true,
      data: null,
    });

    await expect(
      publishChanges(
        exec,
        git,
        worktree.data,
        "thread-gitlink",
        thread.title,
        baseHead,
        gitlinkHead,
        null,
        prepared,
        forgeCwd,
        "main",
      ),
    ).resolves.toMatchObject({
      publication: { outcome: "published", head: gitlinkHead },
    });
    expect(await git.remoteHead(worktree.data, "origin", "spi/gitlink-add")).toEqual({
      ok: true,
      data: gitlinkHead,
    });
  }, 60_000);
});
