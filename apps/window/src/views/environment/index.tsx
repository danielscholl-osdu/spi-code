// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Reading, RepoLine } from "@spi-code/contracts";
import { useId } from "react";
import { useStore } from "zustand";
import { navigate } from "../../app/navigation.js";
import { treeServices } from "../../app/queue.js";
import { SectionEvidence } from "../../components/evidence/SectionEvidence.js";
import { Place } from "../../components/place/Place.js";
import { RepositoryFacts } from "../../components/place/RepositoryFacts.js";
import { type SelectionStore, selectionStore } from "../../panels/selection.js";
import {
  repositoryLinePointer,
  repositoryLineRow,
  type SelectionRow,
  selectionRows,
} from "../../panels/selection-rows.js";
import { useSelectionList } from "../../panels/useSelectionList.js";
import { watchStore } from "../../store/watch.js";
import { plainTitle } from "../../text.js";
import { FlowContext } from "./flow-context.js";
import { runningFactHome } from "./running-fact.js";
import {
  eventKey,
  eventText,
  eventWhen,
  eventWord,
  fixed,
  hourTicks,
  inspectId,
  pctOf,
  place,
  TIER_PX,
  TRACK_MIN_PX,
} from "./timeline.js";
import "./environment.css";

function LineReading({ line }: { line: RepoLine }) {
  return (
    <>
      <span className="env-repo-tag" data-tone={line.tone}>
        {line.tag}
      </span>
      <span>
        <span className="env-repo-line-text">{plainTitle(line.text)}</span>
        {line.sub && <small>{plainTitle(line.sub)}</small>}
        {line.upstream && <small>upstream</small>}
      </span>
    </>
  );
}

const NO_READING: Reading = { anchor: { kind: "environment" }, content: null };

