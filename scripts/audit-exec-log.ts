// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

/** Audit a recorded exec log before it may leave this machine:
 *   bun scripts/audit-exec-log.ts <sweep directory>
 * The directory holds exec.jsonl and the visibility.json written at record time. Every
 * recorded field is scanned for credentials, email addresses and repositories that were not
 * public when the log was recorded. A call the recorder fenced read nothing, so the names in
 * it are not data from that repository. Exits 1 with one line per finding.
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
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

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
}

const NAME = "[A-Za-z0-9_.-]+";
const GITHUB_PATTERNS = [
  new RegExp(`(?<![A-Za-z0-9_.-])repos/(${NAME})/(${NAME})`, "g"),
  new RegExp(
    `repository\\(owner:\\s*\\\\?"(${NAME})\\\\?",\\s*name:\\s*\\\\?"(${NAME})\\\\?"`,
    "g",
  ),
  new RegExp(
    `\\\\?"(?:nameWithOwner|full_name)\\\\?"\\s*:\\s*\\\\?"(${NAME})/(${NAME})\\\\?"`,
    "g",
  ),
  new RegExp(
    `github\\.com/(${NAME})/(${NAME})/(?:pull|pulls|issues|actions|commit|commits|blob|tree|releases|compare|runs|security|tags)\\b`,
    "g",
  ),
];
const GITLAB_PATH = "[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+";
const GITLAB_PATTERNS = [
  /(?<![A-Za-z0-9_.-])projects\/([A-Za-z0-9_.%-]+)/g,
  new RegExp(`fullPath:\\s*\\\\?"(${GITLAB_PATH})\\\\?"`, "g"),
  new RegExp(`\\\\?"path_with_namespace\\\\?"\\s*:\\s*\\\\?"(${GITLAB_PATH})\\\\?"`, "g"),
  new RegExp(`community\\.opengroup\\.org/(${GITLAB_PATH})/-/`, "g"),
];

function repoName(owner: string, name: string): string {
  return `${owner}/${name.replace(/\.git$/, "")}`;
}

/** The GitHub repositories and GitLab projects a recorded text names. */
export function references(
  text: string,
  into: References = { github: new Set(), gitlab: new Set() },
) {
  for (const pattern of GITHUB_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const [, owner, name] = match;
      if (owner && name) into.github.add(repoName(owner, name));
    }
  }
  for (const pattern of GITLAB_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const project = match[1];
      if (!project) continue;
      let path = project;
      try {
        path = decodeURIComponent(project);
      } catch {
        // An undecodable segment is audited as written.
      }
      into.gitlab.add(path);
    }
  }
  return into;
}

export type Visibility = "public" | "missing" | "private" | "internal" | "unknown";
export interface VisibilityFile {
  checkedAt: string;
  github: Record<string, Visibility>;
  gitlab: Record<string, Visibility>;
}

// "missing" is a repository the recording account could not see, so no data from it was read.
const ALLOWED: ReadonlySet<Visibility> = new Set(["public", "missing"]);

export interface AuditResult {
  entries: number;
  fields: number;
  references: { github: number; gitlab: number };
  findings: string[];
}

function lookup(map: Record<string, Visibility>, name: string): Visibility | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(map)) if (key.toLowerCase() === lower) return value;
  return undefined;
}

function scan(where: string, text: string, findings: string[], refs: References | undefined): void {
  for (const { name, pattern } of TOKEN_PATTERNS) {
    if (pattern.test(text)) findings.push(`${where}: ${name}`);
  }
  const emails = text.match(EMAIL);
  if (emails) findings.push(`${where}: email address (${emails.length})`);
  if (refs) references(text, refs);
}

/** Audits exec.jsonl and every other recorded JSON file in a sweep directory. */
export function auditSweep(directory: string): AuditResult {
  const findings: string[] = [];
  const refs: References = { github: new Set(), gitlab: new Set() };
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
    const named = fenced(entry) ? undefined : refs;
    for (const field of FIELDS) {
      const value = entry[field];
      if (value === undefined || value === null || typeof value === "number") continue;
      for (const [i, text] of (Array.isArray(value) ? value : [value]).entries()) {
        fields++;
        scan(
          `${where} ${field}${Array.isArray(value) ? `[${i}]` : ""}`,
          String(text),
          findings,
          named,
        );
      }
    }
  });
  for (const name of readdirSync(directory).sort()) {
    if (name === LOG_FILE || name === VISIBILITY_FILE || !name.endsWith(".json")) continue;
    fields++;
    scan(name, readFileSync(join(directory, name), "utf8"), findings, refs);
  }
  const visibilityPath = join(directory, VISIBILITY_FILE);
  const visibility: VisibilityFile | undefined = existsSync(visibilityPath)
    ? JSON.parse(readFileSync(visibilityPath, "utf8"))
    : undefined;
  if (!visibility)
    findings.push(`${VISIBILITY_FILE}: missing; visibility is checked at record time`);
  for (const [forge, names] of [
    ["github", refs.github],
    ["gitlab", refs.gitlab],
  ] as const) {
    for (const name of [...names].sort()) {
      const seen = visibility ? lookup(visibility[forge], name) : undefined;
      if (visibility && !ALLOWED.has(seen ?? "unknown")) {
        findings.push(`${forge} ${name}: ${seen ?? "not checked at record time"}`);
      }
    }
  }
  return {
    entries: lines.length,
    fields,
    references: { github: refs.github.size, gitlab: refs.gitlab.size },
    findings,
  };
}

export function report(directory: string, result: AuditResult): string {
  return [
    `audit ${directory}: ${result.entries} entries, ${result.fields} fields, ` +
      `${result.references.github} GitHub repositories, ${result.references.gitlab} GitLab projects`,
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
