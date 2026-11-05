// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { CoreContext } from "../context.js";
import type { ReadRecord } from "../evidence/index.js";
import type { RepoFact, UpstreamFact } from "../facts.js";
import { encodeProject, type Glab } from "../forge.js";
import { errorText, pool } from "../util.js";
import { usedAtSchema } from "./recency.js";

interface RawBranch {
  commit: { id: string; committed_date?: string; created_at?: string; web_url?: string };
}

interface RawCompare {
  commits?: { id: string; title: string; created_at: string; web_url: string }[];
  compare_timeout?: boolean;
}

const commitsSchema = z.array(z.object({ sha: z.string(), title: z.string(), at: z.string(), url: z.string() }));
const compareEntrySchema = z.object({ commits: commitsSchema, usedAt: usedAtSchema });
export type UpstreamCompare = z.infer<typeof compareEntrySchema>;
// A bare commit array is the shape saved before recency was tracked; it loads as least recently used.
export const upstreamCompareSchema = z.union([
  compareEntrySchema,
  commitsSchema.transform((commits): UpstreamCompare => ({ commits })),
]);
export type UpstreamCompares = Record<string, UpstreamCompare>;

// A compare between two fixed shas never changes, so only complete reads are kept.
export async function readUpstream(
  glab: Glab,
  repos: Record<string, RepoFact>,
  compares: UpstreamCompares,
  ctx: CoreContext,
): Promise<{ upstream: Record<string, UpstreamFact>; reads: ReadRecord[] }> {
  const upstream: Record<string, UpstreamFact> = {};
  const reads: ReadRecord[] = [];
  const usedAt = ctx.clock.now().toISOString();
  await pool(ctx.fleet.forks, 3, async (fork) => {
    let object = "repository/branches/master";
    const record = (): ReadRecord => ({
      source: fork.upstream, object, observedAt: ctx.clock.now().toISOString(),
      completeness: { kind: "complete" },
    });
    try {
      const project = encodeProject(fork.upstream);
      const synced = repos[fork.repo]?.upstreamSha?.sha;
      const fact: UpstreamFact = { service: fork.id, synced, commits: [] };
      const branch = await glab.rest<RawBranch>(`projects/${project}/${object}`);
      const headSha = branch.commit.id;
      fact.head = {
        sha: headSha,
        at: branch.commit.committed_date ?? branch.commit.created_at ?? "",
        url: branch.commit.web_url ?? "",
      };
      reads.push(record());
      if (synced) {
        if (headSha.startsWith(synced) || synced.startsWith(headSha)) {
          fact.lag = 0;
        } else {
          const key = `${synced}...${headSha}`;
          object = `repository/compare?from=${synced}&to=${headSha}`;
          let commits = compares[key]?.commits;
          if (!commits) {
            const cmp = await glab.rest<RawCompare>(`projects/${project}/${object}`);
            if (!cmp.commits) throw new Error("compare response has no commits");
            if (cmp.compare_timeout) {
              reads.push({
                ...record(),
                completeness: {
                  kind: "cut", reason: "GitLab compare timed out; total is a lower bound",
                  read: cmp.commits.length, total: cmp.commits.length + 1,
                },
              });
              upstream[fork.id] = fact;
              return;
            }
            commits = cmp.commits.map((c) => ({
              sha: c.id, title: c.title, at: c.created_at, url: c.web_url,
            }));
          }
          compares[key] = { commits, usedAt };
          fact.commits = commits;
          fact.lag = commits.length;
          reads.push(record());
        }
      }
      upstream[fork.id] = fact;
    } catch (error) {
      reads.push({ ...record(), failure: errorText(error) });
    }
  });
  return { upstream, reads };
}
