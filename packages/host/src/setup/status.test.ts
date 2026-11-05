// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { SetupToolSchema } from "@spi-code/contracts";
import type { Exec, ExecOptions, ExecResult } from "@spi-code/core";
import { expect, it } from "vitest";
import { ghStatus, glabStatus, isClassicGhToken, parseGhScopes } from "./status.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

interface Reply {
  stdout?: string;
  stderr?: string;
  exit?: number;
  error?: string;
}

function fakeExec(replies: Record<string, Reply>): Exec {
  const run = async (
    cmd: string,
    args: string[],
    opts: ExecOptions = {},
  ): Promise<ExecResult<string>> => {
    const reply = replies[`${cmd} ${args.slice(0, 2).join(" ")}`] ?? {
      exit: 1,
      error: "unscripted",
    };
    if (reply.error) return { ok: false, error: reply.error, code: null };
    if (reply.stderr) opts.onOutput?.("stderr", reply.stderr);
    const exit = reply.exit ?? 0;
    if (exit !== 0 && !opts.acceptNonZeroExit)
      return { ok: false, error: `exit ${exit}`, code: exit };
    return { ok: true, data: reply.stdout ?? "", exitCode: exit };
  };
  return { runText: run, runJSON: async () => ({ ok: false, error: "unused", code: null }) };
}

const gh = (name: string, exit = 0, stream: "stdout" | "stderr" = "stdout") =>
  fakeExec({
    "gh auth status":
      stream === "stdout" ? { stdout: fixture(name), exit } : { stderr: fixture(name), exit },
  });

it("reports a gh token without the workflow scope as scope-missing", async () => {
  const status = await ghStatus(gh("gh-status-no-workflow.txt"));
  expect(status).toMatchObject({
    state: "scope-missing",
    action: "signin",
    scopes: ["gist", "read:org", "repo"],
    missingScopes: ["workflow"],
  });
  expect(SetupToolSchema.safeParse({ tool: "gh", ...status }).success).toBe(true);
});

it("reports gh as ready when repo and workflow are present, reading stderr too", async () => {
  for (const stream of ["stdout", "stderr"] as const) {
    const status = await ghStatus(gh("gh-status-ok.txt", 0, stream));
    expect(status).toMatchObject({ state: "ready", action: null });
    expect(status.scopes).toContain("workflow");
  }
});

it("explains a classic ghp_ token instead of the OAuth sign-in", async () => {
  const status = await ghStatus(gh("gh-status-classic-token.txt"));
  expect(status.state).toBe("classic-token");
  expect(status.action).toBe("attention");
  expect(status.reason).toMatch(/classic ghp_ personal access token/);
  expect(status.reason).toMatch(/gh auth login --web/);
  expect(SetupToolSchema.safeParse({ tool: "gh", ...status }).success).toBe(true);
  expect(isClassicGhToken(fixture("gh-status-ok.txt"))).toBe(false);
});

it("reports gh as signed out, and failed when gh cannot run", async () => {
  const out = await ghStatus(gh("gh-status-signed-out.txt", 1, "stderr"));
  expect(out).toMatchObject({ state: "signed-out", action: "signin" });
  const broken = await ghStatus(fakeExec({ "gh auth status": { error: "spawn gh ENOENT" } }));
  expect(broken).toMatchObject({ state: "failed", action: "attention" });
  expect(JSON.stringify(broken)).not.toContain("ENOENT");
});

it("parses scopes from gh status text", () => {
  expect(parseGhScopes(fixture("gh-status-ok.txt"))).toEqual([
    "gist",
    "read:org",
    "repo",
    "workflow",
  ]);
  expect(parseGhScopes(fixture("gh-status-signed-out.txt"))).toBeUndefined();
});

const glabReplies = (status: Reply, pat: Reply): Record<string, Reply> => ({
  "glab auth status": status,
  "glab api personal_access_tokens/self": pat,
});

it("parses glab status and the token scopes", async () => {
  const ok = await glabStatus(
    fakeExec(
      glabReplies(
        { stdout: fixture("glab-status-ok.txt") },
        { stdout: fixture("glab-pat-self.json") },
      ),
    ),
  );
  expect(ok).toEqual({ state: "ready", action: null, scopes: ["api", "write_repository"] });
  const noApi = await glabStatus(
    fakeExec(
      glabReplies(
        { stdout: fixture("glab-status-ok.txt") },
        { stdout: fixture("glab-pat-self-no-api.json") },
      ),
    ),
  );
  expect(noApi).toMatchObject({
    state: "scope-missing",
    missingScopes: ["api"],
    scopes: ["read_repository"],
  });
  expect(SetupToolSchema.safeParse({ tool: "glab", ...noApi }).success).toBe(true);
});

it("never treats an unverifiable scope probe as ready", async () => {
  for (const pat of [
    { stdout: '{"message":"404 Not Found"}', exit: 1 },
    { stdout: "{}" },
    { stdout: "<html>proxy login</html>" },
    { error: "spawn glab ENOENT" },
  ]) {
    const status = await glabStatus(
      fakeExec(glabReplies({ stdout: fixture("glab-status-ok.txt") }, pat)),
    );
    expect(status).toMatchObject({ state: "signed-out", action: "signin" });
  }
});

it("blanks stray GitLab tokens on every glab status call", async () => {
  const envs: (Record<string, string> | undefined)[] = [];
  const base = fakeExec(
    glabReplies(
      { stdout: fixture("glab-status-ok.txt") },
      { stdout: fixture("glab-pat-self.json") },
    ),
  );
  const exec: Exec = {
    ...base,
    runText: (cmd, args, opts) => {
      envs.push(opts?.env);
      return base.runText(cmd, args, opts);
    },
  };
  await glabStatus(exec);
  expect(envs).toHaveLength(2);
  for (const env of envs) {
    expect(env).toEqual({ GITLAB_TOKEN: "", GITLAB_ACCESS_TOKEN: "", OAUTH_TOKEN: "" });
  }
});

it("says which glab scopes are needed", async () => {
  const status = await glabStatus(
    fakeExec(
      glabReplies(
        { stdout: fixture("glab-status-ok.txt") },
        { stdout: fixture("glab-pat-self-no-api.json") },
      ),
    ),
  );
  expect(status.reason).toMatch(/needs the api or read_api scope/);
});

it("flags a classic ghp_ token only on the active gh account", async () => {
  const inactive = fixture("gh-status-inactive-classic.txt");
  expect(isClassicGhToken(inactive)).toBe(false);
  const status = await ghStatus(gh("gh-status-inactive-classic.txt"));
  expect(status).toMatchObject({ state: "ready", action: null });
  expect(status.scopes).toContain("workflow");
});

it("reports glab as signed out when unauthenticated or its token is rejected", async () => {
  for (const [name, stream] of [
    ["glab-status-signed-out.txt", "stderr"],
    ["glab-status-rejected.txt", "stdout"],
  ] as const) {
    const status = await glabStatus(
      fakeExec(
        glabReplies(
          stream === "stderr"
            ? { stderr: fixture(name), exit: 1 }
            : { stdout: fixture(name), exit: 1 },
          {},
        ),
      ),
    );
    expect(status).toMatchObject({ state: "signed-out", action: "signin" });
  }
});
