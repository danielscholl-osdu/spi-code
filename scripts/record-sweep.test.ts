// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { type AddressInfo, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CORE_LIB_REPO, TEMPLATE_REPO } from "../packages/core/src/config.js";
import type { ExecOptions, ExecOutput } from "../packages/core/src/exec/port.js";
import type { ExecLogEntry } from "../packages/core/src/exec/recording.js";
import { BUDGET_KEY } from "../packages/core/src/forge.js";
import { callTargets, fenced, GITLAB_HOST, type Visibility } from "./audit-exec-log.js";
import {
  anonymousGroupRead,
  anonymousVisibility,
  type Checked,
  type CheckVisibility,
  fence,
  type Get,
  GITLAB_API,
  isolatedGet,
  recordSweep,
} from "./record-sweep.js";

const NOW = new Date("2026-11-05T12:00:00Z");
const outs: string[] = [];

afterEach(() => {
  for (const out of outs.splice(0)) rmSync(out, { recursive: true, force: true });
});

type Call = { cmd: string; args: string[] };
type Answer = (call: Call) => ExecOutput | undefined;
/** A URL the group-read transport was given. */
type Sent = { url: URL };

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

/** A transport that answers as the glab call for the same path would: its stdout as the body,
 * an empty list when nothing is given. */
function fakeGet(sent: Sent[], answer?: Answer): Get {
  return async (url) => {
    sent.push({ url });
    const path = url.href.slice(GITLAB_API.length);
    const given = answer?.({ cmd: "glab", args: ["api", "--hostname", GITLAB_HOST, path] });
    return given && given.exit !== 0
      ? { status: 404, type: "application/json", body: JSON.stringify({ message: given.stderr }) }
      : { status: 200, type: "application/json", body: given?.stdout ?? "[]" };
  };
}

/** The isolated transport, sent to a local server standing in for GitLab. */
const toLocal =
  (port: number): Get =>
  (url, signal) =>
    isolatedGet(new URL(url.href.replace(GITLAB_API, `http://127.0.0.1:${port}/api/v4/`)), signal);

async function listening<T extends { listen: (...args: never[]) => unknown }>(server: T) {
  await new Promise<void>((done) =>
    (server.listen as (port: number, host: string, done: () => void) => void)(0, "127.0.0.1", done),
  );
  return (server as unknown as { address: () => AddressInfo }).address().port;
}

const closing = (server: { close: (done: () => void) => unknown }) =>
  new Promise<void>((done) => server.close(() => done()));

/** Headers a credential could ride in. */
const CREDENTIAL_HEADERS = [
  "authorization",
  "proxy-authorization",
  "private-token",
  "job-token",
  "cookie",
];

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
      iid: i + 1,
      project_id: id,
      confidential: false,
      references: { full: `osdu/platform/p${id}#${i + 1}` },
      description: `ISSUE-BODY-${id}`,
      milestone: null,
    })),
  ),
  stderr: "",
  exit: 0,
});

/** Everything that could name or carry a GitLab credential, set for the recording. */
const SIGNED_IN: Record<string, string> = {
  GITLAB_TOKEN: "glpat-recording-account",
  GLAB_TOKEN: "glpat-glab-account",
  GITLAB_ACCESS_TOKEN: "glpat-access-account",
  OAUTH_TOKEN: "oauth-recording-account",
  CI_JOB_TOKEN: "job-token-recording",
  GLAB_ENABLE_CI_AUTOLOGIN: "true",
  GLAB_CONFIG_DIR: "/Users/someone/.config/glab-cli",
  GITLAB_HOST: "gitlab.example",
  GIT_DIR: "/Users/someone/work/.git",
  GIT_CONFIG_GLOBAL: "/Users/someone/.gitconfig",
};

async function attempt(check: CheckVisibility, answer?: Answer, get?: Get) {
  const out = mkdtempSync(join(tmpdir(), "spi-code-record-test-"));
  outs.push(out);
  const calls: Call[] = [];
  const sent: Sent[] = [];
  const run = recordSweep({
    out,
    runner: fakeRunner(calls, answer),
    get: get ?? fakeGet(sent, answer),
    check,
    now: NOW,
    secrets: {},
    bun: "test",
  });
  return { run, out, calls, sent };
}

