// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Reading, RepoLine } from "@spi-code/contracts";
import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import {
  FORKS,
  navigate,
  type OpenSelection,
  routeHash,
  setOpenSelection,
  useOpenSelection,
} from "../../app/navigation.js";
import { treeServices } from "../../app/queue.js";
import { SectionEvidence } from "../../components/evidence/SectionEvidence.js";
import { Place, type PlaceProps } from "../../components/place/Place.js";
import { RepositoryFacts } from "../../components/place/RepositoryFacts.js";
import { Popover } from "../../components/popover/Popover.js";
import { repositoryLinePointer } from "../../panels/selection-rows.js";
import { watchStore } from "../../store/watch.js";
import { plainTitle } from "../../text.js";
import { TimedText } from "../../time.js";
import { BorrowRows, dayFrom } from "./borrows.js";
import { FlowContext } from "./flow-context.js";
import { environmentOpening } from "./opening.js";
import {
  eventKey,
  eventText,
  eventWhen,
  eventWord,
  fixed,
  hourTicks,
  pctOf,
  place,
  TIER_PX,
  TRACK_MIN_PX,
} from "./timeline.js";
import "./environment.css";
import { placePin } from "../../store/pins.js";

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

// A missed nightly is drawn about as long as a smoke run takes.
const MISSED_SLOT_MS = 30 * 60_000;

const NO_READING: Reading = { anchor: { kind: "environment" }, content: null };

const keyOf = ({ kind, id }: OpenSelection) => `${kind}~${id}`;

/** What the open selection hangs under: the control clicked for it, else the first one that opens it. */
function anchorOf(
  root: HTMLElement | null,
  key: string,
  clicked: { key: string; element: HTMLElement } | null,
): HTMLElement | null {
  if (!root) return null;
  if (clicked?.key === key && clicked.element.isConnected && root.contains(clicked.element))
    return clicked.element;
  const opens = [...root.querySelectorAll<HTMLElement>("[data-opens]")];
  const own = opens.find((element) => element.dataset.opens === key);
  if (own) return own;
  if (!key.startsWith("item~")) return null;
  const id = key.slice(5);
  return (
    [...root.querySelectorAll<HTMLElement>(".place [data-selection-id]")].find(
      (element) => element.dataset.selectionId === id,
    ) ??
    [...root.querySelectorAll<HTMLElement>("[data-inspect]")].find(
      (element) => element.dataset.inspect === id,
    ) ??
    null
  );
}

