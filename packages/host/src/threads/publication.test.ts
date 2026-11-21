// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "@spi-code/core";
import type { ThreadDefinition } from "@spi-code/threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostExec, type HostExecLog } from "../exec/host-exec.js";
import type { PrivilegedGit } from "../scopes/git.js";
import { ScopeRegistry } from "../scopes/registry.js";
import { spiReadTools } from "../tools/spi-reads.js";
import { type PublicationGit, preparePublication, publishChanges } from "./publication.js";

const BASE = "1".repeat(40);
const OBSERVED = "2".repeat(40);
const HEAD = "3".repeat(40);
const TOKEN = "fixture-glab-secret";
const GITHUB = "Azure/osdu-spi-partition";
const GITLAB = "osdu/platform/system/partition";
const GITLAB_HOST = "community.opengroup.org";

let root: string;
let bin: string;
let record: string;
let logs: HostExecLog[];

async function tool(name: "gh" | "glab") {
  const script = join(bin, `${name}.cjs`);
  await writeFile(
    script,
    `const fs = require("node:fs");
const tool = ${JSON.stringify(name)};
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(record)}, tool + " " + JSON.stringify(args) + "\\n");
const mode = fs.readFileSync(${JSON.stringify(join(root, "mode"))}, "utf8");
if (args[0] === "auth") {
  process.stderr.write("fixture rejected auth subcommand");
  process.exit(2);
}
if (tool === "gh" && args[0] === "pr" && args[1] === "create") {
  console.log("https://github.com/${GITHUB}/pull/42");
  process.exit(0);
}
if (tool === "glab" && args[0] === "api") {
  if (args[1].startsWith("projects/")) {
    const access = mode === "direct" ? 40 : 10;
    console.log(JSON.stringify({
      path_with_namespace: "${GITLAB}",
      web_url: "https://${GITLAB_HOST}/${GITLAB}",
      default_branch: "trunk",
      permissions: { project_access: { access_level: access } }
    }));
    process.exit(0);
  }
  console.log(JSON.stringify(mode === "fork" ? [{
    path_with_namespace: "operator/partition",
    web_url: "https://${GITLAB_HOST}/operator/partition",
    forked_from_project: { path_with_namespace: "${GITLAB}" }
  }] : []));
  process.exit(0);
}
if (tool === "glab" && args[0] === "mr" && args[1] === "create") {
  if (mode === "token") {
    process.stderr.write("${TOKEN}");
    process.exit(1);
  }
  console.log("https://${GITLAB_HOST}/${GITLAB}/-/merge_requests/73");
  process.exit(0);
}
process.stderr.write("unexpected fixture command");
process.exit(2);
`,
  );
  if (process.platform === "win32") {
    await writeFile(join(bin, `${name}.cmd`), `@node "%~dp0\\${name}.cjs" %*\r\n`);
  } else {
    const launcher = join(bin, name);
    await writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    await chmod(launcher, 0o755);
  }
}

