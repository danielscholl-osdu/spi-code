// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

/** Audit a recorded exec log before it may leave this machine:
 *   bun scripts/audit-exec-log.ts <sweep directory>
 * The directory holds exec.jsonl and the visibility.json written at record time. Every
 * recorded field of every file, visibility.json included, is scanned for credentials and email
 * addresses, as written and with its JSON strings decoded. Every call, a fenced one included,
 * must have a shape the call grammar reads, and must target only repositories, projects and
 * groups that were public when the log was recorded, on either forge: no recorded call reads a
 * private repository. A call the recorder fenced read nothing and may name the one private
 * repository it refused. A private name quoted in a response is allowed (maintainer decision,
 * 2026-11-05); its contents are not, since no call read them. Exits 1 with one line per finding.
 */
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

const VALUE_CHAR = String.raw`[^\s"'&;,<>(){}$\[\]\\]|\\+(?![nrtbfu"/\\])`;
const VALUE_END = String.raw`(?=$|[\s"'&;,]|\\+[nrtbfu"/])`;
// Whole values that stand in for a credential. <...>, ${...}, {{...}} and empty values never
// match, since a value must be six value characters. The last line lists values the live
// sweep recorded that hold no secret.
// The pattern is case-sensitive so CODE_REFERENCE can read camelCase; words match in any case.
const anyCase = (words: string) =>
  words.replace(/[A-Za-z]/g, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
const PLACEHOLDERS = [
  anyCase("todo|tbd|to_?be_?updated|changeme|changeit|replace_?me|placeholder|dummy|example"),
  anyCase("none|null|undefined"),
  `${anyCase("your")}[_-][A-Za-z0-9_-]*[_-]${anyCase("here")}|${anyCase("x")}{3,}|\\*{3,}`,
  anyCase("client-secret"),
].join("|");
// Code that reads a credential from a variable or property: an unquoted camelCase name whose
// last word is the credential (userPassword, config.dbPassword). secretsauce is not one.
const CODE_REFERENCE = String.raw`(?<!["'])(?:[A-Za-z_]\w*\.)*[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)*(?:Password|Passwd|Secret|Key|Token)`;

export const TOKEN_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: "GitHub token", pattern: /(?:gh[opsur]_|github_pat_)[A-Za-z0-9_]{8,}/ },
  { name: "GitLab token", pattern: /gl(?:pat|dt|rt|cbt|ptt|ft|imt|agent|soat)-[A-Za-z0-9_-]{8,}/ },
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
  // A credential assigned with "=" (environment lines, connection strings, query strings).
  // A redaction, a placeholder or code that reads a variable, property or call holds no secret;
  // any other value of six or more characters does. A backslash that begins a JSON escape (\n, \t, \", \uXXXX) ends the value,
  // so a diff nested in JSON is read line by line; any other backslash is part of the value. A
  // password that itself holds a backslash before one of those letters is read only up to it.
  {
    name: "credential assignment",
    pattern: new RegExp(
      `(?<![A-Za-z0-9])(?:${anyCase("password|passwd|secret|client_secret|api_?key|access_?key")})[ \\t]*=[ \\t]*["']?` +
        `(?!<redacted>)(?!(?:${PLACEHOLDERS})${VALUE_END})(?!${CODE_REFERENCE}${VALUE_END})` +
        `(?:${VALUE_CHAR}){6,}${VALUE_END}`,
      "m",
    ),
  },
];

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

