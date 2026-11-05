// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

/** Audit a recorded exec log before it may leave this machine:
 *   bun scripts/audit-exec-log.ts <sweep directory>
 * The directory holds exec.jsonl and the visibility.json written at record time. Every
 * recorded call, a fenced one included, must match the allowlist of shapes the sweep issues
 * (REST_SHAPES, FIXED_SHAPES, GRAPHQL_BLOCKS with FRAGMENT_HASHES) on the host the sweep uses,
 * and may target only repositories, projects and groups that were public when the log was
 * recorded: no recorded call reads a private repository. A call the recorder fenced read
 * nothing and may name the one private repository it refused. Repository names are allowed
 * anywhere (maintainer decision, 2026-11-05).
 * Every recorded field of every file, visibility.json included, is scanned for tokens, keys
 * and email addresses, as written, with its JSON strings decoded and with the base64 content
 * of its API envelopes decoded; an envelope that does not decode is itself a finding. The credential-assignment
 * heuristic guards what the operator's side wrote, so it skips only public repository content:
 * the stdout of a public-content shape whose every target is public, a GraphQL response's
 * public-content blocks whose targets are public, and the Facts' github.data.repos entries of
 * public repositories. Exits 1 with one line per finding.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LOG_FILE = "exec.jsonl";
export const VISIBILITY_FILE = "visibility.json";
export const EMAIL_MARK = "<email>";
export const JWT_MARK = "<jwt>";
// The recorder refuses, without running it, any call that names a repository that is not public.
export const FENCE_MARK = "spi-code record fence:";

const JWT_SOURCE = "\\beyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}";
const FIELDS = ["cmd", "args", "stdin", "stdout", "stderr", "exit", "ms", "error"] as const;

// A credential-named key: a name holding one of these words as a whole part, split at
// non-letters and camel humps, in any case (KEY, API_KEY, apiKey, client_secret, pAsSwOrD).
// The pattern is case-sensitive so a camel hump can be told apart.
const anyCase = (words: string) =>
  words.replace(/[A-Za-z]/g, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
const CREDENTIAL_WORD = anyCase(
  "password|passwd|pwd|secret|token|credential|auth|api_?key|access_?key|key",
);
const CREDENTIAL_KEY = String.raw`(?:(?<![A-Za-z0-9])|(?<=[a-z0-9])(?=[A-Z]))(?:${CREDENTIAL_WORD})[sS]?(?![a-z])(?!(?<=[A-Z])[A-Z])[\w.-]*`;
// k=v, k = v, export k=v, k: v, "k": "v", 'k': 'v', quoted or not, JSON-escaped or not.
const ASSIGN = String.raw`\\?["']?[ \t]*[:=][ \t]*\\?["']?`;
// Any non-empty value. Only an empty one (a quote, separator or line end) and a nested mapping
// or list, whose members are scanned on their own, are not values.
const VALUE = String.raw`(?![\s"'\`,;&)}\]]|\\[nrtbfu"'/\\]|\{(?!\{)|\[|$)`;
const GITHUB_PREFIX = "(?:gh[opsur]_|github_pat_)";
const GITLAB_PREFIX = "gl(?:pat|dt|rt|cbt|ptt|ft|imt|agent|soat)-";
// The CLI's own mask of a token it holds (gh auth status prints gho_ and asterisks): a token
// prefix followed by asterisks only, up to the end of the value.
const CLI_MASK = String.raw`(?:${GITHUB_PREFIX}|${GITLAB_PREFIX})\*+(?=[\s"'\\]|$)`;

export const TOKEN_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: "GitHub token", pattern: new RegExp(`${GITHUB_PREFIX}[A-Za-z0-9_]{8,}`) },
  { name: "GitLab token", pattern: new RegExp(`${GITLAB_PREFIX}[A-Za-z0-9_-]{8,}`) },
  {
    name: "authorization header",
    pattern:
      /authorization\\?["']?\s*[:=]\s*\\?["']?(?!<redacted>)(?:basic|bearer|token)\s+[^\s"'\\<]{8,}/i,
  },
  { name: "bearer credential", pattern: /\bbearer\s+(?!<redacted>)[A-Za-z0-9._~+/=-]{16,}/i },
  { name: "JSON web token", pattern: new RegExp(JWT_SOURCE) },
  { name: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "Azure SAS signature", pattern: /[?&]sig=[A-Za-z0-9%/+=]{20,}/ },
  { name: "Azure storage key", pattern: /AccountKey=[A-Za-z0-9+/=]{20,}/ },
  { name: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "Slack token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
];

/** A credential-named key assigned any non-empty value, in any of the forms ASSIGN reads,
 * anywhere in the text: no value is exempt for its shape. Only the recorder's own <redacted>
 * mark and a CLI's own token mask are not values. It guards what the operator's side wrote, so
 * it skips the content of public repositories (see scan); the TOKEN_PATTERNS run everywhere. */
export const CREDENTIAL_ASSIGNMENT = {
  name: "credential assignment",
  pattern: new RegExp(`${CREDENTIAL_KEY}${ASSIGN}(?!<redacted>)(?!${CLI_MASK})${VALUE}`, "m"),
};

/** Files derived only from reads the audit passed: their text is public repository content. */
export const FACTS_FILES: ReadonlySet<string> = new Set(["core-facts.json", "rib-facts.json"]);

