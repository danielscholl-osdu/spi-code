// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CORE_LIB_REPO, TEMPLATE_REPO } from "../packages/core/src/config.js";
import type { ExecOptions, ExecOutput } from "../packages/core/src/exec/port.js";
import type { ExecLogEntry } from "../packages/core/src/exec/recording.js";
import { BUDGET_KEY } from "../packages/core/src/forge.js";
import { callTargets, fenced, type Visibility } from "./audit-exec-log.js";
import { type Checked, type CheckVisibility, fence, recordSweep } from "./record-sweep.js";

const NOW = new Date("2026-11-05T12:00:00Z");
const outs: string[] = [];

afterEach(() => {
  for (const out of outs.splice(0)) rmSync(out, { recursive: true, force: true });
});

type Call = { cmd: string; args: string[] };
type Answer = (call: Call) => ExecOutput | undefined;
/** A call the anonymous runner ran: its arguments, the environment and working directory it
 * ran with, and what that configuration directory held when it ran. */
type Anonymous = Call & { env: NodeJS.ProcessEnv; cwd?: string; configHeld?: string[] };

/** Answers GraphQL with a known budget, so the paced release reads run, and refuses the rest. */
function fakeRunner(calls: Call[], answer?: Answer) {
  return async (cmd: string, args: string[], _opts: ExecOptions): Promise<ExecOutput> => {
    const call = { cmd, args };
    calls.push(call);
    const given = answer?.(call);
    if (given) return given;
    if (cmd === "gh" && args[0] === "api" && args[1] === "graphql") {
      const rate = { cost: 1, remaining: 4900, resetAt: "2026-11-05T13:00:00Z" };
      return { stdout: JSON.stringify({ data: { [BUDGET_KEY]: rate } }), stderr: "", exit: 0 };
    }
    return { stdout: "", stderr: "fake: not answered", exit: 1 };
  };
}

function visibility(hidden: Partial<Record<Checked, string[]>> = {}): CheckVisibility {
  return async (forge, name) =>
    hidden[forge]?.some((h) => h.toLowerCase() === name.toLowerCase()) ? "private" : "public";
}

const isGroupRead = (call: Call) =>
  call.cmd === "glab" && call.args.some((arg) => arg.startsWith("groups/"));

/** A group issues page holding one issue of each project id given. */
const issuesOf = (...projects: number[]): ExecOutput => ({
  stdout: JSON.stringify(
    projects.map((id, i) => ({
      id: i + 1,
      project_id: id,
      references: { full: `osdu/platform/p${id}#${i + 1}` },
      description: `ISSUE-BODY-${id}`,
      milestone: null,
    })),
  ),
  stderr: "",
  exit: 0,
});

const SIGNED_IN: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/Users/someone",
  GITLAB_TOKEN: "glpat-recording-account",
  GLAB_TOKEN: "glpat-recording-account",
  GITLAB_ACCESS_TOKEN: "glpat-recording-account",
  OAUTH_TOKEN: "oauth-recording-account",
  CI_JOB_TOKEN: "job-token",
  GLAB_ENABLE_CI_AUTOLOGIN: "true",
  GITLAB_CI: "true",
  GITLAB_HOST: "gitlab.example",
  GH_TOKEN: "gho_recording-account",
  GLAB_CONFIG_DIR: "/Users/someone/.config/glab-cli",
  XDG_CONFIG_HOME: "/Users/someone/.config",
};

async function attempt(check: CheckVisibility, answer?: Answer) {
  const out = mkdtempSync(join(tmpdir(), "spi-code-record-test-"));
  outs.push(out);
  const calls: Call[] = [];
  const anonymous: Anonymous[] = [];
  const signedIn = fakeRunner(calls, answer);
  const run = recordSweep({
    out,
    runner: signedIn,
    env: SIGNED_IN,
    anonymous: (env) => async (cmd, args, opts) => {
      const dir = env.GLAB_CONFIG_DIR;
      anonymous.push({
        cmd,
        args,
        env,
        ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
        ...(dir && existsSync(dir) ? { configHeld: readdirSync(dir) } : {}),
      });
      return answer?.({ cmd, args }) ?? { stdout: "[]", stderr: "", exit: 0 };
    },
    check,
    now: NOW,
    secrets: {},
    bun: "test",
  });
  return { run, out, calls, anonymous };
}

