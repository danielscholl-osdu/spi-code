// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SweepStatus } from "@spi-code/contracts";
import { type LiHTMLAttributes, type ReactNode, useId } from "react";
import { useStore } from "zustand";
import type { Route } from "../../app/routes.js";
import { worstEnvelope } from "../../components/evidence/WorstEnvelope.js";
import { type Evidence, envelopesForAll } from "../../store/evidence.js";
import { type createWatchStore, watchStore } from "../../store/watch.js";
import { type QueueEntry, queueGroups, scopeRoute, treeServices } from "./queue.js";
import "./inbox.css";

type WatchStore = ReturnType<typeof createWatchStore>;

/** One line for a section whose sources are not all fresh (EV-03); nothing when they are. */
function SectionEvidence({
  evidence,
  prefixes,
}: {
  evidence: Evidence;
  prefixes: readonly string[];
}) {
  const envelopes = envelopesForAll(evidence, prefixes).map(({ envelope }) => envelope);
  const notFresh = envelopes.filter(({ state }) => state !== "fresh");
  if (notFresh.length === 0) return null;
  const worst = worstEnvelope(notFresh);
  const inferred = envelopes.every((envelope) => envelope.inferred === true);
  return (
    <span className="inbox-evidence" data-state={worst.state}>
      {`${notFresh.length} of ${envelopes.length} sources not fresh · ${worst.state}${inferred ? " · inferred" : ""}`}
    </span>
  );
}

