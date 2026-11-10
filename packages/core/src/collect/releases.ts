// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { RELEASES_EVERY_MS } from "../config.js";
import type { CoreContext } from "../context.js";
import type { ReadRecord } from "../evidence/index.js";
import type { Gh } from "../forge.js";
import { type BuildPins, type ReleaseFact, type ReleaseReads, pinKey } from "../releases.js";
import { errorText, pool } from "../util.js";
import { pinsOf } from "./pins.js";

export interface ReleasePersist {
  load(): Promise<unknown>;
  save(state: ReleaseState): Promise<void>;
}

export interface ReleaseState extends ReleaseReads {
  records: ReadRecord[];
  /** The object each cached pin's tag named when it was read; a pin without one is unconfirmed. */
  shas: Record<string, string>;
}

const recordSchema = z.object({
  source: z.string(),
  object: z.string(),
  observedAt: z.iso.datetime({ offset: true }),
  completeness: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("complete") }),
    z.object({
      kind: z.literal("cut"), reason: z.string(),
      read: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
    }),
  ]),
  failure: z.string().optional(),
  retainedFrom: z.iso.datetime({ offset: true }).optional(),
  inferred: z.boolean().optional(),
});
export const releaseStateSchema = z.object({
  at: z.iso.datetime({ offset: true }).optional(),
  releases: z.record(z.string(), z.array(z.object({
    tag: z.string(), at: z.string(), body: z.string(),
  }))),
  created: z.record(z.string(), z.string()),
  pins: z.record(z.string(), z.object({ lib: z.string().nullable(), java: z.string().nullable() })),
  errors: z.record(z.string(), z.string()),
  records: z.array(recordSchema).default([]),
  shas: z.record(z.string(), z.string()).default({}),
});

export function emptyReads(): ReleaseState {
  return { releases: {}, created: {}, pins: {}, errors: {}, records: [], shas: {} };
}

const JAVA_PROPS = Object.freeze([
  /<java\.version>\s*([^<$\s]+)\s*</,
  /<maven\.compiler\.release>\s*([^<$\s]+)\s*</,
  /<maven\.compiler\.target>\s*([^<$\s]+)\s*</,
]);

export function javaOf(pom: string): string | null {
  for (const re of JAVA_PROPS) {
    const v = re.exec(pom)?.[1];
    if (v) return v.replace(/^1\./, "");
  }
  return null;
}

export function pinPoms(paths: readonly string[]): string[] {
  return paths.filter(
    (p) => p.endsWith("pom.xml") && /azure|aks|enqueue/i.test(p) && !/test/i.test(p),
  );
}

interface RawBlob {
  text?: string | null;
}

export const TAG_REFS_JQ = '.[] | {tag: (.ref | ltrimstr("refs/tags/")), sha: .object.sha}';

/** Every tag ref in one request: matching-refs takes no page size and answers with the lot. */
async function readTagShas(gh: Gh, repo: string): Promise<Map<string, string>> {
  const refs = await gh.pages<{ tag: string; sha: string }>(`repos/${repo}/git/matching-refs/tags/`, TAG_REFS_JQ);
  return new Map(refs.map((r) => [r.tag, r.sha]));
}

async function readPins(gh: Gh, repo: string, tag: string): Promise<BuildPins> {
  const tree = await gh.rest<{ paths: string[]; truncated: boolean }>(
    `repos/${repo}/git/trees/${encodeURIComponent(tag)}?recursive=1`,
    "{paths: [.tree[].path], truncated: .truncated}",
  );
  if (tree.truncated) throw new Error(`${repo} tree truncated at ${tag}`);
  const poms = ["pom.xml", ...pinPoms(tree.paths)];
  const [owner, name] = repo.split("/");
  const fields = poms.map((p, i) =>
    `p${i}: object(expression: ${JSON.stringify(`${tag}:${p}`)}) { ... on Blob { text } }`,
  ).join(" ");
  const { data, errors } = await gh.graphql<{
    repository: Record<string, RawBlob | null> | null;
  }>(`{ repository(owner: "${owner}", name: "${name}") { ${fields} } }`);
  if (errors.length > 0 || !data.repository) {
    throw new Error(errors[0]?.message ?? `${repo} not readable at ${tag}`);
  }
  const texts = poms.map((_, i) => data.repository?.[`p${i}`]?.text ?? "");
  const root = texts[0] ?? "";
  const lib = texts.slice(1).concat(root).map((t) => pinsOf(t).coreLibAzure)
    .find((v) => v && !v.startsWith("$"));
  return { lib: lib ?? null, java: javaOf(root) };
}

