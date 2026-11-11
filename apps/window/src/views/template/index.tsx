// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Reading, RepoEntry, RepoLine, ViewSnapshot } from "@spi-code/contracts";
import { useLayoutEffect, useRef } from "react";
import { useStore } from "zustand";
import { navigate } from "../../app/navigation.js";
import { type QueueEntry, treeServices } from "../../app/queue.js";
import { SectionEvidence } from "../../components/evidence/SectionEvidence.js";
import { Place } from "../../components/place/Place.js";
import { isReadFigure, RepositoryFacts } from "../../components/place/RepositoryFacts.js";
import { type SelectionStore, selectionStore } from "../../panels/selection.js";
import {
  repositoryLineRow,
  type SelectionRow,
  selectionRows,
} from "../../panels/selection-rows.js";
import { useSelectionList } from "../../panels/useSelectionList.js";
import { watchStore } from "../../store/watch.js";
import { plainTitle } from "../../text.js";
import { QueueRow } from "./QueueRow.js";
import "./template.css";

const TEMPLATE_REPOSITORY = "osdu-spi";
const ROLLOUT = "rollout";
const NO_READING: Reading = { anchor: { kind: "engineering" }, content: null };

function templateParts({ briefing }: ViewSnapshot) {
  const factIndex = briefing.facts.findIndex(({ label }) => label.startsWith("Template"));
  const fact = briefing.facts[factIndex];
  const queue: QueueEntry[] = [
    ...briefing.focus.map((item, index) => ({ item, pointer: `/briefing/focus/${index}` })),
    ...briefing.rest.map((item, index) => ({ item, pointer: `/briefing/rest/${index}` })),
  ];
  const repoIndex = briefing.repositories.rows.findIndex(
    ({ name }) => name === TEMPLATE_REPOSITORY,
  );
  const repository = briefing.repositories.rows[repoIndex];
  return {
    fact: fact && { fact, pointer: `/briefing/facts/${factIndex}` },
    rollout: queue.find(({ item }) => item.id === ROLLOUT),
    repository: repository && {
      entry: repository,
      index: repoIndex,
      pointer: `/briefing/repositories/rows/${repoIndex}`,
    },
  };
}

type LineRow = { key: string; line: RepoLine; selection?: SelectionRow };

function repositoryRows(entry: RepoEntry, repoIndex: number, pointer: string) {
  const lead: SelectionRow = {
    id: entry.id,
    title: entry.title,
    kind: "repository",
    prefixes: [pointer],
  };
  const sections = entry.sections.flatMap((section, sectionIndex) =>
    section.lines.length > 0
      ? [
          {
            section,
            lines: section.lines.map((line, index): LineRow => {
              const at = `${pointer}/sections/${sectionIndex}/lines/${index}`;
              const selection = repositoryLineRow(line, repoIndex, sectionIndex, index);
              return { key: line.id ?? at, line, ...(selection ? { selection } : {}) };
            }),
          },
        ]
      : [],
  );
  return { lead, sections };
}

function LineText({ line }: { line: RepoLine }) {
  return (
    <>
      <span className="template-line-tag">{line.tag}</span>
      <span>
        <span className="template-line-text">{plainTitle(line.text)}</span>
        <span className="template-line-sub">{plainTitle(line.sub)}</span>
      </span>
    </>
  );
}

