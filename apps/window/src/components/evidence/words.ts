// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { AREAS, type AreaName, type Envelope, type ViewSnapshot } from "@spi-code/contracts";
import { clockTime, timeUnit } from "../../time.js";

/** Appendix C: each area in the words an operator reads. */
export const AREA_NAMES: Readonly<Record<AreaName, string>> = {
  fleet: "Fleet membership",
  github: "GitHub issues and PRs",
  runs: "Workflow runs",
  approvals: "Run approvals",
  lifecycle: "Stack lifecycle runs",
  details: "Run details",
  upstream: "Upstream GitLab",
  radar: "Upstream radar",
  template: "Template",
  auth: "Sign-in",
  security: "Security alerts",
};

const SOURCE_NAMES: Readonly<Record<string, string>> = { releases: "Release lines" };

/** What each sweep source reads, in the first-sweep list's fixed second column. */
export const SOURCE_READS: Readonly<Record<AreaName | "releases", string>> = {
  auth: "gh and glab",
  fleet: "forks, stack and rollout",
  github: "pull requests and checks",
  runs: "main and cascade on each fork",
  approvals: "runs waiting for approval",
  lifecycle: "deploys on the stack repo",
  template: "template revision per fork",
  details: "logs of failed checks",
  upstream: "GitLab master per fork",
  radar: "open merge requests upstream",
  security: "code scanning on each fork",
  releases: "release PRs and tags",
};

export function sourceReads(source: string): string | undefined {
  return Object.hasOwn(SOURCE_READS, source)
    ? SOURCE_READS[source as keyof typeof SOURCE_READS]
    : undefined;
}

export function sourceName(source: string): string {
  return (AREAS as readonly string[]).includes(source)
    ? AREA_NAMES[source as AreaName]
    : (SOURCE_NAMES[source] ?? source);
}

/** An identifier such as `job_log_char_limit` as words. */
export function plain(identifier: string): string {
  return identifier.replaceAll(/[_-]+/g, " ").trim();
}

const count = (value: number) => value.toLocaleString("en-US");

/** A duration in the largest whole unit: `4 min`, `3 h`, `2 d`. */
export function span(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return timeUnit(minutes, "min");
  const hours = Math.round(minutes / 60);
  return hours < 48 ? timeUnit(hours, "h") : timeUnit(Math.round(hours / 24), "d");
}

export function ago(at: string, now: number): string {
  return now - Date.parse(at) < 60_000 ? "just now" : `${span(now - Date.parse(at))} ago`;
}

export type EvidenceTone = "fresh" | "warn" | "bad" | "inferred" | "muted";

export function envelopeTone(envelope: Envelope): EvidenceTone {
  if (envelope.state === "failed") return "bad";
  if (envelope.state === "stale" || envelope.state === "incomplete") return "warn";
  if (envelope.state === "unread") return "muted";
  return envelope.inferred === true ? "inferred" : "fresh";
}

const STATE_WORDS: Readonly<Record<Envelope["state"], string>> = {
  fresh: "fresh",
  stale: "stale",
  incomplete: "cut",
  failed: "read failed",
  unread: "not read yet",
};

export function stateWord(envelope: Envelope): string {
  return STATE_WORDS[envelope.state];
}

/** The short chip text: `fresh · 2 min`, `cut · 40 of 52`, `read failed · showing 25 min old data`. */
export function chipText(envelope: Envelope, now: number): string {
  if (envelope.state === "unread") return "not read yet";
  const { completeness, observedAt } = envelope;
  if (envelope.state === "failed")
    return observedAt === undefined
      ? "read failed · nothing retained"
      : `read failed · showing ${span(now - Date.parse(observedAt))} old data`;
  if (completeness.kind === "cut")
    return `cut · ${count(completeness.read)} of ${count(completeness.total)}`;
  return observedAt === undefined
    ? stateWord(envelope)
    : `${stateWord(envelope)} · ${span(now - Date.parse(observedAt))}`;
}

/**
 * The row sentence: state, age and completeness in the window's words. A cut gives its read and
 * total, never core's reason text.
 */
