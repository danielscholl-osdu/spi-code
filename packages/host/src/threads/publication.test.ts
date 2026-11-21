// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { appendFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecOptions, ExecResult } from "@spi-code/core";
import type { ThreadDefinition } from "@spi-code/threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PrivilegedGit } from "../scopes/git.js";
import { ScopeRegistry } from "../scopes/registry.js";
import { spiReadTools } from "../tools/spi-reads.js";
import {
  observePublication,
  type PublicationGit,
  preparePublication,
  publishChanges,
} from "./publication.js";

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
          ? [{ url: `https://github.com/${GITHUB}/pull/42`, number: 42 }]
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

function forge(mode: ForgeMode = "direct"): Exec {
  return new ForgeExec(mode);
}

function gitTarget() {
  return { clone: join(root, "clone"), worktree: { id: "thread-1", cwd: root } } as const;
}

function runner({
  remote = null,
  guarded = false,
}: {
  remote?: string | null;
  guarded?: boolean;
} = {}) {
  const calls = {
    remote: [] as { remote: string; url: string }[],
    push: [] as Parameters<PrivilegedGit["push"]>[1][],
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
    remoteHead: async () => ({ ok: true, data: remote }),
    isAncestor: async () => ({ ok: true, data: guarded }),
    push: async (_target, request) => {
      calls.push.push(request);
      return { ok: true, data: "pushed" };
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
    const { git, calls } = runner({ remote: BASE, guarded: true });
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
    const { git } = runner({ remote: BASE, guarded: true });
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
    const { git, calls } = runner({ remote: OBSERVED, guarded: true });
    await expect(observePublication(git, gitTarget(), prepared)).resolves.toEqual({
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

  it("refuses a non-fast-forward remote and never reaches push", async () => {
    const exec = forge("direct");
    const scope = new ScopeRegistry().lookup("partition");
    if (!scope) throw new Error("Missing partition");
    const prepared = await preparePublication(exec, scope, landing("fork-main"), forgeCwd);
    if (!prepared.ok) throw new Error("Expected ready");
    const { git, calls } = runner({ remote: OBSERVED, guarded: false });
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
    expect(calls.push).toEqual([]);
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
    const { git, calls } = runner({ remote: OBSERVED, guarded: true });
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
    const { git, calls } = runner({ remote: OBSERVED, guarded: true });
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
