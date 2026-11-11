// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type InspectResult,
  type NotesState,
  PROTOCOL_VERSION,
  parseMessage,
  type ReleaseLine,
} from "@spi-code/contracts";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { navigate } from "../../app/navigation.js";
import { treeServices } from "../../app/queue.js";
import { SectionEvidence } from "../../components/evidence/SectionEvidence.js";
import { Place } from "../../components/place/Place.js";
import type { SelectionRow } from "../../panels/selection-rows.js";
import { useSelectionList } from "../../panels/useSelectionList.js";
import { watchStore } from "../../store/watch.js";
import type { ReleasesSection } from "./anchors.js";
import { ReleaseSections } from "./Sections.js";

export { FORMING_RELEASES_ANCHOR, SHARED_COMPONENTS_ANCHOR } from "./anchors.js";

import "./panes.css";
import "./releases.css";

const notesLabels: Record<NotesState, string> = {
  approved: "APPROVED",
  draft: "DRAFT",
  none: "NO NOTES YET",
  invalid: "NOTES FILE INVALID",
};

function Notes({ line }: { line: ReleaseLine }) {
  const tone =
    line.notes === "approved"
      ? "ok"
      : line.notes === "invalid"
        ? "bad"
        : line.notes === "none" && !line.open
          ? "neutral"
          : "warn";
  return (
    <span className="notes-chip" data-notes={line.notes} data-tone={tone}>
      {notesLabels[line.notes]}
    </span>
  );
}

// A month can carry several stats under one anchor, so the key counts earlier stats that share it.
function keyedStats(stats: ReleaseLine["stats"]) {
  const seen = new Map<string, number>();
  return stats.map((stat) => {
    const occurrence = seen.get(stat.anchor) ?? 0;
    seen.set(stat.anchor, occurrence + 1);
    return { key: `${stat.anchor}#${occurrence}`, stat };
  });
}

