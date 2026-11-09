// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type {
  AreaEnvelope,
  AreaName,
  Envelope,
  InspectResult,
  ReadRecord,
  SweepProgress,
  SweepStatus,
} from "@spi-code/contracts";
import { watchStore } from "../../store/watch.js";
import { clockTime } from "../../time.js";
import { FirstSweepBody } from "../sweep/FirstSweepBody.js";
import { SweepNow } from "../sweep/SweepNow.js";
import { SweepSources } from "../sweep/SweepSources.js";
import { SweepStopped } from "../sweep/SweepStopped.js";
import { type SourceTone, settled } from "../sweep/words.js";
import { FailedReads } from "./FailedReads.js";
import type { SweepLineSnapshot } from "./SweepLine.js";
import { useNow } from "./useNow.js";
import {
  AREA_NAMES,
  ago,
  areaFact,
  byWorst,
  chipText,
  type EvidenceSource,
  type EvidenceTone,
  envelopeSentence,
  envelopeTone,
  everyInferred,
  INFERRED_EVERY_SOURCE,
  plain,
  sourceName,
  sourceReads,
  span,
  stateWord,
  sweepLine,
  sweepSources,
  worstTone,
} from "./words.js";
import "../sweep/sweep.css";
import "./evidence.css";

type Row = { key: string; name: string; tone: EvidenceTone; word: string; sentence: string };