// An address starts where a local part can; git@<forge> is a clone address, not a person's.
const EMAIL =
  /(?<![A-Za-z0-9._%+-])(?!git@(?:github\.com|community\.opengroup\.org)\b)[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** Replaces email addresses, keeping any JSON escape the match would otherwise cut. */
export function scrubEmails(text: string): string {
  return text.replace(EMAIL, (match, offset: number) => {
    if (text[offset - 1] !== "\\") return EMAIL_MARK;
    const kept = /^u[0-9A-Fa-f]{4}/.exec(match)?.[0] ?? match[0] ?? "";
    return `${kept}${EMAIL_MARK}`;
  });
}

const JWT = new RegExp(JWT_SOURCE, "g");

/** Replaces JSON web tokens; public merge request diffs carry sample ones. */
export function scrubJwts(text: string): string {
  return text.replace(JWT, JWT_MARK);
}

/** What a fenced call returns in place of running: the one line that names why. */
export function fenceMessage(what: string, why: string): string {
  return `${FENCE_MARK} ${what} ${why}; not read\n`;
}

export const NOT_PUBLIC = "is not public";

/** A call the recorder refused without running: it returned no output. */
export function fenced(entry: { stdout?: unknown; stderr?: unknown; exit?: unknown }): boolean {
  return (
    entry.stdout === "" &&
    entry.exit === 1 &&
    typeof entry.stderr === "string" &&
    entry.stderr.startsWith(FENCE_MARK)
  );
}

export interface References {
  github: Set<string>;
  gitlab: Set<string>;
  gitlabGroups: Set<string>;
}

export function noReferences(): References {
  return { github: new Set(), gitlab: new Set(), gitlabGroups: new Set() };
}

function merge(into: References, from: References): References {
  for (const key of ["github", "gitlab", "gitlabGroups"] as const)
    for (const name of from[key]) into[key].add(name);
  return into;
}

// The allowlist: every command shape the recorded sweep issues, each with its class. A
// public-content shape reads repository content only; its stdout skips the credential
// assignment heuristic when every repository it reads was public. An operator shape reads what
// the account holds or sees (auth, alerts, variables, issues that may be confidential) and is
// scanned in full. Any other command is unrecognized, and fails the audit.
export type CallClass = "public-content" | "operator";

/** One block of a GraphQL document: the response key it fills, and what it reads. */
export interface GraphqlBlock {
  key: string;
  shape: string;
  class: CallClass;
  targets: References;
}

export interface Classified {
  shape: string;
  class: CallClass;
  targets: References;
  /** A GraphQL call's blocks, one per response key; its exemption is decided per block. */
  blocks?: GraphqlBlock[];
}

export interface Refused {
  refused: "unrecognized command" | "host override";
  detail: string;
}

export const GITHUB_HOST = "github.com";
export const GITLAB_HOST = "community.opengroup.org";
const CANONICAL_HOST: Record<string, string> = { gh: GITHUB_HOST, glab: GITLAB_HOST };
/** Environment variables that route gh or glab to another host or account. */
export const HOST_VARIABLES = [
  "GH_HOST",
  "GITLAB_HOST",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_CONFIG_DIR",
] as const;

const NAME = "[A-Za-z0-9_.-]+";
const ENCODED = "[A-Za-z0-9_.%-]+";
const REF = "[A-Za-z0-9_.%-]+";
const SHA = "[0-9a-f]{7,40}";
const N = "\\d+";
const REPO = `repos/(?<owner>${NAME})/(?<repo>${NAME})/`;
const PROJECT = `projects/(?<project>${ENCODED})/`;
const GROUP = `groups/(?<group>${ENCODED})/`;
const GITLAB_PAGE = `per_page=${N}&page=${N}`;

const RUN_FIELDS =
  "{id, name, path, event, status, conclusion, created_at, updated_at, head_branch, head_sha, display_title, html_url, run_attempt}";
const RUNS_JQ = `{total: .total_count, runs: [.workflow_runs[] | ${RUN_FIELDS}]}`;
const JOB_JQ =
  "{id, name, status, conclusion, started_at, completed_at, html_url, run_attempt, steps: [(.steps // [])[] | {number, name, status, conclusion, started_at, completed_at}]}";
const COMPARE_JQ =
  "{status, ahead_by, behind_by, total_commits, commits: [.commits[] | {sha, parents: [.parents[].sha], message: .commit.message, date: .commit.committer.date, url: .html_url}]}";
const SYNC_CONFIG_JQ =
  '.content | gsub("\\n"; "") | @base64d | fromjson | .sync_rules | {dirs: [.directories[]?.path], files: ([.files[]?.path] + [.workflows.template_workflows[]?.path])}';
const DEPENDABOT_JQ =
  ".[] | {number, severity: .security_advisory.severity, package: .dependency.package.name, ecosystem: .dependency.package.ecosystem, manifest: .dependency.manifest_path, scope: .dependency.scope, fixed: .security_vulnerability.first_patched_version.identifier, advisory: .security_advisory.ghsa_id, cve: .security_advisory.cve_id, summary: .security_advisory.summary, url: .html_url, createdAt: .created_at}";
const CODE_SCANNING_JQ =
  ".[] | {number, severity: .rule.security_severity_level, ruleSeverity: .rule.severity, rule: .rule.id, description: .rule.description, tool: .tool.name, path: .most_recent_instance.location.path, url: .html_url, createdAt: .created_at}";

type Mode = "rest" | "pages" | "text";
interface RestShape {
  id: string;
  cmd: "gh" | "glab";
  mode: Mode;
  path: RegExp;
  /** The exact jq filter; none means the call takes none. */
  jq?: string;
  class: CallClass;
}

function shape(
  id: string,
  cmd: "gh" | "glab",
  mode: Mode,
  path: string,
  jq?: string,
  cls: CallClass = "public-content",
): RestShape {
  return { id, cmd, mode, path: new RegExp(`^${path}$`), ...(jq ? { jq } : {}), class: cls };
}

/** The REST shapes, from packages/core/src/forge.ts and collect/**: path, exact jq, class. */
export const REST_SHAPES: readonly RestShape[] = [
  shape(
    "runs",
    "gh",
    "rest",
    `${REPO}actions/workflows/(?:sync|sync-template|cascade)\\.yml/runs\\?per_page=${N}(?:&page=${N})?`,
    RUNS_JQ,
  ),
  shape(
    "validate runs",
    "gh",
    "rest",
    `${REPO}actions/workflows/validate\\.yml/runs\\?branch=main&event=push&per_page=${N}(?:&page=${N})?`,
    RUNS_JQ,
  ),
  shape(
    "waiting runs",
    "gh",
    "rest",
    `${REPO}actions/runs\\?status=action_required&per_page=${N}(?:&page=${N})?`,
    RUNS_JQ,
  ),
  shape(
    "lifecycle runs",
    "gh",
    "rest",
    `${REPO}actions/workflows/(?:env-refresh|env-upgrade|smoke|sweeper)\\.yml/runs\\?per_page=${N}&created=%3E%3D\\d{4}-\\d\\d-\\d\\d&page=${N}`,
    RUNS_JQ,
  ),
  shape("run", "gh", "rest", `${REPO}actions/runs/${N}`, RUN_FIELDS),
  shape(
    "run jobs",
    "gh",
    "rest",
    `${REPO}actions/runs/${N}/attempts/${N}/jobs\\?per_page=${N}&page=${N}`,
    `{total: .total_count, jobs: [.jobs[] | ${JOB_JQ}]}`,
  ),
  shape("job", "gh", "rest", `${REPO}actions/jobs/${N}`, JOB_JQ),
  shape("job log", "gh", "text", `${REPO}actions/jobs/${N}/logs`),
  shape(
    "annotations",
    "gh",
    "pages",
    `${REPO}check-runs/${N}/annotations\\?per_page=${N}`,
    ".[] | {level: .annotation_level, title, message}",
  ),
  shape(
    "declaration",
    "gh",
    "rest",
    `${REPO}contents/ops/environments/shared\\.yaml\\?ref=${SHA}`,
    "{text: (.content | @base64d)}",
  ),
  shape(
    "open pulls",
    "gh",
    "pages",
    `${REPO}pulls\\?state=open&per_page=${N}`,
    ".[] | {number, title, url: .html_url, author: .user.login, association: .author_association, draft, sha: .head.sha}",
  ),
  shape(
    "pull files",
    "gh",
    "pages",
    `${REPO}pulls/${N}/files\\?per_page=${N}`,
    ".[] | {path: .filename, additions, deletions}",
  ),
  shape(
    "pull",
    "gh",
    "rest",
    `${REPO}pulls/${N}`,
    "{changed: .changed_files, additions, deletions, sha: .head.sha}",
  ),
  shape(
    "pull commits",
    "gh",
    "pages",
    `${REPO}pulls/${N}/commits\\?per_page=${N}`,
    ".[].commit.message | tojson",
  ),
  shape("tags", "gh", "pages", `${REPO}tags\\?per_page=${N}`, "[.[].name]"),
  shape(
    "compare position",
    "gh",
    "rest",
    `${REPO}compare/${REF}\\.\\.\\.${REF}`,
    "{status, ahead_by, behind_by}",
  ),
  shape(
    "compare commits",
    "gh",
    "rest",
    `${REPO}compare/${REF}\\.\\.\\.${REF}\\?per_page=${N}&page=${N}`,
    COMPARE_JQ,
  ),
  shape(
    "compare files",
    "gh",
    "rest",
    `${REPO}compare/${REF}\\.\\.\\.${REF}`,
    "[.files[]?.filename]",
  ),
  shape(
    "sync config",
    "gh",
    "rest",
    `${REPO}contents/\\.github/sync-config\\.json\\?ref=${REF}`,
    SYNC_CONFIG_JQ,
  ),
  shape("upstream filter", "gh", "rest", `${REPO}contents/\\.github/upstream-filter\\.yml`),
  shape("blob", "gh", "rest", `${REPO}git/blobs/${SHA}`),
  shape(
    "tree",
    "gh",
    "rest",
    `${REPO}git/trees/${REF}\\?recursive=1`,
    "{paths: [.tree[].path], truncated: .truncated}",
  ),
  shape(
    "releases",
    "gh",
    "pages",
    `${REPO}releases\\?per_page=${N}`,
    '.[] | select(.draft | not) | {tag: .tag_name, at: (.published_at // .created_at), body: (.body // "")}',
  ),
  shape(
    "integration head",
    "gh",
    "rest",
    `${REPO}commits/fork_integration`,
    "{sha: .sha, at: .commit.committer.date}",
  ),
  shape(
    "dependabot alerts",
    "gh",
    "pages",
    `${REPO}dependabot/alerts\\?state=open&per_page=${N}`,
    DEPENDABOT_JQ,
    "operator",
  ),
  shape(
    "code scanning alerts",
    "gh",
    "pages",
    `${REPO}code-scanning/alerts\\?state=open&per_page=${N}`,
    CODE_SCANNING_JQ,
    "operator",
  ),
  shape(
    "variables",
    "gh",
    "rest",
    `${REPO}actions/variables\\?per_page=${N}&page=${N}`,
    undefined,
    "operator",
  ),
  shape("user", "gh", "rest", "user", ".login", "operator"),
  shape("upstream branch", "glab", "rest", `${PROJECT}repository/branches/master`),
  shape("upstream compare", "glab", "rest", `${PROJECT}repository/compare\\?from=${SHA}&to=${SHA}`),
  shape(
    "open merge requests",
    "glab",
    "rest",
    `${PROJECT}merge_requests\\?state=opened&target_branch=master&${GITLAB_PAGE}`,
  ),
  shape(
    "merge request diffs",
    "glab",
    "rest",
    `${PROJECT}merge_requests/${N}/diffs\\?${GITLAB_PAGE}`,
  ),
  shape("commit diff", "glab", "rest", `${PROJECT}repository/commits/${SHA}/diff\\?${GITLAB_PAGE}`),
  shape("upstream pom", "glab", "rest", `${PROJECT}repository/files/pom\\.xml\\?ref=${SHA}`),
  shape("upstream tags", "glab", "rest", `${PROJECT}repository/tags\\?${GITLAB_PAGE}`),
  shape(
    "upstream tree",
    "glab",
    "rest",
    `${PROJECT}repository/tree\\?ref=master(?:&path=${ENCODED})?&${GITLAB_PAGE}`,
  ),
  shape(
    "removal issues",
    "glab",
    "rest",
    `${GROUP}issues\\?labels=${ENCODED}&state=all&${GITLAB_PAGE}`,
    undefined,
    "operator",
  ),
];

/** Commands with no path: the CLIs' own sign-in checks. */
export const FIXED_SHAPES: readonly { cmd: string; args: readonly string[]; id: string }[] = [
  { cmd: "gh", args: ["auth", "status", "--hostname", GITHUB_HOST], id: "gh auth status" },
  { cmd: "glab", args: ["auth", "status", "--hostname", GITLAB_HOST], id: "glab auth status" },
];

// GraphQL: each block of a document matches one template over its canonical text (comments,
// whitespace and commas dropped, tokens joined by one space, strings re-encoded). A block's
// targets come only from its template's slots, never from free text.
const STR = String.raw`"(?:[^"\\]|\\.)*"`;
const OWNER = `"(?<owner>${NAME})"`;
const REPO_NAME = `"(?<repo>${NAME})"`;
const EXPRESSION = String.raw`"[\w.+-]+:[\w./+-]+"`;
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A block template: literal canonical text, with raw regex in its interpolations. */
function tpl(strings: TemplateStringsArray, ...raw: string[]): RegExp {
  return new RegExp(`^${strings.map((text, i) => escapeRegex(text) + (raw[i] ?? "")).join("")}$`);
}

interface BlockTemplate {
  id: string;
  cmd: "gh" | "glab";
  class: CallClass;
  pattern: RegExp;
  /** The fragment each spread in the block must name. */
  spreads?: readonly string[];
}

const BUDGET_SHAPE = "budget";
const PORT_QUERY = new RegExp(
  `^repo:(?<owner>${NAME})/(?<repo>${NAME}) is:pr (?:is:open|is:merged merged:>=\\d{4}-\\d\\d-\\d\\d merged:<=\\d{4}-\\d\\d-\\d\\d)$`,
);

export const GRAPHQL_BLOCKS: readonly BlockTemplate[] = [
  // forge.ts budgetQuery adds this to every gh document: rate-limit numbers, read strictly.
  {
    id: BUDGET_SHAPE,
    cmd: "gh",
    class: "operator",
    pattern: tpl`spicodeBudget : rateLimit { cost remaining resetAt }`,
  },
  {
    id: "fleet file",
    cmd: "gh",
    class: "public-content",
    pattern: tpl`${"(?<key>stack|template)"} : repository ( owner : ${OWNER} name : ${REPO_NAME} ) { object ( expression : ${EXPRESSION} ) { ... on Blob { text } } }`,
  },
  {
    id: "template repository",
    cmd: "gh",
    class: "public-content",
    spreads: ["Base", "Template"],
    pattern: tpl`${"(?<key>r_template)"} : repository ( owner : ${OWNER} name : ${REPO_NAME} ) { ... Base ... Template }`,
  },
  {
    id: "stack repository",
    cmd: "gh",
    class: "public-content",
    spreads: ["Base", "Stack"],
    pattern: tpl`${"(?<key>r_stack)"} : repository ( owner : ${OWNER} name : ${REPO_NAME} ) { ... Base ... Stack }`,
  },
  {
    id: "fork repository",
    cmd: "gh",
    class: "public-content",
    spreads: ["Base", "Fork"],
    pattern: tpl`${"(?<key>r_fork\\d+)"} : repository ( owner : ${OWNER} name : ${REPO_NAME} ) { ... Base ... Fork }`,
  },
  {
    id: "planned repository",
    cmd: "gh",
    class: "public-content",
    pattern: tpl`${"(?<key>p_\\d+)"} : repository ( owner : ${OWNER} name : ${REPO_NAME} ) { nameWithOwner }`,
  },
  {
    id: "port search",
    cmd: "gh",
    class: "public-content",
    pattern: tpl`${"(?<key>port_page|port_o\\d+|port_m\\d+)"} : search ( query : ${'"(?<query>[^"\\\\]*)"'} type : ISSUE first : ${N}${` (?:after : ${STR} )?`}) { issueCount pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { number url mergedAt bodyText commits ( first : ${N} ) { totalCount pageInfo { hasNextPage } nodes { commit { message } } } } } }`,
  },
  {
    id: "fork pins",
    cmd: "gh",
    class: "public-content",
    pattern: tpl`${"(?<key>pom\\d+)"} : repository ( owner : ${OWNER} name : ${REPO_NAME} ) { root : object ( expression : "main:pom.xml" ) { ... on Blob { oid } }${` (?:azure : object \\( expression : ${EXPRESSION} \\) \\{ \\.\\.\\. on Blob \\{ oid \\} \\} )?`}}`,
  },
  {
    id: "created",
    cmd: "gh",
    class: "public-content",
    pattern: tpl`${"(?<key>r\\d+)"} : repository ( owner : ${OWNER} name : ${REPO_NAME} ) { createdAt }`,
  },
  {
    id: "release poms",
    cmd: "gh",
    class: "public-content",
    pattern: tpl`${"(?<key>repository)"} ( owner : ${OWNER} name : ${REPO_NAME} ) {${`(?: p\\d+ : object \\( expression : ${EXPRESSION} \\) \\{ \\.\\.\\. on Blob \\{ text \\} \\})+`} }`,
  },
  {
    id: "merged requests",
    cmd: "glab",
    class: "public-content",
    pattern: tpl`${"(?<key>p\\d+)"} : project ( fullPath : ${`"(?<project>${NAME}(?:/${NAME})+)"`} ) { mergeRequests ( state : merged targetBranches : [ "master" ] mergedAfter : ${STR} first : ${N} ) { pageInfo { hasNextPage } nodes { iid title webUrl mergedAt diffHeadSha } } }`,
  },
];

/** The sha-256 of each fragment's canonical text, as packages/core/src/collect/github-read.ts
 * sends it. Any other fragment text is unrecognized. */
export const FRAGMENT_HASHES: Readonly<Record<string, string>> = {
  Base: "e3b5be226498b330cb95d3845c1d4000e2e5f29f507c8b19c65d17b22eec9157",
  Template: "2d7b47a33820effd3c22f17bce66c9d51d013968e7ffd79e63f6fdec223e6a4c",
  Fork: "937f5c673aee2ea622156e6ea76b450e4be9231df63ea5fcfa99005fb45abd92",
  Stack: "7e9be32536546dd43de851827f6041a4c3c6184591934481e552906e49f6068f",
};

const GRAPHQL_TOKEN =
  /[\s,\uFEFF]+|#[^\r\n]*|"""|"(?:[^"\\\r\n]|\\.)*"|\.\.\.|[_A-Za-z][_0-9A-Za-z]*|-?\d+(?:\.\d+)?|[{}()[\]:!$=@]|[\s\S]/g;

/** A GraphQL document's canonical tokens, or undefined for one the audit does not read. */
export function graphqlTokens(document: string): string[] | undefined {
  const tokens: string[] = [];
  for (const [token] of document.matchAll(GRAPHQL_TOKEN)) {
    if (/^[\s,\uFEFF]/.test(token) || token.startsWith("#")) continue;
    if (token === '"""') return undefined;
    if (token.startsWith('"')) {
      try {
        tokens.push(JSON.stringify(JSON.parse(token) as string));
      } catch {
        return undefined;
      }
      continue;
    }
    if (!/^(?:\.\.\.|[_A-Za-z]\w*|-?\d+(?:\.\d+)?|[{}()[\]:!$=@])$/.test(token)) return undefined;
    tokens.push(token);
  }
  return tokens;
}

interface Document {
  blocks: string[];
  fragments: { name: string; text: string }[];
}

const OPEN = new Set(["{", "(", "["]);
const CLOSE = new Set(["}", ")", "]"]);

/** An anonymous query: its root blocks, split where each closes, and its fragments. */
function parseDocument(tokens: readonly string[]): Document | undefined {
  let i = tokens[0] === "query" ? 1 : 0;
  if (tokens[i] !== "{") return undefined;
  const blocks: string[] = [];
  let start = ++i;
  let depth = 0;
  for (; ; i++) {
    const token = tokens[i];
    if (token === undefined) return undefined;
    if (OPEN.has(token)) depth++;
    else if (CLOSE.has(token)) {
      if (depth === 0) {
        if (token !== "}" || i !== start) return undefined;
        i++;
        break;
      }
      depth--;
      if (depth === 0 && token === "}") {
        blocks.push(tokens.slice(start, i + 1).join(" "));
        start = i + 1;
      }
    }
  }
  const fragments: Document["fragments"] = [];
  while (i < tokens.length) {
    const name = tokens[i + 1];
    if (tokens[i] !== "fragment" || !name || tokens[i + 2] !== "on" || tokens[i + 4] !== "{")
      return undefined;
    const from = i;
    depth = 0;
    for (i += 4; ; i++) {
      const token = tokens[i];
      if (token === undefined) return undefined;
      if (OPEN.has(token)) depth++;
      else if (CLOSE.has(token) && --depth === 0) break;
    }
    fragments.push({ name, text: tokens.slice(from, ++i).join(" ") });
  }
  return { blocks, fragments };
}

export function fragmentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function repoTarget(groups: Record<string, string | undefined>, into: References): boolean {
  const { owner, repo } = groups;
  if (!owner || !repo || [owner, repo].some((part) => part === "." || part === "..")) return false;
  into.github.add(`${owner}/${repo}`);
  return true;
}

function gitlabTarget(encoded: string, into: Set<string>): boolean {
  let path: string;
  try {
    path = decodeURIComponent(encoded);
  } catch {
    return false;
  }
  if (!gitlabSegments(path)) return false;
  into.add(path);
  return true;
}

/** Whether every segment of a decoded GitLab path is one the audit reads. */
function gitlabSegments(path: string): boolean {
  return path.split("/").every((s) => /^[\w.-]+$/.test(s) && s !== "." && s !== "..");
}

/** The stages core records per upstream project in radar.data.removal.labels (pins.ts). */
const REMOVAL_STAGES: ReadonlySet<unknown> = new Set(["pending", "established"]);

function unrecognized(cmd: string, args: readonly string[]): Refused {
  return { refused: "unrecognized command", detail: [cmd, ...args].join(" ") };
}

function classifyGraphql(cmd: "gh" | "glab", document: string): Classified | undefined {
  const tokens = graphqlTokens(document);
  const parsed = tokens && parseDocument(tokens);
  if (!parsed) return undefined;
  const blocks: GraphqlBlock[] = [];
  const spreads = new Set<string>();
  for (const text of parsed.blocks) {
    let found: { template: BlockTemplate; groups: Record<string, string | undefined> } | undefined;
    for (const template of GRAPHQL_BLOCKS) {
      const match = template.cmd === cmd ? template.pattern.exec(text) : null;
      if (match) {
        found = { template, groups: match.groups ?? {} };
        break;
      }
    }
    if (!found) return undefined;
    const { template, groups } = found;
    const targets = noReferences();
    if (groups.query !== undefined) {
      const query = PORT_QUERY.exec(groups.query);
      if (!query || !repoTarget(query.groups ?? {}, targets)) return undefined;
    } else if (groups.project !== undefined) {
      if (!gitlabTarget(groups.project, targets.gitlab)) return undefined;
    } else if (template.id !== BUDGET_SHAPE && !repoTarget(groups, targets)) return undefined;
    const key = template.id === BUDGET_SHAPE ? "spicodeBudget" : (groups.key as string);
    if (blocks.some((block) => block.key === key)) return undefined;
    for (const spread of template.spreads ?? []) spreads.add(spread);
    blocks.push({ key, shape: template.id, class: template.class, targets });
  }
  const budgets = blocks.filter((block) => block.shape === BUDGET_SHAPE).length;
  if (budgets !== (cmd === "gh" ? 1 : 0) || blocks.length === budgets) return undefined;
  const defined = new Set(parsed.fragments.map((fragment) => fragment.name));
  if (defined.size !== parsed.fragments.length || defined.size !== spreads.size) return undefined;
  for (const { name, text } of parsed.fragments)
    if (!spreads.has(name) || FRAGMENT_HASHES[name] !== fragmentHash(text)) return undefined;
  const targets = blocks.reduce((all, block) => merge(all, block.targets), noReferences());
  const operator = blocks.some((block) => block.class === "operator");
  return { shape: "graphql", class: operator ? "operator" : "public-content", targets, blocks };
}

/** A routing override in a call's arguments: a host other than the one the sweep uses. */
function hostOverride(cmd: string, args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg.startsWith("--hostname=")) return arg;
    if (arg === "--hostname") {
      const host = args[i + 1];
      if (host !== CANONICAL_HOST[cmd]) return `--hostname ${host ?? ""}`;
      i++;
      continue;
    }
    const header =
      arg === "-H" || arg === "--header"
        ? args[i + 1]
        : arg.startsWith("--header=")
          ? arg.slice("--header=".length)
          : /^-H./.test(arg)
            ? arg.slice(2)
            : undefined;
    if (header !== undefined && /^\s*host\s*:/i.test(header)) return `header ${header}`;
  }
  return undefined;
}

