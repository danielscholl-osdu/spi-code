// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, deflateSync, gzipSync, inflateRawSync } from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import { buildQueries } from "../packages/core/src/collect/github-read.js";
import {
  auditSweep,
  callTargets,
  classify,
  fenceMessage,
  JWT_MARK,
  NOT_PUBLIC,
  REST_SHAPES,
  scrubEmails,
  scrubJwts,
  sweepReferences,
} from "./audit-exec-log.js";
import { managedEnv, prepareOut } from "./record-sweep.js";

const AUDIT = join(import.meta.dirname, "..", "fixtures", "exec", "audit");
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function copyOfClean(): string {
  const dir = mkdtempSync(join(tmpdir(), "spicode-audit-"));
  temps.push(dir);
  cpSync(join(AUDIT, "clean"), dir, { recursive: true });
  return dir;
}

function append(dir: string, entry: object): void {
  const path = join(dir, "exec.jsonl");
  writeFileSync(path, `${readFileSync(path, "utf8").trimEnd()}\n${JSON.stringify(entry)}\n`);
}

function setVisibility(dir: string, forge: string, name: string, seen: string): void {
  const path = join(dir, "visibility.json");
  const visibility = JSON.parse(readFileSync(path, "utf8"));
  visibility[forge] = { ...visibility[forge], [name]: seen };
  writeFileSync(path, JSON.stringify(visibility));
}

const ok = { stdin: null, stderr: "", exit: 0, ms: 1 };

function plant(dir: string, line: number, from: string, to: string): void {
  const path = join(dir, "exec.jsonl");
  const lines = readFileSync(path, "utf8").split("\n");
  lines[line] = (lines[line] ?? "").replace(from, to);
  writeFileSync(path, lines.join("\n"));
}

describe("audit-exec-log", () => {
  test("passes a clean log whose every repository was public", () => {
    const result = auditSweep(join(AUDIT, "clean"));
    expect(result.findings).toEqual([]);
    expect(result.references).toEqual({ github: 2, gitlab: 1, gitlabGroups: 0 });
  });

  test("reads the clean log's file-content responses as envelopes", () => {
    const dir = copyOfClean();
    for (const line of [4, 5, 6])
      plant(dir, line, '\\"encoding\\":\\"base64\\"', '\\"encoding\\":\\"utf-8\\"');
    expect(auditSweep(dir).findings).toEqual(
      [5, 6, 7].map(
        (line) => `exec.jsonl:${line} stdout: file content: unsupported encoding "utf-8"`,
      ),
    );
  });

  test("fails a log that leaks an email address and a private repository", () => {
    expect(auditSweep(join(AUDIT, "leaky")).findings).toEqual([
      "exec.jsonl:4 stdout: email address (1)",
      "github acme/hidden-plans: private",
    ]);
  });

  test("fails a copy of a clean log with a token planted in it", () => {
    const dir = copyOfClean();
    plant(dir, 0, "Token: <redacted>", `Token: ${"ghp_"}${"x".repeat(36)}`);
    expect(auditSweep(dir).findings).toEqual([
      "exec.jsonl:1 stdout: GitHub token",
      "exec.jsonl:1 stdout: credential assignment",
    ]);
  });

  test("fails an unredacted authorization header and a repository never checked", () => {
    const dir = copyOfClean();
    plant(
      dir,
      1,
      '"args":["api",',
      `"args":["api","-H","Authorization: bearer ${"a".repeat(24)}",`,
    );
    plant(dir, 2, "acme", "elsewhere");
    const findings = auditSweep(dir).findings;
    expect(findings.filter((f) => !f.includes("unrecognized command"))).toEqual([
      "exec.jsonl:2 args[2]: authorization header",
      "exec.jsonl:2 args[2]: bearer credential",
      "github elsewhere/gadgets: not checked at record time",
    ]);
    expect(findings.filter((f) => f.includes("unrecognized command")).length).toBe(1);
  });

  test("scrubs emails without breaking the JSON around them", () => {
    const text = JSON.stringify({
      stdout: JSON.stringify({ author_email: "jane@example.com", note: "\njoe@example.org" }),
    });
    const scrubbed = scrubEmails(text);
    expect(JSON.parse(JSON.parse(scrubbed).stdout)).toEqual({
      author_email: "<email>",
      note: "\n<email>",
    });
    expect(scrubEmails("git@github.com:acme/vault.git by jane@example.com")).toBe(
      "git@github.com:acme/vault.git by <email>",
    );
  });

  test("passes a call fenced on a private repository, which read nothing of it", () => {
    const releases = {
      cmd: "gh",
      args: [
        "api",
        "--paginate",
        "repos/acme/vault/releases?per_page=100",
        "--jq",
        jqOf("releases"),
      ],
      stdin: null,
      ms: 0,
    };
    const fence = { stdout: "", stderr: fenceMessage("acme/vault", NOT_PUBLIC), exit: 1 };
    const dir = copyOfClean();
    setVisibility(dir, "github", "acme/vault", "private");
    append(dir, { ...releases, ...fence });
    expect(auditSweep(dir).findings).toEqual([]);
    expect(sweepReferences(dir).github.has("acme/vault")).toBe(true);
    for (const forged of [
      { ...fence, stdout: "[]" },
      { ...fence, exit: 0 },
      { ...fence, stderr: `${fence.stderr}and more\n` },
      { ...fence, stderr: fenceMessage("acme/other", NOT_PUBLIC) },
      { ...fence, error: "fenced" },
    ]) {
      const each = copyOfClean();
      setVisibility(each, "github", "acme/vault", "private");
      append(each, { ...releases, ...forged });
      expect(auditSweep(each).findings).toEqual(["github acme/vault: private"]);
    }
  });

  test("scrubs JSON web tokens", () => {
    const jwt = `eyJ${"a".repeat(10)}.eyJ${"b".repeat(10)}.${"c".repeat(10)}`;
    expect(scrubJwts(`token: ${jwt}\n`)).toBe(`token: ${JWT_MARK}\n`);
  });
});

