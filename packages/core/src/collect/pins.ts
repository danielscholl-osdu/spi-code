// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { CoreContext } from "../context.js";
import type { ReadRecord } from "../evidence/index.js";
import type { RadarFacts } from "../facts.js";
import type { Gh, Glab } from "../forge.js";
import { errorText } from "../util.js";

export interface PinRead {
  osCoreCommon?: string;
  coreLibAzure?: string;
}

export function pinsOf(pom: string): PinRead {
  const prop = (name: string) =>
    new RegExp(`<${name.replace(/\./g, "\\.")}>\\s*([^<$\\s]+)\\s*<`).exec(pom)?.[1];
  const artifact =
    /<artifactId>\s*core-lib-azure\s*<\/artifactId>\s*<version>\s*([^<$\s]+)\s*</.exec(pom)?.[1];
  const osCoreCommon = prop("os-core-common.version");
  const coreLibAzure = prop("core-lib-azure.version") ?? artifact;
  return {
    ...(osCoreCommon ? { osCoreCommon } : {}),
    ...(coreLibAzure ? { coreLibAzure } : {}),
  };
}

const LIBRARIES = Object.freeze({
  osCoreCommon: "osdu/platform/system/lib/core/os-core-common",
  coreLibAzure: "osdu/platform/system/lib/cloud/azure/os-core-lib-azure",
});
const LATEST_MS = 60 * 60_000;
const REMOVAL_GROUP = "osdu/platform";
const REMOVAL_LABELS = Object.freeze({
  pending: "SPI fork::pending",
  established: "SPI fork::established",
});

export type RemovalRead = NonNullable<RadarFacts["removal"]>;
interface Cached<T> {
  value?: T;
  record: ReadRecord;
}
export interface PinState {
  poms: Record<string, PinRead>;
  forks: Record<string, Cached<PinRead>>;
  upstreamPoms: Record<string, Cached<PinRead>>;
  latest: Partial<Record<keyof PinRead, Cached<PinRead>>>;
  latestAt?: string;
  removal?: Cached<RemovalRead>;
  removalAt?: string;
}

export function emptyPinState(): PinState {
  return { poms: {}, forks: {}, upstreamPoms: {}, latest: {} };
}

async function attempt<T>(
  ctx: CoreContext, source: string, object: string, previous: Cached<T> | undefined,
  load: () => Promise<T>,
): Promise<Cached<T>> {
  const record: ReadRecord = {
    source, object, observedAt: ctx.clock.now().toISOString(), completeness: { kind: "complete" },
  };
  try {
    return { value: await load(), record };
  } catch (error) {
    const last = previous?.record;
    const retainedFrom = previous?.value === undefined ? undefined
      : last?.retainedFrom ?? (last?.failure === undefined ? last?.observedAt : undefined);
    return {
      ...(previous?.value === undefined ? {} : { value: previous.value }),
      record: {
        ...record, failure: errorText(error) || "Unknown error",
        ...(retainedFrom ? { retainedFrom } : {}),
      },
    };
  }
}

function decode(content: string): string {
  return Buffer.from(content.replace(/\s/g, ""), "base64").toString("utf8");
}

interface RawPoms {
  root?: { oid?: string } | null;
  azure?: { oid?: string } | null;
}
type ForkPins = { root?: PinRead; azure?: PinRead };

export async function readForkPins(
  gh: Gh, forks: readonly { id: string; repo: string; azure?: string }[],
  state: PinState, ctx: CoreContext,
): Promise<{ pins: Record<string, ForkPins>; reads: ReadRecord[] }> {
  const pins: Record<string, ForkPins> = {};
  const reads: ReadRecord[] = [];
  if (forks.length === 0) return { pins, reads };
  const fields = forks.map((f, i) => {
    const [owner, name] = f.repo.split("/");
    const azure = f.azure
      ? ` azure: object(expression: ${JSON.stringify(`main:${f.azure}/pom.xml`)}) { ... on Blob { oid } }`
      : "";
    return `pom${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { root: object(expression: "main:pom.xml") { ... on Blob { oid } }${azure} }`;
  });
  let data: Record<string, RawPoms | null> = {};
  let errors: Awaited<ReturnType<Gh["graphql"]>>["errors"] = [];
  let failure: string | undefined;
  try {
    const result = await gh.graphql<Record<string, RawPoms | null>>(`query { ${fields.join(" ")} }`);
    data = result.data;
    errors = result.errors;
  } catch (error) {
    failure = errorText(error) || "Unknown error";
  }
  for (const [i, fork] of forks.entries()) {
    const out: ForkPins = {};
    for (const kind of ["root", "azure"] as const) {
      if (kind === "azure" && !fork.azure) continue;
      const object = kind === "root" ? "main:pom.xml" : `main:${fork.azure}/pom.xml`;
      const key = `${fork.repo}:${object}`;
      const cached = await attempt(ctx, fork.repo, object, state.forks[key], async () => {
        const error = errors.find((e) => !e.path?.length || (
          e.path[0] === `pom${i}` && (e.path.length === 1 || e.path[1] === kind)
        ));
        if (failure !== undefined || error) throw new Error(failure ?? error?.message);
        const oid = data[`pom${i}`]?.[kind]?.oid;
        if (!oid) throw new Error(`${object} is not readable`);
        const blobKey = `${fork.repo}:${oid}`;
        const known = state.poms[blobKey];
        if (known) return known;
        const file = await gh.rest<{ content: string }>(`repos/${fork.repo}/git/blobs/${oid}`);
        const value = pinsOf(decode(file.content));
        state.poms[blobKey] = value;
        return value;
      });
      state.forks[key] = cached;
      reads.push(cached.record);
      if (cached.value !== undefined) out[kind] = cached.value;
    }
    pins[fork.id] = out;
  }
  return { pins, reads };
}

