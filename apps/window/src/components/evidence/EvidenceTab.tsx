// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type {
  AreaEnvelope,
  AreaName,
  Envelope,
  InspectResult,
  ReadRecord,
  SweepProgress,
  SweepSourceProgress,
  SweepStatus,
} from "@spi-code/contracts";
import { watchStore } from "../../store/watch.js";
import { clockTime } from "../../time.js";
import { FirstSweepBody } from "../sweep/FirstSweepBody.js";
import { SweepNow } from "../sweep/SweepNow.js";
import { SweepSources } from "../sweep/SweepSources.js";
import { SweepStopped } from "../sweep/SweepStopped.js";
import { duration, type SourceOutcome, type SourceTone } from "../sweep/words.js";
import {
  type FailedReadGroup,
  FailedReads,
  failedReadGroups,
  failedServices,
  failureCause,
} from "./FailedReads.js";
import type { SweepLineSnapshot } from "./SweepLine.js";
import { useNow } from "./useNow.js";
import {
  areaFact,
  areaPhrase,
  areaSentence,
  byWorst,
  cachedFrom,
  chipText,
  type EvidenceSource,
  type EvidenceTone,
  envelopeSentence,
  envelopeTone,
  everyInferred,
  INFERRED_EVERY_SOURCE,
  keptData,
  observedFrom,
  sourceReads,
  stateWord,
  sweepLine,
  sweepSources,
  worstTone,
} from "./words.js";
import "../sweep/sweep.css";
import "./evidence.css";

export type Row = { key: string; name: string; tone: EvidenceTone; word: string; sentence: string };

