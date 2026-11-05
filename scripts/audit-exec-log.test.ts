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
import { afterEach, describe, expect, test } from "vitest";
import {
  auditSweep,
  callTargets,
  fenceMessage,
  JWT_MARK,
  NOT_PUBLIC,
  references,
  scrubEmails,
  scrubJwts,
  sweepReferences,
} from "./audit-exec-log.js";
import { prepareOut } from "./record-sweep.js";

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

  test("fails a log that leaks an email address and a private repository", () => {
    expect(auditSweep(join(AUDIT, "leaky")).findings).toEqual([
      "exec.jsonl:4 stdout: email address (1)",
      "github acme/secret-plans: private",
    ]);
  });

  test("fails a copy of a clean log with a token planted in it", () => {
    const dir = copyOfClean();
    plant(dir, 0, "Token: <redacted>", `Token: ${"ghp_"}${"x".repeat(36)}`);
    expect(auditSweep(dir).findings).toEqual(["exec.jsonl:1 stdout: GitHub token"]);
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
    expect(auditSweep(dir).findings).toEqual([
      "exec.jsonl:2 args[2]: authorization header",
      "exec.jsonl:2 args[2]: bearer credential",
      "github elsewhere/gadgets: not checked at record time",
    ]);
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
    const releases = { cmd: "gh", args: ["api", "repos/acme/vault/releases"], stdin: null, ms: 0 };
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

  test("reads the repository names a recorded call carries", () => {
    const refs = references(
      'repos/a/b/pulls repository(owner: "c", name: "d") projects/x%2Fy%2Fz fullPath: "p/q"',
    );
    expect([...refs.github].sort()).toEqual(["a/b", "c/d"]);
    expect([...refs.gitlab].sort()).toEqual(["p/q", "x/y/z"]);
  });
});

// Every call shape the recorder emits, as recorded on 2026-11-05, with what it names.
const GITLAB_HOST = ["--hostname", "community.opengroup.org"];
const SHAPES: {
  cmd: string;
  args: string[];
  github?: string[];
  gitlab?: string[];
  groups?: string[];
}[] = [
  { cmd: "gh", args: ["auth", "status", "--hostname", "github.com"] },
  { cmd: "glab", args: ["auth", "status", ...GITLAB_HOST] },
  { cmd: "gh", args: ["api", "user", "--jq", ".login"] },
  {
    cmd: "gh",
    args: [
      "api",
      "repos/Azure/osdu-spi-partition/actions/workflows/sync.yml/runs?per_page=10",
      "--jq",
      "{total: .total_count}",
    ],
    github: ["Azure/osdu-spi-partition"],
  },
  {
    cmd: "gh",
    args: [
      "api",
      "--paginate",
      "repos/Azure/osdu-spi-stack/pulls?state=open&per_page=100",
      "--jq",
      ".[] | {number}",
    ],
    github: ["Azure/osdu-spi-stack"],
  },
  {
    cmd: "gh",
    args: ["api", "--allow-escape-sequences", "repos/Azure/osdu-spi-stack/actions/jobs/1/logs"],
    github: ["Azure/osdu-spi-stack"],
  },
  {
    cmd: "gh",
    args: ["api", "repos/Azure/osdu-spi/contents/.github/x.yml"],
    github: ["Azure/osdu-spi"],
  },
  {
    cmd: "gh",
    args: [
      "api",
      "graphql",
      "-f",
      'query=query { spicodeBudget: rateLimit { cost remaining resetAt }  template: repository(owner: "Azure", name: "osdu-spi") { object(expression: "main:x") { ... on Blob { text } } } r1: repository(owner: "Azure", name: "osdu-spi-stack") { createdAt } }',
    ],
    github: ["Azure/osdu-spi", "Azure/osdu-spi-stack"],
  },
  {
    cmd: "gh",
    args: [
      "api",
      "graphql",
      "-f",
      'query=query { port_o0: search(query: "repo:Azure/osdu-spi-partition is:pr is:open", type: ISSUE, first: 100) { issueCount } }',
    ],
    github: ["Azure/osdu-spi-partition"],
  },
  {
    cmd: "glab",
    args: [
      "api",
      ...GITLAB_HOST,
      "projects/osdu%2Fplatform%2Fsystem%2Fpartition/repository/branches/master",
    ],
    gitlab: ["osdu/platform/system/partition"],
  },
  {
    cmd: "glab",
    args: [
      "api",
      ...GITLAB_HOST,
      "groups/osdu%2Fplatform/issues?labels=SPI%20fork%3A%3Apending&state=all",
    ],
    groups: ["osdu/platform"],
  },
  {
    cmd: "glab",
    args: [
      "api",
      "graphql",
      ...GITLAB_HOST,
      "-f",
      'query=query { p0: project(fullPath: "osdu/platform/system/partition") { mergeRequests(state: merged, first: 100) { nodes { iid } } } }',
    ],
    gitlab: ["osdu/platform/system/partition"],
  },
];

