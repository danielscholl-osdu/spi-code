// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Reading, SweepProgress, ViewSnapshot } from "@spi-code/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { type Navigation, navigate } from "../../app/navigation.js";
import { scopeRoute, treeServices } from "../../app/queue.js";
import { sectionSources } from "../../components/evidence/SectionEvidence.js";
import { useNow } from "../../components/evidence/useNow.js";
import { byWorst } from "../../components/evidence/words.js";
import { Place } from "../../components/place/Place.js";
import { SweepSources } from "../../components/sweep/SweepSources.js";
import { SweepStopped } from "../../components/sweep/SweepStopped.js";
import { about, failedCount, settled } from "../../components/sweep/words.js";
import { openReadiness } from "../../settings/readiness.js";
import { type createWatchStore, watchStore } from "../../store/watch.js";
import { plainTitle } from "../../text.js";
import { selectTodayItems } from "./selectors.js";
import "./today.css";

type Item = ViewSnapshot["briefing"]["focus"][number];
type Content = NonNullable<Reading["content"]>;

function headline({ seen }: ViewSnapshot, interrupts: number): string {
  const count = seen.since.length;
  if (seen.cursor === null && !seen.at) {
    return `First look: ${interrupts} interruption${interrupts === 1 ? " needs" : "s need"} you.`;
  }
  const since = seen.at && !Number.isNaN(Date.parse(seen.at)) ? seen.at : "you last looked";
  if (count > 0) return `${count} new interruption${count === 1 ? "" : "s"} since ${since}.`;
  if (interrupts === 0) return `No new interruptions since ${since}.`;
  return `Nothing new since ${since} · ${interrupts} interruption${interrupts === 1 ? " still needs" : "s still need"} you.`;
}

function qualifier(snapshot: ViewSnapshot): string | undefined {
  const affected = sectionSources(snapshot, ["/briefing"])
    .filter(({ envelope }) => envelope.state === "failed" || envelope.state === "incomplete")
    .sort((a, b) => byWorst(a.envelope, b.envelope));
  const first = affected[0];
  if (!first) return undefined;
  const state = first.envelope.state === "failed" ? "read failed" : "incomplete";
  const more = affected.length - 1;
  return `${first.name} ${state}${more > 0 ? `, ${more} more source${more === 1 ? "" : "s"} affected` : ""}; items may be missing.`;
}

function tiles(facts: ViewSnapshot["briefing"]["facts"]): Content["tiles"] | undefined {
  const [environment, upstream, engineering] = facts;
  if (!environment || !upstream || !engineering) return undefined;
  const tile = (fact: typeof environment) => ({
    label: fact.label,
    value: fact.figure,
    counts: fact.sub.split(" · ")[0] ?? fact.sub,
  });
  const revision = /^Template · main (\S+)$/.exec(engineering.label)?.[1];
  const unread = engineering.sub.split(" · ").find((part) => part.endsWith("not read yet"));
  return [
    tile(environment),
    tile(upstream),
    revision
      ? {
          label: "Engineering system",
          value: engineering.figure,
          counts: `forks on ${revision}${unread ? ` · ${unread}` : ""}`,
        }
      : tile(engineering),
  ];
}

const SWEEP_UNSENT = "Could not send the request to SPI Code.";
const HAND_OVER_MS = 150;

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function stage(progress: SweepProgress | null): string {
  if (!progress) return "";
  if (progress.outcome === "failed") return "The first sweep stopped.";
  const failures = failedCount(progress);
  return `${settled(progress)} of ${progress.sources.length} sources done${failures > 0 ? `, ${failures} failed` : ""}.`;
}

function FirstSweepBody({
  progress,
  now,
  onOpenSettings,
  onRetry,
  error,
}: {
  progress: SweepProgress | null;
  now: number;
  onOpenSettings: () => void;
  onRetry?: () => void;
  error?: string | undefined;
}) {
  if (progress?.outcome === "failed") {
    return (
      <div className="today-first">
        <h2 className="today-first-lead">The first sweep stopped.</h2>
        <p className="today-first-sub">
          <SweepStopped progress={progress} now={now} />
        </p>
        <div className="today-first-actions">
          <button type="button" onClick={onRetry}>
            Try again
          </button>
          <button type="button" onClick={onOpenSettings}>
            Open Settings
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
        <SweepSources progress={progress} now={now} meta={false} onOpenSettings={onOpenSettings} />
      </div>
    );
  }
  return (
    <div className="today-first">
      <h2 className="today-first-lead">First sweep is reading the program.</h2>
      <p className="today-first-sub">
        {progress?.usualMs
          ? `Usually about ${about(progress.usualMs)}.`
          : "A first sweep takes a few minutes. Today opens here when it's done."}
      </p>
      {progress && <SweepSources progress={progress} now={now} onOpenSettings={onOpenSettings} />}
      <p className="today-first-foot">
        You can close this window. SPI Code tells you when Today is ready.
      </p>
    </div>
  );
}