export function EvidenceTable({
  label,
  rows,
  compact = false,
}: {
  label: string;
  rows: readonly Row[];
  compact?: boolean;
}) {
  return (
    <table className="evidence-table" aria-label={label}>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.key}
            data-source={row.key}
            data-tone={row.tone}
            aria-label={compact ? `${row.name} · ${row.word}. ${row.sentence}` : undefined}
          >
            <th scope="row">{row.name}</th>
            <td data-state={row.word} title={compact ? row.sentence : undefined}>
              <span className="evidence-dot" data-tone={row.tone} aria-hidden /> {row.word}
            </td>
            {!compact && <td>{row.sentence}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export const sourceRow = ({ key, name, envelope }: EvidenceSource, now: number): Row => ({
  key,
  name,
  tone: envelopeTone(envelope),
  word: stateWord(envelope),
  sentence: envelopeSentence(envelope, now),
});

const MARKS: Readonly<Record<Envelope["state"], { mark: string; tone: SourceTone }>> = {
  fresh: { mark: "✓", tone: "ok" },
  stale: { mark: "–", tone: "warn" },
  incomplete: { mark: "⚠", tone: "warn" },
  failed: { mark: "✕", tone: "bad" },
  unread: { mark: "○", tone: "wait" },
};

/** Sources the sweep's list does not carry, from their envelopes, in the list's row form. */
function EnvelopeRows({
  label,
  sources,
  now,
  sweptAt,
  since,
  observed,
}: {
  label: string;
  sources: readonly EvidenceSource[];
  now: number;
  sweptAt: string;
  since?: string | undefined;
  observed: boolean;
}) {
  return (
    <div className="sweep-sources">
      <ul className="sweep-rows" aria-label={label}>
        {sources.map(({ key, name, envelope }) => {
          const phrase = observed
            ? areaPhrase(envelope, sweptAt, now, since)
            : envelopeSentence(envelope, now, sweptAt);
          const title = observed ? areaSentence(envelope, sweptAt, now) : undefined;
          return (
            <li
              key={key}
              className="sweep-row"
              data-source={key}
              data-tone={MARKS[envelope.state].tone}
              {...(title ? { "aria-label": `${name} · ${phrase}. ${title}` } : {})}
            >
              <span className="sweep-mark" aria-hidden="true">
                {MARKS[envelope.state].mark}
              </span>
              <span className="sweep-name">{name}</span>
              <span className="sweep-what">{sourceReads(key) ?? ""}</span>
              <span className="sweep-outcome" title={title}>
                {phrase}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A read this sweep that some reads of failed, the rest read. */
const partlyRead = (source: SweepSourceProgress) =>
  source.state === "cut" && ((source.incomplete.failed ?? 0) > 0 || source.failure !== undefined);

/**
 * A listed source's row on the Evidence page: the sweep's outcome and only the envelope's facts
 * that carry information, a failure's cause once on the line under it, and Ruling J's full
 * sentence as its title.
 */
function evidenceOutcome(
  source: SweepSourceProgress,
  outcome: SourceOutcome,
  envelope: Envelope | undefined,
  {
    sweptAt,
    since,
    now,
    groups,
  }: {
    sweptAt: string;
    since: string | undefined;
    now: number;
    groups: readonly FailedReadGroup[];
  },
): { outcome: SourceOutcome; title?: string | undefined } {
  const read = source.state === "read" || source.state === "cut";
  const sentence =
    envelope &&
    areaSentence(envelope, sweptAt, now, { logged: read && envelope.state === "unread" });
  const title = [outcome.detail, sentence].filter(Boolean).join(" ") || undefined;
  const cause = failureCause(groups);
  if (outcome.tone === "bad" && source.state !== "skipped") {
    // The source's reason is said by a group of the same cause, which also names its services.
    const why = groups.some(({ code }) => code === outcome.code)
      ? cause
      : [outcome.why, cause].filter(Boolean).join(" ");
    return {
      outcome: {
        ...outcome,
        text: envelope ? `failed · ${keptData(envelope, now)}` : "failed",
        ...(why ? { why } : {}),
      },
      title,
    };
  }
  if (partlyRead(source)) {
    const kept =
      envelope?.state === "failed" && envelope.observedAt !== undefined
        ? `Showing data from ${clockTime(envelope.observedAt, { now, hint: false })}.`
        : undefined;
    const why = [cause ?? outcome.why, kept].filter(Boolean).join(" ");
    return { outcome: { ...outcome, ...(why ? { why } : {}) }, title };
  }
  // A cut read says how much of it was read: by its envelope once the snapshot holds this read.
  const held =
    since !== undefined && envelope?.state !== "unread" && envelope?.completeness.kind === "cut"
      ? envelope.completeness
      : undefined;
  const count = (value: number) => value.toLocaleString("en-US");
  const cut =
    source.state === "cut"
      ? {
          ...outcome,
          text: [
            "read",
            ...(source.startedAt && source.endedAt
              ? [duration(Date.parse(source.endedAt) - Date.parse(source.startedAt))]
              : []),
            held
              ? `${count(held.read)} of ${count(held.total)} read`
              : `${count(source.incomplete.total - source.incomplete.count)} of ${count(source.incomplete.total)} read`,
          ].join(" · "),
        }
      : outcome;
  if (envelope === undefined) return { outcome: cut, title };
  // A read the snapshot does not hold yet has only the sweep's words; its envelope is older.
  if (read && since === undefined) return { outcome: cut, title };
  const extra =
    envelope.state === "unread"
      ? read
        ? ["no observation recorded in this snapshot"]
        : []
      : [
          envelope.state === "failed"
            ? keptData(envelope, now)
            : observedFrom(envelope, sweptAt, now, since ?? sweptAt),
          envelope.completeness.kind === "cut" &&
          source.state !== "skipped" &&
          source.state !== "cut"
            ? `${envelope.completeness.read.toLocaleString("en-US")} of ${envelope.completeness.total.toLocaleString("en-US")} read`
            : undefined,
        ].filter((part): part is string => part !== undefined);
  if (source.state === "skipped" && envelope.state !== "unread" && envelope.state !== "failed") {
    const rest = cut.text.replace(/^not due(?: · )?/, "");
    const last = envelope.observedAt
      ? `last read ${clockTime(envelope.observedAt, { now, hint: false })}`
      : "not due";
    const counted =
      envelope.completeness.kind === "cut"
        ? `${envelope.completeness.read.toLocaleString("en-US")} of ${envelope.completeness.total.toLocaleString("en-US")} read`
        : undefined;
    return {
      outcome: {
        ...cut,
        text: [last, envelope.state === "stale" ? "stale" : undefined, rest, counted]
          .filter(Boolean)
          .join(" · "),
      },
      title,
    };
  }
  const partial =
    source.state === "read" && envelope.state !== "unread" && envelope.completeness.kind === "cut";
  return {
    outcome: {
      ...cut,
      ...(partial ? { mark: "⚠", tone: "warn" as const } : {}),
      text: [cut.text, ...extra].join(" · "),
    },
    title,
  };
}

/** Today's caveat words for a source whose read failed or was cut. */
function caveatWords(envelope: Envelope, partial: boolean): string {
  if (envelope.state === "failed" && !partial) return "read failed";
  if (envelope.state !== "unread" && envelope.completeness.kind === "cut")
    return `was read only in part: ${envelope.completeness.read.toLocaleString("en-US")} of ${envelope.completeness.total.toLocaleString("en-US")}`;
  return "was read only in part";
}

const LIST: Readonly<Record<SweepProgress["outcome"], string>> = {
  running: "live",
  committed: "completed",
  failed: "stopped",
  cancelled: "cancelled",
};

/**
 * The Evidence tab for the sweep: each source once, with how the newest sweep read it and when its
 * data was last read; then failed reads grouped by source and cause.
 */
export function SweepEvidence({
  snapshot,
  sweep,
  progress = null,
  completed = null,
  onOpenSettings = () => {},
  onRequestSweep = () => watchStore.getState().requestSweep(),
  observed = false,
  now,
}: {
  snapshot: (SweepLineSnapshot & { reads: readonly ReadRecord[] }) | null;
  sweep: SweepStatus | null;
  /**
   * The newest sweep's progress; over an older snapshot its list, live or stopped, sits above the
   * last good reads.
   */
  progress?: SweepProgress | null | undefined;
  /** The last committed sweep's list, kept with each source's final state. */
  completed?: SweepProgress | null | undefined;
  onOpenSettings?: () => void;
  onRequestSweep?: () => void | Promise<void>;
  /** Each source's own observed time and completeness, as the Evidence page shows them. */
  observed?: boolean;
  now?: number | undefined;
}) {
  const live = progress?.outcome === "running" ? progress : null;
  const clock = useNow(
    live ? 1000 : 30_000,
    sweep?.nextSweepAt ? Date.parse(sweep.nextSweepAt) : undefined,
  );
  const at = now ?? clock;
  if (snapshot === null)
    return (
      <article className="evidence" data-evidence="sweep">
        {progress ? (
          <FirstSweepBody
            progress={progress}
            now={at}
            nextSweepAt={sweep?.nextSweepAt}
            onOpenSettings={onOpenSettings}
            onRequestSweep={onRequestSweep}
          />
        ) : (
          <p className="panel-empty">Waiting for the first sweep. Nothing has been read yet.</p>
        )}
      </article>
    );
  const sources = sweepSources(snapshot);
  const line = sweepLine({ sources: sources.map(({ envelope }) => envelope) });
  const next = sweep?.nextSweepAt && Date.parse(sweep.nextSweepAt) > at ? sweep.nextSweepAt : null;
  const list = progress ?? completed;
  const envelopes = new Map(sources.map(({ key, envelope }) => [key, envelope]));
  const listed = new Set(list?.sources.map(({ source }) => source));
  const unlisted = sources.filter(({ key }) => !listed.has(key));
  // A snapshot taken before the listed sweep began holds the previous sweep's reads.
  const own = list !== null && Date.parse(snapshot.sweptAt) >= Date.parse(list.startedAt);
  const since = own ? list.startedAt : undefined;
  // A row that says a source failed, or partly read, carries its failed reads' cause.
  const carrying = observed
    ? (list?.sources ?? []).filter(
        (source) =>
          source.state === "failed" ||
          partlyRead(source) ||
          (list?.outcome === "failed" &&
            list.source === source.source &&
            (source.state === "reading" || source.state === "throttled")),
      )
    : [];
  const carried = new Set(carrying.map(({ source }) => source));
  // A repository's read names no area, so it belongs to the row whose failure names its service.
  const groups = failedReadGroups(snapshot.reads, ({ source, service }) => {
    const naming = carrying
      .filter(
        (entry) =>
          entry.state === "cut" &&
          service !== undefined &&
          failedServices(entry.failure).includes(service),
      )
      .map((entry) => entry.source);
    if (naming.length > 0) return naming.includes(source) ? source : naming[0];
    return carried.has(source) ? source : undefined;
  });
  const describe = (source: SweepSourceProgress, outcome: SourceOutcome) =>
    evidenceOutcome(source, outcome, envelopes.get(source.source), {
      sweptAt: snapshot.sweptAt,
      since,
      now: at,
      groups: groups.filter((group) => group.row === source.source),
    });
  const uncarried = groups.filter((group) => group.row === undefined);
  // A failed area this sweep partly read is amber, as its row is.
  const cut = new Set(list?.sources.filter(partlyRead).map(({ source }) => source));
  // Only the sweep that supplied the snapshot can say its failed read was partial.
  const partial = (key: string) => own && cut.has(key);
  const caveats = sources.filter(
    ({ envelope }) => envelope.state === "failed" || envelope.state === "incomplete",
  );
  const tone =
    observed &&
    line.tone === "bad" &&
    sources.every(({ key, envelope }) => envelope.state !== "failed" || cut.has(key))
      ? "warn"
      : line.tone;
  const fact = (source: string) => {
    const envelope = envelopes.get(source);
    const entry = list?.sources.find((candidate) => candidate.source === source);
    const read = entry?.state === "read" || entry?.state === "cut" ? entry : undefined;
    // A read the snapshot does not hold yet says only what the sweep recorded it reused; the
    // snapshot's age is the previous read's, not this one's.
    const words: { text: string; tone?: EvidenceTone } | null | undefined =
      read !== undefined && !own
        ? read.reused && { text: cachedFrom(read.reused.from, at) }
        : envelope &&
          areaFact(envelope, at, { reusedFrom: read?.reused?.from, sweptAt: snapshot.sweptAt });
    return (
      words && (
        <span className="evidence-fact" data-tone={words.tone}>
          {words.text}
        </span>
      )
    );
  };
  return (
    <article className="evidence" data-evidence="sweep">
      <header className="evidence-header" data-sweep-header="">
        <div>
          <h2 className="evidence-title">The sweep</h2>
          <p data-sweep-schedule="">
            {live ? (
              <>
                Sweeping since{" "}
                <time dateTime={live.startedAt}>
                  {clockTime(live.startedAt, { now: at, hint: false })}
                </time>
              </>
            ) : (
              <>
                Swept{" "}
                <time dateTime={snapshot.sweptAt}>
                  {clockTime(snapshot.sweptAt, { now: at, hint: false })}
                </time>
                {next && (
                  <>
                    {" · next sweep "}
                    <time dateTime={next}>{clockTime(next, { now: at, hint: false })}</time>
                  </>
                )}
              </>
            )}
          </p>
        </div>
        {!live && <SweepNow onOpenReadiness={onOpenSettings} />}
      </header>
      {!live &&
        (observed && caveats.length > 0 ? (
          <ul className="evidence-band" data-tone={tone} role="note">
            {caveats.map(({ key, name, envelope }) => (
              <li key={key} data-caveat={key}>
                <span className="evidence-band-mark" aria-hidden="true">
                  {envelope.state === "failed" && !partial(key) ? "✕" : "⚠"}
                </span>
                <span>
                  <b>{name}</b> {caveatWords(envelope, partial(key))}; items from it may be missing.
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="evidence-line" data-tone={tone}>
            {line.text}
          </p>
        ))}
      {list ? (
        <section data-sweep-list={LIST[list.outcome]} aria-label="Sources">
          {!observed && <h3>Sources</h3>}
          {list.outcome === "failed" && (
            <p className="evidence-line" data-tone="bad" data-sweep-outcome="failed">
              This sweep stopped. <SweepStopped progress={list} now={at} />
            </p>
          )}
          {list.outcome === "cancelled" && (
            <p className="evidence-line" data-sweep-outcome="cancelled">
              This sweep was cancelled.
            </p>
          )}
          <SweepSources
            progress={list}
            now={at}
            meta={false}
            onOpenSettings={onOpenSettings}
            fact={observed ? undefined : fact}
            envelope={(source) => envelopes.get(source)}
            describe={observed ? describe : undefined}
            split={observed}
          />
          {unlisted.length > 0 && (
            <EnvelopeRows
              label="More sources"
              sources={unlisted}
              now={at}
              sweptAt={snapshot.sweptAt}
              since={since}
              observed={observed}
            />
          )}
        </section>
      ) : (
        <section aria-label="Sources">
          <h3>Sources</h3>
          <EnvelopeRows
            label="Sources"
            sources={sources}
            now={at}
            sweptAt={snapshot.sweptAt}
            observed={observed}
          />
        </section>
      )}
      {uncarried.length > 0 && (
        <>
          <h3>Failed reads</h3>
          <FailedReads groups={uncarried} />
        </>
      )}
    </article>
  );
}

/** The areas a selection's provenance names; none when it names none. */
export function selectionAreas(result: InspectResult): AreaEnvelope[] {
  const named = new Set<AreaName>(result.provenance?.flatMap(({ areas }) => areas) ?? []);
  return (result.areas ?? []).filter(({ area }) => named.has(area));
}

/** The repository a selection is, from its `repo:<name>` id; null for any other selection. */
export function selectionRepository(id: string): string | null {
  return id.startsWith("repo:") ? id.slice("repo:".length) : null;
}

const namesRepository = (text: string, name: string) => {
  const [, repo] = text.replace(/^repos\//, "").split("/");
  return repo === name || repo === `osdu-spi-${name}`;
};

/**
 * A selection's reads: the ones its result carries, then the sweep's reads whose GitHub
 * `owner/repo` source or object is the selected repository, each once.
 */
export function selectionReads(result: InspectResult, reads: readonly ReadRecord[]): ReadRecord[] {
  const name = selectionRepository(result.id);
  const all = [
    ...result.evidence,
    ...(name === null
      ? []
      : reads.filter(
          (record) => namesRepository(record.source, name) || namesRepository(record.object, name),
        )),
  ];
  const seen = new Set<string>();
  return all.filter((record) => {
    const key = JSON.stringify(record);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The chip under a selection's title: shown when any source is not fresh or every source is
 * inferred, and it opens the selection's Evidence tab.
 */
export function SelectionEvidenceChip({
  result,
  reads = [],
  onOpen,
  now,
}: {
  result: InspectResult;
  reads?: readonly ReadRecord[] | undefined;
  onOpen(): void;
  now?: number | undefined;
}) {
  const clock = useNow();
  const envelopes = selectionAreas(result).map(({ envelope }) => envelope);
  const inferred = everyInferred([...envelopes, ...selectionReads(result, reads)]);
  const worst = envelopes.filter((envelope) => envelope.state !== "fresh").sort(byWorst)[0];
  if (worst === undefined && !inferred) return null;
  const text = worst
    ? `${chipText(worst, now ?? clock)}${inferred ? " · inferred" : ""}`
    : INFERRED_EVERY_SOURCE;
  const tone = worstTone(envelopes);
  return (
    <button
      type="button"
      className="evidence-chip"
      data-selection-evidence=""
      data-tone={tone}
      {...(inferred ? { "data-inferred": "" } : {})}
      aria-label={`${text}. Open the evidence for this selection`}
      onClick={onOpen}
    >
      {text}
    </button>
  );
}