export class ReleaseReader {
  private reads = emptyReads();
  private reading: Promise<void> | undefined;
  private loaded = false;
  private savePending = false;

  constructor(
    private readonly gh: Gh,
    private readonly persist: ReleasePersist,
    private readonly ctx: CoreContext,
    private readonly onChange: () => void = () => undefined,
  ) {}

  get data(): ReleaseState { return this.reads; }
  get records(): readonly ReadRecord[] { return this.reads.records; }
  get busy(): boolean { return !!this.reading; }

  read(opts: { force?: boolean; refreshPins?: boolean } = {}): Promise<void> {
    if (this.reading) return this.reading;
    this.reading = this.readIfDue(opts.force === true, opts.refreshPins === true).finally(() => {
      this.reading = undefined;
    });
    return this.reading;
  }

  private record(source: string, object: string, failure?: string, retained = false): void {
    const previous = this.reads.records.find((r) => r.source === source && r.object === object);
    const retainedFrom = retained
      ? previous?.retainedFrom ?? (previous?.failure ? undefined : previous?.observedAt)
      : undefined;
    this.reads.records = this.reads.records.filter((r) => r.source !== source || r.object !== object);
    this.reads.records.push({
      source, object, observedAt: this.ctx.clock.now().toISOString(),
      completeness: { kind: "complete" },
      ...(failure === undefined ? {} : { failure }),
      ...(retainedFrom === undefined ? {} : { retainedFrom }),
    });
  }

  private dropRecord(source: string, object: string): void {
    this.reads.records = this.reads.records.filter((r) => r.source !== source || r.object !== object);
  }

  private async readIfDue(force: boolean, refreshPins: boolean): Promise<void> {
    if (!this.loaded) {
      this.dropRecord("release-state", "load");
      try {
        const value = await this.persist.load();
        if (value !== undefined && value !== null) {
          const parsed = releaseStateSchema.safeParse(value);
          if (!parsed.success) throw new Error(`Invalid persisted release reads: ${parsed.error.message}`);
          this.reads = parsed.data;
          this.dropRecord("release-state", "load");
        }
      } catch (error) {
        this.record("release-state", "load", errorText(error));
      }
      this.loaded = true;
    }
    const last = Date.parse(this.reads.at ?? "");
    if (!force && Number.isFinite(last) && this.ctx.clock.now().getTime() - last < RELEASES_EVERY_MS) {
      if (this.savePending) await this.save();
      return;
    }
    await this.readAll(refreshPins);
  }

