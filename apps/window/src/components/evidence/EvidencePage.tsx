// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type {
  AreaEnvelope,
  ReadRecord,
  SweepProgress,
  SweepStatus,
  TodayLine,
} from "@spi-code/contracts";
import {
  type EvidenceRoute,
  type EvidenceSelection,
  leaveEvidence,
  routeLabel,
  showWholeSweep,
} from "../../app/navigation.js";
import { PaneTitle } from "../../app/title-row.js";
import { clockTime } from "../../time.js";
import { EvidenceTable, SweepEvidence, sourceRow } from "./EvidenceTab.js";
import { type PageEvidence, pageEvidence, type ReadGroup } from "./page-evidence.js";
import type { SweepLineSnapshot } from "./SweepLine.js";
import { useNow } from "./useNow.js";
import { AREA_NAMES, areaPhrase, areaSentence, plain } from "./words.js";
import "../sweep/sweep.css";
import "./evidence.css";

export type EvidenceSnapshot = SweepLineSnapshot & {
  reads: readonly ReadRecord[];
  briefing: { lines?: readonly TodayLine[] | undefined };
};

const count = (value: number) => value.toLocaleString("en-US");

type ReadLine = { key: string; name: string; tone?: "warn" | "bad"; note?: string; time: string };

export function readLine(
  { fork, record }: ReadGroup["records"][number],
  several: boolean,
  now: number,
): ReadLine {
  const time = clockTime(record.observedAt, { now, hint: false });
  const { completeness } = record;
  const key = `${record.source}/${record.object}/${record.observedAt}`;
  const object = record.object.replace(/^main:/, "main · ");
  const name = several ? `${fork} · ${object}` : object;
  if (record.failure !== undefined) return { key, name, tone: "bad", note: "read failed", time };
  if (completeness.kind === "cut")
    return {
      key,
      name,
      tone: "warn",
      note: `cut, ${count(completeness.read)} of ${count(completeness.total)} read · ${plain(completeness.reason)}`,
      time,
    };
  return { key, name, time };
}

/** GitLab reads are many per project; they read as one line with their count and last time. */
function gitlabLine({ source, records }: ReadGroup, now: number): ReadLine {
  const last = records.map(({ record }) => record.observedAt).sort();
  const failed = records.filter(({ record }) => record.failure !== undefined).length;
  return {
    key: source ?? "gitlab",
    name: `${count(records.length)} ${records.length === 1 ? "read" : "reads"}`,
    ...(failed > 0 ? { tone: "bad" as const, note: `${count(failed)} failed` } : {}),
    time: clockTime(last.at(-1) ?? "", { now, hint: false }),
  };
}

export function ReadLines({ label, lines }: { label: string; lines: readonly ReadLine[] }) {
  return (
    <ul className="evidence-reads" aria-label={label}>
      {lines.map(({ key, name, tone, note, time }) => (
        <li key={key} data-tone={tone}>
          <span className="evidence-read-object">{name}</span>
          <span className="evidence-read-time">
            {note && <span className="evidence-fact" data-tone={tone}>{`${note} · `}</span>}
            {time}
          </span>
        </li>
      ))}
    </ul>
  );
}

const groupTitle = ({ forge, source }: ReadGroup) =>
  source === undefined
    ? "Reads of the forks in this row"
    : forge === "gitlab"
      ? `Reads of GitLab ${source}`
      : `Reads of ${source}`;

type Subject = "item" | "row" | "service";

const areaNote = (attributed: PageEvidence["attributed"], subject: Subject) =>
  attributed === "item"
    ? `SPI Code read this ${subject} from these areas.`
    : `SPI Code read this ${subject} from these areas. It does not yet narrow them per item, so this is the sweep's list.`;