/** The Environment place: the reading, then the stack's runs and its repository, each folded. */
export default function Environment({ store = watchStore }: { store?: typeof watchStore }) {
  const runsHeading = useId();
  const repositoryHeading = useId();
  const dayHeading = useId();
  const snapshot = useStore(store, (state) => state.snapshot);
  const body = snapshot?.body;
  const marked = useOpenSelection();
  const opening = environmentOpening(body, marked);
  const markedKey = marked && keyOf(marked);
  const pane = useRef<HTMLDivElement>(null);
  const clicked = useRef<{ key: string; element: HTMLElement } | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const opened = opening !== undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new snapshot redraws the anchors.
  useLayoutEffect(() => {
    const found = markedKey && opened ? anchorOf(pane.current, markedKey, clicked.current) : null;
    const folded = found?.closest("details");
    if (folded && !folded.open) folded.open = true;
    setAnchor(found);
  }, [markedKey, opened, body]);
  const close = useCallback(() => setOpenSelection(null), []);
  const toggle = (selection: OpenSelection, element: HTMLElement) => {
    const key = keyOf(selection);
    clicked.current = { key, element };
    setOpenSelection(markedKey === key ? null : selection);
  };
  const opener = (selection: OpenSelection) => ({
    "data-opens": keyOf(selection),
    "aria-haspopup": "dialog" as const,
    "aria-expanded": markedKey === keyOf(selection),
    onClick: (event: { currentTarget: HTMLElement }) => toggle(selection, event.currentTarget),
  });
  const env = body?.briefing.environment;
  const reading = body?.readings.find(({ anchor }) => anchor.kind === "environment") ?? NO_READING;
  const to = env ? Date.parse(env.to) : 0;
  const from = dayFrom(to);
  const lanes =
    env?.lanes.map((lane, index) => ({
      lane,
      pointer: `/briefing/environment/lanes/${index}`,
      placed: place(
        lane.events.filter(({ end }) => !end || Date.parse(end) >= from),
        from,
        to,
      ),
    })) ?? [];
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
      })),
    })) ?? [];
  const placeOf = (extra: Pick<PlaceProps, "tiles" | "belowTiles" | "readingLead"> = {}) => (
    <Place
      {...extra}
      name="Environment"
      pin={placePin("environment")}
      reading={reading}
      snapshot={body}
      services={treeServices(body?.tree)}
      onNavigate={navigate}
      onSelect={(id) => {
        const element = [
          ...(pane.current?.querySelectorAll<HTMLElement>(".place [data-selection-id]") ?? []),
        ].find((element) => element.dataset.selectionId === id);
        if (element) toggle({ kind: "item", id }, element);
      }}
    />
  );
  if (!body || !env)
    return (
      <div className="environment" data-view-pane="environment" ref={pane}>
        {placeOf()}
      </div>
    );
  // Keep duration text deterministic for the snapshot rather than ticking on the renderer clock.
  const now = new Date(to);
  const ticks = hourTicks(from, to);
  const timeline = (env.lanes.length > 0 || env.forksNote || env.borrows?.length) && (
    <section className="env-day" aria-labelledby={dayHeading}>
      <h3 className="env-section-label" id={dayHeading}>
        Last 24 hours
      </h3>
      <SectionEvidence evidence={body} prefixes={["/briefing/environment/lanes"]} />
      <div className="env-scroll">
        <div className="env-timeline" style={{ minWidth: TRACK_MIN_PX }}>
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
                  {lane.cadence && <small className="env-cadence">{lane.cadence}</small>}
                </div>
                <div className="env-track" style={{ height: tiers * TIER_PX + 10 }}>
                  {lane.missed
                    ?.filter((at) => Date.parse(at) >= from)
                    .map((at) => {
                      const left = pctOf(Date.parse(at), from, to);
                      const right = pctOf(Date.parse(at) + MISSED_SLOT_MS, from, to);
                      return (
                        <span
                          className="env-missed"
                          key={at}
                          data-missed={at}
                          aria-hidden="true"
                          style={{ left: `${fixed(left)}%`, width: `${fixed(right - left)}%` }}
                        />
                      );
                    })}
                  {placed.map((p) => {
                    const key = eventKey(lane, p.e);
                    const name = `${lane.label} ${p.e.label}, ${eventWord[p.e.state]}${p.e.byHand ? ", by hand" : ""}, ${eventWhen(p.e, now)}`;
                    return (
                      <button
                        type="button"
                        className={`env-event state-${p.e.state}${p.e.end ? "" : " open"}`}
                        key={key}
                        data-event={key}
                        data-by-hand={p.e.byHand}
                        data-inspect={p.e.inspect}
                        {...opener({ kind: "event", id: key })}
                        title={name}
                        aria-label={name}
                        style={{
                          left: `${fixed(p.left)}%`,
                          width: `${fixed(p.width)}%`,
                          top: p.tier * TIER_PX + 10,
                        }}
                      >
                        {p.e.byHand && (
                          <span className="env-by-hand" aria-hidden="true">
                            {"\u25c6"}
                          </span>
                        )}
                        <span className={`env-event-label${p.flip ? " flip" : ""}`}>
                          {eventText(p.e)}
                        </span>
                      </button>
                    );
                  })}
                  {placed.length === 0 &&
                    (lane.last ? (
                      <span className="env-none env-last" data-pointer={`${pointer}/last`}>
                        <span aria-hidden="true">{"\u2039 "}</span>
                        {lane.last.text}
                        {lane.last.note && (
                          <>
                            {" \u00b7 "}
                            <span className="env-last-note" data-late={lane.last.late}>
                              {lane.last.note}
                            </span>
                          </>
                        )}
                      </span>
                    ) : (
                      <span className="env-none">none in the last day</span>
                    ))}
                </div>
              </div>
            );
          })}
          <BorrowRows env={env} to={to} opener={(id) => opener({ kind: "borrow", id })} />
        </div>
      </div>
    </section>
  );
  const { status } = env;
  return (
    <div className="environment" data-view-pane="environment" ref={pane}>
      {placeOf({
        tiles: [],
        readingLead: status && (
          <>
            <h2 className="env-status" data-state={status.state}>
              <span className="env-status-label">{status.label}</span>
              {status.length && <span>{status.length}</span>}
              {status.reason && (
                <small>
                  <TimedText text={status.reason} hint={false} />
                </small>
              )}
              {status.live?.map(({ id, fork }) => (
                <button key={fork} type="button" {...opener({ kind: "borrow", id })}>
                  {fork}
                </button>
              ))}
            </h2>
            {env.line && (
              <p className="env-line">
                <TimedText text={env.line} hint={false} />
              </p>
            )}
            <SectionEvidence evidence={body} prefixes={["/briefing/environment/line"]} />
          </>
        ),
        belowTiles: timeline || undefined,
      })}
      <details className="env-part" data-part="runs">
        <summary id={runsHeading}>Stack runs</summary>
        <section className="env-part-body" aria-labelledby={runsHeading}>
          <FlowContext
            flow={body.briefing.flow}
            onSelect={(id) => {
              const fork = body.briefing.flow.rows.find(({ inspect }) => inspect === id)?.fork;
              navigate(FORKS);
              if (fork) setOpenSelection({ kind: "fork", id: fork });
            }}
          />
          <SectionEvidence evidence={body} prefixes={["/briefing/environment/headline"]} />
          <p className="env-lead" data-pointer="/briefing/environment/headline">
            <TimedText text={env.headline} hint={false} />
          </p>
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
            {sections.map((section) => (
              <div className="env-repo-section" key={section.title} data-weight={section.weight}>
                <h3>
                  {section.title}{" "}
                  <small>
                    {section.count}
                    {section.rest}
                  </small>
                </h3>
                {section.lines.map(({ line, pointer }) => {
                  return line.id ? (
                    <button
                      className="env-repo-line"
                      type="button"
                      key={pointer}
                      data-pointer={pointer}
                      {...opener({ kind: "repository-line", id: line.id })}
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
            {repository.note && <p className="env-muted">{repository.note}</p>}
          </section>
        </details>
      )}
      {opening && marked && anchor?.isConnected && (
        <Popover
          anchor={anchor}
          selection={marked}
          content={opening.content}
          onClose={close}
          within={pane.current?.closest<HTMLElement>("main")}
        >
          {opening.fork && (
            <div className="popover-rows">
              <a
                className="kit-link kit-link--muted"
                href={routeHash({ kind: "service", id: opening.fork })}
              >
                {opening.fork} home
              </a>
            </div>
          )}
          {opening.during.length > 0 && (
            <div className="popover-rows">
              {opening.during.map(({ key, text }) => (
                <button
                  type="button"
                  key={key}
                  onClick={() => setOpenSelection({ kind: "event", id: key })}
                >
                  {text}
                  {"\u00a0›"}
                </button>
              ))}
            </div>
          )}
        </Popover>
      )}
    </div>
  );
}