/** The Environment place: the reading, then the stack's runs and its repository, each folded. */
export default function Environment({
  store = watchStore,
  inspector = selectionStore,
}: {
  store?: typeof watchStore;
  inspector?: SelectionStore;
}) {
  const runsHeading = useId();
  const repositoryHeading = useId();
  const snapshot = useStore(store, (state) => state.snapshot);
  const selected = useStore(inspector, (state) => state.selected);
  const body = snapshot?.body;
  const env = body?.briefing.environment;
  const reading = body?.readings.find(({ anchor }) => anchor.kind === "environment") ?? NO_READING;
  const facts =
    env?.facts
      .map((fact, index) => ({ fact, index, home: runningFactHome(fact, reading) }))
      .filter(({ home }) => home.versionTile < 0 || !home.subInHeadline) ?? [];
  const from = env ? Date.parse(env.from) : 0;
  const to = env ? Date.parse(env.to) : 0;
  const lanes =
    env?.lanes.map((lane, index) => {
      const pointer = `/briefing/environment/lanes/${index}`;
      return {
        lane,
        pointer,
        placed: place(lane.events, from, to).map((p) => ({
          ...p,
          row: {
            id: inspectId(lane, p.e),
            title: p.e.label,
            kind: "environment",
            prefixes: [`${pointer}/events/${lane.events.indexOf(p.e)}`],
          } satisfies SelectionRow,
        })),
      };
    }) ?? [];
  const events = useSelectionList(
    lanes.flatMap(({ placed }) => placed.map(({ row }) => row)),
    undefined,
    inspector,
  );
  const repositories = body?.briefing.repositories.rows ?? [];
  const repositoryIndex = repositories.findIndex((row) => row.name === "osdu-spi-stack");
  const repository = repositories[repositoryIndex];
  const repositoryPointer = `/briefing/repositories/rows/${repositoryIndex}`;
  const sections =
    repository?.sections.map((section, sectionIndex) => ({
      ...section,
      lines: section.lines.map((line, lineIndex) => ({
        line,
        pointer: repositoryLinePointer(repositoryIndex, sectionIndex, lineIndex),
        row: repositoryLineRow(line, repositoryIndex, sectionIndex, lineIndex),
      })),
    })) ?? [];
  const lines = useSelectionList(
    sections.flatMap((section) => section.lines.flatMap(({ row }) => (row ? [row] : []))),
    undefined,
    inspector,
  );
  const placeView = (
    <Place
      name="Environment"
      reading={reading}
      services={treeServices(body?.tree)}
      onNavigate={navigate}
      onSelect={(id) => {
        const row =
          body && selectionRows(body).find((row) => row.kind === "queue" && row.id === id);
        if (!row) return;
        inspector.getState().select(row.id, row);
        inspector.getState().setTab("detail");
      }}
      {...(selected !== null ? { selectedId: selected } : {})}
    />
  );
  if (!body || !env)
    return (
      <div className="environment" data-view-pane="environment">
        {placeView}
      </div>
    );
  // Keep duration text deterministic for the snapshot rather than ticking on the renderer clock.
  const now = new Date(to);
  const ticks = hourTicks(from, to);
  return (
    <div className="environment" data-view-pane="environment">
      {placeView}
      <details className="env-part" data-part="runs">
        <summary id={runsHeading}>Stack runs</summary>
        <section className="env-part-body" aria-labelledby={runsHeading}>
          <FlowContext
            flow={body.briefing.flow}
            onSelect={(id) => {
              const row = selectionRows(body).find((row) => row.id === id);
              if (!row) return;
              inspector.getState().select(id, row);
              inspector.getState().setTab("detail");
            }}
          />
          <SectionEvidence evidence={body} prefixes={["/briefing/environment/headline"]} />
          <p className="env-lead" data-pointer="/briefing/environment/headline">
            {env.headline}
          </p>
          {env.facts.length > 0 && (
            <>
              <SectionEvidence evidence={body} prefixes={["/briefing/environment/facts"]} />
              {facts.length > 0 && (
                <div className="env-facts">
                  {facts.map(({ fact, index, home }) => {
                    const pointer = `/briefing/environment/facts/${index}/figure`;
                    return (
                      <div
                        className={`env-fact tone-${fact.tone}`}
                        data-pointer={pointer}
                        key={fact.label}
                      >
                        <div className="env-fact-label">{fact.label}</div>
                        {home.versionTile < 0 && <strong>{fact.figure}</strong>}
                        {!home.subInHeadline && <div>{fact.sub}</div>}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
          {env.lanes.length > 0 && (
            <>
              <SectionEvidence evidence={body} prefixes={["/briefing/environment/lanes"]} />
              <div role="listbox" aria-label="Lane events" data-selection-list>
                <div className="env-scroll">
                  <div className="env-timeline" style={{ minWidth: TRACK_MIN_PX + 84 }}>
                    <div className="env-grid" aria-hidden="true">
                      {ticks.map((tick) => (
                        <span
                          key={tick.at}
                          className={`env-tick${new Date(tick.at).getHours() % 2 === 0 ? " major" : ""}`}
                          style={{ left: `${fixed(pctOf(tick.at, from, to))}%` }}
                        />
                      ))}
                    </div>
                    <div className="env-row env-axis" aria-hidden="true">
                      <div />
                      <div className="env-track">
                        {ticks
                          .filter((tick) => {
                            const left = pctOf(tick.at, from, to);
                            return left > 2 && left < 98 && new Date(tick.at).getHours() % 2 === 0;
                          })
                          .map((tick) => (
                            <span
                              className="env-hour"
                              key={tick.at}
                              style={{ left: `${fixed(pctOf(tick.at, from, to))}%` }}
                            >
                              {tick.text}
                            </span>
                          ))}
                      </div>
                    </div>
                    {lanes.map(({ lane, pointer, placed }) => {
                      const tiers = Math.max(1, ...placed.map((p) => p.tier + 1));
                      return (
                        <div className="env-row" key={lane.id} data-lane={lane.id}>
                          <div className="env-lane-label" data-pointer={pointer}>
                            {lane.label}
                          </div>
                          <div className="env-track" style={{ height: tiers * TIER_PX + 10 }}>
                            {placed.map((p) => {
                              const key = eventKey(lane, p.e);
                              const name = `${lane.label} ${p.e.label}, ${eventWord[p.e.state]}, ${eventWhen(p.e, now)}`;
                              return (
                                <button
                                  type="button"
                                  className={`env-event state-${p.e.state}`}
                                  key={key}
                                  data-event={key}
                                  role="option"
                                  {...events.rowProps(p.row)}
                                  title={name}
                                  aria-label={name}
                                  style={{
                                    left: `${fixed(p.left)}%`,
                                    width: `${fixed(p.width)}%`,
                                    top: p.tier * TIER_PX + 10,
                                  }}
                                >
                                  <span className={`env-event-label${p.flip ? " flip" : ""}`}>
                                    {eventText(p.e)}
                                  </span>
                                </button>
                              );
                            })}
                            {placed.length === 0 && (
                              <span className="env-none">none in the last day</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </>
          )}
          {env.note && (
            <>
              <SectionEvidence evidence={body} prefixes={["/briefing/environment/note"]} />
              <p className="env-note" data-pointer="/briefing/environment/note">
                {env.note}
              </p>
            </>
          )}
        </section>
      </details>
      {repository && (
        <details className="env-part" data-part="repository" data-pointer={repositoryPointer}>
          <summary id={repositoryHeading}>
            Stack repository <small>{repository.name}</small>
          </summary>
          <section className="env-part-body" aria-labelledby={repositoryHeading}>
            <SectionEvidence evidence={body} prefixes={[repositoryPointer]} />
            <RepositoryFacts repository={repository} pointer={repositoryPointer} />
            {repository.title && (
              <p data-tone={repository.tone} data-pointer={`${repositoryPointer}/title`}>
                {plainTitle(repository.title)}
              </p>
            )}
            {repository.sub && <p className="env-muted">{plainTitle(repository.sub)}</p>}
            <div role="listbox" aria-label="Stack repository lines" data-selection-list>
              {sections.map((section) => (
                <div className="env-repo-section" key={section.title} data-weight={section.weight}>
                  <h3>
                    {section.title}{" "}
                    <small>
                      {section.count}
                      {section.rest}
                    </small>
                  </h3>
                  {section.lines.map(({ line, pointer, row }) => {
                    return row ? (
                      <button
                        className="env-repo-line"
                        type="button"
                        role="option"
                        key={pointer}
                        data-pointer={pointer}
                        {...lines.rowProps(row)}
                      >
                        <LineReading line={line} />
                      </button>
                    ) : (
                      <div className="env-repo-line" key={pointer} data-pointer={pointer}>
                        <LineReading line={line} />
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            {repository.note && <p className="env-muted">{repository.note}</p>}
          </section>
        </details>
      )}
    </div>
  );
}