// Representative calls of the allowlisted shapes, as the sweep issues them, with what they read.
const GITLAB_HOST = ["--hostname", "community.opengroup.org"];
const jqOf = (id: string) => REST_SHAPES.find((shape) => shape.id === id)?.jq ?? "";
const BUDGET = "spicodeBudget: rateLimit { cost remaining resetAt }";
const SHAPES: {
  cmd: string;
  args: string[];
  class: "public-content" | "operator";
  github?: string[];
  gitlab?: string[];
  groups?: string[];
}[] = [
  { cmd: "gh", args: ["auth", "status", "--hostname", "github.com"], class: "operator" },
  { cmd: "glab", args: ["auth", "status", ...GITLAB_HOST], class: "operator" },
  { cmd: "gh", args: ["api", "user", "--jq", ".login"], class: "operator" },
  {
    cmd: "gh",
    args: [
      "api",
      "repos/Azure/osdu-spi-partition/actions/workflows/sync.yml/runs?per_page=10",
      "--jq",
      jqOf("runs"),
    ],
    class: "public-content",
    github: ["Azure/osdu-spi-partition"],
  },
  {
    cmd: "gh",
    args: [
      "api",
      "--paginate",
      "repos/Azure/osdu-spi-stack/pulls?state=open&per_page=100",
      "--jq",
      jqOf("open pulls"),
    ],
    class: "public-content",
    github: ["Azure/osdu-spi-stack"],
  },
  {
    cmd: "gh",
    args: ["api", "--allow-escape-sequences", "repos/Azure/osdu-spi-stack/actions/jobs/1/logs"],
    class: "public-content",
    github: ["Azure/osdu-spi-stack"],
  },
  {
    cmd: "gh",
    args: ["api", "repos/Azure/osdu-spi/contents/.github/upstream-filter.yml"],
    class: "public-content",
    github: ["Azure/osdu-spi"],
  },
  {
    cmd: "gh",
    args: [
      "api",
      "--paginate",
      "repos/Azure/osdu-spi-stack/dependabot/alerts?state=open&per_page=100",
      "--jq",
      jqOf("dependabot alerts"),
    ],
    class: "operator",
    github: ["Azure/osdu-spi-stack"],
  },
  {
    cmd: "gh",
    args: [
      "api",
      "graphql",
      "-f",
      `query=query { ${BUDGET}  template: repository(owner: "Azure", name: "osdu-spi") { object(expression: "main:x.json") { ... on Blob { text } } } r1: repository(owner: "Azure", name: "osdu-spi-stack") { createdAt } }`,
    ],
    class: "operator",
    github: ["Azure/osdu-spi", "Azure/osdu-spi-stack"],
  },
  {
    cmd: "gh",
    args: [
      "api",
      "graphql",
      "-f",
      `query=query { ${BUDGET} port_o0: search(query: "repo:Azure/osdu-spi-partition is:pr is:open", type: ISSUE, first: 100) { issueCount pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { number url mergedAt bodyText commits(first: 100) { totalCount pageInfo { hasNextPage } nodes { commit { message } } } } } } }`,
    ],
    class: "operator",
    github: ["Azure/osdu-spi-partition"],
  },
  {
    cmd: "glab",
    args: [
      "api",
      ...GITLAB_HOST,
      "projects/osdu%2Fplatform%2Fsystem%2Fpartition/repository/branches/master",
    ],
    class: "public-content",
    gitlab: ["osdu/platform/system/partition"],
  },
  {
    cmd: "glab",
    args: [
      "api",
      ...GITLAB_HOST,
      "groups/osdu%2Fplatform/issues?labels=SPI%20fork%3A%3Apending&state=all&per_page=100&page=1",
    ],
    class: "operator",
    groups: ["osdu/platform"],
  },
  {
    cmd: "glab",
    args: [
      "api",
      "graphql",
      ...GITLAB_HOST,
      "-f",
      'query=query { p0: project(fullPath: "osdu/platform/system/partition") { mergeRequests(state: merged, targetBranches: ["master"], mergedAfter: "2026-01-01T00:00:00Z", first: 100) { pageInfo { hasNextPage } nodes { iid title webUrl mergedAt diffHeadSha } } } }',
    ],
    class: "public-content",
    gitlab: ["osdu/platform/system/partition"],
  },
];

const sorted = (set: Set<string> | undefined) => [...(set ?? [])].sort();