const NAME = "[A-Za-z0-9_.-]+";
const Q = '\\\\?"';
// GitHub's own pages under github.com/<segment>, which are not repositories.
const GITHUB_RESERVED = new Set(
  "about apps collections contact customer-stories enterprise explore features join login logout marketplace new notifications orgs organizations pricing readme search security settings site sponsors topics trending users".split(
    " ",
  ),
);
const GITHUB_PATTERNS = [
  new RegExp(`(?<![A-Za-z0-9_.-])repos/(${NAME})/(${NAME})`, "g"),
  new RegExp(`repository\\(owner:\\s*${Q}(${NAME})${Q},\\s*name:\\s*${Q}(${NAME})${Q}`, "g"),
  new RegExp(`${Q}(?:nameWithOwner|full_name)${Q}\\s*:\\s*${Q}(${NAME})/(${NAME})${Q}`, "g"),
  // Any github.com URL or clone address: https://github.com/o/r, github.com/o/r.git,
  // git@github.com:o/r, ssh://git@github.com/o/r.
  new RegExp(`(?<![A-Za-z0-9_.-])(?:www\\.)?github\\.com[/:](${NAME})/(${NAME})`, "g"),
  new RegExp(`raw\\.githubusercontent\\.com/(${NAME})/(${NAME})`, "g"),
  // A search qualifier: search(query: "repo:o/r is:pr").
  new RegExp(`(?<![A-Za-z0-9_-])repo:(${NAME})/(${NAME})`, "g"),
];
// repository(name: "r", owner: "o"): the arguments in the other order.
const GITHUB_SWAPPED = new RegExp(
  `repository\\(name:\\s*${Q}(${NAME})${Q},\\s*owner:\\s*${Q}(${NAME})${Q}`,
  "g",
);
const GITLAB_PATH = "[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+";
const GITLAB_SEGMENT = "[A-Za-z0-9_][A-Za-z0-9_.-]*";
const GITLAB_RESERVED = new Set(
  "- admin api assets dashboard explore help oauth profile search uploads users".split(" "),
);
const GITLAB_PROJECT_PATTERNS = [
  /(?<![A-Za-z0-9_.-])projects\/([A-Za-z0-9_.%-]+)/g,
  new RegExp(`${Q}path_with_namespace${Q}\\s*:\\s*${Q}(${GITLAB_PATH})${Q}`, "g"),
];
// The REST path groups/<id>; a web URL's /groups/ path is read by GITLAB_URL.
const GITLAB_GROUP_PATTERNS = [/(?<![A-Za-z0-9_.-]|opengroup\.org\/)groups\/([A-Za-z0-9_.%-]+)/g];
// fullPath in a GraphQL call names a project or a group by its field; as a key in a response
// (fullPath, full_path) it may be either, so it is checked as both.
const FULL_PATH = new RegExp(
  `(?:\\b(project|group)\\(\\s*)?${Q}?\\b(?:fullPath|full_path)${Q}?\\s*:\\s*${Q}(${GITLAB_PATH})${Q}`,
  "g",
);
const GITLAB_URL = new RegExp(
  `(?<![A-Za-z0-9_.-])community\\.opengroup\\.org[/:](${GITLAB_SEGMENT}(?:/${GITLAB_SEGMENT})*)(/-/)?`,
  "g",
);

function repoName(owner: string, name: string): string {
  return `${owner}/${name.replace(/\.+$/, "").replace(/\.git$/, "")}`;
}

function decoded(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    // An undecodable segment is audited as written.
    return path;
  }
}

function addGithub(into: References, owner: string | undefined, name: string | undefined): void {
  if (!owner || !name || GITHUB_RESERVED.has(owner.toLowerCase())) return;
  const repo = repoName(owner, name);
  if (!repo.endsWith("/")) into.github.add(repo);
}

function addGitlab(into: Set<string>, path: string): void {
  into.add(path);
}

/** A GitLab URL path: before /-/ it is exactly one project or, after /groups/, one group;
 * otherwise each leading path may be a group and each of two or more segments a project. */
function addGitlabUrl(into: References, path: string, exact: boolean): void {
  const segments = path
    .split("/")
    .map((segment) => segment.replace(/\.+$/, ""))
    .filter(Boolean);
  const last = segments.length - 1;
  if (last >= 0) segments[last] = (segments[last] as string).replace(/\.git$/, "");
  const first = segments[0]?.toLowerCase();
  if (!first || GITLAB_RESERVED.has(first)) return;
  if (first === "groups") {
    if (segments.length > 1) addGitlab(into.gitlabGroups, segments.slice(1).join("/"));
    return;
  }
  if (exact) {
    if (segments.length > 1) addGitlab(into.gitlab, segments.join("/"));
    return;
  }
  for (let end = 1; end <= segments.length; end++) {
    const prefix = segments.slice(0, end).join("/");
    if (end < segments.length) addGitlab(into.gitlabGroups, prefix);
    if (end > 1) addGitlab(into.gitlab, prefix);
  }
}

/** The GitHub repositories, GitLab projects and GitLab groups a recorded text names. */
export function references(text: string, into: References = noReferences()): References {
  for (const pattern of GITHUB_PATTERNS)
    for (const [, owner, name] of text.matchAll(pattern)) addGithub(into, owner, name);
  for (const [, name, owner] of text.matchAll(GITHUB_SWAPPED)) addGithub(into, owner, name);
  for (const pattern of GITLAB_PROJECT_PATTERNS)
    for (const [, project] of text.matchAll(pattern))
      if (project) addGitlab(into.gitlab, decoded(project));
  for (const pattern of GITLAB_GROUP_PATTERNS)
    for (const [, group] of text.matchAll(pattern))
      if (group) addGitlab(into.gitlabGroups, decoded(group));
  for (const [, field, path] of text.matchAll(FULL_PATH)) {
    if (!path) continue;
    if (field !== "group") addGitlab(into.gitlab, path);
    if (field !== "project") addGitlab(into.gitlabGroups, path);
  }
  for (const [, path, dash] of text.matchAll(GITLAB_URL))
    if (path) addGitlabUrl(into, path, dash !== undefined);
  return into;
}