/** Classifies one recorded call against the allowlist. */
export function classify(cmd: string, args: readonly string[]): Classified | Refused {
  const override = hostOverride(cmd, args);
  if (override) return { refused: "host override", detail: override };
  const fixed = FIXED_SHAPES.find(
    (each) =>
      each.cmd === cmd &&
      each.args.length === args.length &&
      each.args.every((arg, i) => arg === args[i]),
  );
  if (fixed) return { shape: fixed.id, class: "operator", targets: noReferences() };
  const is = (...want: (string | null)[]) =>
    args.length === want.length && want.every((w, i) => w === null || w === args[i]);
  let mode: Mode | undefined;
  let path: string | undefined;
  let jq: string | undefined;
  let document: string | undefined;
  if (cmd === "gh") {
    if (is("api", "graphql", "-f", null)) document = args[3];
    else if (is("api", "--paginate", null, "--jq", null))
      [mode, path, jq] = ["pages", args[2], args[4]];
    else if (is("api", "--allow-escape-sequences", null)) [mode, path] = ["text", args[2]];
    else if (is("api", null, "--jq", null)) [mode, path, jq] = ["rest", args[1], args[3]];
    else if (is("api", null)) [mode, path] = ["rest", args[1]];
  } else if (cmd === "glab") {
    if (is("api", "graphql", "--hostname", GITLAB_HOST, "-f", null)) document = args[5];
    else if (is("api", "--hostname", GITLAB_HOST, null)) [mode, path] = ["rest", args[3]];
  }
  if (document !== undefined) {
    const graphql = document.startsWith("query=")
      ? classifyGraphql(cmd as "gh" | "glab", document.slice("query=".length))
      : undefined;
    return graphql ?? unrecognized(cmd, args);
  }
  if (!mode || path === undefined || path.startsWith("-")) return unrecognized(cmd, args);
  for (const each of REST_SHAPES) {
    if (each.cmd !== cmd || each.mode !== mode || each.jq !== jq) continue;
    const match = each.path.exec(path);
    if (!match) continue;
    const groups = match.groups ?? {};
    const targets = noReferences();
    const ok =
      groups.owner !== undefined
        ? repoTarget(groups, targets)
        : groups.project !== undefined
          ? gitlabTarget(groups.project, targets.gitlab)
          : groups.group !== undefined
            ? gitlabTarget(groups.group, targets.gitlabGroups)
            : true;
    if (!ok) break;
    return { shape: each.id, class: each.class, targets };
  }
  return unrecognized(cmd, args);
}