function EvidenceTable({ label, rows }: { label: string; rows: readonly Row[] }) {
  return (
    <table className="evidence-table" aria-label={label}>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} data-source={row.key} data-tone={row.tone}>
            <th scope="row">{row.name}</th>
            <td data-state={row.word}>
              <span className="evidence-dot" data-tone={row.tone} aria-hidden /> {row.word}
            </td>
            <td>{row.sentence}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const sourceRow = ({ key, name, envelope }: EvidenceSource, now: number): Row => ({
  key,
  name,
  tone: envelopeTone(envelope),
  word: stateWord(envelope),
  sentence: envelopeSentence(envelope, now),
});

function readRow(record: ReadRecord, now: number): Row {
  const { completeness } = record;
  const cut =
    completeness.kind === "cut"
      ? `cut, ${completeness.read.toLocaleString("en-US")} of ${completeness.total.toLocaleString("en-US")} · ${plain(completeness.reason)}`
      : "complete";
  const key = `${record.source}/${record.object}`;
  const name = `${sourceName(record.source)} · ${record.object}`;
  if (record.failure !== undefined) {
    const kept =
      record.retainedFrom === undefined
        ? "nothing retained"
        : `showing data from ${ago(record.retainedFrom, now)}`;
    return {
      key,
      name,
      tone: "bad",
      word: "read failed",
      sentence: `${plain(record.failure)}, ${kept}`,
    };
  }
  return {
    key,
    name,
    tone: completeness.kind === "cut" ? "warn" : record.inferred === true ? "inferred" : "fresh",
    word: completeness.kind === "cut" ? "cut" : "read",
    sentence: `read ${ago(record.observedAt, now)}, ${cut}`,
  };
}

function Budget({ sweep, now }: { sweep: SweepStatus | null; now: number }) {
  if (sweep === null) return <p className="panel-empty">The API budget has not been read yet.</p>;
  const reset =
    sweep.resetAt === null
      ? ""
      : Date.parse(sweep.resetAt) > now
        ? `, resets in ${span(Date.parse(sweep.resetAt) - now)}`
        : ", reset due";
  const left =
    sweep.remaining === null
      ? "GitHub did not report the requests left"
      : `${sweep.remaining.toLocaleString("en-US")} GitHub requests left`;
  const floor =
    sweep.floor === undefined
      ? ""
      : `; reads pause at ${sweep.floor.toLocaleString("en-US")} to keep a reserve`;
  return (
    <>
      <p data-budget="">
        {left}
        {reset}
        {floor}.
      </p>
      {sweep.deferredAreas.length > 0 && (
        <ul aria-label="Deferred areas" className="evidence-list">
          {sweep.deferredAreas.map(({ area, reason }) => (
            <li key={area} data-deferred={area}>
              {sourceName(area)} waits for the next sweep · {plain(reason)}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

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
}: {
  label: string;
  sources: readonly EvidenceSource[];
  now: number;
}) {
  return (
    <div className="sweep-sources">
      <ul className="sweep-rows" aria-label={label}>
        {sources.map(({ key, name, envelope }) => (
          <li
            key={key}
            className="sweep-row"
            data-source={key}
            data-tone={MARKS[envelope.state].tone}
          >
            <span className="sweep-mark" aria-hidden="true">
              {MARKS[envelope.state].mark}
            </span>
            <span className="sweep-name">{name}</span>
            <span className="sweep-what">{sourceReads(key) ?? ""}</span>
            <span className="sweep-outcome">{envelopeSentence(envelope, now)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const LIST: Readonly<Record<SweepProgress["outcome"], string>> = {
  running: "live",
  committed: "completed",
  failed: "stopped",
  cancelled: "cancelled",
};

/**
 * The Evidence tab for the sweep: each source once, with how the newest sweep read it and when its
 * data was last read; then failed reads grouped by source and cause, and the API budget.
 */
export function SweepEvidence({
  snapshot,
  sweep,
  progress = null,
  completed = null,
  onOpenSettings = () => {},
  onRequestSweep = () => watchStore.getState().requestSweep(),
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
        <p className="inspector-kicker">what the sweep is drawn from</p>
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
        <h3>API budget</h3>
        <Budget sweep={sweep} now={at} />
      </article>
    );
  const sources = sweepSources(snapshot);
  const line = sweepLine({
    sources: sources.map(({ envelope }) => envelope),
    sweptAt: snapshot.sweptAt,
    nextSyncAt: snapshot.briefing.nextSyncAt,
    now: at,
  });
  const failed = snapshot.reads.filter((record) => record.failure !== undefined);
  const next = sweep?.nextSweepAt && Date.parse(sweep.nextSweepAt) > at ? sweep.nextSweepAt : null;
  const list = progress ?? completed;
  const envelopes = new Map(sources.map(({ key, envelope }) => [key, envelope]));
  const listed = new Set(list?.sources.map(({ source }) => source));
  const unlisted = sources.filter(({ key }) => !listed.has(key));
  // A snapshot taken before the listed sweep began holds the previous sweep's reads.
  const own = list !== null && Date.parse(snapshot.sweptAt) >= Date.parse(list.startedAt);
  const fact = (source: string) => {
    const envelope = envelopes.get(source);
    const entry = list?.sources.find((candidate) => candidate.source === source);
    const read = entry?.state === "read" || entry?.state === "cut" ? entry : undefined;
    // A read the snapshot does not hold yet says only what the sweep recorded it reused; the
    // snapshot's age is the previous read's, not this one's.
    const words: { text: string; tone?: EvidenceTone } | null | undefined =
      read !== undefined && !own
        ? read.reused && { text: `reuses reads from ${ago(read.reused.from, at)}` }
        : envelope && areaFact(envelope, at, read?.reused?.from);
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
      <p className="inspector-kicker">what the sweep is drawn from</p>
      <header className="evidence-header" data-sweep-header="">
        <div>
          <h2 className="evidence-title">The sweep</h2>
          <p data-sweep-schedule="">
            {live ? (
              <>
                Sweeping since{" "}
                <time dateTime={live.startedAt}>
                  {clockTime(live.startedAt, { now: at, hint: false })}
                </time>{" "}
                · {settled(live)} of {live.sources.length}
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
        <SweepNow onViewSweep={() => {}} onOpenReadiness={onOpenSettings} />
      </header>
      <p className="evidence-line" data-tone={line.tone}>
        {line.text}
      </p>
      {list ? (
        <section data-sweep-list={LIST[list.outcome]} aria-label="Sources">
          <h3>Sources</h3>
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
            meta={list === live}
            onOpenSettings={onOpenSettings}
            fact={fact}
            envelope={(source) => envelopes.get(source)}
          />
          {unlisted.length > 0 && <EnvelopeRows label="More sources" sources={unlisted} now={at} />}
        </section>
      ) : (
        <section aria-label="Sources">
          <h3>Sources</h3>
          <EnvelopeRows label="Sources" sources={sources} now={at} />
        </section>
      )}
      <h3>Failed reads</h3>
      {failed.length > 0 ? (
        <FailedReads reads={failed} />
      ) : (
        <p className="panel-empty">No read failed in this sweep.</p>
      )}
      <h3>API budget</h3>
      <Budget sweep={sweep} now={at} />
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

/**
 * The Evidence tab for a selection: the areas its provenance names, then its repository's reads.
 * `reads` is the sweep's reads, filtered here to the selected repository.
 */
export function SelectionEvidence({
  result,
  reads = [],
  now,
}: {
  result: InspectResult;
  reads?: readonly ReadRecord[] | undefined;
  now?: number | undefined;
}) {
  const clock = useNow();
  const at = now ?? clock;
  const areas = selectionAreas(result);
  const records = selectionReads(result, reads);
  const rows = areas.map(({ area, envelope }) =>
    sourceRow({ key: area, name: AREA_NAMES[area], envelope }, at),
  );
  const inferred = everyInferred([...areas.map(({ envelope }) => envelope), ...records]);
  const title = result.title ?? result.id;
  return (
    <article className="evidence" data-evidence="selection">
      <p className="inspector-kicker">what this selection is drawn from</p>
      <h2 className="evidence-title">
        {title}
        {inferred && (
          <span className="evidence-chip" data-inferred="" data-tone="inferred">
            {INFERRED_EVERY_SOURCE}
          </span>
        )}
      </h2>
      <h3>Areas</h3>
      {result.areas === undefined ? (
        <p className="panel-empty">This selection does not say which areas it is drawn from.</p>
      ) : rows.length === 0 ? (
        <p className="panel-empty">
          This selection does not name the areas it is drawn from. The sweep&apos;s evidence covers
          every area.
        </p>
      ) : (
        <EvidenceTable label="Areas" rows={rows} />
      )}
      <h3>Reads for {title}</h3>
      {records.length > 0 ? (
        <EvidenceTable
          label={`Reads for ${title}`}
          rows={records.map((record) => readRow(record, at))}
        />
      ) : (
        <p className="panel-empty">No reads recorded for {title}.</p>
      )}
    </article>
  );
}
