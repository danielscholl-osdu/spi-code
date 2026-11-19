// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Reading, RepoLine } from "@spi-code/contracts";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
import { ActivityLegend, ActivityRow, ActivitySummary, activityView } from "./activity.js";
import { BorrowRows, DayCell, ForkDays } from "./borrows.js";
import { FlowContext } from "./flow-context.js";
import { environmentOpening } from "./opening.js";
import { type Day, dayNames, daysOf, lastOf, missedIn, rangeOf, WEEK, within } from "./range.js";
import {
  eventKey,
  eventText,
  eventWhen,
  fixed,
  hourTicks,
  LABEL_PX,
  pctOf,
  place,
  stateWord,
  TIER_PX,
  TRACK_MIN_PX,
} from "./timeline.js";
import "./environment.css";
import { placePin } from "../../store/pins.js";

function LineReading({ line, upstream }: { line: RepoLine; upstream: string | undefined }) {
  return (
    <>
      <span className="env-repo-tag" data-tone={line.tone}>
        {line.tag}
      </span>
      <span>
        <span className="env-repo-line-text">{plainTitle(line.text)}</span>
        {line.sub && <small>{plainTitle(line.sub)}</small>}
        {line.upstream && upstream && <small>{upstream}</small>}
      </span>
    </>
  );
}