/** What one recorded call reads, or undefined when it is not an allowlisted shape. */
export function callTargets(cmd: string, args: readonly string[]): References | undefined {
  const classified = classify(cmd, args);
  return "refused" in classified ? undefined : classified.targets;
}

export type Visibility = "public" | "missing" | "private" | "internal" | "unknown";
export interface VisibilityFile {
  checkedAt: string;
  github: Record<string, Visibility>;
  gitlab: Record<string, Visibility>;
  gitlabGroups?: Record<string, Visibility>;
  /** The visibility of every project an item of a group read belongs to, by numeric id. */
  gitlabProjectIds?: Record<string, Visibility>;
}

// "missing" is a repository the recording account could not see, so no data from it was read.
const ALLOWED: ReadonlySet<Visibility> = new Set(["public", "missing"]);

export interface AuditResult {
  entries: number;
  fields: number;
  references: { github: number; gitlab: number; gitlabGroups: number };
  findings: string[];
}

function lookup(map: Record<string, Visibility> | undefined, name: string): Visibility | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(map ?? {}))
    if (key.toLowerCase() === lower) return value;
  return undefined;
}

const FORGES = [
  ["github", "github"],
  ["gitlab", "gitlab"],
  ["gitlabGroups", "gitlab group"],
] as const;

