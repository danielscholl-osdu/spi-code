// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { parse } from "yaml";
import { z } from "zod";
import {
  builtInFleet,
  DECLARATION_PATH,
  GITLAB_EVERY_MS,
  GITLAB_HOST,
  KNOWN_SERVICES,
  type ServiceDef,
  STACK_REPO,
  TEMPLATE_REPO,
} from "../config.js";
import type { ReadRecord } from "../evidence/index.js";
import type { FleetEntry, FleetFacts, ForkVars } from "../facts.js";
import type { Gh } from "../forge.js";
import { type ParsedRollout, parseRollout } from "../rollout.js";
import { pool } from "../util.js";
import { APP_VOICE, type Voice } from "../voice.js";

export const ROLLOUT_PATH = ".github/fleet/rollout.json";
export type FleetFiles = { services?: string | null; rollout?: string | null };
export type FleetFileReader = (path: string) => string | null;
export interface FleetRead extends FleetFacts {
  reads: ReadRecord[];
}

const servicesSchema = z.array(z.object({
  id: z.string(),
  upstream: z.string(),
  prefix: z.string().optional(),
  repo: z.string().optional(),
  seeded: z.string().optional(),
  mirror: z.boolean().nullable().optional(),
}));

function blob(alias: string, repo: string, path: string): string {
  const [owner, name] = repo.split("/");
  return `${alias}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { object(expression: ${JSON.stringify(`main:${path}`)}) { ... on Blob { text } } }`;
}
type BlobRepo = { object: { text?: string } | null } | null;

function record(
  source: string,
  object: string,
  now: Date,
  previous: readonly ReadRecord[],
  error?: unknown,
): ReadRecord {
  const last = previous.find((r) => r.source === source && r.object === object);
  const retainedFrom = last?.failure === undefined ? last?.observedAt : last.retainedFrom;
  return {
    source, object, observedAt: now.toISOString(), completeness: { kind: "complete" },
    ...(error === undefined ? {} : {
      failure: error instanceof Error ? error.message : String(error),
      ...(retainedFrom ? { retainedFrom } : {}),
    }),
  };
}

export function parseForks(text: string, voice: Voice = APP_VOICE): FleetEntry[] {
  const doc = parse(text) as { forks?: unknown } | null;
  if (!Array.isArray(doc?.forks)) throw new Error(`${DECLARATION_PATH} has no forks: list`);
  const out: FleetEntry[] = [];
  for (const raw of doc.forks as unknown[]) {
    const e = raw as Partial<Record<keyof FleetEntry, unknown>> | null;
    if (typeof e?.service !== "string" || typeof e.repo !== "string") continue;
    if (!/^[\w.-]+\/[\w.-]+$/.test(e.repo)) continue;
    out.push({
      service: e.service,
      repo: e.repo,
      ...(typeof e.canonicalSource === "string" ? { canonicalSource: e.canonicalSource } : {}),
    });
  }
  if (out.length === 0) throw new Error(`${DECLARATION_PATH} lists no forks ${voice.name} can read`);
  return out;
}

async function readVars(gh: Gh, repo: string): Promise<ForkVars> {
  const vars: { name: string; value: string }[] = [];
  for (let page = 1; ; page++) {
    const result = await gh.rest<{ total_count: number; variables: typeof vars }>(
      `repos/${repo}/actions/variables?per_page=100&page=${page}`,
    );
    vars.push(...result.variables);
    if (vars.length >= result.total_count) break;
    if (result.variables.length === 0) throw new Error(`${repo}: variables pagination ended before total_count`);
  }
  const value = (name: string) => vars.find((v) => v.name === name)?.value;
  const upstreamUrl = value("UPSTREAM_REPO_URL");
  const syncMode = value("SYNC_MODE");
  return { ...(upstreamUrl ? { upstreamUrl } : {}), ...(syncMode ? { syncMode } : {}) };
}

