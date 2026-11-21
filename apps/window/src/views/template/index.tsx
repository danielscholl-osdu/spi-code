// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Reading, RepoEntry, RepoLine, ViewSnapshot } from "@spi-code/contracts";
import { useRef } from "react";
import { useStore } from "zustand";
import { navigate, type OpenSelection } from "../../app/navigation.js";
import { type QueueEntry, treeServices } from "../../app/queue.js";
import { SectionEvidence } from "../../components/evidence/SectionEvidence.js";
import { itemContent, usePlaceOpening } from "../../components/place/opening.js";
import { Place } from "../../components/place/Place.js";
import { isReadFigure, RepositoryFacts } from "../../components/place/RepositoryFacts.js";
import { Popover } from "../../components/popover/Popover.js";
import { watchStore } from "../../store/watch.js";
import { plainTitle } from "../../text.js";
import { TimedText } from "../../time.js";
import { QueueRow } from "./QueueRow.js";
import { Repositories } from "./Repositories.js";
import { Rollout, rolloutLadder } from "./Rollout.js";
import "./template.css";
import { placePin } from "../../store/pins.js";
import { ScopeThreads } from "../../threads/ScopeThreads.js";

const TEMPLATE_REPOSITORY = "osdu-spi";
const ROLLOUT = "rollout";
const NO_READING: Reading = { anchor: { kind: "engineering" }, content: null };

function templateParts({ briefing }: ViewSnapshot) {
  const fact = briefing.repositories.template;
  const queue: QueueEntry[] = [
    ...briefing.focus.map((item, index) => ({ item, pointer: `/briefing/focus/${index}` })),
    ...briefing.rest.map((item, index) => ({ item, pointer: `/briefing/rest/${index}` })),
  ];
  const repoIndex = briefing.repositories.rows.findIndex(
    ({ name }) => name === TEMPLATE_REPOSITORY,
  );
  const repository = briefing.repositories.rows[repoIndex];
  return {
    fact: fact && { fact, pointer: "/briefing/repositories/template" },
    rollout: queue.find(({ item }) => item.id === ROLLOUT),
    repository: repository && {
      entry: repository,
      index: repoIndex,
      pointer: `/briefing/repositories/rows/${repoIndex}`,
    },
  };
}

type LineRow = { key: string; line: RepoLine };

function repositorySections(entry: RepoEntry, pointer: string) {
  return entry.sections.flatMap((section, sectionIndex) =>
    section.lines.length > 0
      ? [
          {
            section,
            lines: section.lines.map((line, index): LineRow => {
              const at = `${pointer}/sections/${sectionIndex}/lines/${index}`;
              return { key: line.id ?? at, line };
            }),
          },
        ]
      : [],
  );
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

const ENGINEERING = { kind: "engineering-system" } as const;

export default function Template({ store = watchStore }: { store?: typeof watchStore }) {
  const snapshot = useStore(store, (state) => state.snapshot?.body);
  const pane = useRef<HTMLDivElement>(null);
  const { marked, anchor, opener, openItem, close } = usePlaceOpening(pane, snapshot);
  const reading =
    snapshot?.readings.find(({ anchor }) => anchor.kind === "engineering") ?? NO_READING;
  const parts = snapshot && templateParts(snapshot);
  const sections =
    parts?.repository && repositorySections(parts.repository.entry, parts.repository.pointer);
  const ladder = snapshot && rolloutLadder(snapshot);
  const opened =
    snapshot &&
    marked?.kind === "item" &&
    !(marked.id === ROLLOUT && ladder?.rungs.some(({ member }) => member)) &&
    itemContent(snapshot, marked.id, {
      label: "Template",
      destination: ENGINEERING,
      selection: marked,
    });
  const isOpen = (selection: OpenSelection) =>
    marked?.kind === selection.kind && marked.id === selection.id;
  const fact = parts?.fact;
  const fleetFacts =
    snapshot?.briefing.repositories.facts
      .map((fact, index) => ({ fact, pointer: `/briefing/repositories/facts/${index}` }))
      .filter(({ fact }) => isReadFigure(fact.figure)) ?? [];
  return (
    <div className="inbox template" data-view-pane="engineering-system" ref={pane}>
      <Place
        name="Template"
        pin={placePin("engineering-system")}
        ask="template"
        reading={reading}
        snapshot={snapshot}
        services={treeServices(snapshot?.tree)}
        onNavigate={navigate}
        onSelect={openItem}
        belowTiles={
          snapshot &&
          (ladder || snapshot.briefing.repositories.rows.length > 0) && (
            <>
              {ladder && <Rollout ladder={ladder} snapshot={snapshot} />}
              <Repositories snapshot={snapshot} onSecurity={() => navigate({ kind: "security" })} />
            </>
          )
        }
      />
      {snapshot &&
        parts &&
        (fact || parts.rollout || parts.repository || fleetFacts.length > 0) && (
          <details className="template-details">
            <summary>Details</summary>
            <div className="template-details-body">
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
                  <div
                    className="inbox-fact"
                    data-tone={fact.fact.tone}
                    data-pointer={fact.pointer}
                  >
                    <div className="inbox-fact-label">{fact.fact.label}</div>
                    <div className="inbox-fact-figure">{fact.fact.figure}</div>
                    <div className="inbox-fact-sub">{fact.fact.sub}</div>
                  </div>
                  <SectionEvidence evidence={snapshot} prefixes={[fact.pointer]} />
                </div>
              )}
              {parts.rollout && (
                <section className="inbox-section" aria-label="Rollout" data-part="rollout">
                  <div className="inbox-section-header">
                    <h2>Rollout</h2>
                    <SectionEvidence evidence={snapshot} prefixes={[parts.rollout.pointer]} />
                  </div>
                  <ul className="inbox-rows">
                    <QueueRow
                      entry={parts.rollout}
                      selected={isOpen({ kind: "item", id: parts.rollout.item.id })}
                      services={treeServices(snapshot.tree)}
                      onNavigate={navigate}
                      opens={opener({ kind: "item", id: parts.rollout.item.id })}
                    />
                  </ul>
                  {!!parts.rollout.item.more?.length && (
                    <dl className="template-detail" data-pointer={`${parts.rollout.pointer}/more`}>
                      {parts.rollout.item.more.map(({ label, text }) => (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd>
                            <TimedText text={text} hint={false} />
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </section>
              )}
              {parts.repository && sections && (
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
                  <button
                    type="button"
                    className="template-repo-lead"
                    data-pointer={parts.repository.pointer}
                    {...opener({ kind: "item", id: parts.repository.entry.id })}
                  >
                    <span className="template-repo-title" data-tone={parts.repository.entry.tone}>
                      {plainTitle(parts.repository.entry.title)}
                    </span>
                    <span className="template-line-sub">
                      {plainTitle(parts.repository.entry.sub)}
                    </span>
                  </button>
                  {sections.map(({ section, lines }) => (
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
                        {lines.map(({ key, line }) => (
                          <li
                            key={key}
                            data-tone={line.tone}
                            data-upstream={line.upstream || undefined}
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
      <ScopeThreads scope="template" />
      {opened && marked && anchor && (
        <Popover anchor={anchor} selection={marked} content={opened} onClose={close} />
      )}
    </div>
  );
}
