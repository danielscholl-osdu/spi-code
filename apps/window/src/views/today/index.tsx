// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";
import { useEffect } from "react";
import { useStore } from "zustand";
import { SectionEvidence } from "../../components/evidence/SectionEvidence.js";
import { type createWatchStore, watchStore } from "../../store/watch.js";
import "./today.css";

type Briefing = ViewSnapshot["briefing"];
type FocusItem = Briefing["focus"][number];
type Theme = Briefing["themes"][number];

function ranked(items: readonly FocusItem[], prefix: string): [FocusItem, string][] {
  return items
    .map((item, index): [FocusItem, string] => [item, `${prefix}/${index}`])
    .sort(([a], [b]) => a.rung - b.rung);
}

export default function Today({
  store = watchStore,
}: {
  store?: ReturnType<typeof createWatchStore>;
}) {
  const snapshot = useStore(store, (state) => state.snapshot);
  const selectedId = useStore(store, (state) => state.selection?.id);
  const select = useStore(store, (state) => state.select);
  const focus = snapshot ? ranked(snapshot.body.briefing.focus, "/briefing/focus") : [];
  const first = focus[0]?.[0].id;
  useEffect(() => {
    if (selectedId === undefined && first !== undefined) select(first);
  }, [selectedId, first, select]);
  if (!snapshot)
    return (
      <section className="today">
        <h1>Today</h1>
        <p role="status">Waiting for the first sweep.</p>
      </section>
    );
  const brief = snapshot.body.briefing;
  const evidence = snapshot.body;
  const row = ([item, pointer]: [FocusItem, string]) => {
    const tone = item.rung === 0 ? "bad" : item.cls === "PORT" ? "neutral" : "warn";
    return (
      <button
        type="button"
        className="today-row"
        key={item.id}
        data-selection-id={item.id}
        data-pointer={pointer}
        aria-pressed={selectedId === item.id}
        onClick={() => select(item.id)}
      >
        <span className="today-priority" data-priority={item.rung} data-tone={tone}>
          P{item.rung}
        </span>
        <span>
          <strong className="today-item-title">{item.title}</strong>{" "}
          <span className="today-muted">{item.scope}</span>{" "}
          <span className="today-class" data-tone={tone}>
            {item.cls}
          </span>
          <span className="today-sub">{item.sub}</span>
        </span>
      </button>
    );
  };
  const forks = (entries: Theme["certain"], className: string) => (
    <ul className={className}>
      {entries.map((fork) => (
        <li key={fork.fork}>
          {fork.inspect ? (
            <button
              type="button"
              className="today-link"
              data-selection-id={fork.inspect}
              onClick={() => {
                if (fork.inspect) select(fork.inspect);
              }}
            >
              {fork.fork} · {fork.state}
            </button>
          ) : (
            <>
              {fork.fork} · {fork.state}
            </>
          )}
        </li>
      ))}
    </ul>
  );
  return (
    <section className="today" aria-label="Today">
      <SectionEvidence evidence={evidence} prefixes={["/briefing/headline", "/briefing/summary"]} />
      <h1 data-pointer="/briefing/headline">{brief.headline}</h1>
      {brief.summary && (
        <p className="today-summary" data-pointer="/briefing/summary">
          {brief.summary}
        </p>
      )}
      {brief.facts.length > 0 && (
        <>
          <SectionEvidence evidence={evidence} prefixes={["/briefing/facts"]} />
          <div className="today-facts">
            {brief.facts.map((fact, index) => (
              <div
                className="today-fact"
                data-tone={fact.tone}
                data-pointer={`/briefing/facts/${index}/figure`}
                key={fact.label}
              >
                <div className="today-fact-label">{fact.label}</div>
                <strong className="today-figure">{fact.figure}</strong>
                <div className="today-fact-sub">{fact.sub}</div>
              </div>
            ))}
          </div>
          <section className="today-focus" aria-label="Focus">
            <SectionEvidence
              evidence={evidence}
              prefixes={["/briefing/focus", "/briefing/rest", "/briefing/more"]}
            />
            {focus.map(row)}
            {brief.rest.length > 0 && (
              <details>
                <summary data-pointer="/briefing/more">{brief.more} more in the queue</summary>
                {ranked(brief.rest, "/briefing/rest").map(row)}
              </details>
            )}
          </section>
          {brief.ready.length > 0 && (
            <>
              <SectionEvidence evidence={evidence} prefixes={["/briefing/ready"]} />
              <p className="today-ready">
                <strong>Ready, no rush:</strong>{" "}
                {brief.ready.map((item, index) => (
                  <span key={item.id} data-pointer={`/briefing/ready/${index}`}>
                    {index > 0 && " · "}
                    <button
                      type="button"
                      className="today-link"
                      data-selection-id={item.id}
                      onClick={() => select(item.id)}
                    >
                      {item.text}
                    </button>
                  </span>
                ))}
              </p>
            </>
          )}
        </>
      )}
      {brief.themes.length > 0 && (
        <section className="today-themes" aria-label="Themes">
          <h2>Themes</h2>
          <SectionEvidence evidence={evidence} prefixes={["/briefing/themes"]} />
          {brief.themes.map((theme, index) => (
            <article
              className="today-theme"
              data-theme-id={theme.id}
              data-tone={theme.tone}
              data-pointer={`/briefing/themes/${index}`}
              key={theme.id}
            >
              <h3>{theme.title}</h3>
              <p className="today-theme-sub">{theme.sub}</p>
              {theme.when && <time>{theme.when}</time>}
              {theme.certain.length > 0 && (
                <>
                  <h4>Certain</h4>
                  {forks(theme.certain, "today-certain")}
                </>
              )}
              {theme.possible.length > 0 && (
                <>
                  <h4>Possible</h4>
                  {forks(theme.possible, "today-possible")}
                </>
              )}
              {theme.exposed.length > 0 && <p>Exposed: {theme.exposed.join(", ")}</p>}
              <p className="today-theme-next">{theme.next}</p>
              {theme.inspect && (
                <button
                  type="button"
                  className="today-link"
                  data-selection-id={theme.inspect}
                  onClick={() => {
                    if (theme.inspect) select(theme.inspect);
                  }}
                >
                  Open in inspector
                </button>
              )}
            </article>
          ))}
        </section>
      )}
    </section>
  );
}