async function record(check: CheckVisibility, answer?: Answer, get?: Get) {
  const { run, out, calls, sent } = await attempt(check, answer, get);
  const result = await run;
  const log = readFileSync(join(out, "exec.jsonl"), "utf8");
  const entries = log
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ExecLogEntry);
  return { ...result, out, calls, sent, log, entries };
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
  it("never run glab: they are answered by an anonymous GET to GitLab's API", async () => {
    const { calls, sent, entries } = await record(
      visibility({ github: [CORE_LIB_REPO] }),
      (call) => (isGroupRead(call) ? issuesOf(42) : undefined),
    );
    expect(calls.filter(isGroupRead)).toEqual([]);
    expect(sent.length).toBeGreaterThan(0);
    const reads = entries.filter(isGroupRead);
    expect(reads.length).toBe(sent.length);
    for (const [i, { url }] of sent.entries()) {
      expect(url.href.startsWith(`${GITLAB_API}groups/`)).toBe(true);
      // Recorded as the glab call core makes, so replay finds it.
      expect(reads[i]).toMatchObject({
        cmd: "glab",
        args: ["api", "--hostname", GITLAB_HOST, url.href.slice(GITLAB_API.length)],
        stdout: issuesOf(42).stdout,
        exit: 0,
      });
    }
  });

  describe("with every GitLab credential and git discovery variable set", () => {
    beforeEach(() => {
      for (const [name, value] of Object.entries(SIGNED_IN)) vi.stubEnv(name, value);
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    // The isolated transport, sent to a local server standing in for GitLab: what goes on the
    // wire, with an authenticated proxy in every proxy variable, in either case.
    it("sends no credential header or cookie, and goes direct past any proxy", async () => {
      let proxied = 0;
      const proxy = createTcpServer((socket) => {
        proxied++;
        socket.destroy();
      });
      const proxyPort = await listening(proxy);
      const via = `http://proxy-user:proxy-pass@127.0.0.1:${proxyPort}`;
      for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"]) {
        vi.stubEnv(name, via);
        vi.stubEnv(name.toLowerCase(), via);
      }
      vi.stubEnv("NO_PROXY", "");
      vi.stubEnv("no_proxy", "");
      vi.stubEnv("NODE_USE_ENV_PROXY", "1");
      const seen: IncomingHttpHeaders[] = [];
      const server = createServer((request, response) => {
        seen.push(request.headers);
        response.setHeader("content-type", "application/json");
        response.end(issuesOf(42).stdout);
      });
      const port = await listening(server);
      try {
        const { calls, log, entries } = await record(
          visibility({ github: [CORE_LIB_REPO] }),
          undefined,
          toLocal(port),
        );
        expect(calls.filter(isGroupRead)).toEqual([]);
        expect(proxied).toBe(0);
        expect(seen.length).toBe(entries.filter(isGroupRead).length);
        expect(seen.length).toBeGreaterThan(0);
        for (const headers of seen) {
          expect(Object.keys(headers).sort()).toEqual([
            "accept",
            "accept-encoding",
            "connection",
            "host",
            "user-agent",
          ]);
          for (const name of CREDENTIAL_HEADERS) expect(headers[name]).toBeUndefined();
          expect(headers.host).toBe(`127.0.0.1:${port}`);
          expect(JSON.stringify(headers)).not.toMatch(
            /glpat|oauth-recording|job-token-recording|proxy-pass/,
          );
        }
        for (const [name, value] of Object.entries(SIGNED_IN))
          if (name.includes("TOKEN")) expect(log).not.toContain(value);
        expect(log).not.toContain("proxy-pass");
        for (const read of entries.filter(isGroupRead))
          expect(JSON.stringify(read)).not.toMatch(/authorization|private-token|token|cookie/i);
      } finally {
        await closing(server);
        await closing(proxy);
      }
    });
  });

  // Node's fetch goes through undici's global dispatcher, which anything loaded in the process
  // can replace; the isolated transport never touches it.
  it("sends no header a global fetch dispatcher adds", async () => {
    const key = Symbol.for("undici.globalDispatcher.1");
    const slot = globalThis as unknown as Record<symbol, unknown>;
    const seen: IncomingHttpHeaders[] = [];
    const server = createServer((request, response) => {
      seen.push(request.headers);
      response.setHeader("content-type", "application/json");
      response.end(issuesOf(42).stdout);
    });
    const port = await listening(server);
    await (await fetch(`http://127.0.0.1:${port}/warm`)).text();
    const original = slot[key] as { dispatch: (opts: unknown, handler: unknown) => boolean };
    expect(original).toBeDefined();
    const injecting = Object.create(original) as typeof original;
    injecting.dispatch = (opts, handler) => {
      const { headers } = opts as { headers?: unknown };
      const added = Array.isArray(headers)
        ? [...headers, "authorization", "Bearer injected-dispatcher"]
        : { ...(headers as object), authorization: "Bearer injected-dispatcher" };
      return original.dispatch({ ...(opts as object), headers: added }, handler);
    };
    slot[key] = injecting;
    try {
      seen.length = 0;
      await (await fetch(`http://127.0.0.1:${port}/sanity`)).text();
      // The dispatcher does inject into a global fetch.
      expect(seen[0]?.authorization).toBe("Bearer injected-dispatcher");
      seen.length = 0;
      const { entries } = await record(
        visibility({ github: [CORE_LIB_REPO] }),
        undefined,
        toLocal(port),
      );
      expect(seen.length).toBe(entries.filter(isGroupRead).length);
      expect(seen.length).toBeGreaterThan(0);
      for (const headers of seen)
        for (const name of CREDENTIAL_HEADERS) expect(headers[name]).toBeUndefined();
    } finally {
      slot[key] = original;
      await closing(server);
    }
  });

  it("read a chunked body and follow no redirect", async () => {
    const server = createServer((request, response) => {
      if (request.url?.includes("moved")) {
        response.writeHead(302, { location: "https://elsewhere.example/" });
        response.end("moved");
        return;
      }
      response.setHeader("content-type", "application/json");
      response.write('[{"id":');
      response.end("1}]");
    });
    const port = await listening(server);
    try {
      const get = toLocal(port);
      expect(await anonymousGroupRead(get, "groups/x/issues", {})).toEqual({
        stdout: '[{"id":1}]',
        stderr: "",
        exit: 0,
      });
      expect(await anonymousGroupRead(get, "groups/moved/issues", {})).toEqual({
        stdout: "",
        stderr: "glab: HTTP 302\n",
        exit: 1,
      });
    } finally {
      await closing(server);
    }
  });

  it("refuse a URL that carries credentials", async () => {
    await expect(
      isolatedGet(new URL("http://user:pass@127.0.0.1:9/"), new AbortController().signal),
    ).rejects.toThrow(/credentials/);
  });

  it("record glab's failure for a failed response, without its body", async () => {
    const answer =
      (status: number, body: string, type = "application/json"): Get =>
      async () => ({ status, type, body });
    expect(
      await anonymousGroupRead(
        answer(404, '{"message":"404 Group Not Found"}'),
        "groups/x/issues",
        {},
      ),
    ).toEqual({ stdout: "", stderr: "glab: 404 Group Not Found (HTTP 404)\n", exit: 1 });
    expect(
      await anonymousGroupRead(answer(502, "<html>bad</html>", "text/html"), "groups/x/issues", {}),
    ).toEqual({
      stdout: "",
      stderr: "glab: HTTP 502\n",
      exit: 1,
    });
    const refused = async () => {
      throw new Error("fetch failed");
    };
    expect(await anonymousGroupRead(refused, "groups/x/issues", {})).toEqual({
      stdout: "",
      stderr: "glab: fetch failed\n",
      exit: 1,
    });
    // Only group reads, and only on GitLab's API.
    let asked = 0;
    const counted: Get = async () => {
      asked++;
      return { status: 200, type: "application/json", body: "[]" };
    };
    for (const path of [
      "projects/1/issues",
      "groups/../projects/1",
      "//evil.example/groups/x",
      `//user:pass@${GITLAB_HOST}/api/v4/groups/x/issues`,
    ])
      expect(await anonymousGroupRead(counted, path, {})).toMatchObject({ exit: 1 });
    expect(asked).toBe(0);
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

  it("aborts before writing anything on a confidential issue, even of a public project", async () => {
    const { run, out } = await attempt(visibility({ github: [CORE_LIB_REPO] }), (call) =>
      isGroupRead(call)
        ? {
            stdout: JSON.stringify([
              { id: 1, iid: 3, project_id: 42, confidential: false, description: "fine" },
              { id: 2, iid: 7, project_id: 42, confidential: true, description: "SECRET-BODY" },
            ]),
            stderr: "",
            exit: 0,
          }
        : undefined,
    );
    const failure = await run.then(
      () => undefined,
      (error: unknown) => String(error),
    );
    expect(failure).toMatch(/GitLab project 42 issue 7 .*confidential/);
    expect(failure).not.toMatch(/SECRET-BODY/);
    expect(readdirSync(out)).toEqual([]);
  });

  it("aborts before writing anything on an issue that does not declare itself non-confidential", async () => {
    for (const declared of [{}, { confidential: null }, { confidential: "false" }]) {
      const { run, out } = await attempt(visibility({ github: [CORE_LIB_REPO] }), (call) =>
        isGroupRead(call)
          ? {
              stdout: JSON.stringify([
                { id: 2, iid: 7, project_id: 42, description: "UNDECLARED-BODY", ...declared },
              ]),
              stderr: "",
              exit: 0,
            }
          : undefined,
      );
      const failure = await run.then(
        () => undefined,
        (error: unknown) => String(error),
      );
      expect(failure).toMatch(/GitLab project 42 issue 7 .*confidentiality not declared/);
      expect(failure).not.toMatch(/UNDECLARED-BODY/);
      expect(readdirSync(out)).toEqual([]);
    }
  });

  it("count a project public only when its issues are open to everyone", () => {
    const project = (issues?: string) => ({
      visibility: "public",
      ...(issues ? { issues_access_level: issues } : {}),
    });
    expect(anonymousVisibility(project("enabled"), { issues: true })).toBe("public");
    // Members-only issues of a public project are private content.
    expect(anonymousVisibility(project("private"), { issues: true })).toBe("private");
    expect(anonymousVisibility(project("disabled"), { issues: true })).toBe("unknown");
    expect(anonymousVisibility(project(), { issues: true })).toBe("unknown");
    expect(anonymousVisibility({ visibility: "internal" }, { issues: true })).toBe("unknown");
    expect(anonymousVisibility(project())).toBe("public");
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
