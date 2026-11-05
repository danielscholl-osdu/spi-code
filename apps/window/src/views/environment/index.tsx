// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useState } from "react";
import { useStore } from "zustand";
import { watchStore } from "../../store/watch.js";
import {
  eventKey,
  eventText,
  eventWhen,
  eventWord,
  firstEvent,
  fixed,
  hourTicks,
  pctOf,
  place,
  TIER_PX,
  TRACK_MIN_PX,
} from "./timeline.js";
import "./environment.css";

export default function Environment({ store = watchStore }: { store?: typeof watchStore }) {
  const snapshot = useStore(store, (state) => state.snapshot);
  const [selected, setSelected] = useState<string>();
  const env = snapshot?.body.briefing.environment;
  if (!env)
    return (
      <>
        <h1>Environment</h1>
        <p role="status">Waiting for the first sweep.</p>
      </>
    );
  const from = Date.parse(env.from);
  const to = Date.parse(env.to);
  // Keep duration text deterministic for the snapshot rather than ticking on the renderer clock.
  const now = new Date(to);
  const ticks = hourTicks(from, to);
  const all = env.lanes.flatMap((lane) =>
    lane.events.map((e) => ({ lane, e, key: eventKey(lane, e) })),
  );
  const first = firstEvent(env.lanes);
  const active = all.find(({ key }) => key === selected) ?? all.find(({ key }) => key === first);
  return (
    <div className="environment">
      <h1>Environment</h1>
      <h2>{env.headline}</h2>
      {env.facts.length > 0 && (
        <div className="env-facts">
          {env.facts.map((fact) => (
            <div className={`env-fact tone-${fact.tone}`} key={fact.label}>
              <div className="env-fact-label">{fact.label}</div>
              <strong>{fact.figure}</strong>
              <div>{fact.sub}</div>
            </div>
          ))}
        </div>
      )}
      {env.lanes.length > 0 && (
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
            {env.lanes.map((lane) => {
              const placed = place(lane.events, from, to);
              const tiers = Math.max(1, ...placed.map((p) => p.tier + 1));
              return (
                <div className="env-row" key={lane.id} data-lane={lane.id}>
                  <div className="env-lane-label">{lane.label}</div>
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
                          aria-pressed={key === active?.key}
                          title={name}
                          aria-label={name}
                          onClick={() => setSelected(key)}
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
                    {placed.length === 0 && <span className="env-none">none in the last day</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {env.note && <p className="env-note">{env.note}</p>}
      {active && (
        <section className={`env-detail state-${active.e.state}`} aria-label="Event details">
          <p>
            {active.lane.label} &middot; {eventWord[active.e.state]}
          </p>
          <h3>{active.e.label}</h3>
          <dl>
            <dt>When</dt>
            <dd>{eventWhen(active.e, now)}</dd>
            <dt>What happened</dt>
            <dd>{active.e.detail}</dd>
          </dl>
          {active.e.inspect && (
            <button
              className="env-inspect"
              type="button"
              onClick={() => {
                if (active.e.inspect) store.getState().select(active.e.inspect);
              }}
            >
              Open in inspector
            </button>
          )}
        </section>
      )}
    </div>
  );
}
