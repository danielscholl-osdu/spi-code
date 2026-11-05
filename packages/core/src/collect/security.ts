// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { CoreContext } from "../context.js";
import type { ReadRecord } from "../evidence/index.js";
import type { CodeAlertFact, DependencyAlertFact, RepoAlerts, Severity } from "../facts.js";
import type { Gh } from "../forge.js";
import { errorText, pool } from "../util.js";

const DEPENDABOT_JQ = `.[] | {number, severity: .security_advisory.severity, package: .dependency.package.name, ecosystem: .dependency.package.ecosystem, manifest: .dependency.manifest_path, scope: .dependency.scope, fixed: .security_vulnerability.first_patched_version.identifier, advisory: .security_advisory.ghsa_id, cve: .security_advisory.cve_id, summary: .security_advisory.summary, url: .html_url, createdAt: .created_at}`;

const CODE_JQ = `.[] | {number, severity: .rule.security_severity_level, ruleSeverity: .rule.severity, rule: .rule.id, description: .rule.description, tool: .tool.name, path: .most_recent_instance.location.path, url: .html_url, createdAt: .created_at}`;

const SEVERITIES: ReadonlySet<string> = new Set(["critical", "high", "medium", "low"]);

type Raw = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function severity(v: unknown): Severity | undefined {
  const s = str(v)?.toLowerCase();
  if (s === "moderate") return "medium";
  return s && SEVERITIES.has(s) ? (s as Severity) : undefined;
}

export function parseDependencyAlert(r: Raw): DependencyAlertFact | undefined {
  const sev = severity(r.severity);
  const pkg = str(r.package);
  const manifest = str(r.manifest);
  const url = str(r.url);
  if (typeof r.number !== "number" || !sev || !pkg || !manifest || !url) return undefined;
  const scope = str(r.scope);
  const fixed = str(r.fixed);
  const cve = str(r.cve);
  return {
    number: r.number,
    severity: sev,
    package: pkg,
    ecosystem: str(r.ecosystem) ?? "",
    manifest,
    ...(scope === "runtime" || scope === "development" ? { scope } : {}),
    ...(fixed ? { fixed } : {}),
    advisory: str(r.advisory) ?? "",
    ...(cve ? { cve } : {}),
    summary: str(r.summary) ?? pkg,
    url,
    createdAt: str(r.createdAt) ?? "",
  };
}

export function parseCodeAlert(r: Raw): CodeAlertFact | undefined {
  const rule = str(r.rule);
  const url = str(r.url);
  if (typeof r.number !== "number" || !rule || !url) return undefined;
  const sev = severity(r.severity);
  const ruleSeverity = str(r.ruleSeverity);
  const path = str(r.path);
  return {
    number: r.number,
    ...(sev ? { severity: sev } : {}),
    ...(ruleSeverity ? { ruleSeverity } : {}),
    rule,
    description: str(r.description) ?? rule,
    tool: str(r.tool) ?? "",
    ...(path ? { path } : {}),
    url,
    createdAt: str(r.createdAt) ?? "",
  };
}

// GitHub answers 404 or 403 when a list is off or hidden from this token.
function hidden(err: unknown): boolean {
  return /HTTP 40[34]\b/.test(errorText(err));
}

async function list<T>(
  gh: Gh,
  path: string,
  jq: string,
  parse: (r: Raw) => T | undefined,
): Promise<T[] | undefined> {
  try {
    const raw = await gh.pages<Raw>(`${path}?state=open&per_page=100`, jq);
    return raw.flatMap((r) => parse(r) ?? []);
  } catch (err) {
    if (hidden(err)) return undefined;
    throw err;
  }
}

export interface SecurityRead {
  data: Record<string, RepoAlerts>;
  reads: readonly ReadRecord[];
}

export async function readSecurity(
  gh: Gh,
  prev: SecurityRead | undefined,
  ctx: CoreContext,
): Promise<SecurityRead> {
  const out: Record<string, RepoAlerts> = {};
  const reads = await pool(ctx.fleet.repos, 4, async (repo): Promise<ReadRecord> => {
    const record: ReadRecord = {
      source: repo,
      object: "security",
      observedAt: ctx.clock.now().toISOString(),
      completeness: { kind: "complete" },
    };
    try {
      const [dependabot, code] = await Promise.all([
        list(gh, `repos/${repo}/dependabot/alerts`, DEPENDABOT_JQ, parseDependencyAlert),
        list(gh, `repos/${repo}/code-scanning/alerts`, CODE_JQ, parseCodeAlert),
      ]);
      out[repo] = { ...(dependabot ? { dependabot } : {}), ...(code ? { code } : {}) };
      return record;
    } catch (err) {
      const last = prev?.data[repo];
      if (last) out[repo] = last;
      const previous = prev?.reads.find((r) => r.source === repo && r.object === "security");
      const retainedFrom = last
        ? (previous?.retainedFrom ?? (previous?.failure === undefined ? previous?.observedAt : undefined))
        : undefined;
      return {
        ...record,
        failure: errorText(err),
        ...(retainedFrom ? { retainedFrom } : {}),
      };
    }
  });
  return { data: out, reads };
}