  private async readAll(refreshPins: boolean): Promise<void> {
    const repos = [...this.ctx.fleet.releaseRepos];
    const forks = new Set(this.ctx.fleet.forks.map((f) => f.repo));
    const releases = { ...this.reads.releases };
    const errors: Record<string, string> = {};
    await pool(repos, 4, async (repo) => {
      try {
        const list = await this.gh.pages<ReleaseFact>(
          `repos/${repo}/releases?per_page=100`,
          '.[] | select(.draft | not) | {tag: .tag_name, at: (.published_at // .created_at), body: (.body // "")}',
        );
        releases[repo] = list.sort((a, b) => b.at.localeCompare(a.at));
        this.record("github-releases", repo);
      } catch (err) {
        errors[repo] = errorText(err);
        this.record("github-releases", repo, errors[repo], releases[repo] !== undefined);
      }
    });
    const created = { ...this.reads.created };
    try {
      const fields = repos.map((r, i) => {
        const [owner, name] = r.split("/");
        return `r${i}: repository(owner: "${owner}", name: "${name}") { createdAt }`;
      }).join(" ");
      const { data, errors: gqlErrors } = await this.gh.graphql<Record<string, { createdAt?: string } | null>>(
        `{ ${fields} }`,
      );
      repos.forEach((r, i) => {
        const at = data[`r${i}`]?.createdAt;
        if (at) {
          created[r] = at;
          this.record("github-created", r);
        } else {
          const own = gqlErrors.find((e) => e.path?.[0] === `r${i}`);
          const failure = own?.message ?? `${r} creation date not readable`;
          errors[`created:${r}`] = failure;
          this.record("github-created", r, failure, created[r] !== undefined);
        }
      });
    } catch (err) {
      errors.created = errorText(err);
      for (const repo of repos) this.record("github-created", repo, errors.created, created[repo] !== undefined);
    }
    const pins = { ...this.reads.pins };
    const shas = { ...this.reads.shas };
    const recorded = new Set(
      this.reads.records.filter((r) => r.source === "github-pins").map((r) => r.object),
    );
    const listed = Object.entries(releases).filter(([repo]) => forks.has(repo))
      .flatMap(([repo, list]) => list.map((r) => ({ repo, tag: r.tag, key: pinKey(repo, r.tag) })));
    const looked = new Map<string, Map<string, string>>();
    const lookups = [...new Set(listed.map((r) => r.repo))].filter((repo) => !errors[repo]);
    await pool(lookups, 4, async (repo) => {
      try {
        looked.set(repo, await readTagShas(this.gh, repo));
      } catch (err) {
        errors[`tags:${repo}`] = errorText(err);
      }
    });
    const confirmed = new Set<string>();
    const gone = new Set<string>();
    const reread: { repo: string; tag: string; key: string; sha?: string }[] = [];
    for (const r of listed) {
      const tags = looked.get(r.repo);
      const sha = tags?.get(r.tag);
      if (tags && sha === undefined) {
        gone.add(r.key);
        continue;
      }
      const unread = refreshPins || !pins[r.key] || this.reads.errors[r.key] !== undefined || !recorded.has(r.key);
      if (unread || (sha !== undefined && shas[r.key] !== sha)) reread.push({ ...r, ...(sha ? { sha } : {}) });
      else if (sha !== undefined) confirmed.add(r.key);
    }
    for (const key of gone) {
      delete pins[key];
      delete shas[key];
    }
    await pool(reread, 4, async ({ repo, tag, key, sha }) => {
      try {
        pins[key] = await readPins(this.gh, repo, tag);
        if (sha) shas[key] = sha;
        else delete shas[key];
        this.record("github-pins", key);
      } catch (err) {
        errors[key] = errorText(err);
        this.record("github-pins", key, errors[key], pins[key] !== undefined);
      }
    });
    this.settleRecords(repos, new Set(listed.map((r) => r.key)), gone, confirmed);
    const readAny = repos.some((r) => !errors[r]);
    this.reads = {
      ...(readAny ? { at: this.ctx.clock.now().toISOString() } : this.reads.at ? { at: this.reads.at } : {}),
      releases, created, pins, errors, records: this.reads.records, shas,
    };
    this.savePending = true;
    await this.save();
  }

  /**
   * A cached pin is confirmed when its tag still names the object it was read from, and only
   * then does it take this read's time; a moved tag was re-read above, and a tag lookup that
   * failed confirms nothing. Records for tags gone or no longer listed, and for repos no longer
   * in the fleet, go, since nothing re-reads them.
   */
  private settleRecords(
    repos: readonly string[],
    listed: ReadonlySet<string>,
    gone: ReadonlySet<string>,
    confirmed: ReadonlySet<string>,
  ): void {
    const current = new Set(repos);
    const now = this.ctx.clock.now().toISOString();
    this.reads.records = this.reads.records.flatMap((r) => {
      if (r.source === "github-pins") {
        if (!listed.has(r.object) || gone.has(r.object)) return [];
        return confirmed.has(r.object) && r.failure === undefined ? [{ ...r, observedAt: now }] : [r];
      }
      if (r.source === "github-releases" || r.source === "github-created") {
        return current.has(r.object) ? [r] : [];
      }
      return [r];
    });
  }

  private async save(): Promise<void> {
    this.dropRecord("release-state", "save");
    try {
      await this.persist.save(this.reads);
    } catch (error) {
      this.record("release-state", "save", errorText(error));
      throw error;
    }
    this.savePending = false;
    this.onChange();
  }
}
