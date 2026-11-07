// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Reading, SweepStatus, ViewSnapshot } from "@spi-code/contracts";
import { useStore } from "zustand";
import { type Navigation, navigate } from "../../app/navigation.js";
import { scopeRoute, treeServices } from "../../app/queue.js";
import { sectionSources } from "../../components/evidence/SectionEvidence.js";
import { byWorst } from "../../components/evidence/words.js";
import { Place } from "../../components/place/Place.js";
import { type createWatchStore, watchStore } from "../../store/watch.js";
import { plainTitle } from "../../text.js";
import "./today.css";

type Item = ViewSnapshot["briefing"]["focus"][number];
type Content = NonNullable<Reading["content"]>;

function headline({ seen, briefing }: ViewSnapshot): string {
  const count = seen.since.length;
  if (seen.cursor === null && !seen.at) {
    const interrupts = [...briefing.focus, ...briefing.rest].filter(
      ({ attention }) => attention === "interrupt",
    ).length;
    return `First look: ${interrupts} interruption${interrupts === 1 ? " needs" : "s need"} you.`;
  }
  const since = seen.at
    ? new Date(seen.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : "you last looked";
  return `${count === 0 ? "No" : count} new interruption${count === 1 ? "" : "s"} since ${since}.`;
}

function qualifier(snapshot: ViewSnapshot): string | undefined {
  const affected = sectionSources(snapshot, ["/briefing"])
    .filter(({ envelope }) => envelope.state === "failed" || envelope.state === "incomplete")
    .sort((a, b) => byWorst(a.envelope, b.envelope));
  const first = affected[0];
  if (!first) return undefined;
  const state = first.envelope.state === "failed" ? "read failed" : "incomplete";
  return `${first.name} ${state}${affected.length > 1 ? `, ${affected.length - 1} more sources affected` : ""}; items may be missing.`;
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
  return [
    tile(environment),
    tile(upstream),
    revision
      ? { label: "Engineering system", value: engineering.figure, counts: `forks on ${revision}` }
      : tile(engineering),
  ];
}

function FirstSweep({ sweep }: { sweep: SweepStatus | null }) {
  return (
    <section className="today" aria-label="Today">
      <h1>Today</h1>
      <p role="status">First sweep running</p>
      {sweep && (
        <dl className="today-sweep">
          <div>
            <dt>remaining</dt>
            <dd>{sweep.remaining === null ? "unknown" : `${sweep.remaining} API calls`}</dd>
          </div>
          <div>
            <dt>floor</dt>
            <dd>{sweep.floor === undefined ? "none" : `${sweep.floor} API calls`}</dd>
          </div>
          <div>
            <dt>resetAt</dt>
            <dd>
              {sweep.resetAt === null ? (
                "unknown"
              ) : (
                <time dateTime={sweep.resetAt}>{new Date(sweep.resetAt).toLocaleTimeString()}</time>
              )}
            </dd>
          </div>
          <div>
            <dt>deferredAreas</dt>
            <dd>
              {sweep.deferredAreas.length === 0 ? (
                "none"
              ) : (
                <ul>
                  {sweep.deferredAreas.map(({ area, reason }) => (
                    <li key={area}>
                      {area}: {reason}
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}

export default function Today({
  store = watchStore,
  onNavigate = navigate,
}: {
  store?: ReturnType<typeof createWatchStore>;
  onNavigate?: Navigation["navigate"];
}) {
  const snapshot = useStore(store, (state) => state.snapshot);
  const sweep = useStore(store, (state) => state.sweep);
  const selectedId = useStore(store, (state) => state.selection?.id);
  const select = useStore(store, (state) => state.select);
  if (!snapshot) return <FirstSweep sweep={sweep} />;
  const body = snapshot.body;
  const brief = body.briefing;
  const measures = tiles(brief.facts);
  if (!measures) return <FirstSweep sweep={sweep} />;
  const services = treeServices(body.tree);
  const focus = brief.focus
    .filter(({ attention, owned }) => attention !== "ambient" || owned)
    .slice(0, 5);
  const ids = new Set(focus.map(({ id }) => id));
  const folded = [...brief.focus, ...brief.rest].filter(({ id }) => !ids.has(id));
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
    ready ? `${ready}${failing !== undefined ? `, ${failing} failing` : ""}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const qualification = qualifier(body);
  return (
    <section className="today" aria-label="Today">
      <Place
        name="Today"
        reading={{
          anchor: { kind: "program" },
          content: {
            headline: headline(body),
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
    </section>
  );
}