const STRING_LITERAL = /"(?:[^"\\]|\\.)*"/g;
const DECODE_DEPTH = 4;

/** The text and every string it holds behind a JSON escape: each escaped JSON string literal
 * decoded, and \uXXXX escapes outside one, nested to DECODE_DEPTH. */
function decodings(text: string, depth = 0, into: string[] = [text]): string[] {
  if (depth >= DECODE_DEPTH || !text.includes("\\")) return into;
  const unicode = text.replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  if (unicode !== text) into.push(unicode);
  for (const [literal] of text.matchAll(STRING_LITERAL)) {
    if (!literal.includes("\\")) continue;
    let value: unknown;
    try {
      value = JSON.parse(literal);
    } catch {
      continue;
    }
    if (typeof value !== "string") continue;
    into.push(value);
    decodings(value, depth + 1, into);
  }
  return into;
}

/** One item a group read returned: its project's numeric id, its iid, and its confidentiality:
 * false only when the item says `confidential: false`, "undeclared" when the field is missing
 * or not a boolean. */
export interface GroupItem {
  project: string;
  iid: string;
  confidential: boolean | "undeclared";
}

/** Why a group item cannot be recorded for its confidentiality, or undefined when it can. */
export function confidentiality(item: GroupItem): string | undefined {
  if (item.confidential === false) return undefined;
  return item.confidential === true ? "confidential" : "confidentiality not declared";
}