const sorted = (set: Set<string> | undefined) => [...(set ?? [])].sort();

describe("call shapes", () => {
  test.each(SHAPES)(
    "$cmd $args.0 $args.1 names what it reads",
    ({ cmd, args, github, gitlab, groups }) => {
      const targets = callTargets(cmd, args);
      expect(targets).toBeDefined();
      expect(sorted(targets?.github)).toEqual(github ?? []);
      expect(sorted(targets?.gitlab)).toEqual(gitlab ?? []);
      expect(sorted(targets?.gitlabGroups)).toEqual(groups ?? []);
    },
  );

  test("reads repositories named by bare arguments and GraphQL variables", () => {
    expect(sorted(callTargets("gh", ["repo", "view", "acme/vault"])?.github)).toEqual([
      "acme/vault",
    ]);
    expect(sorted(callTargets("gh", ["pr", "list", "-R", "acme/vault"])?.github)).toEqual([
      "acme/vault",
    ]);
    expect(sorted(callTargets("glab", ["repo", "view", "a/b/c"])?.gitlab)).toEqual(["a/b/c"]);
    const query =
      "query=query($o: String!, $n: String!) { repository(owner: $o, name: $n) { id } }";
    expect(
      sorted(
        callTargets("gh", ["api", "graphql", "-f", query, "-f", "o=acme", "-F", "n=vault"])?.github,
      ),
    ).toEqual(["acme/vault"]);
  });

  test.each([
    ["gh", ["api", "orgs/acme/repos"]],
    ["gh", ["pr", "list"]],
    ["gh", ["auth", "token"]],
    ["gh", ["api", "graphql", "-f", "query={ repository(owner: $o, name: $n) { id } }"]],
    [
      "gh",
      [
        "api",
        "graphql",
        "-f",
        'query={ organization(login: "acme") { repositories(first: 9) { nodes { name } } } }',
      ],
    ],
    [
      "gh",
      [
        "api",
        "graphql",
        "-f",
        'query={ search(query: "org:acme", type: REPOSITORY, first: 9) { repositoryCount } }',
      ],
    ],
    ["gh", ["api", "--input", "-", "repos/acme/widgets/issues"]],
    ["glab", ["api", "repos/acme/widgets"]],
    ["git", ["clone", "https://github.com/acme/vault"]],
  ])("refuses to vouch for %s %j", (cmd, args) => {
    expect(callTargets(cmd, args)).toBeUndefined();
  });

  const local = join(import.meta.dirname, "..", "fixtures", "exec", "local");
  const recorded = existsSync(local)
    ? readdirSync(local)
        .filter((name) => /^sweep-/.test(name))
        .map((name) => join(local, name))
    : [];
  test.skipIf(!recorded.length)("every call in a local recording is a known shape", () => {
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

describe("references in text", () => {
  test.each([
    ["https://github.com/acme/vault", "acme/vault"],
    ["clone github.com/acme/vault.git.", "acme/vault"],
    ["git@github.com:acme/vault.git", "acme/vault"],
    ["ssh://git@github.com/acme/vault", "acme/vault"],
    ["https://github.com/acme/vault/wiki/Home", "acme/vault"],
    ['search(query: \\"repo:acme/vault is:pr\\")', "acme/vault"],
    ["https://raw.githubusercontent.com/acme/vault/main/x.yml", "acme/vault"],
    ['repository(name: "vault", owner: "acme")', "acme/vault"],
  ])("GitHub: %s", (text, name) => {
    expect(sorted(references(text).github)).toEqual([name]);
  });

  test("skips GitHub's own pages", () => {
    expect(
      sorted(references("https://github.com/orgs/acme/people github.com/settings/tokens").github),
    ).toEqual([]);
  });

  test.each([
    ["https://community.opengroup.org/a/b/-/merge_requests/1", ["a/b"], []],
    ["git@community.opengroup.org:a/b.git", ["a/b"], ["a"]],
    ["https://community.opengroup.org/a/b/c", ["a/b", "a/b/c"], ["a", "a/b"]],
    ["https://community.opengroup.org/groups/a/b/-/issues", [], ["a/b"]],
    ["glab api groups/a%2Fb/issues", [], ["a/b"]],
    ['group(fullPath: \\"a/b\\")', [], ["a/b"]],
    ['project(fullPath: "a/b")', ["a/b"], []],
  ])("GitLab: %s", (text, projects, groups) => {
    const refs = references(text);
    expect(sorted(refs.gitlab)).toEqual(projects);
    expect(sorted(refs.gitlabGroups)).toEqual(groups);
  });
});

describe("audit of shapes, decoded strings and new credentials", () => {
  test("fails a private repository read by a bare argument", () => {
    const dir = copyOfClean();
    setVisibility(dir, "github", "acme/vault", "private");
    append(dir, { cmd: "gh", args: ["repo", "view", "acme/vault"], ...ok, stdout: "{}" });
    expect(auditSweep(dir).findings).toEqual(["github acme/vault: private"]);
  });

  test("fails a private repository read through GraphQL variables", () => {
    const dir = copyOfClean();
    setVisibility(dir, "github", "acme/vault", "private");
    append(dir, {
      cmd: "gh",
      args: [
        "api",
        "graphql",
        "-f",
        "query=query($o: String!, $n: String!) { repository(owner: $o, name: $n) { id } }",
        "-f",
        "o=acme",
        "-f",
        "n=vault",
      ],
      ...ok,
      stdout: "{}",
    });
    expect(auditSweep(dir).findings).toEqual(["github acme/vault: private"]);
  });

  test("fails a private repository a call reads by its clone URL", () => {
    const dir = copyOfClean();
    setVisibility(dir, "github", "acme/vault", "private");
    append(dir, {
      cmd: "git",
      args: ["ls-remote", "git@github.com:acme/vault.git"],
      ...ok,
      stdout: "",
    });
    expect(auditSweep(dir).findings).toEqual(["github acme/vault: private"]);
  });

  test("fails a call whose shape it cannot read", () => {
    const dir = copyOfClean();
    append(dir, { cmd: "gh", args: ["api", "orgs/acme/repos"], ...ok, stdout: "[]" });
    expect(auditSweep(dir).findings).toEqual([
      "exec.jsonl:5: unrecognised call gh api orgs/acme/repos",
    ]);
  });

  test("fails a private GitLab group", () => {
    const dir = copyOfClean();
    setVisibility(dir, "gitlabGroups", "osdu/secret", "private");
    append(dir, {
      cmd: "glab",
      args: ["api", ...GITLAB_HOST, "groups/osdu%2Fsecret/issues"],
      ...ok,
      stdout: "[]",
    });
    expect(auditSweep(dir).findings).toEqual(["gitlab group osdu/secret: private"]);
  });

  test("fails credentials and emails hidden behind JSON escapes", () => {
    const dir = copyOfClean();
    plant(dir, 1, '\\"login\\": \\"octo\\"', '\\"login\\": \\"jane\\\\u0040example.com\\"');
    append(dir, {
      cmd: "gh",
      args: ["api", "repos/acme/widgets/issues"],
      ...ok,
      stdout: JSON.stringify({ body: `{"t": "ghp\\u005f${"x".repeat(36)}"}` }),
    });
    expect(auditSweep(dir).findings).toEqual([
      "exec.jsonl:2 stdout: email address (1)",
      "exec.jsonl:5 stdout: GitHub token",
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
      args: ["api", ...GITLAB_HOST, `${widgets}/issues`],
      ...ok,
      stdout: JSON.stringify([{ description: "Fork: https://github.com/acme/vault" }]),
    });
    append(dir, {
      cmd: "gh",
      args: ["api", "repos/acme/widgets/forks"],
      ...ok,
      stdout: JSON.stringify([
        { full_name: "acme/vault" },
        { body: "Upstream: https://community.opengroup.org/osdu/secret/thing/-/issues/1" },
      ]),
    });
    setVisibility(dir, "github", "acme/vault", "private");
    setVisibility(dir, "gitlab", "osdu/secret/thing", "private");
    expect(auditSweep(dir).findings).toEqual([]);
    expect(sweepReferences(dir).github.has("acme/vault")).toBe(false);
    append(dir, { cmd: "gh", args: ["api", "repos/acme/vault/forks"], ...ok, stdout: "[]" });
    append(dir, {
      cmd: "glab",
      args: ["api", ...GITLAB_HOST, "projects/osdu%2Fsecret%2Fthing/issues"],
      ...ok,
      stdout: "[]",
    });
    expect(auditSweep(dir).findings).toEqual([
      "github acme/vault: private",
      "gitlab osdu/secret/thing: private",
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

  test.each([
    "password = getPassword()",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell placeholder, not a template
    "password=${PASSWORD}",
    "secret=<redacted>",
    "String password = userPassword;",
    // A diff nested in JSON: its escaped newlines and brackets still end the value.
    String.raw`-db.password=TODO\\n-server.port=8080`,
    String.raw`-AZURE_CLIENT_SECRET=\\u003cclient_secret\\u003e\\n-PORT=8080`,
    // Explicit placeholder forms.
    "password=<your-password>",
    "password={{ .Values.password }}",
    "password=xxxxxxxx",
    "password=********",
    "password=changeme",
    "password=TODO",
    "password=",
    "api_key=your_api_key_here",
    // Code that reads a credential from a property, or a statement that copies a variable.
    "PASSWORD=config.dbPassword",
    "API_KEY=process.env.API_KEY",
    "apiKey = this.config.apiKey;",
  ])("passes code that names a credential without holding one: %s", (text) => {
    const dir = copyOfClean();
    plant(dir, 0, "Token: <redacted>", `Token: <redacted> ${text}`);
    expect(auditSweep(dir).findings).toEqual([]);
  });
});

// A .env file in a diff nested in JSON: a mixed-case value is a password, not a code reference.
test.each(["PASSWORD", "Password", "pAsSwOrD", "Client_Secret", "API_KEY"])(
  "fails %s=monKey in a JSON-wrapped .env diff",
  (key) => {
    const dir = copyOfClean();
    append(dir, {
      cmd: "glab",
      args: [
        "api",
        ...GITLAB_HOST,
        "projects/osdu%2Fplatform%2Fsystem%2Fwidgets/repository/commits/abc/diff",
      ],
      ...ok,
      stdout: JSON.stringify({ diff: `+.env\n+${key}=monKey\n` }),
    });
    const { findings } = auditSweep(dir);
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) expect(finding).toMatch(/ stdout: credential assignment$/);
  },
);

// Values the live sweep recorded that are not secrets; each is exempt by name.
test.each(["AUTHORIZE_API_KEY=tobeupdated", String.raw`export CLIENT_SECRET=\"client-secret\"`])(
  "passes a false positive seen in the recorded sweep: %s",
  (text) => {
    const dir = copyOfClean();
    plant(dir, 0, "Token: <redacted>", `Token: <redacted> ${text}`);
    expect(auditSweep(dir).findings).toEqual([]);
  },
);

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