describe("call shapes", () => {
  test.each(SHAPES)("$cmd $args.0 $args.1 is $class and names what it reads", (shape) => {
    const classified = classify(shape.cmd, shape.args);
    expect("refused" in classified ? classified : classified.class).toBe(shape.class);
    const targets = callTargets(shape.cmd, shape.args);
    expect(sorted(targets?.github)).toEqual(shape.github ?? []);
    expect(sorted(targets?.gitlab)).toEqual(shape.gitlab ?? []);
    expect(sorted(targets?.gitlabGroups)).toEqual(shape.groups ?? []);
  });

  test("gives a GraphQL call's budget block the operator class, and each other block its own", () => {
    const classified = classify("gh", SHAPES[8]?.args ?? []);
    expect("refused" in classified ? [] : classified.blocks?.map((b) => [b.key, b.class])).toEqual([
      ["spicodeBudget", "operator"],
      ["template", "public-content"],
      ["r1", "public-content"],
    ]);
  });

  // The documents core sends, built by core: every block and fragment is allowlisted.
  test("reads every document packages/core builds", () => {
    const forks = Array.from({ length: 7 }, (_, i) => ({ repo: `Azure/osdu-spi-f${i}` }));
    const docs = buildQueries({
      fleet: { forks, planned: [{ id: "planned" }] },
      stackRepo: "Azure/osdu-spi-stack",
    } as unknown as Parameters<typeof buildQueries>[0]);
    const read = docs.map((doc) => {
      const args = ["api", "graphql", "-f", `query=${doc.replace("query {", `query { ${BUDGET}`)}`];
      return sorted(callTargets("gh", args)?.github);
    });
    expect(read).toEqual([
      ["Azure/osdu-spi", "Azure/osdu-spi-planned", "Azure/osdu-spi-stack"],
      forks.slice(0, 5).map((f) => f.repo),
      forks.slice(5).map((f) => f.repo),
    ]);
  });

  test.each([
    ["a bare argument", "gh", ["repo", "view", "acme/vault"]],
    ["a -R repository", "gh", ["pr", "list", "-R", "acme/vault"]],
    ["glab repo view", "glab", ["repo", "view", "a/b/c"]],
    [
      "GraphQL variables",
      "gh",
      [
        "api",
        "graphql",
        "-f",
        "query=query($o: String!, $n: String!) { repository(owner: $o, name: $n) { id } }",
        "-f",
        "o=acme",
      ],
    ],
    ["an organization listing", "gh", ["api", "orgs/acme/repos"]],
    ["gh pr list", "gh", ["pr", "list"]],
    ["gh auth token", "gh", ["auth", "token"]],
    [
      "an organization's repositories",
      "gh",
      [
        "api",
        "graphql",
        "-f",
        `query={ ${BUDGET} organization(login: "acme") { repositories(first: 9) { nodes { name } } } }`,
      ],
    ],
    [
      "a repository search",
      "gh",
      [
        "api",
        "graphql",
        "-f",
        `query={ ${BUDGET} search(query: "org:acme", type: REPOSITORY, first: 9) { repositoryCount } }`,
      ],
    ],
    ["a request body", "gh", ["api", "--input", "-", "repos/acme/widgets/issues"]],
    ["a gh path on glab", "glab", ["api", "repos/acme/widgets"]],
    ["git clone", "git", ["clone", "https://github.com/acme/vault"]],
    ["a jq filter of its own", "gh", ["api", "repos/acme/widgets/pulls/1", "--jq", "env"]],
    ["a dot segment", "gh", ["api", "repos/acme/../actions/runs/1", "--jq", jqOf("run")]],
    [
      "a forged fragment",
      "gh",
      [
        "api",
        "graphql",
        "-f",
        `query=query { ${BUDGET} r_stack: repository(owner: "a", name: "b") { ...Base ...Stack } } fragment Base on Repository { nameWithOwner viewerPermission } fragment Stack on Repository { nameWithOwner }`,
      ],
    ],
  ])("refuses %s", (_, cmd, args) => {
    expect(callTargets(cmd, args)).toBeUndefined();
  });

  const local = join(import.meta.dirname, "..", "fixtures", "exec", "local");
  const recorded = existsSync(local)
    ? readdirSync(local)
        .filter((name) => /^sweep-/.test(name))
        .map((name) => join(local, name))
    : [];
  test.skipIf(!recorded.length)("every call in a local recording is an allowlisted shape", () => {
    for (const dir of recorded) {
      for (const line of readFileSync(join(dir, "exec.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)) {
        const entry = JSON.parse(line) as { cmd: string; args: string[] };
        expect(
          callTargets(entry.cmd, entry.args),
          `${entry.cmd} ${entry.args.join(" ")}`.slice(0, 200),
        ).toBeDefined();
      }
    }
  });
});

describe("audit of shapes, decoded strings and new credentials", () => {
  // A call outside the allowlist reads what it likes: it fails as unrecognized, whatever it names.
  test.each([
    ["by a bare argument", "gh", ["repo", "view", "acme/vault"]],
    [
      "through GraphQL variables",
      "gh",
      [
        "api",
        "graphql",
        "-f",
        "query=query($o: String!, $n: String!) { repository(owner: $o, name: $n) { id } }",
        "-f",
        "o=acme",
        "-f",
        "n=vault",
      ],
    ],
    ["by its clone URL", "git", ["ls-remote", "git@github.com:acme/vault.git"]],
    ["by an organization listing", "gh", ["api", "orgs/acme/repos"]],
  ])("fails a call that reads %s", (_, cmd, args) => {
    const dir = copyOfClean();
    setVisibility(dir, "github", "acme/vault", "private");
    append(dir, { cmd, args, ...ok, stdout: "{}" });
    expect(auditSweep(dir).findings).toEqual([
      `exec.jsonl:8: unrecognized command: ${[cmd, ...args].join(" ")}`,
    ]);
  });

  test("fails a private GitLab group", () => {
    const dir = copyOfClean();
    setVisibility(dir, "gitlabGroups", "osdu/hidden", "private");
    append(dir, {
      cmd: "glab",
      args: [
        "api",
        ...GITLAB_HOST,
        "groups/osdu%2Fhidden/issues?labels=x&state=all&per_page=100&page=1",
      ],
      ...ok,
      stdout: "[]",
    });
    expect(auditSweep(dir).findings).toEqual(["gitlab group osdu/hidden: private"]);
  });

  // A public group does not make its projects public: a group read must carry evidence that
  // every item's project was public when recorded.
  describe("a group issues read", () => {
    const issues = (...items: object[]) => {
      const dir = copyOfClean();
      setVisibility(dir, "gitlabGroups", "osdu/platform", "public");
      append(dir, {
        cmd: "glab",
        args: [
          "api",
          ...GITLAB_HOST,
          "groups/osdu%2Fplatform/issues?labels=x&state=all&per_page=100&page=1",
        ],
        ...ok,
        stdout: JSON.stringify(items),
      });
      return dir;
    };
    const issue = (project: number) => ({
      id: 1,
      iid: 1,
      project_id: project,
      confidential: false,
      references: { full: `osdu/platform/p${project}#1` },
      description: "an issue body",
    });

    test("fails an item of a private project, hand-inserted", () => {
      const dir = issues(issue(42), issue(7777));
      setVisibility(dir, "gitlabProjectIds", "42", "public");
      setVisibility(dir, "gitlabProjectIds", "7777", "private");
      expect(auditSweep(dir).findings).toEqual(["gitlab project 7777 in a group read: private"]);
    });

    test("fails an item whose project was never checked, or was missing", () => {
      const dir = issues(issue(42), issue(43));
      setVisibility(dir, "gitlabProjectIds", "43", "missing");
      expect(auditSweep(dir).findings).toEqual([
        "gitlab project 42 in a group read: not checked at record time",
        "gitlab project 43 in a group read: missing",
      ]);
    });

    test("fails an item without a project, and a response that is not a list", () => {
      expect(auditSweep(issues({ id: 1 })).findings).toEqual([
        "exec.jsonl:8: group read: an item without a project",
      ]);
      const dir = copyOfClean();
      setVisibility(dir, "gitlabGroups", "osdu/platform", "public");
      append(dir, {
        cmd: "glab",
        args: [
          "api",
          ...GITLAB_HOST,
          "groups/osdu%2Fplatform/issues?labels=x&state=all&per_page=100&page=1",
        ],
        ...ok,
        stdout: '{"message":"x"}',
      });
      expect(auditSweep(dir).findings).toEqual([
        "exec.jsonl:8: group read: an item without a project",
      ]);
    });

    test("fails a confidential issue, even of a public project", () => {
      const dir = issues(issue(42), { ...issue(42), iid: 7, confidential: true });
      setVisibility(dir, "gitlabProjectIds", "42", "public");
      expect(auditSweep(dir).findings).toEqual([
        "gitlab project 42 issue 7 in a group read: confidential",
      ]);
    });

    test("fails an issue that does not declare itself non-confidential", () => {
      const { confidential: _, ...missing } = issue(42);
      const dir = issues(
        issue(42),
        { ...missing, iid: 2 },
        { ...issue(42), iid: 3, confidential: null },
        { ...issue(42), iid: 4, confidential: "false" },
      );
      setVisibility(dir, "gitlabProjectIds", "42", "public");
      expect(auditSweep(dir).findings).toEqual([
        "gitlab project 42 issue 2 in a group read: confidentiality not declared",
        "gitlab project 42 issue 3 in a group read: confidentiality not declared",
        "gitlab project 42 issue 4 in a group read: confidentiality not declared",
      ]);
    });

    test("checks a failed call's group response too; only an empty one holds nothing", () => {
      const dir = copyOfClean();
      setVisibility(dir, "gitlabGroups", "osdu/platform", "public");
      const path = "groups/osdu%2Fplatform/issues?labels=x&state=all&per_page=100&page=1";
      append(dir, {
        cmd: "glab",
        args: ["api", ...GITLAB_HOST, path],
        ...ok,
        exit: 1,
        stdout: JSON.stringify([issue(7777)]),
      });
      append(dir, { cmd: "glab", args: ["api", ...GITLAB_HOST, path], ...ok, exit: 1, stdout: "" });
      expect(auditSweep(dir).findings).toEqual([
        "gitlab project 7777 in a group read: not checked at record time",
      ]);
    });

    test("passes when every item's project was public", () => {
      const dir = issues(issue(42), issue(42));
      setVisibility(dir, "gitlabProjectIds", "42", "public");
      expect(auditSweep(dir).findings).toEqual([]);
    });
  });

  test("fails credentials and emails hidden behind JSON escapes", () => {
    const dir = copyOfClean();
    plant(dir, 1, '\\"author\\": \\"octo\\"', '\\"author\\": \\"jane\\\\u0040example.com\\"');
    append(dir, {
      cmd: "gh",
      args: ["api", "repos/acme/widgets/pulls/1", "--jq", jqOf("pull")],
      ...ok,
      stdout: JSON.stringify({ body: `{"t": "ghp\\u005f${"x".repeat(36)}"}` }),
    });
    expect(auditSweep(dir).findings).toEqual([
      "exec.jsonl:2 stdout: email address (1)",
      "exec.jsonl:8 stdout: GitHub token",
    ]);
  });

  test("fails a credential or email planted in visibility.json", () => {
    const dir = copyOfClean();
    const path = join(dir, "visibility.json");
    const visibility = JSON.parse(readFileSync(path, "utf8"));
    visibility.note = `ghp_${"x".repeat(36)} jane@example.com`;
    writeFileSync(path, JSON.stringify(visibility));
    expect(auditSweep(dir).findings).toEqual([
      "visibility.json: GitHub token",
      "visibility.json: email address (1)",
    ]);
  });

  // Maintainer decision, 2026-11-05: private names may appear; their contents may not.
  test("passes a private name quoted in a public response, and fails a call that reads it", () => {
    const dir = copyOfClean();
    const widgets = "projects/osdu%2Fplatform%2Fsystem%2Fwidgets";
    append(dir, {
      cmd: "glab",
      args: [
        "api",
        ...GITLAB_HOST,
        `${widgets}/merge_requests?state=opened&target_branch=master&per_page=100&page=1`,
      ],
      ...ok,
      stdout: JSON.stringify([{ description: "Fork: https://github.com/acme/vault" }]),
    });
    append(dir, {
      cmd: "gh",
      args: ["api", "repos/acme/widgets/git/trees/main?recursive=1", "--jq", jqOf("tree")],
      ...ok,
      stdout: JSON.stringify({
        paths: ["acme/vault", "https://community.opengroup.org/osdu/hidden/thing/-/issues/1"],
        truncated: false,
      }),
    });
    setVisibility(dir, "github", "acme/vault", "private");
    setVisibility(dir, "gitlab", "osdu/hidden/thing", "private");
    expect(auditSweep(dir).findings).toEqual([]);
    expect(sweepReferences(dir).github.has("acme/vault")).toBe(false);
    append(dir, {
      cmd: "gh",
      args: ["api", "--paginate", "repos/acme/vault/tags?per_page=100", "--jq", jqOf("tags")],
      ...ok,
      stdout: "[]",
    });
    append(dir, {
      cmd: "glab",
      args: [
        "api",
        ...GITLAB_HOST,
        "projects/osdu%2Fhidden%2Fthing/repository/tags?per_page=100&page=1",
      ],
      ...ok,
      stdout: "[]",
    });
    expect(auditSweep(dir).findings).toEqual([
      "github acme/vault: private",
      "gitlab osdu/hidden/thing: private",
    ]);
  });

  test.each([
    ["AWS access key", `AKIA${"ABCDEFGHIJKLMNOP"}`],
    ["Slack token", `xoxb-${"1234567890"}-abcdefghij`],
    ["credential assignment", "jdbc:x;user=sa;password=Hunter2pass9;"],
    ["credential assignment", "CLIENT_SECRET=s3cr3tValue42"],
    ["credential assignment", String.raw`password=Hunter2pass9\\n-port=8080`],
    // A literal backslash in a password (JSON-encoded in the raw line) does not end it.
    ["credential assignment", String.raw`password=Hunter\\2pass9`],
    ["credential assignment", "password=CorrectHorseBatteryStaple"],
    // Words, not placeholders: a value of letters is a password unless it is a known placeholder.
    ["credential assignment", "password=secretsauce"],
    ["credential assignment", "password=passphrase"],
    ["credential assignment", "password=monkey"],
    ["credential assignment", "client_secret=abcdefghijklmnop"],
    ["credential assignment", String.raw`password = \"secretPassword\";`],
    // Mixed case is not code: an assignment outside a statement holds the value it names.
    ["credential assignment", "PASSWORD = monKey"],
    ["credential assignment", "password=Hunter2.pass"],
  ])("fails a planted %s", (name, secret) => {
    const dir = copyOfClean();
    plant(dir, 0, "Token: <redacted>", `Token: <redacted> ${secret}`);
    expect(auditSweep(dir).findings).toEqual([`exec.jsonl:1 stdout: ${name}`]);
  });

  // Any credential-named key assigned any non-empty value is a finding: no value is exempt for
  // its shape. The first rows are the round-4 recheck's accepted probes; the rest were passing
  // controls (code, placeholders, live-sweep values) until the exemptions were removed.
  test.each([
    "PASSWORD=a.password",
    "PASSWORD=Hunt.er2Key",
    "PASSWORD=Y2xpZW50.c2VjcmV0.API_KEY",
    "export PASSWORD=a.password",
    "password = s3cr3tValue;",
    "password = hunter2;",
    "password: s3cr3tValue",
    String.raw`{\"password\":\"s3cr3tValue\"}`,
    "{'password': 's3cr3tValue'}",
    "KEY=x.y.API_KEY",
    "pwd=s3cr3t",
    "auth: s3cr3t",
    "credential=s3cr3t",
    "accessToken: s3cr3t",
    "Client-Secret = s3cr3t",
    "keys: s3cr3t",
    "password=a",
    "password = getPassword()",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell placeholder, not a template
    "password=${PASSWORD}",
    "String password = userPassword;",
    String.raw`-db.password=TODO\\n-server.port=8080`,
    String.raw`-AZURE_CLIENT_SECRET=\\u003cclient_secret\\u003e\\n-PORT=8080`,
    "password=<your-password>",
    "password={{ .Values.password }}",
    "password=xxxxxxxx",
    "password=********",
    "password=changeme",
    "password=TODO",
    "api_key=your_api_key_here",
    "PASSWORD=config.dbPassword",
    "API_KEY=process.env.API_KEY",
    "apiKey = this.config.apiKey;",
    "AUTHORIZE_API_KEY=tobeupdated",
    String.raw`export CLIENT_SECRET=\"client-secret\"`,
  ])("fails a credential-named key with any value: %s", (text) => {
    const dir = copyOfClean();
    plant(dir, 0, "Token: <redacted>", `Token: <redacted> ${text}`);
    expect(auditSweep(dir).findings).toEqual(["exec.jsonl:1 stdout: credential assignment"]);
  });

  // No value: an empty one, the recorder's own mark, or a nested mapping or list. And names that
  // only contain a credential word inside another word.
  test.each([
    "password=",
    String.raw`password=\"\"`,
    "secret=<redacted>",
    String.raw`password:\n  file: x`,
    "auth: {",
    "keys: [",
    "monkey: 3",
    "keyboard=qwerty",
    "KEYCLOAK_URL=x",
    "author: someone",
    "AUTHORIZED_GROUP=x",
    "tokenizer=x",
  ])("passes a credential word with no value, or no credential name: %s", (text) => {
    const dir = copyOfClean();
    plant(dir, 0, "Token: <redacted>", `Token: <redacted> ${text}`);
    expect(auditSweep(dir).findings).toEqual([]);
  });
});

// A .env file in a diff nested in JSON, written on the operator's side: a mixed-case value is a
// password, not a code reference. (The same diff read from a public repository is its content.)
test.each(["PASSWORD", "Password", "pAsSwOrD", "Client_Secret", "API_KEY"])(
  "fails %s=monKey in a JSON-wrapped .env diff",
  (key) => {
    const dir = copyOfClean();
    append(dir, {
      cmd: "glab",
      args: [
        "api",
        ...GITLAB_HOST,
        "projects/osdu%2Fplatform%2Fsystem%2Fwidgets/repository/commits/abcdef0/diff?per_page=100&page=1",
      ],
      ...ok,
      stdout: "[]",
      stderr: JSON.stringify({ diff: `+.env\n+${key}=monKey\n` }),
    });
    expect(auditSweep(dir).findings).toEqual(["exec.jsonl:8 stderr: credential assignment"]);
  },
);

// The credential-assignment heuristic guards the operator's side. A public repository's own
// content and the Facts derived from it are public by design, so only the high-confidence
// detectors run there.
describe("credential assignments by provenance", () => {
  const LINE = "CLIENT_SECRET=s3cr3tValue42";
  const CREATED = `query { ${BUDGET} r0: repository(owner: "acme", name: "widgets") { createdAt } r1: repository(owner: "acme", name: "vault") { createdAt } }`;
  const read = (repo: string, extra: object = {}) => ({
    cmd: "gh",
    args: [
      "api",
      `repos/${repo}/contents/ops/environments/shared.yaml?ref=abcdef0`,
      "--jq",
      jqOf("declaration"),
    ],
    ...ok,
    stdout: JSON.stringify({ content: `${LINE}\n` }),
    ...extra,
  });

  test("passes a credential assignment in the stdout of public repository reads", () => {
    const dir = copyOfClean();
    append(dir, read("acme/widgets"));
    append(dir, {
      cmd: "glab",
      args: [
        "api",
        ...GITLAB_HOST,
        "projects/osdu%2Fplatform%2Fsystem%2Fwidgets/repository/files/pom.xml?ref=abcdef0",
      ],
      ...ok,
      stdout: JSON.stringify({ encoding: "base64", content: Buffer.from(LINE).toString("base64") }),
    });
    expect(auditSweep(dir).findings).toEqual([]);
  });

  test.each([
    ["stderr", read("acme/widgets", { stdout: "{}", stderr: LINE }), [], "stderr"],
    [
      "stdin",
      read("acme/widgets", { stdout: "{}", stdin: LINE }),
      ["exec.jsonl:8: unrecognized command: stdin"],
      "stdin",
    ],
    [
      "argv",
      read("acme/widgets", {
        args: ["api", "repos/acme/widgets/pulls/1", "--jq", LINE],
        stdout: "[]",
      }),
      [`exec.jsonl:8: unrecognized command: gh api repos/acme/widgets/pulls/1 --jq ${LINE}`],
      "args[3]",
    ],
    [
      "a non-repository command's stdout",
      read("acme/widgets", { args: ["api", "user", "--jq", ".login"] }),
      [],
      "stdout",
    ],
    ["the stdout of a private read", read("acme/vault"), ["github acme/vault: private"], "stdout"],
    ["the stdout of a read missing from visibility.json", read("acme/vault"), [], "stdout"],
    [
      "the stdout of a read of a public and a private repository",
      read("acme/widgets", {
        args: ["api", "graphql", "-f", `query=${CREATED}`],
        stdout: JSON.stringify({ data: { r0: { createdAt: "x" }, r1: { createdAt: LINE } } }),
      }),
      ["github acme/vault: private"],
      "stdout",
    ],
  ])("fails a credential assignment in %s", (what, entry, more, field) => {
    const dir = copyOfClean();
    if (what.includes("private")) setVisibility(dir, "github", "acme/vault", "private");
    if (what.includes("missing")) setVisibility(dir, "github", "acme/vault", "missing");
    append(dir, entry);
    const findings = auditSweep(dir).findings;
    expect(findings.filter((f) => f.endsWith(": credential assignment"))).toEqual([
      `exec.jsonl:8 ${field}: credential assignment`,
    ]);
    expect(findings.filter((f) => !f.endsWith(": credential assignment"))).toEqual(more);
  });

  test("exempts only the GraphQL blocks that read a public repository", () => {
    const dir = copyOfClean();
    setVisibility(dir, "github", "acme/vault", "private");
    const stdout = (r0: string, r1: string) =>
      JSON.stringify({
        data: { spicodeBudget: { cost: 1 }, r0: { createdAt: r0 }, r1: { createdAt: r1 } },
      });
    append(
      dir,
      read("acme/widgets", {
        args: ["api", "graphql", "-f", `query=${CREATED}`],
        stdout: stdout(LINE, "x"),
      }),
    );
    expect(auditSweep(dir).findings).toEqual(["github acme/vault: private"]);
    const budget = copyOfClean();
    append(budget, {
      ...read("acme/widgets", {
        args: [
          "api",
          "graphql",
          "-f",
          `query=${CREATED.replace(' r1: repository(owner: "acme", name: "vault") { createdAt }', "")}`,
        ],
      }),
      stdout: JSON.stringify({ data: { spicodeBudget: { note: LINE }, r0: { createdAt: "x" } } }),
    });
    expect(auditSweep(budget).findings).toEqual(["exec.jsonl:8 stdout: credential assignment"]);
  });

  test("fails a token in public repository stdout and in the Facts files", () => {
    const dir = copyOfClean();
    const tokens = `ghp_${"x".repeat(36)} glpat-${"y".repeat(20)} ${LINE}`;
    append(dir, read("acme/widgets", { stdout: JSON.stringify({ content: tokens }) }));
    for (const name of ["core-facts.json", "rib-facts.json", "services.json"])
      writeFileSync(join(dir, name), JSON.stringify({ title: tokens }));
    expect(auditSweep(dir).findings).toEqual([
      "exec.jsonl:8 stdout: GitHub token",
      "exec.jsonl:8 stdout: GitLab token",
      "core-facts.json: GitHub token",
      "core-facts.json: GitLab token",
      "core-facts.json: credential assignment",
      "rib-facts.json: GitHub token",
      "rib-facts.json: GitLab token",
      "rib-facts.json: credential assignment",
      "services.json: GitHub token",
      "services.json: GitLab token",
      "services.json: credential assignment",
    ]);
  });

  test("passes the gh CLI's own token mask and fails anything more", () => {
    const dir = copyOfClean();
    plant(dir, 0, "Token: <redacted>", `Token: gho_${"*".repeat(36)}`);
    expect(auditSweep(dir).findings).toEqual([]);
    plant(dir, 0, `gho_${"*".repeat(36)}`, "gho_****x");
    expect(auditSweep(dir).findings).toEqual(["exec.jsonl:1 stdout: credential assignment"]);
  });
});

// Recheck 5's bypasses: each planted a credential assignment in the stdout of a call the sweep
// never issues, and each passed. Every one now fails on the call itself, and its stdout is strict.
describe("allowlist", () => {
  const LINE = "CLIENT_SECRET=s3cr3tValue42";
  const WIDGETS = "projects/osdu%2Fplatform%2Fsystem%2Fwidgets";
  const PULL = ["repos/acme/widgets/pulls/1", "--jq", jqOf("pull")];
  const gql = (cmd: string, query: string) =>
    cmd === "gh"
      ? ["api", "graphql", "-f", `query=${query}`]
      : ["api", "graphql", ...GITLAB_HOST, "-f", `query=${query}`];
  const planted = (cmd: string, args: string[], extra: object = {}) => {
    const dir = copyOfClean();
    append(dir, {
      cmd,
      args,
      ...ok,
      stdout: JSON.stringify({ data: { r0: { v: LINE } }, v: LINE }),
      ...extra,
    });
    return auditSweep(dir).findings;
  };

  test.each([
    ["invitations", "gh", ["api", "repos/acme/widgets/invitations"]],
    ["notifications", "gh", ["api", "repos/acme/widgets/notifications"]],
    [
      "a collaborator's permission",
      "gh",
      ["api", "repos/acme/widgets/collaborators/octo/permission"],
    ],
    ["the app installation", "gh", ["api", "repos/acme/widgets/installation"]],
    ["hooks", "gh", ["api", "repos/acme/widgets/hooks"]],
    ["security advisories", "gh", ["api", "repos/acme/widgets/security-advisories"]],
    ["GitLab variables", "glab", ["api", ...GITLAB_HOST, `${WIDGETS}/variables`]],
    ["GitLab access tokens", "glab", ["api", ...GITLAB_HOST, `${WIDGETS}/access_tokens`]],
    [
      "an allowlisted path with another jq",
      "gh",
      ["api", "repos/acme/widgets/pulls/1", "--jq", "env"],
    ],
    [
      "glab currentUser named for a repository in a comment",
      "glab",
      gql("glab", "{ currentUser { username } } # repo:acme/widgets"),
    ],
    [
      "rateLimit named for a repository in a comment",
      "gh",
      gql("gh", "{ rateLimit { remaining } } # repo:acme/widgets"),
    ],
    [
      "a repository's owner's repositories",
      "gh",
      gql(
        "gh",
        `{ ${BUDGET} r0: repository(owner: "acme", name: "widgets") { owner { repositories(first: 9) { nodes { name } } } } }`,
      ),
    ],
    [
      "viewer",
      "gh",
      gql(
        "gh",
        `{ ${BUDGET} viewer { login } r0: repository(owner: "acme", name: "widgets") { createdAt } }`,
      ),
    ],
  ])("fails a call to %s as unrecognized", (_, cmd, args) => {
    expect(planted(cmd, args)).toEqual([
      `exec.jsonl:8: unrecognized command: ${[cmd, ...args].join(" ")}`.slice(0, 300),
      "exec.jsonl:8 stdout: credential assignment",
    ]);
  });

  test.each([
    ["--hostname", ["api", "--hostname", "evil.example", ...PULL], {}, "--hostname evil.example"],
    ["--hostname=", ["api", "--hostname=evil.example", ...PULL], {}, "--hostname=evil.example"],
    [
      "a Host header",
      ["api", "-H", "Host: evil.example", ...PULL],
      {},
      "header Host: evil.example",
    ],
  ])("fails a call routed by %s as a host override", (_, args, extra, detail) => {
    expect(planted("gh", args, extra)).toEqual([
      `exec.jsonl:8: host override: ${detail}`,
      "exec.jsonl:8 stdout: credential assignment",
    ]);
  });

  test.each(["GH_HOST", "GITLAB_HOST", "gh_config_dir"])(
    "fails a call with %s in its environment",
    (name) => {
      expect(planted("gh", ["api", ...PULL], { env: { [name]: "evil.example" } })).toEqual([
        "exec.jsonl:8: unexpected field env",
        `exec.jsonl:8: host override: env ${name}`,
        "exec.jsonl:8 stdout: credential assignment",
      ]);
    },
  );

  test("keeps the stdout of an allowlisted operator call strict", () => {
    expect(
      planted("gh", [
        "api",
        "--paginate",
        "repos/acme/widgets/dependabot/alerts?state=open&per_page=100",
        "--jq",
        jqOf("dependabot alerts"),
      ]),
    ).toEqual(["exec.jsonl:8 stdout: credential assignment"]);
    expect(planted("gh", ["api", ...PULL])).toEqual([]);
  });

  test("runs visibility checks against the canonical host, without routing variables", () => {
    const env = managedEnv({ GH_HOST: "evil", gitlab_host: "evil", GH_TOKEN: "t", PATH: "/bin" });
    expect(env).toEqual({ PATH: "/bin" });
  });
});

// The Facts files hold the operator's account and auth state as well as public reads: only
// listed public-derived subtrees are exempt from the credential-assignment heuristic.
describe("Facts files", () => {
  const LINE = "CLIENT_SECRET=s3cr3tValue42";
  interface Facts {
    auth: { data: { gh: { detail: string } } };
    github: { data: { repos: Record<string, { body?: string }>; errors?: string[] } };
    account?: { scopes: string };
    radar?: {
      data: { removal: { labels: Record<string, string> }; other?: Record<string, string> };
    };
  }
  const facts = (plant: (facts: Facts) => void) => {
    const dir = copyOfClean();
    setVisibility(dir, "github", "acme/vault", "private");
    const content: Facts = {
      auth: { data: { gh: { detail: "" } } },
      github: { data: { repos: { "acme/widgets": {}, "acme/vault": {} } } },
    };
    plant(content);
    writeFileSync(join(dir, "core-facts.json"), JSON.stringify(content));
    return auditSweep(dir).findings;
  };

  const PROJECT = "osdu/platform/security-and-compliance/secret";
  const labels = (entries: Record<string, string>, f: Facts) => {
    f.radar = { data: { removal: { labels: entries } } };
  };

  test.each(["pending", "established"])("passes an upstream project path at stage %s", (stage) => {
    expect(facts((f) => labels({ [PROJECT]: stage }, f))).toEqual([]);
  });

  test.each([
    ["a planted assignment", { [PROJECT]: LINE }, []],
    ["another stage name", { [PROJECT]: "Pending" }, []],
    ["a token", { [PROJECT]: `ghp_${"x".repeat(36)}` }, ["core-facts.json: GitHub token"]],
    ["a key that is no project path", { CLIENT_SECRET: "pending" }, []],
    ["a single-segment key", { secret: "pending" }, []],
    ["a key with a dot segment", { "osdu/../secret": "pending" }, []],
  ])("fails removal labels holding %s", (_, entries, more) => {
    expect(facts((f) => labels(entries, f))).toEqual([
      ...more,
      "core-facts.json: credential assignment",
    ]);
  });

  test("fails the same project path and stage anywhere else in the Facts", () => {
    expect(facts((f) => (f.account = { scopes: { [PROJECT]: "pending" } as never }))).toEqual([
      "core-facts.json: credential assignment",
    ]);
    expect(
      facts((f) => {
        f.radar = { data: { removal: { labels: {} }, other: { [PROJECT]: "pending" } } };
      }),
    ).toEqual(["core-facts.json: credential assignment"]);
  });

  test("passes a credential assignment read from a public repository", () => {
    expect(facts((f) => ((f.github.data.repos["acme/widgets"] ?? {}).body = LINE))).toEqual([]);
  });

  test.each([
    ["auth detail", (f: Facts) => (f.auth.data.gh.detail = LINE)],
    [
      "a private repository's entry",
      (f: Facts) => ((f.github.data.repos["acme/vault"] ?? {}).body = LINE),
    ],
    ["an unlisted subtree", (f: Facts) => (f.account = { scopes: LINE })],
    ["github data outside repos", (f: Facts) => (f.github.data.errors = [LINE])],
  ])("fails a credential assignment in %s", (_, plant) => {
    expect(facts(plant)).toEqual(["core-facts.json: credential assignment"]);
  });
});

describe("base64 content", () => {
  const LINE = "CLIENT_SECRET=s3cr3tValue42";
  const b64 = (text: string) => Buffer.from(text).toString("base64");
  // GitHub wraps a contents or blob read's base64 at 60 characters.
  const wrapped = (text: string) => b64(text).replace(/.{60}/g, "$&\n");
  const READS = {
    "a GitLab file read": {
      cmd: "glab",
      args: [
        "api",
        ...GITLAB_HOST,
        "projects/osdu%2Fplatform%2Fsystem%2Fwidgets/repository/files/pom.xml?ref=abcdef0",
      ],
      envelope: (content: unknown) => ({ file_name: "pom.xml", encoding: "base64", content }),
    },
    "a GitHub contents read": {
      cmd: "gh",
      args: ["api", "repos/acme/widgets/contents/.github/upstream-filter.yml"],
      envelope: (content: unknown) => ({ path: "x", type: "file", encoding: "base64", content }),
    },
    "a GitHub blob read": {
      cmd: "gh",
      args: ["api", `repos/acme/widgets/git/blobs/${"a".repeat(40)}`],
      envelope: (content: unknown) => ({ sha: "a".repeat(40), encoding: "base64", content }),
    },
  };
  type Read = keyof typeof READS;
  const audited = (read: Read, stdout: string, extra: object = {}) => {
    const dir = copyOfClean();
    const { cmd, args } = READS[read];
    append(dir, { cmd, args, ...ok, stdout, ...extra });
    return auditSweep(dir).findings;
  };
  const encoded = (read: Read, text: string) =>
    JSON.stringify(READS[read].envelope(read === "a GitLab file read" ? b64(text) : wrapped(text)));
  const pom = (inner: string) =>
    `<project>\n${"<!-- padding -->\n".repeat(8)}${inner}\n</project>\n`;
  const reads = Object.keys(READS) as Read[];

  test.each(reads)("passes public content and its credential assignments in %s", (read) => {
    expect(audited(read, encoded(read, pom(`<password>${LINE}</password>`)))).toEqual([]);
  });

  const planted: [string, string, string][] = [
    ["a GitHub token", `<token>${"ghp_"}${"x".repeat(36)}</token>`, "GitHub token"],
    ["a GitLab token", `<token>${"glpat-"}${"y".repeat(20)}</token>`, "GitLab token"],
    [
      "a private key",
      `-----BEGIN ${"RSA "}PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----`,
      "private key",
    ],
    [
      "a JSON web token",
      `eyJ${"a".repeat(10)}.eyJ${"b".repeat(10)}.${"c".repeat(10)}`,
      "JSON web token",
    ],
    ["an email address", "<email>jane@example.com</email>", "email address (1)"],
  ];
  test.each(
    reads.flatMap((read) => planted.map(([what, text, finding]) => [what, read, text, finding])),
  )("fails %s inside the base64 content of %s", (_, read, text, finding) => {
    const stdout = encoded(read as Read, pom(text as string));
    expect(stdout).not.toContain((text as string).slice(0, 12));
    expect(audited(read as Read, stdout)).toEqual([`exec.jsonl:8 stdout: ${finding}`]);
  });

  test("fails a planted token in base64 content inside a Facts file", () => {
    const dir = copyOfClean();
    writeFileSync(
      join(dir, "core-facts.json"),
      JSON.stringify({ note: { encoding: "base64", content: b64(`ghp_${"x".repeat(36)}`) } }),
    );
    expect(auditSweep(dir).findings).toEqual(["core-facts.json: GitHub token"]);
  });

  test("fails a credential assignment in the base64 content of an operator read", () => {
    const dir = copyOfClean();
    append(dir, {
      cmd: "gh",
      args: ["api", "user", "--jq", ".login"],
      ...ok,
      stdout: JSON.stringify({ encoding: "base64", content: b64(LINE) }),
    });
    expect(auditSweep(dir).findings).toEqual(["exec.jsonl:8 stdout: credential assignment"]);
  });

  test.each([
    ["characters outside base64", "not*base64!"],
    ["missing padding", b64("ab").replace(/=+$/, "")],
    ["non-zero padding bits", "YR=="],
    ["a content that is not a string", 42],
    ["no content", undefined],
  ])("fails base64 content with %s", (_, content) => {
    const read = "a GitHub contents read";
    expect(audited(read, JSON.stringify(READS[read].envelope(content)))).toEqual([
      "exec.jsonl:8 stdout: malformed base64 content",
    ]);
  });

  test("fails an envelope in stdout that does not parse as JSON", () => {
    const read = "a GitLab file read";
    expect(audited(read, `${encoded(read, pom("x"))} trailing`)).toEqual([
      "exec.jsonl:8 stdout: malformed base64 content",
      "exec.jsonl:8 stdout: file content: not a JSON object",
    ]);
  });

  describe("a known file-content response", () => {
    const token = () => `<token>${"ghp_"}${"x".repeat(36)}</token>`;
    const envelope = (read: Read, fields: Record<string, unknown>) => {
      const { encoding: _, content: __, ...rest } = READS[read].envelope("");
      return JSON.stringify({ ...rest, ...fields });
    };

    test.each(reads)("passes an error body and a file too large to hold content in %s", (read) => {
      expect(audited(read, JSON.stringify({ message: "Not Found", status: "404" }))).toEqual([]);
      expect(audited(read, envelope(read, { encoding: "none", content: "" }))).toEqual([]);
    });

    test.each(reads)("passes text content that also inflates as raw deflate in %s", (read) => {
      const text = '{\n  "maps": {}\n}\n';
      expect(inflateRawSync(Buffer.from(text)).length).toBeGreaterThan(0);
      expect(audited(read, envelope(read, { encoding: "base64", content: b64(text) }))).toEqual([]);
    });

    test.each(reads)("passes YAML and XML text that quotes an envelope field in %s", (read) => {
      const yaml = 'top_level:\n  "content": shared\n';
      const xml = pom('x<!-- {"content":"generated files"} -->');
      for (const text of [yaml, xml])
        expect(audited(read, envelope(read, { encoding: "base64", content: b64(text) }))).toEqual(
          [],
        );
    });

    // An envelope written with its field names as JSON escapes, as text no regex reads as one.
    const escaped = () => `{"\\u0065ncoding":"utf-8","\\u0063ontent":"${b64(token())}"}`;

    const cases: [string, (read: Read) => string, string][] = [
      [
        "an unsupported encoding",
        (read) => envelope(read, { encoding: "utf-8", content: pom("x") }),
        'unsupported encoding "utf-8"',
      ],
      [
        "an encoding in another case",
        (read) => envelope(read, { encoding: "BASE64", content: b64(pom("x")) }),
        'unsupported encoding "BASE64"',
      ],
      [
        "an encoding that is not a string",
        (read) => envelope(read, { encoding: 64, content: b64(pom("x")) }),
        "unsupported encoding 64",
      ],
      [
        "content without an encoding",
        (read) => envelope(read, { content: b64(token()) }),
        "content without an encoding",
      ],
      [
        "content under encoding none",
        (read) => envelope(read, { encoding: "none", content: b64(token()) }),
        'content under encoding "none"',
      ],
      [
        "gzip-compressed content",
        (read) =>
          envelope(read, { encoding: "base64", content: gzipSync(token()).toString("base64") }),
        "compressed content (gzip)",
      ],
      [
        "zlib-compressed content",
        (read) =>
          envelope(read, { encoding: "base64", content: deflateSync(token()).toString("base64") }),
        "compressed content (zlib)",
      ],
      [
        "double-encoded base64",
        (read) => envelope(read, { encoding: "base64", content: b64(b64(token())) }),
        "double-encoded base64",
      ],
      [
        "an envelope inside base64 content",
        (read) =>
          envelope(read, {
            encoding: "base64",
            content: b64(JSON.stringify({ encoding: "base64", content: b64(token()) })),
          }),
        "double-encoded base64",
      ],
      [
        "a JSON-string-wrapped envelope",
        (read) => JSON.stringify(encoded(read, token())),
        "JSON-string-wrapped envelope",
      ],
      ["a JSON value that is not an object", () => "42", "not a JSON object"],
      ...[9, 10, 11, 12, 13, 14, 15].map((windowBits): [string, (read: Read) => string, string] => [
        `zlib-compressed content with windowBits ${windowBits}`,
        (read) =>
          envelope(read, {
            encoding: "base64",
            content: deflateSync(token(), { windowBits }).toString("base64"),
          }),
        "compressed content (zlib)",
      ]),
      [
        "raw deflate content",
        (read) =>
          envelope(read, {
            encoding: "base64",
            content: deflateRawSync(token()).toString("base64"),
          }),
        "compressed content (deflate)",
      ],
      [
        "a nested envelope with an unsupported encoding",
        () => JSON.stringify({ data: { encoding: "utf-8", content: b64(token()) } }),
        'unsupported encoding "utf-8"',
      ],
      [
        "nested content without an encoding",
        () => JSON.stringify({ data: [{ content: b64(token()) }] }),
        "content without an encoding",
      ],
      [
        "a nested envelope of double-encoded base64",
        () => JSON.stringify({ data: { encoding: "base64", content: b64(b64(token())) } }),
        "double-encoded base64",
      ],
      [
        "a nested envelope of gzip-compressed content",
        () =>
          JSON.stringify({
            data: { encoding: "base64", content: gzipSync(token()).toString("base64") },
          }),
        "compressed content (gzip)",
      ],
      [
        "a nested JSON-string-wrapped envelope",
        (read) => JSON.stringify({ data: encoded(read, token()) }),
        "JSON-string-wrapped envelope",
      ],
      [
        "an envelope behind escapes inside base64 content",
        (read) =>
          envelope(read, {
            encoding: "base64",
            content: b64(
              JSON.stringify(JSON.stringify({ encoding: "utf-8", content: b64(token()) })),
            ),
          }),
        "double-encoded base64",
      ],
      [
        "a JSON string holding an envelope with escaped field names",
        () => JSON.stringify({ data: escaped() }),
        "JSON-string-wrapped envelope",
      ],
      [
        "base64 content holding an envelope with escaped field names",
        (read) => envelope(read, { encoding: "base64", content: b64(escaped()) }),
        "double-encoded base64",
      ],
      ["raw base64 stdout", () => b64(token()), "not a JSON object"],
      ["an empty array", () => "[]", "not a JSON object"],
      ["an array-wrapped envelope", (read) => `[${encoded(read, pom("x"))}]`, "not a JSON object"],
    ];
    test.each(
      reads.flatMap((read) =>
        cases.map(([what, stdout, finding]) => [what, read, stdout, finding]),
      ),
    )("fails %s in %s", (_, read, stdout, finding) => {
      const out = (stdout as (read: Read) => string)(read as Read);
      expect(out).not.toContain("ghp_");
      expect(audited(read as Read, out)).toEqual([`exec.jsonl:8 stdout: file content: ${finding}`]);
    });

    test("leaves other reads' encodings to the detectors", () => {
      const dir = copyOfClean();
      append(dir, {
        cmd: "gh",
        args: ["api", "user", "--jq", ".login"],
        ...ok,
        stdout: JSON.stringify({ encoding: "utf-8", content: "octo" }),
      });
      expect(auditSweep(dir).findings).toEqual([]);
    });
  });
});

describe("record-sweep", () => {
  test("refuses to record into a directory that holds anything", () => {
    const dir = mkdtempSync(join(tmpdir(), "spicode-out-"));
    temps.push(dir);
    writeFileSync(join(dir, "keep.txt"), "mine");
    expect(() => prepareOut(dir)).toThrow(/not empty/);
    expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("mine");
    const fresh = join(dir, "sub", "sweep");
    prepareOut(fresh);
    expect(existsSync(fresh)).toBe(true);
    mkdirSync(join(dir, "empty"));
    prepareOut(join(dir, "empty"));
  });
});