export default function Releases({ section }: { section?: ReleasesSection | undefined } = {}) {
  const pane = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (section) pane.current?.querySelector(`#${section}`)?.scrollIntoView?.({ block: "start" });
  }, [section]);
  const evidence = useStore(watchStore, (state) => state.snapshot?.body);
  const reading = evidence?.readings.find(({ anchor }) => anchor.kind === "releases") ?? {
    anchor: { kind: "releases" },
    content: null,
  };
  const releases = evidence?.releases;
  const rows = (releases?.lines ?? [])
    .map((line, index) => ({
      line,
      index,
      selection: {
        id: line.id,
        title: line.name,
        kind: "release",
        prefixes: [`/releases/lines/${index}`],
      } satisfies SelectionRow,
    }))
    .sort((a, b) => b.line.month.localeCompare(a.line.month));
  const open = (selection: SelectionRow) => {
    const row = rows.find(({ line }) => line.id === selection.id);
    if (row) navigate({ kind: "release", month: row.line.month });
  };
  const list = useSelectionList(
    rows.map(({ selection }) => selection),
    open,
  );
  return (
    <div className="releases" data-view-pane="releases" ref={pane}>
      <Place
        name="Releases"
        reading={reading}
        services={treeServices(evidence?.tree)}
        onNavigate={navigate}
      />
      <div className="watch-pane">
        {evidence && <ReleaseSections snapshot={evidence} />}
        {evidence && <SectionEvidence evidence={evidence} prefixes={["/releases/lines"]} />}
        {!releases?.lines.length || !evidence ? (
          releases?.reading || !reading.content ? (
            <h2 role="status">
              {releases?.reading ? "Reading releases…" : "No releases read yet."}
            </h2>
          ) : null
        ) : (
          <>
            <h2>Release months</h2>
            <table className="release-months" aria-label="Release months" data-selection-list>
              <thead>
                <tr>
                  {["Month", "Notes", "Headline", "State"].map((label) => (
                    <th scope="col" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ line, index, selection }) => (
                  <tr
                    key={line.id}
                    data-rel={line.id}
                    data-pointer={`/releases/lines/${index}`}
                    {...list.rowProps(selection)}
                  >
                    <td>
                      <button
                        type="button"
                        className="release-name"
                        onClick={(event) => {
                          event.stopPropagation();
                          list.select(selection);
                          open(selection);
                        }}
                      >
                        SPI {line.name}
                      </button>
                    </td>
                    <td>
                      <Notes line={line} />
                    </td>
                    <td>{line.headline}</td>
                    <td>{line.stateText}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

function ReleaseDocument({ id, cursor }: { id: string; cursor: number }) {
  const epoch = useStore(watchStore, (state) => state.epoch);
  const [reading, setReading] = useState<{
    id: string;
    result?: InspectResult;
    error?: string;
  }>();
  const [linkError, setLinkError] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: sweeps and host reconnects invalidate the document read
  useEffect(() => {
    const request = crypto.randomUUID();
    setReading((previous) =>
      previous?.id === id && previous.result ? { id, result: previous.result } : { id },
    );
    const unsubscribe = window.spi.onMessage((input) => {
      const parsed = parseMessage(input);
      if (!parsed.ok) return;
      const message = parsed.message;
      if (
        message.type === "error" &&
        (message.id === request || message.payload.code === "host_unavailable")
      )
        setReading({ id, error: message.payload.message });
      else if (message.id === request && message.type === "inspect.result")
        setReading(
          message.payload.id === id
            ? { id, result: message.payload }
            : { id, error: "Release document reply did not match the requested month." },
        );
    });
    window.spi.postMessage({
      version: PROTOCOL_VERSION,
      id: request,
      kind: "request",
      type: "inspect.request",
      payload: { id },
    });
    return unsubscribe;
  }, [id, cursor, epoch]);
  const current = reading?.id === id ? reading : undefined;
  const related = current?.result?.related;
  async function open(url: string) {
    setLinkError("");
    try {
      if (!(await window.spi.openExternal(url)))
        setLinkError("Could not open the link in your browser.");
    } catch {
      setLinkError("Could not open the link in your browser.");
    }
  }
  if (current?.error) return <p role="alert">{current.error}</p>;
  if (!related) return <p role="status">Reading release document…</p>;
  if (related.length === 0) return null;
  return (
    <section aria-label="Document">
      <h2>Document</h2>
      {linkError && <p role="alert">{linkError}</p>}
      <ul className="release-document">
        {related.map((entry, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: related rows have no stable identity and may repeat
          <li key={index} data-related-state={entry.state}>
            <span className="release-document-state">{entry.state}</span>
            {entry.url ? (
              <a
                href={entry.url}
                onClick={(event) => {
                  event.preventDefault();
                  if (entry.url) void open(entry.url);
                }}
              >
                {entry.text}
              </a>
            ) : (
              entry.text
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ReleaseMonth({ month }: { month: string }) {
  const evidence = useStore(watchStore, (state) => state.snapshot?.body);
  const index = evidence?.releases.lines.findIndex((line) => line.month === month) ?? -1;
  const line = evidence?.releases.lines[index];
  const reading = evidence?.readings.find(
    ({ anchor }) => anchor.kind === "release-month" && anchor.month === month,
  ) ?? { anchor: { kind: "release-month" as const, month }, content: null };
  const row: SelectionRow | undefined = line
    ? {
        id: line.id,
        title: line.name,
        kind: "release",
        prefixes: [`/releases/lines/${index}`],
      }
    : undefined;
  const list = useSelectionList(row ? [row] : []);
  return (
    <article className="release-page" data-view-pane="release" data-rel-detail={line?.id}>
      <Place
        name={line ? `SPI ${line.name}` : `Release ${month}`}
        reading={reading}
        services={treeServices(evidence?.tree)}
        onNavigate={navigate}
        actions={
          <button type="button" disabled={!row} onClick={() => row && list.select(row)}>
            Detail
          </button>
        }
      />
      <div className="watch-pane">
        {!line || !evidence ? (
          <p role="status">
            {evidence?.releases.reading ? "Reading releases…" : "This month has not been read yet."}
          </p>
        ) : (
          <div data-pointer={`/releases/lines/${index}`}>
            <SectionEvidence evidence={evidence} prefixes={[`/releases/lines/${index}`]} />
            <section aria-label="Figures" className="pane-facts">
              {keyedStats(line.stats).map(({ key, stat }) => (
                <div
                  className="pane-fact"
                  key={key}
                  data-anchor={stat.anchor}
                  data-tone={stat.tone}
                  data-unread={stat.figure === "?"}
                >
                  <span className="pane-fact-short">{stat.short}</span>
                  <strong>{stat.figure}</strong>
                  <div>{stat.label}</div>
                </div>
              ))}
            </section>
            {line.keyChanges.length > 0 && (
              <section aria-label="Key changes">
                <h2>Key changes</h2>
                <ul>
                  {line.keyChanges.map((change, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: changes are plain strings that can repeat
                    <li key={index}>{change}</li>
                  ))}
                </ul>
              </section>
            )}
            <ReleaseDocument key={line.id} id={line.id} cursor={evidence.cursor} />
          </div>
        )}
      </div>
    </article>
  );
}