export async function readUpstreamPins(
  glab: Glab, project: string, head: string | undefined, state: PinState, ctx: CoreContext,
): Promise<{ pins?: PinRead; reads: ReadRecord[] }> {
  if (!head) return { reads: [] };
  const key = `${project}:${head}`;
  const known = state.upstreamPoms[key];
  if (known?.record.failure === undefined && known?.value !== undefined) {
    return { pins: known.value, reads: [known.record] };
  }
  const path = `projects/${encodeURIComponent(project)}/repository/files/pom.xml?ref=${encodeURIComponent(head)}`;
  const cached = await attempt(ctx, project, path, known, async () => {
    const file = await glab.rest<{ content: string }>(path);
    return pinsOf(decode(file.content));
  });
  state.upstreamPoms[key] = cached;
  return { ...(cached.value === undefined ? {} : { pins: cached.value }), reads: [cached.record] };
}

function newest(tags: readonly string[]): string | undefined {
  return tags.filter((t) => /^v?\d+\.\d+\.\d+$/.test(t)).map((t) => t.replace(/^v/, ""))
    .sort((a, b) => {
      const pa = a.split(".").map(Number);
      const pb = b.split(".").map(Number);
      for (let i = 0; i < 3; i++)
        if (pa[i] !== pb[i]) return (pb[i] ?? 0) - (pa[i] ?? 0);
      return 0;
    })[0];
}

export async function readLatest(
  glab: Glab, state: PinState, ctx: CoreContext,
): Promise<{ pins: PinRead; reads: ReadRecord[] }> {
  const now = ctx.clock.now();
  if (!state.latestAt || now.getTime() - Date.parse(state.latestAt) >= LATEST_MS) {
    for (const key of Object.keys(LIBRARIES) as (keyof PinRead)[]) {
      const project = LIBRARIES[key];
      state.latest[key] = await attempt(ctx, project, "release tags", state.latest[key], async () => {
        const tags = await glab.restAll<{ name: string }>(
          `projects/${encodeURIComponent(project)}/repository/tags`,
        );
        const top = newest(tags.map((t) => t.name));
        if (!top) throw new Error("No release tags are readable");
        return { [key]: top };
      });
    }
    state.latestAt = now.toISOString();
  }
  const pins: PinRead = {};
  const reads: ReadRecord[] = [];
  for (const cached of Object.values(state.latest)) {
    Object.assign(pins, cached.value);
    reads.push(cached.record);
  }
  return { pins, reads };
}

interface RawIssue {
  references?: { full?: string };
  milestone?: { due_date?: string | null } | null;
}

export async function readRemoval(
  glab: Glab, state: PinState, ctx: CoreContext,
): Promise<{ removal?: RemovalRead; reads: ReadRecord[] }> {
  const now = ctx.clock.now();
  if (!state.removalAt || now.getTime() - Date.parse(state.removalAt) >= LATEST_MS) {
    state.removal = await attempt(ctx, REMOVAL_GROUP, "removal issues", state.removal, async () => {
      const labels: RemovalRead["labels"] = {};
      let due: string | undefined;
      for (const stage of Object.keys(REMOVAL_LABELS) as (keyof typeof REMOVAL_LABELS)[]) {
        const issues = await glab.restAll<RawIssue>(
          `groups/${encodeURIComponent(REMOVAL_GROUP)}/issues?labels=${encodeURIComponent(REMOVAL_LABELS[stage])}&state=all`,
        );
        for (const issue of issues) {
          const project = issue.references?.full?.split("#")[0];
          if (project && labels[project] !== "established") labels[project] = stage;
          due ??= issue.milestone?.due_date ?? undefined;
        }
      }
      return { ...(due ? { due } : {}), labels };
    });
    state.removalAt = now.toISOString();
  }
  const cached = state.removal;
  return {
    ...(cached?.value === undefined ? {} : { removal: cached.value }),
    reads: cached ? [cached.record] : [],
  };
}