export function envelopeSentence(envelope: Envelope, now: number): string {
  if (envelope.state === "unread") return "not read yet";
  const { completeness, observedAt } = envelope;
  const cut =
    completeness.kind === "cut"
      ? `${count(completeness.read)} of ${count(completeness.total)} read`
      : "";
  if (envelope.state === "failed") {
    const kept =
      observedAt === undefined ? "nothing retained" : `showing data from ${ago(observedAt, now)}`;
    return cut ? `read failed, ${kept}, ${cut}` : `read failed, ${kept}`;
  }
  const read = observedAt === undefined ? "" : `, last read ${ago(observedAt, now)}`;
  if (envelope.state === "incomplete") return `cut${read}, ${cut || "not every item read"}`;
  return `${envelope.state}${read}, complete`;
}

/**
 * What an area's envelope adds to a sweep source's row, which already says how this sweep read
 * it: when it was last read, and whether the data is stale or retained from an earlier read. An
 * unread area adds nothing. `reusedFrom` is the oldest read this sweep's read carried over from an
 * earlier sweep, as the sweep recorded it; the row says the read reused data from then rather than
 * pairing "read" with an older age.
 */
export function areaFact(
  envelope: Envelope,
  now: number,
  reusedFrom?: string,
): { text: string; tone?: EvidenceTone } | null {
  if (envelope.state === "unread") return null;
  const { observedAt } = envelope;
  if (envelope.state === "failed")
    return {
      text:
        observedAt === undefined ? "nothing retained" : `showing data from ${ago(observedAt, now)}`,
      tone: "bad",
    };
  const age =
    reusedFrom !== undefined
      ? `reuses reads from ${ago(reusedFrom, now)}`
      : observedAt === undefined
        ? undefined
        : `last read ${ago(observedAt, now)}`;
  if (age === undefined) return envelope.state === "stale" ? { text: "stale", tone: "warn" } : null;
  return envelope.state === "stale" ? { text: `stale, ${age}`, tone: "warn" } : { text: age };
}

const RANK: Readonly<Record<Envelope["state"], number>> = {
  failed: 4,
  incomplete: 3,
  stale: 2,
  unread: 1,
  fresh: 0,
};

/** Sorts the worst envelope first: failed, cut, stale, not read yet, fresh. */
export function byWorst(a: Envelope, b: Envelope): number {
  return RANK[b.state] - RANK[a.state];
}

export const INFERRED_EVERY_SOURCE = "inferred · every source";

/** Coarse EV-03: inferred only when there is a source and every one of them is inferred. */
export function everyInferred(envelopes: readonly { inferred?: boolean | undefined }[]): boolean {
  return envelopes.length > 0 && envelopes.every((envelope) => envelope.inferred === true);
}

export type EvidenceSource = { key: string; name: string; envelope: Envelope };

/**
 * One envelope per supplemental source: its worst read, inferred only when every read of it is.
 */
export function bySource(
  entries: readonly { envelope?: Envelope | undefined }[],
): Map<string, Envelope> {
  const sources = new Map<string, Envelope>();
  for (const { envelope } of entries) {
    if (!envelope) continue;
    const held = sources.get(envelope.source);
    if (!held) {
      sources.set(envelope.source, envelope);
      continue;
    }
    const worst = byWorst(envelope, held) < 0 ? envelope : held;
    const inferred = held.inferred === true && envelope.inferred === true;
    sources.set(
      envelope.source,
      worst.state === "unread" || (worst.inferred === true) === inferred
        ? worst
        : { ...worst, inferred },
    );
  }
  return sources;
}

/**
 * Every source a sweep draws from: the eleven areas in appendix C order (an area the snapshot
 * omits reads as not read yet), then each collector outside the areas once.
 */
export function sweepSources(
  snapshot: Pick<ViewSnapshot, "areas" | "provenance">,
): EvidenceSource[] {
  const areas = AREAS.map((area) => ({
    key: area,
    name: AREA_NAMES[area],
    envelope: snapshot.areas.find((entry) => entry.area === area)?.envelope ?? {
      source: area,
      state: "unread" as const,
    },
  }));
  const extra = bySource(snapshot.provenance);
  return [
    ...areas,
    ...[...extra].map(([source, envelope]) => ({
      key: source,
      name: sourceName(source),
      envelope,
    })),
  ];
}

const SEVERITY: Readonly<Record<EvidenceTone, number>> = {
  fresh: 0,
  inferred: 1,
  muted: 2,
  warn: 3,
  bad: 4,
};

