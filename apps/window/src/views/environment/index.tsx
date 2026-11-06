// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { RepoLine } from "@spi-code/contracts";
import { useStore } from "zustand";
import { SectionEvidence } from "../../components/evidence/SectionEvidence.js";
import { type SelectionStore, selectionStore } from "../../panels/selection.js";
import {
  repositoryLinePointer,
  repositoryLineRow,
  type SelectionRow,
} from "../../panels/selection-rows.js";
import { useSelectionList } from "../../panels/useSelectionList.js";
import { watchStore } from "../../store/watch.js";
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
        <span>{line.text}</span>
        {line.sub && <small>{line.sub}</small>}
        {line.upstream && <small>upstream</small>}
      </span>
    </>
  );
}

export default function Environment({
  store = watchStore,
  inspector = selectionStore,
}: {
  store?: typeof watchStore;
  inspector?: SelectionStore;
}) {
  const snapshot = useStore(store, (state) => state.snapshot);
  const env = snapshot?.body.briefing.environment;
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
  const repositories = snapshot?.body.briefing.repositories.rows ?? [];
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
  if (!snapshot || !env)
    return (
      <>
        <h1>Environment</h1>
        <p role="status">Waiting for the first sweep.</p>
      </>
    );
  // Keep duration text deterministic for the snapshot rather than ticking on the renderer clock.
  const now = new Date(to);
  const ticks = hourTicks(from, to);
  const evidence = snapshot.body;
  return (
    <div className="environment">
      <h1>Environment</h1>
      <SectionEvidence evidence={evidence} prefixes={["/briefing/environment/headline"]} />
      <h2 data-pointer="/briefing/environment/headline">{env.headline}</h2>
      {env.facts.length > 0 && (
        <>
          <SectionEvidence evidence={evidence} prefixes={["/briefing/environment/facts"]} />
          <div className="env-facts">
            {env.facts.map((fact, index) => {
              const pointer = `/briefing/environment/facts/${index}/figure`;
              return (
                <div
                  className={`env-fact tone-${fact.tone}`}
                  data-pointer={pointer}
                  key={fact.label}
                >
                  <div className="env-fact-label">{fact.label}</div>
                  <strong>{fact.figure}</strong>
                  <div>{fact.sub}</div>
                </div>
              );
            })}
          </div>
        </>
      )}
      {(env.lanes.length > 0 || env.note) && (
        <section aria-label="Lane events">
          {env.lanes.length > 0 && (
            <>
              <SectionEvidence evidence={evidence} prefixes={["/briefing/environment/lanes"]} />
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
              <SectionEvidence evidence={evidence} prefixes={["/briefing/environment/note"]} />
              <p className="env-note" data-pointer="/briefing/environment/note">
                {env.note}
              </p>
            </>
          )}
        </section>
      )}
      {repository && (
        <section className="env-section" aria-label="Repository" data-pointer={repositoryPointer}>
          <h2>
            Repository <small>{repository.name}</small>
          </h2>
          <SectionEvidence evidence={evidence} prefixes={[repositoryPointer]} />
          {repository.title && <p data-tone={repository.tone}>{repository.title}</p>}
          {repository.sub && <p className="env-muted">{repository.sub}</p>}
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
      )}
      <section className="env-section" aria-label="Threads">
        <h2>Threads</h2>
        <p className="env-muted">Threads are not available yet.</p>
      </section>
      <section className="env-section" aria-label="Live cluster">
        <h2>Live cluster</h2>
        <p className="env-muted">Live reads are not available yet.</p>
      </section>
    </div>
  );
}
