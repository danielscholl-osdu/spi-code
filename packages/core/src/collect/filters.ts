// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { githubUrl, gitlabUrl } from "../config.js";
import type { CoreContext } from "../context.js";
import type { ReadRecord } from "../evidence/index.js";
import { encodeProject, type Gh, type Glab } from "../forge.js";
import { filterSection } from "../model/filter.js";
import type { HaltEntries } from "../model/queue.js";
import { errorText } from "../util.js";

export { filterSection };

export const FILTER_PATH = ".github/upstream-filter.yml";

// absent: upstream has no such entry, so this fork will not halt on it.
// listed: the fork's filter already classifies it. unlisted: the next sync halts.
export type EntryState = "absent" | "listed" | "unlisted" | "unread";

export interface ForkEntry {
  fork: string;
  entry: string;
  state: EntryState;
  verdict?: string;
  url?: string;
  /** The reads this entry's state rests on. */
  reads: ReadRecord[];
  /** Every read made for this entry's fork, failed ones included. */
  attempted: ReadRecord[];
}

// The halts whose entries are checked against each fork's filter, and where they live.
const CHECKED: Readonly<Record<string, { readonly section: string; readonly path?: string }>> = {
  UNKNOWN_TOP_LEVEL: { section: "top_level" },
  UNKNOWN_TESTING_ENTRY: { section: "testing", path: "testing" },
};

export function checkable(halt: HaltEntries | undefined): halt is HaltEntries {
  return !!halt && halt.entries.length > 0 && Object.hasOwn(CHECKED, halt.code);
}

// The filter is a flat `section:` then indented `name: verdict` map, so a line
// reader is enough and the rib carries no YAML dependency.
export async function readFilterFile(gh: Gh, repo: string): Promise<{ sha: string; text: string }> {
  const file = await gh.rest<{ sha: string; content: string }>(
    `repos/${repo}/contents/${FILTER_PATH}`,
  );
  return {
    sha: file.sha,
    text: Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8"),
  };
}

async function readFilter(gh: Gh, repo: string): Promise<string> {
  return (await readFilterFile(gh, repo)).text;
}

async function readTree(glab: Glab, project: string, object: string): Promise<Set<string>> {
  const tree = await glab.restAll<{ name: string }>(
    `projects/${encodeProject(project)}/${object}`,
  );
  return new Set(tree.map((t) => t.name));
}

async function recorded<T>(
  ctx: Pick<CoreContext, "clock">,
  source: string,
  object: string,
  read: () => Promise<T>,
): Promise<{ result: PromiseSettledResult<T>; record: ReadRecord }> {
  let result: PromiseSettledResult<T>;
  try {
    result = { status: "fulfilled", value: await read() };
  } catch (reason) {
    result = { status: "rejected", reason };
  }
  return {
    result,
    record: {
      source, object, observedAt: ctx.clock.now().toISOString(),
      completeness: { kind: "complete" },
      ...(result.status === "rejected" ? { failure: errorText(result.reason) } : {}),
    },
  };
}

export async function entryAcrossForks(
  gh: Gh,
  glab: Glab,
  halt: HaltEntries,
  ctx: Pick<CoreContext, "fleet" | "clock">,
): Promise<ForkEntry[]> {
  const where = Object.hasOwn(CHECKED, halt.code) ? CHECKED[halt.code] : undefined;
  if (!where) return [];
  const others = ctx.fleet.forks.filter((f) => f.id !== halt.fork);
  const object = `repository/tree?ref=master${where.path ? `&path=${encodeURIComponent(where.path)}` : ""}`;
  const perFork = await Promise.all(
    others.map(async (fork): Promise<ForkEntry[]> => {
      const [filterRead, treeRead] = await Promise.all([
        recorded(ctx, fork.repo, FILTER_PATH, () => readFilter(gh, fork.repo)),
        recorded(ctx, fork.upstream, object, () => readTree(glab, fork.upstream, object)),
      ]);
      const filter = filterRead.result;
      const tree = treeRead.result;
      const attempted = [filterRead.record, treeRead.record];
      const treeOnly = [treeRead.record];
      const listed =
        filter.status === "fulfilled" ? filterSection(filter.value, where.section) : undefined;
      const present = tree.status === "fulfilled" ? tree.value : undefined;
      return halt.entries.map((entry): ForkEntry => {
        if (!present) {
          return { fork: fork.id, entry, state: "unread", reads: treeOnly, attempted };
        }
        if (!present.has(entry)) {
          return {
            fork: fork.id,
            entry,
            state: "absent",
            url: gitlabUrl(fork.upstream, `/-/tree/master${where.path ? `/${where.path}` : ""}`),
            reads: treeOnly,
            attempted,
          };
        }
        if (!listed) return { fork: fork.id, entry, state: "unread", reads: attempted, attempted };
        const verdict = listed.get(entry);
        return {
          fork: fork.id,
          entry,
          state: verdict ? "listed" : "unlisted",
          ...(verdict ? { verdict } : {}),
          url: githubUrl(fork.repo, `/blob/main/${FILTER_PATH}`),
          reads: attempted,
          attempted,
        };
      });
    }),
  );
  return perFork.flat();
}