// The call grammar: what a gh or glab call reads, from its arguments alone. A call outside it
// is unknown, and the recorder refuses an unknown call rather than guess what it names.
const API_VALUE_FLAGS = new Set(["--jq", "-q", "-H", "--header", "--hostname", "-X", "--method"]);
const API_FIELD_FLAGS = new Set(["-f", "-F", "--field", "--raw-field"]);
const API_BARE_FLAGS = new Set([
  "--paginate",
  "--allow-escape-sequences",
  "--silent",
  "-i",
  "--include",
]);
const OWNER_REPO = new RegExp(`^(${NAME})/(${NAME})$`);
// Fields that reach repositories, projects or groups by anything but a literal name.
const GRAPHQL_DENIED =
  /\b(?:organization|repositoryOwner|user|node|nodes|namespace|projects|groups|repositories)\s*\(|\bviewer\b/;

function apiTargets(cmd: string, args: readonly string[]): References | undefined {
  const fields = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const [flag, inline] =
      arg.startsWith("--") && arg.includes("=")
        ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
        : [arg, undefined];
    if (API_BARE_FLAGS.has(flag) && inline === undefined) continue;
    if (API_VALUE_FLAGS.has(flag) || API_FIELD_FLAGS.has(flag)) {
      const value = inline ?? args[++i];
      if (value === undefined) return undefined;
      if (API_FIELD_FLAGS.has(flag)) {
        const at = value.indexOf("=");
        if (at < 1) return undefined;
        fields.set(value.slice(0, at), value.slice(at + 1));
      }
      continue;
    }
    if (arg.startsWith("-")) return undefined;
    positional.push(arg);
  }
  if (positional.length !== 1) return undefined;
  const endpoint = (positional[0] as string).replace(/^\//, "");
  const refs = noReferences();
  if (endpoint === "graphql") return graphqlTargets(fields, refs);
  if (fields.size) return undefined;
  if (cmd === "gh") {
    if (/^(?:user|rate_limit)(?:\?|$)/.test(endpoint)) return refs;
    const repo = new RegExp(`^repos/(${NAME})/(${NAME})(?:[/?]|$)`).exec(endpoint);
    if (!repo) return undefined;
    addGithub(refs, repo[1], repo[2]);
    return refs;
  }
  if (/^user(?:\?|$)/.test(endpoint)) return refs;
  const gitlab = /^(projects|groups)\/([^/?]+)(?:[/?]|$)/.exec(endpoint);
  if (!gitlab) return undefined;
  (gitlab[1] === "projects" ? refs.gitlab : refs.gitlabGroups).add(decoded(gitlab[2] as string));
  return refs;
}

/** A GraphQL call names what it reads only through repository, search, project and group
 * fields whose arguments are all literal once the call's -f variables are put in. */
function graphqlTargets(fields: Map<string, string>, refs: References): References | undefined {
  const raw = fields.get("query");
  if (raw === undefined) return undefined;
  let unresolved = false;
  const query = raw.replace(/\$(\w+)/g, (_, name: string) => {
    const value = fields.get(name);
    if (value === undefined) unresolved = true;
    return JSON.stringify(value ?? "");
  });
  if (unresolved || GRAPHQL_DENIED.test(query)) return undefined;
  const count = (pattern: RegExp) => [...query.matchAll(pattern)].length;
  const repositories = count(/\brepository\s*\(/g);
  const read = references(query, noReferences());
  const parsed =
    count(new RegExp(`repository\\(owner:\\s*"${NAME}",\\s*name:\\s*"${NAME}"`, "g")) +
    count(new RegExp(`repository\\(name:\\s*"${NAME}",\\s*owner:\\s*"${NAME}"`, "g"));
  if (parsed !== repositories) return undefined;
  for (const [, search] of query.matchAll(/\bsearch\s*\(\s*query:\s*("(?:[^"\\]|\\.)*")/g)) {
    if (!/(?<![A-Za-z0-9_-])repo:\S+\/\S+/.test(JSON.parse(search as string) as string))
      return undefined;
  }
  if (count(/\bsearch\s*\(/g) !== count(/\bsearch\s*\(\s*query:\s*"/g)) return undefined;
  for (const field of ["project", "group"]) {
    const literal = count(
      new RegExp(`\\b${field}\\(\\s*fullPath:\\s*"${GITLAB_PATH}"\\s*\\)`, "g"),
    );
    if (literal !== count(new RegExp(`\\b${field}\\s*\\(`, "g"))) return undefined;
  }
  return merge(refs, read);
}

/** What one recorded call reads, or undefined when its shape is outside the grammar. */
export function callTargets(cmd: string, args: readonly string[]): References | undefined {
  const [sub, verb] = args;
  if ((cmd === "gh" || cmd === "glab") && sub === "auth") {
    if (verb !== "status") return undefined;
    const rest = args.slice(2);
    for (let i = 0; i < rest.length; i += 2)
      if (!["--hostname", "-h"].includes(rest[i] as string) || rest[i + 1] === undefined)
        return undefined;
    return noReferences();
  }
  if ((cmd === "gh" || cmd === "glab") && sub === "api") return apiTargets(cmd, args.slice(1));
  if (cmd === "gh" && sub === "repo") {
    const named = args.slice(2).filter((arg) => !arg.startsWith("-"));
    const repo = named.length ? OWNER_REPO.exec(named[0] as string) : null;
    if (!repo) return undefined;
    const refs = noReferences();
    addGithub(refs, repo[1], repo[2]);
    return refs;
  }
  if (cmd === "glab" && sub === "repo" && verb === "view") {
    const path = args[2];
    if (!path || !new RegExp(`^${GITLAB_PATH}$`).test(path)) return undefined;
    const refs = noReferences();
    refs.gitlab.add(path);
    return refs;
  }
  const at = args.findIndex((arg) => arg === "-R" || arg === "--repo");
  const target = at < 0 ? undefined : args[at + 1];
  if (target && (cmd === "gh" || cmd === "glab")) {
    const refs = noReferences();
    if (cmd === "gh") {
      const repo = OWNER_REPO.exec(target);
      if (!repo) return undefined;
      addGithub(refs, repo[1], repo[2]);
    } else if (new RegExp(`^${GITLAB_PATH}$`).test(target)) refs.gitlab.add(target);
    else return undefined;
    return refs;
  }
  if (cmd === "git" && sub === "ls-remote" && verb) {
    const refs = references(verb);
    return refs.github.size || refs.gitlab.size ? refs : undefined;
  }
  return undefined;
}

export type Visibility = "public" | "missing" | "private" | "internal" | "unknown";
export interface VisibilityFile {
  checkedAt: string;
  github: Record<string, Visibility>;
  gitlab: Record<string, Visibility>;
  gitlabGroups?: Record<string, Visibility>;
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

function scan(where: string, text: string, findings: string[]): void {
  const texts = decodings(text);
  for (const { name, pattern } of TOKEN_PATTERNS) {
    if (texts.some((each) => pattern.test(each))) findings.push(`${where}: ${name}`);
  }
  const emails = new Set(texts.flatMap((each) => each.match(EMAIL) ?? []));
  if (emails.size) findings.push(`${where}: email address (${emails.size})`);
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
 * and email addresses, and reads what each call targets, a fenced call's included. */
function collect(directory: string): Collected {
  const findings: string[] = [];
  const refs = noReferences();
  const calls: Call[] = [];
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
    const { cmd, args } = entry;
    const targets =
      typeof cmd === "string" && Array.isArray(args) && args.every((a) => typeof a === "string")
        ? callTargets(cmd, args as string[])
        : undefined;
    if (targets) {
      merge(refs, targets);
      calls.push({ targets, fencedOn: fencedOn(entry) });
    } else {
      const call = [cmd, ...(Array.isArray(args) ? args : [])].join(" ");
      findings.push(`${where}: unrecognised call ${call}`.slice(0, 300));
    }
    for (const field of FIELDS) {
      const value = entry[field];
      if (value === undefined || value === null || typeof value === "number") continue;
      for (const [i, text] of (Array.isArray(value) ? value : [value]).entries()) {
        fields++;
        scan(`${where} ${field}${Array.isArray(value) ? `[${i}]` : ""}`, String(text), findings);
      }
    }
  });
  for (const name of readdirSync(directory).sort()) {
    if (name === LOG_FILE || !name.endsWith(".json")) continue;
    fields++;
    scan(name, readFileSync(join(directory, name), "utf8"), findings);
  }
  return { entries: lines.length, fields, refs, calls, findings };
}

/** Every repository, project and group a recorded call targets, fenced calls included: what
 * the recorder checks the visibility of. */
export function sweepReferences(directory: string): References {
  return collect(directory).refs;
}

const FORGES = [
  ["github", "github"],
  ["gitlab", "gitlab"],
  ["gitlabGroups", "gitlab group"],
] as const;

/** Audits exec.jsonl and every other recorded JSON file in a sweep directory. */
export function auditSweep(directory: string): AuditResult {
  const { entries, fields, refs, calls, findings } = collect(directory);
  const visibilityPath = join(directory, VISIBILITY_FILE);
  const visibility: VisibilityFile | undefined = existsSync(visibilityPath)
    ? JSON.parse(readFileSync(visibilityPath, "utf8"))
    : undefined;
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