function SweepField({ name, children }: { name: keyof SweepStatus; children: ReactNode }) {
  return (
    <div className="inbox-sweep-field" data-field={name}>
      <dt>{name}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Before the first sweep finishes: what sweep.status carries, by field, and nothing more. */
function FirstSweep({ sweep }: { sweep: SweepStatus | null }) {
  return (
    <section className="inbox" aria-label="Inbox">
      <div className="inbox-tool">
        <h1>Inbox</h1>
      </div>
      <p role="status">First sweep running</p>
      {sweep && (
        <dl className="inbox-sweep" data-sweep-status>
          <SweepField name="remaining">
            {sweep.remaining === null ? "unknown" : `${sweep.remaining} API calls`}
          </SweepField>
          <SweepField name="floor">
            {sweep.floor === undefined ? "none" : `${sweep.floor} API calls`}
          </SweepField>
          <SweepField name="resetAt">
            {sweep.resetAt === null ? (
              "unknown"
            ) : (
              <time dateTime={sweep.resetAt}>
                {new Date(sweep.resetAt).toLocaleTimeString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            )}
          </SweepField>
          <SweepField name="deferredAreas">
            {sweep.deferredAreas.length === 0 ? (
              "none"
            ) : (
              <ul>
                {sweep.deferredAreas.map(({ area, reason }) => (
                  <li key={area} data-area={area}>
                    {area}: {reason}
                  </li>
                ))}
              </ul>
            )}
          </SweepField>
        </dl>
      )}
    </section>
  );
}

/** One queue item. A page that lists it with useSelectionList passes its rowProps, less onClick. */
export function QueueRow({
  entry: { item, pointer },
  selected,
  services,
  onSelect,
  onNavigate,
  rowProps,
}: {
  entry: QueueEntry;
  selected: boolean;
  services: readonly string[];
  onSelect(id: string): void;
  onNavigate(route: Route): void;
  rowProps?: LiHTMLAttributes<HTMLLIElement>;
}) {
  const route = scopeRoute(item.scope, services);
  return (
    <li
      {...rowProps}
      className="inbox-row"
      data-selection-id={item.id}
      data-pointer={pointer}
      data-selected={selected || undefined}
    >
      <span className="inbox-priority" data-rung={item.rung}>
        P{item.rung}
      </span>
      <span className="inbox-row-body">
        <span className="inbox-row-line">
          {route ? (
            <button
              type="button"
              className="inbox-scope"
              data-scope={item.scope}
              title={`Open ${item.scope}`}
              onClick={() => {
                if (!selected) onSelect(item.id);
                onNavigate(route);
              }}
            >
              {item.scope}
            </button>
          ) : (
            <span className="inbox-scope" data-scope={item.scope} data-fleet>
              {item.scope}
            </span>
          )}
          <button
            type="button"
            className="inbox-row-title"
            aria-pressed={selected}
            onClick={() => onSelect(item.id)}
          >
            {item.title}
          </button>
          <span className="inbox-class">{item.cls}</span>
        </span>
        <span className="inbox-sub">{item.sub}</span>
      </span>
    </li>
  );
}

export default function Inbox({
  store = watchStore,
  onNavigate,
}: {
  store?: WatchStore;
  onNavigate(route: Route): void;
}) {
  const snapshot = useStore(store, (state) => state.snapshot);
  const sweep = useStore(store, (state) => state.sweep);
  const selectedId = useStore(store, (state) => state.selection?.id);
  const select = useStore(store, (state) => state.select);
  const waiting = useId();
  if (!snapshot) return <FirstSweep sweep={sweep} />;
  const evidence = snapshot.body;
  const brief = evidence.briefing;
  const services = treeServices(evidence.tree);
  const groups = queueGroups(brief);
  const row = (entry: QueueEntry) => (
    <QueueRow
      key={entry.item.id}
      entry={entry}
      selected={selectedId === entry.item.id}
      services={services}
      onSelect={select}
      onNavigate={onNavigate}
    />
  );
  const sub = [`${brief.focus.length} in focus`, brief.more > 0 ? `${brief.more} more` : undefined]
    .filter(Boolean)
    .join(" · ");
  return (
    <section className="inbox" aria-label="Inbox">
      <div className="inbox-tool">
        <h1>Inbox</h1>
        <span className="inbox-tool-sub">{sub}</span>
        <SectionEvidence
          evidence={evidence}
          prefixes={["/briefing/headline", "/briefing/summary", "/briefing/facts"]}
        />
      </div>
      <p className="inbox-head" data-pointer="/briefing/headline">
        {brief.headline}
      </p>
      {brief.summary && (
        <p className="inbox-summary" data-pointer="/briefing/summary">
          {brief.summary}
        </p>
      )}
      {brief.facts.length > 0 && (
        <div className="inbox-facts">
          {brief.facts.map((fact, index) => (
            <div
              className="inbox-fact"
              data-tone={fact.tone}
              data-pointer={`/briefing/facts/${index}`}
              key={fact.label}
            >
              <div className="inbox-fact-label">{fact.label}</div>
              <div className="inbox-fact-figure">{fact.figure}</div>
              <div className="inbox-fact-sub">{fact.sub}</div>
            </div>
          ))}
        </div>
      )}
      <section className="inbox-section" aria-labelledby={waiting} data-section="waiting">
        <div className="inbox-section-header">
          <h2 id={waiting}>Waiting for you</h2>
        </div>
        <p className="inbox-empty">Approvals are not available yet.</p>
      </section>
      {groups.map((group) => (
        <section
          className="inbox-section"
          aria-label={group.label}
          data-section={group.label.toLowerCase()}
          key={group.label}
        >
          <div className="inbox-section-header">
            <h2>{group.label}</h2>
            <span className="inbox-section-count">{group.entries.length}</span>
            <SectionEvidence
              evidence={evidence}
              prefixes={group.entries.map(({ pointer }) => pointer)}
            />
          </div>
          <ul className="inbox-rows">{group.entries.map(row)}</ul>
        </section>
      ))}
      {brief.rest.length > 0 && (
        <details className="inbox-more" data-section="more">
          <summary data-pointer="/briefing/more">{brief.more} more in the queue</summary>
          <ul className="inbox-rows">
            {brief.rest.map((item, index) => row({ item, pointer: `/briefing/rest/${index}` }))}
          </ul>
        </details>
      )}
      {brief.ready.length > 0 && (
        <p className="inbox-ready" data-section="ready">
          <strong>Ready, no rush:</strong>{" "}
          {brief.ready.map((item, index) => (
            <span key={item.id} data-pointer={`/briefing/ready/${index}`}>
              {index > 0 && " · "}
              <button
                type="button"
                className="inbox-link"
                data-selection-id={item.id}
                aria-pressed={selectedId === item.id}
                onClick={() => select(item.id)}
              >
                {item.text}
              </button>
            </span>
          ))}
        </p>
      )}
    </section>
  );
}
