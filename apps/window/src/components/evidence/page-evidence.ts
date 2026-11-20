// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type {
  AreaName,
  ReadRecord,
  TodayLine,
  TodayMember,
  ValueSource,
} from "@spi-code/contracts";
import { AREAS } from "@spi-code/contracts";
import type { EvidenceSelection } from "../../app/navigation.js";
import { readFork } from "./FailedReads.js";

export type ReadGroup = {
  forge: "github" | "gitlab";
  /** The repository or GitLab project read; absent when the group holds several forks' reads. */
  source?: string;
  records: { fork: string; record: ReadRecord }[];
};

export type PageEvidence = {
  title: string;
  notRead: string[];
  /** The fork's reads, one group per member fork for a line, then GitLab's for upstream work. */
  reads: ReadGroup[];
  /** Forks whose reads were looked for and none were found. */
  unread: string[];
  areas: AreaName[];
  attributed: "item" | "sweep";
};

/** Upstream work: core says the item was read from GitLab's master or its open merge requests. */
const upstreamWork = (member: Pick<TodayMember, "evidence">) =>
  member.evidence.areas.includes("upstream") || member.evidence.areas.includes("radar");

function forkReads(
  members: readonly Pick<TodayMember, "fork" | "evidence">[],
  reads: readonly ReadRecord[],
): Pick<PageEvidence, "reads" | "unread"> {
  const owned = (forge: ReadGroup["forge"], fork: string) =>
    reads.flatMap((record) => {
      const owner = readFork(record);
      return owner?.forge === forge && owner.fork === fork ? [{ fork, record }] : [];
    });
  const forks = [...new Set(members.map(({ fork }) => fork))];
  const github = forks.map((fork) => ({ fork, records: owned("github", fork) }));
  const gitlab = [...new Set(members.filter(upstreamWork).map(({ fork }) => fork))].flatMap(
    (fork) => owned("gitlab", fork),
  );
  const bySource = (records: ReadGroup["records"], forge: ReadGroup["forge"]): ReadGroup[] =>
    [...new Set(records.map(({ record }) => record.source))].map((source) => ({
      forge,
      source,
      records: records.filter(({ record }) => record.source === source),
    }));
  const forkRecords = github.flatMap(({ records }) => records);
  return {
    reads: [
      ...(forks.length > 1
        ? forkRecords.length > 0
          ? [{ forge: "github" as const, records: forkRecords }]
          : []
        : bySource(forkRecords, "github")),
      ...bySource(gitlab, "gitlab"),
    ],
    unread: github.filter(({ records }) => records.length === 0).map(({ fork }) => fork),
  };
}

const ordered = (areas: Iterable<AreaName>) => {
  const named = new Set(areas);
  return AREAS.filter((area) => named.has(area));
};

/**
 * What a Today item or line was read from, as core attributed it: not read first, then the reads
 * of each member's fork (and its GitLab project for upstream work), then the areas. Null when
 * the briefing no longer holds the selection.
 */
export function pageEvidence(
  selection: EvidenceSelection,
  lines: readonly TodayLine[],
  reads: readonly ReadRecord[],
): PageEvidence | null {
  const line =
    selection.kind === "line"
      ? lines.find(({ id }) => id === selection.id)
      : (lines.find(({ members }) => members.some(({ id }) => id === selection.id)) ??
        lines.find(({ members }) => members.some(({ ids }) => ids.includes(selection.id))));
  if (!line) return null;
  const members =
    selection.kind === "line"
      ? line.members
      : line.members.filter(({ id, ids }) => id === selection.id || ids.includes(selection.id));
  const lead = members[0];
  if (!lead) return null;
  const subject = line.members.length === 1 || selection.kind === "line" ? line.subject : lead.fork;
  return {
    title: `${subject} · ${line.headline}`,
    notRead: [...new Set(members.flatMap(({ evidence }) => evidence.notRead))],
    ...forkReads(members, reads),
    areas: ordered(members.flatMap(({ evidence }) => evidence.areas)),
    attributed: members.some(({ evidence }) => evidence.attributed === "sweep") ? "sweep" : "item",
  };
}

/**
 * What a service's home was read from: its fork's reads, its GitLab project's when the home reads
 * upstream, and the areas its provenance names. Null when the sweep holds no home for it.
 */
export function serviceEvidence(
  service: string,
  snapshot: {
    services?: readonly { service: string }[] | undefined;
    provenance: readonly ValueSource[];
    reads: readonly ReadRecord[];
  },
): PageEvidence | null {
  const index = snapshot.services?.findIndex((entry) => entry.service === service) ?? -1;
  const source = snapshot.provenance.find(({ path }) => path === `/services/${index}/home`);
  if (index < 0 || !source) return null;
  const evidence = { areas: source.areas, notRead: [], attributed: source.attributed ?? "sweep" };
  return {
    title: service,
    notRead: [],
    ...forkReads([{ fork: service, evidence }], snapshot.reads),
    areas: ordered(source.areas),
    attributed: evidence.attributed,
  };
}