/** What takes focus once the next range draws: the way back into 7 days, or the day's heading. */
let pendingFocus: string | undefined;
const HEADING_PX = 72;

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
export default function Environment({
  store = watchStore,
  range: routeRange,
}: {
  store?: typeof watchStore;
  range?: string | undefined;
}) {
  const runsHeading = useId();
  const repositoryHeading = useId();
  const dayHeading = useId();
  const snapshot = useStore(store, (state) => state.snapshot);
  const body = snapshot?.body;
  const env = body?.briefing.environment;
  const range = env ? rangeOf(env, routeRange) : undefined;
  const marked = useOpenSelection();
  const opening = environmentOpening(body, marked, range);
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
  // Keep duration text deterministic for the snapshot rather than ticking on the renderer clock.
  const now = new Date(env ? Date.parse(env.to) : 0);
  const opener = (selection: OpenSelection) => ({
    "data-opens": keyOf(selection),
    "aria-haspopup": "dialog" as const,
    "aria-expanded": markedKey === keyOf(selection),
    onClick: (event: { currentTarget: HTMLElement }) => toggle(selection, event.currentTarget),
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: Focus moves once the new range has drawn.
  useEffect(() => {
    if (pendingFocus) pane.current?.querySelector<HTMLElement>(pendingFocus)?.focus();
    pendingFocus = undefined;
  }, [routeRange]);
  const openDay = (day: Day) => {
    pendingFocus = ".env-back";
    navigate({ kind: "environment", range: day.key });
  };
  const back = () => {
    pendingFocus = `.env-day-heading[data-day="${range?.day?.key}"]`;
    navigate({ kind: "environment", range: WEEK });
  };
  const reading = body?.readings.find(({ anchor }) => anchor.kind === "environment") ?? NO_READING;
  const { from, to } = range ?? { from: 0, to: 0 };
  const words = env?.words;
  const activity = env && activityView(env, from, to, range?.week);
  const lanes =
    env?.lanes.flatMap((lane, index) =>
      activity && lane.id === "holds"
        ? []
        : [
            {
              lane,
              pointer: `/briefing/environment/lanes/${index}`,
              placed: place(
                lane.events.filter(
                  ({ start, end }) => range && within(range, start, end, now.getTime()),
                ),
                from,
                to,
                !range?.week,
              ),
            },
          ],
    ) ?? [];
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
  if (!body || !env || !range)
    return (
      <div className="environment" data-view-pane="environment" ref={pane}>
        {placeOf()}
      </div>
    );
  const days = daysOf(env);
  const ticks = range.week
    ? days.slice(1).map(({ start }) => ({ at: start, major: true, text: "" }))
    : hourTicks(from, to).map((tick) => ({
        ...tick,
        major: new Date(tick.at).getHours() % 2 === 0,
      }));
  const timeline = (activity || env.lanes.length > 0 || env.forksNote || env.borrows?.length) && (
    <section className="env-day" aria-labelledby={dayHeading}>
      <div className="env-range-head">
        <h3 className="env-section-label" id={dayHeading}>
          {range.label}
        </h3>
        <fieldset className="env-range" aria-label={words?.range}>
          <button
            type="button"
            aria-pressed={!range.week && !range.day}
            onClick={() => navigate({ kind: "environment" })}
          >
            {words?.daySwitch}
          </button>
          <button
            type="button"
            aria-pressed={!!range.week}
            onClick={() => navigate({ kind: "environment", range: WEEK })}
          >
            {words?.weekSwitch}
          </button>
        </fieldset>
      </div>
      {(activity || range.day) && (
        <ActivitySummary view={activity}>
          {range.day && (
            <button type="button" className="env-back" onClick={back}>
              {`\u2039 ${words?.weekSwitch ?? ""}`}
            </button>
          )}
        </ActivitySummary>
      )}
      <SectionEvidence evidence={body} prefixes={["/briefing/environment/lanes"]} />
      <div className="env-scroll">
        <div
          className="env-timeline"
          style={
            {
              minWidth: TRACK_MIN_PX,
              "--env-label-width": `${LABEL_PX}px`,
              "--env-after-label": `${LABEL_PX + 6}px`,
            } as CSSProperties
          }
        >
          <div className="env-grid" aria-hidden="true">
            {range.to === now.getTime() && <span className="env-now" />}
            {ticks.map((tick) => (
              <span
                key={tick.at}
                className={`env-tick${tick.major ? " major" : ""}`}
                style={{ left: `${fixed(pctOf(tick.at, from, to))}%` }}
              />
            ))}
          </div>
          <div className="env-row env-axis" aria-hidden={range.week ? undefined : true}>
            <div />
            <div className="env-track">
              {range.week
                ? days.map((day) => {
                    const count =
                      env.borrows?.filter(({ start }) => {
                        const at = Date.parse(start);
                        return at >= day.start && at < day.end;
                      }).length ?? 0;
                    return (
                      <DayCell key={day.key} day={day} from={from} to={to} px={HEADING_PX}>
                        <button
                          type="button"
                          className="env-day-heading"
                          data-day={day.key}
                          data-from={env.days?.find(({ day: key }) => key === day.key)?.from}
                          aria-label={dayNames(day).long}
                          onClick={() => openDay(day)}
                        >
                          {dayNames(day).short}
                          {count > 0 && <small>{count}</small>}
                        </button>
                      </DayCell>
                    );
                  })
                : ticks
                    .filter((tick) => {
                      const left = pctOf(tick.at, from, to);
                      return left > 2 && left < 98 && tick.major;
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
          {activity && (
            <ActivityRow view={activity} from={from} to={to} opener={opener} week={range.week} />
          )}
          {lanes.map(({ lane, pointer, placed }) => {
            const tiers = Math.max(1, ...placed.map((p) => p.tier + 1));
            const last = lastOf(lane, range);
            return (
              <div className="env-row" key={lane.id} data-lane={lane.id}>
                <div className="env-lane-label" data-pointer={pointer}>
                  {lane.label}
                  {lane.cadence && <small className="env-cadence">{lane.cadence}</small>}
                </div>
                <div className="env-track" style={{ height: tiers * TIER_PX + 10 }}>
                  {missedIn(lane, range, now.getTime()).map((at) => {
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
                    const name = [
                      `${lane.label} ${p.e.label}`,
                      stateWord(words, p.e.state),
                      p.e.byHand ? env.activity?.words.byHand : undefined,
                      eventWhen(p.e, now, words),
                    ]
                      .filter(Boolean)
                      .join(", ");
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
                            {"◆"}
                          </span>
                        )}
                        {!range.week && (
                          <span className={`env-event-label${p.flip ? " flip" : ""}`}>
                            {eventText(p.e)}
                          </span>
                        )}
                      </button>
                    );
                  })}
                  {placed.length === 0 &&
                    (last ? (
                      <span className="env-none env-last" data-pointer={`${pointer}/last`}>
                        <span aria-hidden="true">{"‹ "}</span>
                        {last.text}
                        {last.note && (
                          <>
                            {" · "}
                            <span className="env-last-note" data-late={last.late}>
                              {last.note}
                            </span>
                          </>
                        )}
                      </span>
                    ) : (
                      <span className="env-none">
                        {range.week || range.day ? words?.none : words?.noneDay}
                      </span>
                    ))}
                </div>
              </div>
            );
          })}
          {range.week ? (
            <ForkDays env={env} days={days} from={from} to={to} onOpen={openDay} />
          ) : (
            <BorrowRows
              env={env}
              from={from}
              to={to}
              now={now.getTime()}
              opener={(id) => opener({ kind: "borrow", id })}
            />
          )}
        </div>
      </div>
      {activity && <ActivityLegend view={activity} />}
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
              {status.live?.map(({ id, fork }) => {
                const open = opener({ kind: "borrow", id });
                return (
                  <button
                    key={fork}
                    type="button"
                    {...open}
                    onClick={(event) => {
                      if (range.week || range.day) navigate({ kind: "environment" });
                      open.onClick(event);
                    }}
                  >
                    {fork}
                  </button>
                );
              })}
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
        <summary id={runsHeading}>{words?.runs}</summary>
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
            {words?.repository} <small>{repository.name}</small>
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
                      <LineReading line={line} upstream={words?.upstream} />
                    </button>
                  ) : (
                    <div className="env-repo-line" key={pointer} data-pointer={pointer}>
                      <LineReading line={line} upstream={words?.upstream} />
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
          {opening.trigger && <p className="env-trigger">{opening.trigger}</p>}
          {opening.fork && (
            <div className="popover-rows">
              <a
                className="kit-link kit-link--muted"
                href={routeHash({ kind: "service", id: opening.fork.id })}
              >
                {opening.fork.label}
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