async function record(check: CheckVisibility, answer?: Answer) {
  const { run, out, calls, anonymous } = await attempt(check, answer);
  const result = await run;
  const entries = readFileSync(join(out, "exec.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ExecLogEntry);
  return { ...result, out, calls, anonymous, entries };
}

const naming = (calls: Call[], name: string) =>
  calls.filter((c) => [c.cmd, ...c.args].join(" ").toLowerCase().includes(name.toLowerCase()));

describe("recordSweep", () => {
  it("leaves a core library that is not public out of every call, and reads it when public", async () => {
    const hidden = await record(visibility({ github: [CORE_LIB_REPO] }));
    expect(hidden.ctx.fleet.coreLib).toBeNull();
    expect(hidden.meta.coreLib).toBeNull();
    expect(hidden.meta.excluded[CORE_LIB_REPO]).toBe("private");
    expect(naming(hidden.calls, CORE_LIB_REPO)).toEqual([]);
    expect(naming(hidden.entries, CORE_LIB_REPO)).toEqual([]);
    expect(hidden.meta.fenced).toEqual({});
    // The release reads ran: the template's releases were asked for.
    expect(naming(hidden.calls, `repos/${TEMPLATE_REPO}/releases`)).not.toEqual([]);

    const open = await record(visibility());
    expect(open.meta.coreLib).toBe(CORE_LIB_REPO);
    expect(open.meta.excluded[CORE_LIB_REPO]).toBeUndefined();
    expect(naming(open.calls, `repos/${CORE_LIB_REPO}/releases`)).toHaveLength(1);
    expect(naming(open.entries, CORE_LIB_REPO).length).toBeGreaterThan(0);
  });

  it("fences a GitLab project that is not public and records the refusal", async () => {
    const open = await record(visibility({ github: [CORE_LIB_REPO] }));
    const project = open.calls
      .map((c) => callTargets(c.cmd, c.args))
      .flatMap((targets) => (targets ? [...targets.gitlab] : []))[0];
    expect(project).toBeDefined();

    const shut = await record(visibility({ github: [CORE_LIB_REPO], gitlab: [project as string] }));
    expect(shut.meta.fenced[project as string]).toBeGreaterThan(0);
    expect(naming(shut.calls, project as string)).toEqual([]);
    const refused = shut.entries.filter(fenced);
    expect(refused.length).toBe(shut.meta.fenced[project as string]);
  });

  // An Authorization header broken onto the next line once lost the escape's backslash to the
  // redaction, leaving `\\<redacted>`; the recorder repaired it. Core's redaction now keeps it.
  it("keeps a redacted Authorization line inside JSON valid without repair", async () => {
    const release = {
      tag: "v1",
      at: "2026-01-01T00:00:00Z",
      body: "curl -H Authorization:\nopaque-credential\nnext",
    };
    const { entries } = await record(visibility({ github: [CORE_LIB_REPO] }), (call) =>
      call.args.includes(`repos/${TEMPLATE_REPO}/releases?per_page=100`)
        ? { stdout: `${JSON.stringify(release)}\n`, stderr: "", exit: 0 }
        : undefined,
    );
    const entry = entries.find((e) =>
      e.args.includes(`repos/${TEMPLATE_REPO}/releases?per_page=100`),
    );
    expect(entry?.stdout).not.toContain("opaque-credential");
    expect(JSON.parse(entry?.stdout ?? "")).toEqual({
      ...release,
      body: "curl -H Authorization:\n<redacted>\nnext",
    });
  });
});

describe("group-scoped reads", () => {
  // A public group does not make its projects public: a signed-in group read can return issues
  // of private projects the account sees, and of confidential issues in public ones.
  it("run anonymously: no GitLab credential and an empty glab configuration", async () => {
    const { anonymous, calls, entries } = await record(
      visibility({ github: [CORE_LIB_REPO] }),
      (call) => (isGroupRead(call) ? issuesOf(42) : undefined),
    );
    expect(calls.filter(isGroupRead)).toEqual([]);
    expect(anonymous.length).toBeGreaterThan(0);
    for (const call of anonymous) {
      expect(isGroupRead(call)).toBe(true);
      const names = Object.keys(call.env);
      expect(names.filter((n) => /TOKEN|^GITLAB_|^GL_|^CI(_|$)/i.test(n))).toEqual([]);
      expect(names.filter((n) => /^GLAB_/i.test(n))).toEqual(["GLAB_CONFIG_DIR"]);
      const dir = call.env.GLAB_CONFIG_DIR as string;
      expect(dir).not.toBe(SIGNED_IN.GLAB_CONFIG_DIR);
      expect(call.configHeld).toEqual([]);
      expect(call.env.XDG_CONFIG_HOME).toBe(dir);
      expect(call.env.HOME).toBe(dir);
      expect(call.cwd).toBe(dir);
      expect(call.env.PATH).toBe(SIGNED_IN.PATH);
      expect(existsSync(dir)).toBe(false);
    }
    expect(entries.filter(isGroupRead).length).toBe(anonymous.length);
  });

  it("aborts the recording before writing anything when an item's project is not public", async () => {
    const { run, out } = await attempt(
      visibility({ github: [CORE_LIB_REPO], gitlabProjectIds: ["7777"] }),
      (call) => (isGroupRead(call) ? issuesOf(42, 7777) : undefined),
    );
    const failure = await run.then(
      () => undefined,
      (error: unknown) => String(error),
    );
    expect(failure).toMatch(/GitLab project 7777 .*not public/);
    expect(failure).not.toMatch(/ISSUE-BODY|p7777|osdu\/platform/);
    expect(readdirSync(out)).toEqual([]);
  });

  it("aborts when a group read returns an item without a project", async () => {
    const { run, out } = await attempt(visibility({ github: [CORE_LIB_REPO] }), (call) =>
      isGroupRead(call) ? { stdout: '[{"id":1}]', stderr: "", exit: 0 } : undefined,
    );
    await expect(run).rejects.toThrow(/group read/);
    expect(readdirSync(out)).toEqual([]);
  });
});

describe("fence", () => {
  const ok: ExecOutput = { stdout: "{}", stderr: "", exit: 0 };

  it("refuses a name not verified public, checked when first named, without running it", async () => {
    const ran: Call[] = [];
    const checked: string[] = [];
    const refused: Record<string, number> = {};
    const check: CheckVisibility = async (forge, name) => {
      checked.push(`${forge}:${name}`);
      const shut: Record<string, Visibility> = {
        "github:acme/secret": "private",
        "gitlab:group/hidden": "internal",
      };
      return shut[`${forge}:${name}`] ?? "public";
    };
    const run = fence(
      async (cmd, args) => {
        ran.push({ cmd, args });
        return ok;
      },
      check,
      refused,
    );
    const head = (repo: string) => [
      "api",
      `repos/${repo}/commits/fork_integration`,
      "--jq",
      "{sha: .sha, at: .commit.committer.date}",
    ];
    const github = await run("gh", head("acme/secret"), {});
    expect(github.exit).toBe(1);
    const entry = {
      cmd: "gh",
      args: [],
      stdin: null,
      stdout: "",
      stderr: github.stderr,
      exit: 1,
      ms: 0,
    };
    expect(fenced(entry)).toBe(true);
    const gitlab = await run(
      "glab",
      [
        "api",
        "--hostname",
        "community.opengroup.org",
        "projects/group%2Fhidden/repository/branches/master",
      ],
      {},
    );
    expect(gitlab.exit).toBe(1);
    expect(refused).toEqual({ "acme/secret": 1, "group/hidden": 1 });
    expect(checked).toEqual(["github:acme/secret", "gitlab:group/hidden"]);
    expect(ran).toEqual([]);

    expect(await run("gh", head("acme/open"), {})).toEqual(ok);
    expect(ran).toHaveLength(1);
    expect(await run("gh", ["api", "graphql", "-f", "query=x"], { stdin: "y" })).toMatchObject({
      exit: 1,
    });
    expect(ran).toHaveLength(1);
  });
});