/** Every item a group read returned, or undefined when one has no project. A public group does
 * not make its projects public: a group read can hold items of a private project the recording
 * account sees, so each item's project is checked on its own; and a confidential issue of a
 * public project is not public either, nor one that does not say it is not. */
export function groupItems(stdout: string): GroupItem[] | undefined {
  if (!stdout.trim()) return [];
  const values = jsonValues(stdout);
  if (!values) return undefined;
  const items: GroupItem[] = [];
  for (const value of values) {
    if (!Array.isArray(value)) return undefined;
    for (const item of value) {
      if (!item || typeof item !== "object") return undefined;
      const { project_id: id, iid, confidential } = item as Record<string, unknown>;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return undefined;
      items.push({
        project: String(id),
        iid: typeof iid === "number" ? String(iid) : "?",
        confidential: typeof confidential === "boolean" ? confidential : "undeclared",
      });
    }
  }
  return items;
}

/** The JSON values a field holds: the whole text, or one per line (a paginated jq read). */
function jsonValues(text: string): unknown[] | undefined {
  try {
    return [JSON.parse(text)];
  } catch {
    const lines = text.split("\n").filter((line) => line.trim());
    try {
      return lines.map((line) => JSON.parse(line));
    } catch {
      return undefined;
    }
  }
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
// An envelope's encoding field as it appears unparsed: a field that is not JSON yet holds one.
const RAW_ENVELOPE = /"encoding"\s*:\s*"base64"/i;

/** The decoded text of every base64 envelope a field holds ({content, encoding: "base64"}, as
 * GitHub's contents and blob reads and GitLab's file read return it), and whether any envelope
 * could not be decoded: content that is not a string or not canonical base64, or an envelope
 * in text that does not parse as JSON. */
export function base64Contents(text: string): { decoded: string[]; malformed: boolean } {
  const decoded: string[] = [];
  const values = jsonValues(text);
  if (!values) return { decoded, malformed: RAW_ENVELOPE.test(text) };
  let malformed = false;
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    if (typeof record.encoding === "string" && record.encoding.toLowerCase() === "base64") {
      const raw =
        typeof record.content === "string" ? record.content.replace(/\s/g, "") : undefined;
      const bytes = raw !== undefined && BASE64.test(raw) ? Buffer.from(raw, "base64") : undefined;
      if (bytes && bytes.toString("base64") === raw) decoded.push(bytes.toString("utf8"));
      else malformed = true;
    }
    Object.values(record).forEach(walk);
  };
  values.forEach(walk);
  return { decoded, malformed };
}