export default function Template({
  store = watchStore,
  inspector = selectionStore,
}: {
  store?: typeof watchStore;
  inspector?: SelectionStore;
}) {
  const snapshot = useStore(store, (state) => state.snapshot?.body);
  const reading =
    snapshot?.readings.find(({ anchor }) => anchor.kind === "engineering") ?? NO_READING;
  const parts = snapshot && templateParts(snapshot);
  const rollout: SelectionRow | undefined = parts?.rollout && {
    id: parts.rollout.item.id,
    title: parts.rollout.item.title,
    kind: "queue",
    prefixes: [parts.rollout.pointer],
  };
  const repository =
    parts?.repository &&
    repositoryRows(parts.repository.entry, parts.repository.index, parts.repository.pointer);
  const lines = repository?.sections.flatMap(({ lines }) => lines) ?? [];
  const rows = [
    ...(rollout ? [rollout] : []),
    ...(repository ? [repository.lead] : []),
    ...lines.flatMap(({ selection }) => (selection ? [selection] : [])),
  ];
  const list = useSelectionList(
    rows,
    (row) => {
      const url = lines.find(({ selection }) => selection === row)?.line.url;
      if (url) void window.spi.openExternal(url);
    },
    inspector,
  );
  const inside = rows.some((row) => row.id === list.selected) ? list.selected : null;
  const pane = useRef<HTMLDivElement>(null);
  // Runs only when the selection moves to another row inside Details, so a reader who closes it keeps it closed.
  useLayoutEffect(() => {
    const details = pane.current?.querySelector<HTMLDetailsElement>(".template-details");
    if (!inside || !details) return;
    const shown = [
      ...(pane.current?.querySelectorAll<HTMLElement>(".place [data-selection-id]") ?? []),
    ].some((element) => element.dataset.selectionId === inside);
    if (!shown) details.open = true;
  }, [inside]);
  const fact = parts?.fact;
  const fleetFacts =
    snapshot?.briefing.repositories.facts
      .map((fact, index) => ({ fact, pointer: `/briefing/repositories/facts/${index}` }))
      .filter(({ fact }) => isReadFigure(fact.figure)) ?? [];
  return (
    <div className="inbox template" data-view-pane="engineering-system" ref={pane}>
      <Place
        name="Engineering system"
        reading={reading}
        snapshot={snapshot}
        services={treeServices(snapshot?.tree)}
        onNavigate={navigate}
        onSelect={(id) => {
          const row =
            snapshot &&
            selectionRows(snapshot).find((row) => row.kind === "queue" && row.id === id);
          if (!row) return;
          list.select(row);
          inspector.getState().setTab("detail");
        }}
        {...(list.selected !== null ? { selectedId: list.selected } : {})}
      />
      {snapshot && parts && (fact || rollout || repository || fleetFacts.length > 0) && (
        <details className="template-details">
          <summary>Details</summary>
          <div className="template-details-body" data-selection-list>
            {fleetFacts.length > 0 && (
              <section aria-label="Fleet repositories">
                <h2>Fleet repositories</h2>
                <p data-pointer="/briefing/repositories/headline">
                  {snapshot.briefing.repositories.headline}
                </p>
                <dl className="template-fleet-facts">
                  {fleetFacts.map(({ fact, pointer }) => (
                    <div key={fact.label} data-pointer={pointer} data-tone={fact.tone}>
                      <dt>{fact.label}</dt>
                      <dd>
                        <strong>{fact.figure}</strong>
                        <span>{fact.sub}</span>
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
            {fact && (
              <div className="inbox-facts" data-part="fact">
                <div className="inbox-fact" data-tone={fact.fact.tone} data-pointer={fact.pointer}>
                  <div className="inbox-fact-label">{fact.fact.label}</div>
                  <div className="inbox-fact-figure">{fact.fact.figure}</div>
                  <div className="inbox-fact-sub">{fact.fact.sub}</div>
                </div>
                <SectionEvidence evidence={snapshot} prefixes={[fact.pointer]} />
              </div>
            )}
            {parts.rollout && rollout && (
              <section className="inbox-section" aria-label="Rollout" data-part="rollout">
                <div className="inbox-section-header">
                  <h2>Rollout</h2>
                  <SectionEvidence evidence={snapshot} prefixes={[parts.rollout.pointer]} />
                </div>
                <ul className="inbox-rows">
                  <QueueRow
                    entry={parts.rollout}
                    selected={list.selected === rollout.id}
                    services={treeServices(snapshot.tree)}
                    onSelect={() => list.select(rollout)}
                    onNavigate={navigate}
                    rowProps={{ ...list.rowProps(rollout), onClick: undefined }}
                  />
                </ul>
                {!!parts.rollout.item.more?.length && (
                  <dl className="template-detail" data-pointer={`${parts.rollout.pointer}/more`}>
                    {parts.rollout.item.more.map(({ label, text }) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{text}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </section>
            )}
            {parts.repository && repository && (
              <section className="inbox-section" aria-label="Repository" data-part="repository">
                <div className="inbox-section-header">
                  <h2>Repository</h2>
                  <span className="inbox-section-count">{parts.repository.entry.name}</span>
                  <SectionEvidence evidence={snapshot} prefixes={[parts.repository.pointer]} />
                </div>
                <RepositoryFacts
                  repository={parts.repository.entry}
                  pointer={parts.repository.pointer}
                />
                <div
                  className="template-repo-lead"
                  data-pointer={parts.repository.pointer}
                  data-selected={list.selected === repository.lead.id || undefined}
                  {...list.rowProps(repository.lead)}
                >
                  <span className="template-repo-title" data-tone={parts.repository.entry.tone}>
                    {plainTitle(parts.repository.entry.title)}
                  </span>
                  <span className="template-line-sub">
                    {plainTitle(parts.repository.entry.sub)}
                  </span>
                </div>
                {repository.sections.map(({ section, lines }) => (
                  <div
                    className="template-repo-section"
                    data-weight={section.weight}
                    key={section.title}
                  >
                    <h3>
                      {section.title}{" "}
                      <span className="inbox-section-count">
                        {section.count}
                        {section.rest}
                      </span>
                    </h3>
                    <ul className="template-lines">
                      {lines.map(({ key, line, selection }) => (
                        <li
                          key={key}
                          data-tone={line.tone}
                          data-upstream={line.upstream || undefined}
                          data-selected={(selection && list.selected === selection.id) || undefined}
                          {...(selection && list.rowProps(selection))}
                        >
                          <LineText line={line} />
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                {parts.repository.entry.note && (
                  <p className="template-note">{parts.repository.entry.note}</p>
                )}
              </section>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