export async function readFleet(
  gh: Gh,
  prev: (FleetFacts & { reads?: readonly ReadRecord[] }) | undefined,
  now: Date,
  files: FleetFiles = {},
  stackRepo: string = STACK_REPO,
  voice: Voice = APP_VOICE,
): Promise<FleetRead> {
  const reads: ReadRecord[] = [];
  const previous = prev?.reads ?? [];
  const parts = [
    ...(files.services ? [] : [blob("stack", stackRepo, DECLARATION_PATH)]),
    ...(files.rollout ? [] : [blob("template", TEMPLATE_REPO, ROLLOUT_PATH)]),
  ];
  let data: { stack?: BlobRepo; template?: BlobRepo } = {};
  let queryFailure: Error | undefined;
  if (parts.length > 0) {
    try {
      const res = await gh.graphql<typeof data>(`query { ${parts.join("\n")} }`);
      if (res.errors.length > 0) throw new Error(`fleet read: ${res.errors[0]?.message}`);
      data = res.data;
    } catch (error) {
      queryFailure = error instanceof Error ? error : new Error(String(error));
    }
  }
  let forks: FleetEntry[] | undefined;
  if (!files.services) {
    try {
      if (queryFailure) throw queryFailure;
      if (!data.stack) throw new Error(`${stackRepo} is not readable`);
      const text = data.stack.object?.text;
      if (text === undefined) throw new Error(`${stackRepo} has no ${DECLARATION_PATH} on main`);
      forks = parseForks(text, voice);
      reads.push(record(stackRepo, DECLARATION_PATH, now, previous));
    } catch (error) {
      forks = prev?.forks;
      reads.push(record(stackRepo, DECLARATION_PATH, now, previous, error));
    }
  }
  let remote: Pick<FleetFacts, "rollout" | "rolloutFrom"> = {};
  if (!files.rollout) {
    try {
      if (queryFailure) throw queryFailure;
      if (!data.template) throw new Error(`${TEMPLATE_REPO} is not readable`);
      remote = { rollout: data.template.object?.text ?? null, rolloutFrom: `${TEMPLATE_REPO}:${ROLLOUT_PATH}` };
      reads.push(record(TEMPLATE_REPO, ROLLOUT_PATH, now, previous));
    } catch (error) {
      remote = {
        ...(prev?.rollout !== undefined ? { rollout: prev.rollout } : {}),
        ...(prev?.rolloutFrom !== undefined ? { rolloutFrom: prev.rolloutFrom } : {}),
      };
      reads.push(record(TEMPLATE_REPO, ROLLOUT_PATH, now, previous, error));
    }
  }
  let vars = prev?.vars ?? {};
  let varsAt = prev?.varsAt;
  const due = forks && (!varsAt || now.getTime() - Date.parse(varsAt) >= GITLAB_EVERY_MS ||
    forks.some((f) => !(f.repo in vars)));
  if (due && forks) {
    const read: Record<string, ForkVars | null> = {};
    const last = vars;
    await pool(forks, 4, async (f) => {
      try {
        read[f.repo] = await readVars(gh, f.repo);
        reads.push(record(f.repo, "actions/variables", now, previous));
      } catch (error) {
        read[f.repo] = last[f.repo] ?? null;
        reads.push(record(f.repo, "actions/variables", now, previous, error));
      }
    });
    vars = read;
    varsAt = now.toISOString();
  } else {
    reads.push(...previous.filter((r) =>
      r.object === "actions/variables" && forks?.some((f) => f.repo === r.source)));
  }
  return { ...(forks ? { forks } : {}), vars, ...(varsAt ? { varsAt } : {}), ...remote, reads };
}

export function upstreamProject(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try { parsed = new URL(url.trim()); } catch { return undefined; }
  if (!/^https?:$/.test(parsed.protocol) || parsed.hostname !== GITLAB_HOST) return undefined;
  const project = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  return project || undefined;
}

export interface ResolvedFleet {
  services: ServiceDef[];
  source: "stack" | "file" | "built-in";
  unresolved: { service: string; why: string }[];
}

export function resolveFleet(
  data: FleetFacts | undefined,
  pinned: ServiceDef[] | null = null,
): ResolvedFleet {
  if (pinned || !data?.forks) {
    return { services: pinned ?? builtInFleet(null), source: pinned ? "file" : "built-in", unresolved: [] };
  }
  const services: ServiceDef[] = [];
  const unresolved: ResolvedFleet["unresolved"] = [];
  const seen = new Set<string>();
  for (const entry of data.forks) {
    if (seen.has(entry.service)) continue;
    seen.add(entry.service);
    const known = KNOWN_SERVICES.find((s) => s.id === entry.service);
    const vars = data.vars[entry.repo];
    const upstream = known?.upstream ?? upstreamProject(vars?.upstreamUrl);
    if (!upstream) {
      unresolved.push({
        service: entry.service,
        why: vars === null ? "its repository variables are not readable" : "it has no UPSTREAM_REPO_URL variable",
      });
      continue;
    }
    const mirror = vars ? vars.syncMode === "mirror" : null;
    services.push({ ...known, id: entry.service, repo: entry.repo, upstream, mirror });
  }
  return { services, source: "stack", unresolved };
}

export function resolveRollout(data: FleetFacts | undefined, voice: Voice = APP_VOICE): ParsedRollout {
  if (typeof data?.rollout !== "string") return { warnings: [] };
  return parseRollout(data.rollout, voice);
}

export interface FleetView {
  fleet: ResolvedFleet;
  rollout: ParsedRollout;
  rolloutFrom?: string;
  rolloutMissing: boolean;
  reads: ReadRecord[];
}

export function fleetView(
  data: (FleetFacts & { reads?: readonly ReadRecord[] }) | undefined,
  files: FleetFiles,
  options: { now: Date; readFile?: FleetFileReader; previous?: FleetView; voice?: Voice },
): FleetView {
  const previous = options.previous;
  const reads = [...(data?.reads ?? [])];
  const local = <T>(path: string, parseText: (text: string | null) => T, fallback: T): T => {
    try {
      if (!options.readFile) throw new Error(`No fleet file reader for ${path}`);
      const result = parseText(options.readFile(path));
      reads.push(record("file", path, options.now, previous?.reads ?? []));
      return result;
    } catch (error) {
      reads.push(record("file", path, options.now, previous?.reads ?? [], error));
      return fallback;
    }
  };
  const fleet = files.services
    ? local(files.services, (text) => {
      if (text === null) throw new Error(`${files.services} is not readable`);
      return resolveFleet(data, servicesSchema.parse(JSON.parse(text)));
    }, previous?.fleet ?? resolveFleet(undefined))
    : resolveFleet(data);
  if (files.rollout) {
    const rollout = local(files.rollout, (text) => ({
      rollout: text === null ? { warnings: [] } : parseRollout(text, options.voice),
      rolloutMissing: text === null,
    }), { rollout: previous?.rollout ?? { warnings: [] }, rolloutMissing: previous?.rolloutMissing ?? true });
    return { fleet, ...rollout, rolloutFrom: files.rollout, reads };
  }
  return { fleet, rollout: resolveRollout(data, options.voice), ...(data?.rolloutFrom ? { rolloutFrom: data.rolloutFrom } : {}),
    rolloutMissing: data?.rollout === null, reads };
}