/** The text, the strings it holds behind JSON escapes, and the decoded text of its base64
 * envelopes with theirs. */
function readings(text: string): string[] {
  return [
    ...decodings(text),
    ...base64Contents(text).decoded.flatMap((decoded) => decodings(decoded)),
  ];
}

/** Scans one field. The token, key and email detectors read the whole text, base64 envelopes
 * decoded, whatever its provenance; the credential-assignment heuristic reads only strictText:
 * all of it, except where the field holds public repository content (see strictStdout and
 * strictFacts). */
function scan(where: string, text: string, findings: string[], strictText = text): void {
  const texts = readings(text);
  if (base64Contents(text).malformed) findings.push(`${where}: malformed base64 content`);
  for (const { name, pattern } of TOKEN_PATTERNS) {
    if (texts.some((each) => pattern.test(each))) findings.push(`${where}: ${name}`);
  }
  if (strictText && readings(strictText).some((each) => CREDENTIAL_ASSIGNMENT.pattern.test(each)))
    findings.push(`${where}: ${CREDENTIAL_ASSIGNMENT.name}`);
  const emails = new Set(texts.flatMap((each) => each.match(EMAIL) ?? []));
  if (emails.size) findings.push(`${where}: email address (${emails.size})`);
}

/** Targets every one of which was public at record time; none is not public content. */
function allPublic(targets: References, visibility: VisibilityFile | undefined): boolean {
  if (!visibility) return false;
  const seen = FORGES.flatMap(([forge]) =>
    [...targets[forge]].map((name) => lookup(visibility[forge], name)),
  );
  return seen.length > 0 && seen.every((each) => each === "public");
}

/** The part of a call's stdout the credential-assignment heuristic reads: none of a
 * public-content REST read of public repositories; a GraphQL response less each public-content
 * block whose targets are all public; all of anything else. */
function strictStdout(
  call: Classified | undefined,
  stdout: string,
  visibility: VisibilityFile | undefined,
): string {
  if (!call || (call.class === "operator" && !call.blocks)) return stdout;
  if (!call.blocks) return allPublic(call.targets, visibility) ? "" : stdout;
  let response: unknown;
  try {
    response = JSON.parse(stdout);
  } catch {
    return stdout;
  }
  const data = (response as { data?: unknown } | null)?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return stdout;
  for (const block of call.blocks)
    if (block.class === "public-content" && allPublic(block.targets, visibility))
      delete (data as Record<string, unknown>)[block.key];
  return JSON.stringify(response);
}

/** The part of a Facts file the credential-assignment heuristic reads: all of it but the
 * github.data.repos entries of repositories that were public, which hold only what public
 * reads returned. Auth, account, scopes and errors stay strict. */
function strictFacts(text: string, visibility: VisibilityFile | undefined): string {
  let facts: unknown;
  try {
    facts = JSON.parse(text);
  } catch {
    return text;
  }
  const isMap = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  const shaped = facts as {
    github?: { data?: { repos?: unknown } };
    radar?: { data?: { removal?: { labels?: unknown } } };
  } | null;
  const repos = shaped?.github?.data?.repos;
  if (isMap(repos))
    for (const name of Object.keys(repos))
      if (visibility && lookup(visibility.github, name) === "public") delete repos[name];
  // An upstream project path keyed to a removal stage: the path may end in a credential word
  // (osdu/platform/security-and-compliance/secret), the value is one of two stage names.
  const labels = shaped?.radar?.data?.removal?.labels;
  if (isMap(labels))
    for (const [key, stage] of Object.entries(labels))
      if (key.includes("/") && gitlabSegments(key) && REMOVAL_STAGES.has(stage)) delete labels[key];
  return JSON.stringify(facts);
}

/** One recorded call's targets, and the repository it was fenced on, if it read nothing. */
interface Call {
  targets: References;
  /** The repository a fenced call was refused on; it read nothing of it. */
  fencedOn: string | undefined;
}

interface Collected {
  entries: number;
  fields: number;
  refs: References;
  calls: Call[];
  /** The project of every item a group read returned. */
  itemProjects: Set<string>;
  findings: string[];
}

/** The repository a call was fenced on: a call that returned only the fence line naming it. */
function fencedOn(entry: Record<string, unknown>): string | undefined {
  if (entry.stdout !== "" || entry.exit !== 1 || entry.error !== undefined) return undefined;
  const [prefix, suffix] = fenceMessage("\0", NOT_PUBLIC).split("\0") as [string, string];
  const { stderr } = entry;
  if (typeof stderr !== "string" || !stderr.startsWith(prefix) || !stderr.endsWith(suffix))
    return undefined;
  const what = stderr.slice(prefix.length, -suffix.length);
  return /^\S+$/.test(what) ? what : undefined;
}

/** Scans exec.jsonl and every other recorded JSON file in a sweep directory for credentials
 * and email addresses, and classifies every call, a fenced one included, against the
 * allowlist. */