/** The worst tone; `inferred` only when every envelope is inferred. */
export function worstTone(envelopes: readonly Envelope[]): EvidenceTone {
  if (envelopes.length === 0) return "muted";
  const inferred = everyInferred(envelopes);
  return envelopes.reduce<EvidenceTone>((worst, envelope) => {
    const tone = envelopeTone(envelope);
    const next = tone === "inferred" && !inferred ? "fresh" : tone;
    return SEVERITY[next] > SEVERITY[worst] ? next : worst;
  }, "fresh");
}

export type SweepLineInput = {
  sources: readonly Envelope[];
  sweptAt: string;
  nextSyncAt?: string | undefined;
  now: number;
};

const SUPPLEMENTAL_WORDS: Readonly<Record<Envelope["state"], string>> = {
  fresh: "fresh",
  failed: "read failed",
  incomplete: "incomplete",
  stale: "stale",
  unread: "not read yet",
};

const isArea = (source: string) => (AREAS as readonly string[]).includes(source);

/**
 * The title-bar sentence and the worst tone across the sweep's sources. The counts are of the
 * appendix C areas; a source outside them that is not fresh is named on its own.
 */
export function sweepLine({ sources, sweptAt, nextSyncAt, now }: SweepLineInput): {
  text: string;
  tone: EvidenceTone;
} {
  const areas = sources.filter((envelope) => isArea(envelope.source));
  const tally = (state: Envelope["state"]) =>
    areas.filter((envelope) => envelope.state === state).length;
  const counts = [
    [tally("failed"), "failed"],
    [tally("incomplete"), "incomplete"],
    [tally("stale"), "stale"],
    [tally("unread"), "not read yet"],
  ] as const;
  const supplemental = sources
    .filter((envelope) => !isArea(envelope.source) && envelope.state !== "fresh")
    .sort(byWorst);
  const inferred = everyInferred(sources);
  const parts = [`swept ${ago(sweptAt, now)}`];
  let first = true;
  for (const [n, word] of counts) {
    if (n === 0) continue;
    parts.push(first ? `${n} ${n === 1 ? "area" : "areas"} ${word}` : `${n} ${word}`);
    first = false;
  }
  for (const envelope of supplemental) {
    const name = sourceName(envelope.source);
    parts.push(
      `${name.charAt(0).toLowerCase()}${name.slice(1)} ${SUPPLEMENTAL_WORDS[envelope.state]}`,
    );
  }
  if (first && supplemental.length === 0 && !inferred) parts.push("all fresh");
  if (nextSyncAt !== undefined && Date.parse(nextSyncAt) > now)
    parts.push(`next sync in ${span(Date.parse(nextSyncAt) - now)}`);
  if (inferred) parts.push("inferred");
  return { text: parts.join(" · "), tone: worstTone(sources) };
}

/**
 * One count per affected source, toned by the worst: failed is bad; cut, incomplete or stale is
 * warn; only unread areas are muted; all fresh is fresh, or inferred when every source is.
 */
export function freshnessGlyph({
  sources,
  sweptAt,
  now,
}: Omit<SweepLineInput, "now" | "nextSyncAt"> & { now?: number | undefined }): {
  text: string;
  tail: string;
  tone: EvidenceTone;
} {
  const counts = { failed: 0, incomplete: 0, stale: 0 };
  let unread = 0;
  for (const envelope of sources) {
    if (envelope.state === "failed") counts.failed++;
    else if (envelope.state === "unread") unread++;
    else if (envelope.completeness.kind === "cut" || envelope.state === "incomplete")
      counts.incomplete++;
    else if (envelope.state === "stale") counts.stale++;
  }
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const parts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([word, count]) => `${count} ${word}`);
  if (unread > 0) parts.push(`${unread} not read yet`);
  const detail = parts.length > 0 ? parts.join(", ") : "all areas read";
  const inferred = everyInferred(sources);
  return {
    text: `Swept ${clockTime(sweptAt, now === undefined ? {} : { now })} · ${detail}${inferred ? " · inferred" : ""}`,
    tail: total > 0 ? ` · ${total}` : "",
    tone:
      counts.failed > 0
        ? "bad"
        : total > 0
          ? "warn"
          : unread > 0
            ? "muted"
            : inferred
              ? "inferred"
              : "fresh",
  };
}