/** Not read, the reads behind a subject with their times, then the areas core attributes. */
export function SelectionPage({
  evidence,
  subject,
  areas,
  sweptAt,
  logged,
  now,
}: {
  evidence: PageEvidence;
  subject: Subject;
  areas: readonly AreaEnvelope[];
  sweptAt: string;
  logged: readonly string[];
  now: number;
}) {
  const envelopes = new Map(areas.map(({ area, envelope }) => [area, envelope]));
  const rows = evidence.areas.flatMap((area) => {
    const envelope = envelopes.get(area);
    if (!envelope) return [];
    const row = sourceRow({ key: area, name: AREA_NAMES[area], envelope }, now);
    return [
      {
        ...row,
        word: areaPhrase(envelope, sweptAt, now),
        sentence: areaSentence(envelope, sweptAt, now, { logged: logged.includes(area) }),
      },
    ];
  });
  return (
    <>
      {evidence.notRead.length > 0 && (
        <section aria-label="Not read" data-evidence-part="not-read">
          <h3>Not read</h3>
          <ul className="evidence-list evidence-not-read">
            {evidence.notRead.map((text) => (
              <li key={text}>⌀ {text}</li>
            ))}
          </ul>
        </section>
      )}
      {evidence.reads.map((group) => (
        <section
          key={`${group.forge}/${group.source ?? ""}`}
          aria-label={groupTitle(group)}
          data-evidence-part={group.forge === "gitlab" ? "gitlab-reads" : "reads"}
        >
          <h3>{groupTitle(group)}</h3>
          <ReadLines
            label={groupTitle(group)}
            lines={
              group.forge === "gitlab"
                ? [gitlabLine(group, now)]
                : group.records.map((read) => readLine(read, group.source === undefined, now))
            }
          />
        </section>
      ))}
      {evidence.unread.length > 0 && (
        <p className="panel-empty" data-evidence-part="reads">
          No reads recorded for {new Intl.ListFormat("en").format(evidence.unread)}.
        </p>
      )}
      <section aria-label="Areas" data-evidence-part="areas">
        <h3>Areas</h3>
        <p className="evidence-line">{areaNote(evidence.attributed, subject)}</p>
        <EvidenceTable label="Areas" rows={rows} compact />
      </section>
    </>
  );
}

/**
 * Evidence as a page: for a selection, what was not read, then the reads behind it with their
 * times, then the areas core attributes; with none, the whole sweep. Back returns to the page and
 * selection it was opened from.
 */
export function EvidencePage({
  route,
  snapshot,
  sweep,
  progress = null,
  completed = null,
  onOpenSettings,
  now,
}: {
  route: EvidenceRoute;
  snapshot: EvidenceSnapshot | null;
  sweep: SweepStatus | null;
  progress?: SweepProgress | null | undefined;
  completed?: SweepProgress | null | undefined;
  onOpenSettings?: () => void;
  now?: number | undefined;
}) {
  const clock = useNow();
  const at = now ?? clock;
  const from = route.from ?? { kind: "today" };
  const selection: EvidenceSelection | undefined = route.selection;
  const evidence =
    selection && snapshot
      ? pageEvidence(selection, snapshot.briefing.lines ?? [], snapshot.reads)
      : null;
  return (
    <div className="evidence evidence-page" data-evidence-page="">
      <PaneTitle>
        <h1 data-place>Evidence</h1>
      </PaneTitle>
      <button
        type="button"
        className="evidence-back"
        data-evidence-back=""
        onClick={() => leaveEvidence(route)}
      >
        ‹ {routeLabel(from)}
      </button>
      {selection ? (
        <>
          <p className="evidence-lede">
            {evidence?.title ?? "This selection is no longer on Today"}
            {snapshot && (
              <> · sweep ended {clockTime(snapshot.sweptAt, { now: at, hint: false })}</>
            )}
            {" · "}
            <button
              type="button"
              className="evidence-whole"
              data-evidence-whole=""
              onClick={() => showWholeSweep(route)}
            >
              Whole sweep ›
            </button>
          </p>
          {evidence && snapshot && (
            <SelectionPage
              evidence={evidence}
              subject={selection.kind === "line" ? "row" : "item"}
              logged={
                (progress ?? completed)?.sources.flatMap(({ source, state }) =>
                  state === "read" || state === "cut" ? [source] : [],
                ) ?? []
              }
              areas={snapshot.areas}
              sweptAt={snapshot.sweptAt}
              now={at}
            />
          )}
        </>
      ) : (
        <SweepEvidence
          snapshot={snapshot}
          sweep={sweep}
          progress={progress}
          completed={completed}
          {...(onOpenSettings ? { onOpenSettings } : {})}
          observed
          now={now}
        />
      )}
    </div>
  );
}