function FirstSweep({
  progress,
  onOpenSettings,
  onRequestSweep,
}: {
  progress: SweepProgress | null;
  onOpenSettings: () => void;
  onRequestSweep: () => void | Promise<void>;
}) {
  const now = useNow(progress?.outcome === "running" ? 1000 : 30_000);
  const [error, setError] = useState<string>();
  const retry = () => {
    setError(undefined);
    Promise.resolve()
      .then(onRequestSweep)
      .catch(() => setError(SWEEP_UNSENT));
  };
  return (
    <section className="today" aria-label="Today">
      <header className="place-header pane-header">
        <h1 data-place>Today</h1>
      </header>
      <FirstSweepBody
        progress={progress}
        now={now}
        onOpenSettings={onOpenSettings}
        onRetry={retry}
        error={error}
      />
      <p className="visually-hidden" role="status">
        {stage(progress)}
      </p>
    </section>
  );
}

/** The list the brief replaced, held for one crossfade unless motion is reduced. */
function useHandOver(brief: boolean, progress: SweepProgress | null) {
  const was = useRef(brief);
  const last = useRef(progress);
  const [leaving, setLeaving] = useState<{ progress: SweepProgress | null; now: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    if (brief && !was.current && !reducedMotion()) {
      setLeaving({ progress: last.current, now: Date.now() });
    }
    was.current = brief;
    if (!brief) last.current = progress;
  }, [brief, progress]);
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setLeaving(null), HAND_OVER_MS + 50);
    return () => clearTimeout(timer);
  }, [leaving]);
  return [leaving, () => setLeaving(null)] as const;
}

export default function Today({
  store = watchStore,
  onNavigate = navigate,
  onOpenSettings = openReadiness,
}: {
  store?: ReturnType<typeof createWatchStore>;
  onNavigate?: Navigation["navigate"];
  onOpenSettings?: () => void;
}) {
  const snapshot = useStore(store, (state) => state.snapshot);
  const progress = useStore(store, (state) => state.progress);
  const requestSweep = useStore(store, (state) => state.requestSweep);
  const selectedId = useStore(store, (state) => state.selection?.id);
  const select = useStore(store, (state) => state.select);
  const measures = snapshot ? tiles(snapshot.body.briefing.facts) : undefined;
  const [leaving, settle] = useHandOver(Boolean(measures), progress);
  if (!snapshot || !measures) {
    return (
      <FirstSweep
        progress={progress}
        onOpenSettings={onOpenSettings}
        onRequestSweep={requestSweep}
      />
    );
  }
  const body = snapshot.body;
  const brief = body.briefing;
  const services = treeServices(body.tree);
  const { focus, folded, interrupts } = selectTodayItems(brief);
  const groups = ["Before next sync", "Owned", "New"];
  const groupOf = (item: Item) => (item.owned ? "Owned" : item.due ? "Before next sync" : "New");
  const items = groups.flatMap((group) =>
    focus
      .filter((item) => groupOf(item) === group)
      .map((item) => ({
        ...item,
        title: plainTitle(item.title).replace(/^Next sync /, ""),
        scope: item.id === "rollout" ? "osdu-spi" : item.scope,
        sub: "",
        next: "",
        due: undefined,
        group,
      })),
  );
  const releases = body.readings.find(({ anchor }) => anchor.kind === "releases")?.content;
  const failing = releases?.tiles.find(({ label }) => label === "Failing")?.value;
  const ready = brief.ready
    .map((entry) => `${entry.text}${entry.id === "releases" ? " open" : ""}`)
    .join(", ");
  const foldedLine = [
    folded.length > 0 ? `${folded.length} more` : undefined,
    ready
      ? `${ready}${failing !== undefined ? `, ${failing.toLowerCase()} failing` : ""}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const qualification = qualifier(body);
  return (
    <section className={leaving ? "today today-handover" : "today"} aria-label="Today">
      <Place
        name="Today"
        reading={{
          anchor: { kind: "program" },
          content: {
            headline: headline(body, interrupts),
            ...(qualification ? { qualifier: qualification } : {}),
            tiles: measures,
            items,
            folded: null,
          },
        }}
        services={services}
        onNavigate={onNavigate}
        onSelect={select}
        {...(selectedId ? { selectedId } : {})}
      />
      {foldedLine && (
        <details className="place-folded today-folded">
          <summary>{foldedLine}</summary>
          <ul>
            {folded.map((item) => {
              const route = scopeRoute(item.scope, services);
              return (
                <li key={item.id}>
                  <span className="place-rank" data-rung={item.rung}>
                    P{item.rung}
                  </span>{" "}
                  {route ? (
                    <button type="button" className="place-scope" onClick={() => onNavigate(route)}>
                      {item.scope}
                    </button>
                  ) : (
                    <span className="place-scope" data-aggregate>
                      {item.scope}
                    </span>
                  )}{" "}
                  <button
                    type="button"
                    data-selection-id={item.id}
                    aria-pressed={selectedId === item.id}
                    onClick={() => select(item.id)}
                  >
                    {plainTitle(item.title)}
                  </button>
                  <p>{plainTitle(item.sub)}</p>
                </li>
              );
            })}
            {brief.ready.map((entry) => (
              <li key={entry.id}>
                <button type="button" data-selection-id={entry.id} onClick={() => select(entry.id)}>
                  {entry.text}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {leaving && (
        <div className="today-leaving" aria-hidden="true" inert onAnimationEnd={settle}>
          <FirstSweepBody
            progress={leaving.progress}
            now={leaving.now}
            onOpenSettings={onOpenSettings}
          />
        </div>
      )}
    </section>
  );
}