function forge(mode: "direct" | "fork" | "none" | "token"): Exec {
  writeFileSync(join(root, "mode"), mode);
  return new HostExec({
    appData: root,
    capturedPath: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    installer: {
      binDir: async (tool) => (tool === "gh" || tool === "glab" ? bin : undefined),
    },
    env: {
      ...process.env,
      GITLAB_TOKEN: TOKEN,
      GH_TOKEN: TOKEN,
    },
    log: (entry) => logs.push(entry),
  });
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

function branchOf(thread: ThreadDefinition): string {
  if (!thread.landsIn || thread.landsIn.target === "asking") throw new Error("No branch");
  return thread.landsIn.branch;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "spi-publication-"));
  bin = join(root, "bin");
  record = join(root, "commands.txt");
  logs = [];
  await mkdir(bin, { recursive: true });
  await tool("gh");
  await tool("glab");
  writeFileSync(join(root, "mode"), "direct");
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
    const prepared = await preparePublication(exec, scope, thread);
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
      prepared,
    );
    expect(result.publication, JSON.stringify({ result, logs })).toMatchObject({
      outcome: "published",
      head: HEAD,
      request: { forge: "github", requestNumber: 42 },
    });
    expect(calls.push).toEqual([
      {
        remote,
        source: HEAD,
        destination: `refs/heads/${branchOf(thread)}`,
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
    const prepared = await preparePublication(exec, scope, thread);
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
      prepared,
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
    const prepared = await preparePublication(exec, scope, thread);
    if (!prepared.ok) throw new Error("Expected ready");
    expect(prepared.publication.opens).toBe("none");
    const { git } = runner({ remote: BASE, guarded: true });
    await expect(
      publishChanges(exec, git, gitTarget(), "thread-1", undefined, BASE, HEAD, prepared),
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
      const prepared = await preparePublication(exec, scope, thread);
      if (!prepared.ok) throw new Error(JSON.stringify(prepared.publication));
      const { git, calls } = runner();
      await expect(
        publishChanges(exec, git, gitTarget(), "thread-1", thread.title, BASE, HEAD, prepared),
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
        `"mr","create","--repo","${GITLAB}","--source-project","${
          mode === "direct" ? GITLAB : "operator/partition"
        }"`,
      );
      expect(commands).toContain(`"--target-branch","trunk","--draft"`);
      expect(commands).not.toMatch(/\bauth\b/u);
    },
  );

  it("refuses a protected branch before any git or forge write", async () => {
    const exec = forge("direct");
    const scope = new ScopeRegistry().lookup("partition");
    if (!scope) throw new Error("Missing partition");
    for (const branch of ["main", "fork_integration"]) {
      const thread = landing("request", branch);
      await expect(preparePublication(exec, scope, thread)).resolves.toMatchObject({
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
    const prepared = await preparePublication(exec, scope, landing("upstream"));
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
});

describe("publication gates", () => {
  it("refuses a non-fast-forward remote and never reaches push", async () => {
    const exec = forge("direct");
    const scope = new ScopeRegistry().lookup("partition");
    if (!scope) throw new Error("Missing partition");
    const prepared = await preparePublication(exec, scope, landing("fork-main"));
    if (!prepared.ok) throw new Error("Expected ready");
    const { git, calls } = runner({ remote: OBSERVED, guarded: false });
    await expect(
      publishChanges(exec, git, gitTarget(), "thread-1", undefined, BASE, HEAD, prepared),
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
    const prepared = await preparePublication(exec, scope, thread);
    if (!prepared.ok) throw new Error("Expected ready");
    const { git, calls } = runner({ remote: OBSERVED, guarded: true });
    await expect(
      publishChanges(exec, git, gitTarget(), "thread-1", undefined, BASE, HEAD, prepared),
    ).resolves.toMatchObject({
      publication: { outcome: "refused", reason: expect.stringContaining("moved") },
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
      sourceRepository: GITLAB,
      base: "trunk",
    };
    const { git, calls } = runner();
    await expect(
      publishChanges(exec, git, gitTarget(), "thread-1", undefined, BASE, HEAD, prepared),
    ).resolves.toMatchObject({ publication: { outcome: "refused" } });
    expect(calls.push).toEqual([]);
  });

  it("keeps credentials out of logs and the recorded failure", async () => {
    const scope = new ScopeRegistry().lookup("partition");
    if (!scope) throw new Error("Missing partition");
    const thread = landing("upstream");
    const prepared = await preparePublication(forge("direct"), scope, thread);
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
      prepared,
    );
    const commands = await readFile(record, "utf8");
    const recorded = JSON.stringify({ logs, result, commands });
    expect(recorded).not.toContain(TOKEN);
    expect(result.publication).toMatchObject({ outcome: "failed" });
  });

  it("does not offer a publication or push tool to Copilot", () => {
    const tools = spiReadTools(() => undefined, { value: (value) => value });
    expect(tools.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining(["thread.publish", "thread.push", "publish", "push_branch"]),
    );
    expect(JSON.stringify(tools.map(({ name }) => name))).not.toMatch(/publish|push/u);
  });
});