function collect(directory: string, visibility?: VisibilityFile): Collected {
  const findings: string[] = [];
  const refs = noReferences();
  const calls: Call[] = [];
  const projects = new Set<string>();
  const lines = readFileSync(join(directory, LOG_FILE), "utf8")
    .split("\n")
    .filter((line) => line.trim());
  let fields = 0;
  lines.forEach((line, index) => {
    const where = `${LOG_FILE}:${index + 1}`;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      findings.push(`${where}: not JSON`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!(FIELDS as readonly string[]).includes(key))
        findings.push(`${where}: unexpected field ${key}`);
    }
    const env = entry.env;
    const routed =
      env && typeof env === "object"
        ? Object.keys(env).filter((name) =>
            (HOST_VARIABLES as readonly string[]).includes(name.toUpperCase()),
          )
        : [];
    if (routed.length) findings.push(`${where}: host override: env ${routed.join(", ")}`);
    const { cmd, args, stdin } = entry;
    const classified =
      typeof cmd === "string" && Array.isArray(args) && args.every((a) => typeof a === "string")
        ? classify(cmd, args as string[])
        : undefined;
    let call: Classified | undefined;
    if (classified && !("refused" in classified)) {
      // A call routed elsewhere did not read what its shape names: none of its stdout is exempt.
      call = routed.length ? undefined : classified;
      merge(refs, classified.targets);
      calls.push({ targets: classified.targets, fencedOn: fencedOn(entry) });
      // Whatever the exit, a group read's stdout is what it read; only an empty one, a fenced
      // call's included, holds nothing.
      if (classified.targets.gitlabGroups.size) {
        const { stdout } = entry;
        const items = groupItems(
          typeof stdout === "string" ? stdout : stdout == null ? "" : JSON.stringify(stdout),
        );
        if (!items) findings.push(`${where}: group read: an item without a project`);
        for (const item of items ?? []) {
          projects.add(item.project);
          const withheld = confidentiality(item);
          if (withheld)
            findings.push(
              `gitlab project ${item.project} issue ${item.iid} in a group read: ${withheld}`,
            );
        }
      }
    } else {
      const detail =
        classified?.detail ?? [cmd, ...(Array.isArray(args) ? args : [])].map(String).join(" ");
      findings.push(
        `${where}: ${classified?.refused ?? "unrecognized command"}: ${detail}`.slice(0, 300),
      );
    }
    // The sweep sends nothing on stdin; a call that does is not one of its shapes.
    if (stdin !== undefined && stdin !== null && stdin !== "")
      findings.push(`${where}: unrecognized command: stdin`);
    for (const field of FIELDS) {
      const value = entry[field];
      if (value === undefined || value === null || typeof value === "number") continue;
      for (const [i, text] of (Array.isArray(value) ? value : [value]).entries()) {
        fields++;
        const at = `${where} ${field}${Array.isArray(value) ? `[${i}]` : ""}`;
        const body = String(text);
        scan(at, body, findings, field === "stdout" ? strictStdout(call, body, visibility) : body);
      }
    }
  });
  for (const name of readdirSync(directory).sort()) {
    if (name === LOG_FILE || !name.endsWith(".json")) continue;
    fields++;
    const text = readFileSync(join(directory, name), "utf8");
    scan(name, text, findings, FACTS_FILES.has(name) ? strictFacts(text, visibility) : text);
  }
  return { entries: lines.length, fields, refs, calls, itemProjects: projects, findings };
}

/** Every repository, project and group a recorded call targets, fenced calls included: what
 * the recorder checks the visibility of. */
export function sweepReferences(directory: string): References {
  return collect(directory).refs;
}

/** The project of every item a recorded group read returned: what the recorder checks the
 * visibility of besides sweepReferences. */
export function sweepItemProjects(directory: string): Set<string> {
  return collect(directory).itemProjects;
}

/** Audits exec.jsonl and every other recorded JSON file in a sweep directory. */
export function auditSweep(directory: string): AuditResult {
  const visibilityPath = join(directory, VISIBILITY_FILE);
  const visibility: VisibilityFile | undefined = existsSync(visibilityPath)
    ? JSON.parse(readFileSync(visibilityPath, "utf8"))
    : undefined;
  const { entries, fields, refs, calls, itemProjects, findings } = collect(directory, visibility);
  if (!visibility)
    findings.push(`${VISIBILITY_FILE}: missing; visibility is checked at record time`);
  for (const [forge, label] of FORGES) {
    // A call fenced on a repository read nothing of it; any other call reads what it targets.
    const read = new Set(
      calls.flatMap(({ targets, fencedOn }) =>
        [...targets[forge]].filter((name) => name.toLowerCase() !== fencedOn?.toLowerCase()),
      ),
    );
    for (const name of [...read].sort()) {
      const seen = visibility ? lookup(visibility[forge], name) : undefined;
      if (visibility && !ALLOWED.has(seen ?? "unknown"))
        findings.push(`${label} ${name}: ${seen ?? "not checked at record time"}`);
    }
  }
  // An item of a group read was read in full: its project must have been public, not missing.
  for (const id of [...itemProjects].sort((a, b) => Number(a) - Number(b))) {
    const seen = visibility?.gitlabProjectIds?.[id];
    if (visibility && seen !== "public")
      findings.push(
        `gitlab project ${id} in a group read: ${seen ?? "not checked at record time"}`,
      );
  }
  return {
    entries,
    fields,
    references: {
      github: refs.github.size,
      gitlab: refs.gitlab.size,
      gitlabGroups: refs.gitlabGroups.size,
    },
    findings,
  };
}

export function report(directory: string, result: AuditResult): string {
  return [
    `audit ${directory}: ${result.entries} entries, ${result.fields} fields, ` +
      `${result.references.github} GitHub repositories, ${result.references.gitlab} GitLab projects, ` +
      `${result.references.gitlabGroups} GitLab groups`,
    ...result.findings.map((finding) => `  finding: ${finding}`),
    result.findings.length ? `audit: FAIL (${result.findings.length} findings)` : "audit: pass",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2];
  if (!directory) {
    console.error("usage: bun scripts/audit-exec-log.ts <sweep directory>");
    process.exit(2);
  }
  const result = auditSweep(directory);
  console.log(report(directory, result));
  process.exit(result.findings.length ? 1 : 0);
}
