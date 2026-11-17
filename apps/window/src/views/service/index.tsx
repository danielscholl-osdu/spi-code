// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { FocusItem, RepoLine, ViewSnapshot } from "@spi-code/contracts";
import { type ReactNode, useId, useRef } from "react";
import { useStore } from "zustand";
import { navigate, type OpenSelection } from "../../app/navigation.js";
import { treeServices } from "../../app/queue.js";
import { SectionEvidence } from "../../components/evidence/SectionEvidence.js";
import { PopoverFields, usePlaceOpening } from "../../components/place/opening.js";
import { Place } from "../../components/place/Place.js";
import { RepositoryFacts } from "../../components/place/RepositoryFacts.js";
import { RepositoryLine } from "../../components/place/RepositoryLine.js";
import { Popover } from "../../components/popover/Popover.js";
import { inScope } from "../../components/sidebar/attention.js";
import { type createWatchStore, watchStore } from "../../store/watch.js";
import { plainTitle } from "../../text.js";
import { Time, TimedText } from "../../time.js";
import { columns } from "../line/cells.js";
import { lineItem, todayItems } from "../template/Repositories.js";
import { serviceOpening } from "./opening.js";
import "../releases/panes.css";
import "./service.css";

type WatchStore = ReturnType<typeof createWatchStore>;

const STATION_LABELS = {
  upstream: "Upstream",
  sync: "Sync PR",
  cascade: "Cascade",
  main: "Main",
  release: "Release review",
  lane: "Lane context",
};

const openExternal = (url: string | undefined) => {
  if (url) void window.spi?.openExternal(url);
};

const resultTone = (result: string) =>
  result === "success" ? "ok" : result === "failure" || result === "timed_out" ? "bad" : undefined;

type ServiceRelease = NonNullable<ViewSnapshot["services"]>[number]["releases"][number];

function GateHint({ release: { gate, to, readTimes } }: { release: ServiceRelease }) {
  if (gate?.state !== "idle" || to === undefined || gate.text === to) return null;
  return (
    <span data-gate-hint="">
      The gate and this row can differ because they use separate reads: the GitHub read
      {readTimes?.github && (
        <>
          {" "}
          at <Time at={readTimes.github} />
        </>
      )}{" "}
      for the gate and the release history read
      {readTimes?.history && (
        <>
          {" "}
          at <Time at={readTimes.history} />
        </>
      )}{" "}
      for this row.
    </span>
  );
}

function Section({
  name,
  title,
  count,
  evidence,
  prefixes,
  children,
}: {
  name: string;
  title: string;
  count?: ReactNode;
  evidence: ViewSnapshot;
  prefixes: readonly string[];
  children: ReactNode;
}) {
  const heading = useId();
  return (
    <details className="service-details" data-section={name} open={name === "attention"}>
      <summary id={heading} className="service-section-header">
        <span aria-hidden className="section-header-chevron" />
        <span className="service-section-label">{title}</span>
        {count !== undefined && <span className="service-section-count">{count}</span>}
      </summary>
      <section className="service-section" aria-labelledby={heading}>
        {prefixes.length > 0 && <SectionEvidence evidence={evidence} prefixes={prefixes} />}
        {children}
      </section>
    </details>
  );
}

type Opener = ReturnType<typeof usePlaceOpening>["opener"];

/** Rows that each open their popover. */
function OpenList({
  label,
  rows,
  opener,
}: {
  label: string;
  rows: readonly { key: string; selection: OpenSelection; body: ReactNode }[];
  opener: Opener;
}) {
  return (
    <ul className="service-rows" aria-label={label}>
      {rows.map(({ key, selection, body }) => (
        <li key={key}>
          <button
            type="button"
            className="service-row"
            data-selection-id={selection.id}
            {...opener(selection)}
          >
            {body}
          </button>
        </li>
      ))}
    </ul>
  );
}

function RepoLines({
  service,
  section,
  lines,
  pointer,
  items,
  snapshot,
}: {
  service: string;
  section: string;
  lines: readonly RepoLine[];
  pointer: string;
  items: readonly FocusItem[];
  snapshot: ViewSnapshot;
}) {
  return (
    <ul className="service-rows" aria-label={`${service} ${section}`}>
      {lines.map((line, index) => (
        <li key={line.id ?? `${line.tag}:${line.text}`}>
          <RepositoryLine
            repository={service}
            section={section}
            line={line}
            pointer={`${pointer}/lines/${index}`}
            snapshot={snapshot}
            className="service-row"
            place={{
              label: `${service} › Repository › ${section}`,
              destination: { kind: "service", id: service },
            }}
          >
            <LineBody line={line} item={lineItem(line, items)} />
          </RepositoryLine>
        </li>
      ))}
    </ul>
  );
}

function LineBody({ line, item }: { line: RepoLine; item: FocusItem | undefined }) {
  return (
    <>
      <span className="service-tag" data-tone={line.tone}>
        {line.tag}
      </span>
      <span className="service-row-body" data-upstream={line.upstream || undefined}>
        <span className="service-row-title">{plainTitle(line.text)}</span>
        <span className="service-row-sub">{plainTitle(line.sub)}</span>
      </span>
      {item && <span className="service-on-today">On Today · {plainTitle(item.title)}</span>}
    </>
  );
}

export default function ServicePage({
  id,
  store = watchStore,
}: {
  id: string;
  store?: WatchStore;
}) {
  const evidence = useStore(store, (state) => state.snapshot?.body);
  if (!evidence) {
    return (
      <section className="service-page" data-view-pane="service" aria-label={id}>
        <Place
          name={id}
          reading={{ anchor: { kind: "service", id }, content: null }}
          onNavigate={navigate}
          pin={id}
        />
      </section>
    );
  }
  return <ServiceBody key={id} id={id} evidence={evidence} />;
}

/** A station opens its Line cell; the release review, which the Line has no column for, its own. */
const stationSelection = (service: string, station: string): OpenSelection =>
  columns.some((column) => column.id === station)
    ? { kind: "cell", id: `${service}:${station}` }
    : { kind: "station", id: `${service}:${station}` };

function ServiceBody({ id, evidence }: { id: string; evidence: ViewSnapshot }) {
  const { briefing } = evidence;
  const services = treeServices(evidence.tree);
  const reading = evidence.readings.find(
    ({ anchor }) => anchor.kind === "service" && anchor.id === id,
  );
  const page = useRef<HTMLElement>(null);
  const { marked, anchor, opener, openItem, close } = usePlaceOpening(page, evidence);
  const opening = serviceOpening(evidence, id, marked);

  const attention = [...briefing.focus, ...briefing.rest]
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => inScope(item, `service:${id}`, services))
    .sort((a, b) => a.item.rung - b.item.rung || a.index - b.index);

  const flowIndex = briefing.flow.rows.findIndex(({ fork }) => fork === id);
  const flow = briefing.flow.rows[flowIndex];

  const repoIndex = briefing.repositories.rows.findIndex((row) => row.id === `repo:${id}`);
  const repo = briefing.repositories.rows[repoIndex];
  const repoPointer = `/briefing/repositories/rows/${repoIndex}`;

  const serviceIndex = evidence.services?.findIndex(({ service }) => service === id) ?? -1;
  const service = evidence.services?.[serviceIndex];
  const runs = [...(service?.runs ?? [])].sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  const stations = evidence.stations.find(({ service }) => service === id)?.stations ?? [];
  const attentionPointers = attention.map(({ item }) => {
    const at = briefing.focus.indexOf(item);
    return at >= 0 ? `/briefing/focus/${at}` : `/briefing/rest/${briefing.rest.indexOf(item)}`;
  });

  return (
    <section
      className="service-page watch-pane"
      data-view-pane="service"
      aria-label={id}
      ref={page}
    >
      <Place
        name={id}
        reading={reading ?? { anchor: { kind: "service", id }, content: null }}
        services={services}
        onNavigate={navigate}
        pin={id}
        onSelect={openItem}
        actions={
          flow && (
            <button
              type="button"
              data-service-detail="upstream"
              {...opener({ kind: "flow", id: flow.inspect })}
            >
              Upstream sync · {flow.ready.text}
            </button>
          )
        }
      />
      {stations.length > 0 && (
        <nav className="service-station-actions" aria-label={`${id} station details`}>
          {stations.map((station) => (
            <button
              key={station.id}
              type="button"
              data-station={station.id}
              {...opener(stationSelection(id, station.id))}
            >
              {STATION_LABELS[station.id]}
            </button>
          ))}
        </nav>
      )}
      {attention.length > 0 && (
        <Section
          name="attention"
          title="Attention"
          count={attention.length}
          evidence={evidence}
          prefixes={attentionPointers}
        >
          <OpenList
            label={`${id} attention`}
            opener={opener}
            rows={attention.map(({ item }) => ({
              key: item.id,
              selection: { kind: "item", id: item.id },
              body: (
                <>
                  <span className="service-priority" data-rung={item.rung}>
                    P{item.rung}
                  </span>
                  <span className="service-row-body">
                    <span className="service-row-title">
                      <TimedText text={plainTitle(item.title)} hint={false} />
                      <span className="service-class">{item.cls}</span>
                    </span>
                    <span className="service-row-sub">
                      <TimedText text={plainTitle(item.sub)} hint={false} />
                    </span>
                  </span>
                </>
              ),
            }))}
          />
        </Section>
      )}

      {repo && (
        <Section
          name="repository"
          title="Repository"
          count={<span data-tone={repo.tone}>{plainTitle(repo.title)}</span>}
          evidence={evidence}
          prefixes={[repoPointer]}
        >
          <RepositoryFacts repository={repo} pointer={repoPointer} />
          <OpenList
            label={`${id} repository`}
            opener={opener}
            rows={[
              {
                key: repo.id,
                selection: { kind: "item", id: repo.id },
                body: <span className="service-row-sub">{plainTitle(repo.sub)}</span>,
              },
            ]}
          />
          {repo.sections.map(
            (section, sectionIndex) =>
              section.lines.length > 0 && (
                <div
                  key={section.title}
                  className="service-repo-section"
                  data-weight={section.weight}
                >
                  <div className="repo-section-title">
                    <span>{section.title}</span>
                    <span>
                      {section.count}
                      {section.rest}
                    </span>
                  </div>
                  <RepoLines
                    service={id}
                    section={section.title}
                    lines={section.lines}
                    pointer={`${repoPointer}/sections/${sectionIndex}`}
                    items={todayItems(evidence)}
                    snapshot={evidence}
                  />
                </div>
              ),
          )}
          {repo.note && <p className="service-empty">{repo.note}</p>}
        </Section>
      )}

      {service && service.releases.length > 0 && (
        <Section
          name="release"
          title="Release"
          count={service.releases.length}
          evidence={evidence}
          prefixes={[`/services/${serviceIndex}/releases`]}
        >
          <ul className="service-rows">
            {service.releases.map((release) => (
              <li key={release.month} className="service-row" data-release={release.month}>
                <button
                  type="button"
                  className="service-month"
                  onClick={() => navigate({ kind: "release", month: release.month })}
                >
                  {release.month}
                </button>
                <span className="service-row-body">
                  <span className="service-row-title">
                    {release.version}
                    <span className="service-class">{release.state}</span>
                  </span>
                  <span className="service-row-sub">
                    {release.gate && (
                      <span data-gate={release.gate.state}>
                        release review {release.gate.state} · {release.gate.text}
                      </span>
                    )}
                    <GateHint release={release} />
                    {release.releasePr && (
                      <a
                        href={release.releasePr.url}
                        onClick={(event) => {
                          event.preventDefault();
                          openExternal(release.releasePr?.url);
                        }}
                      >
                        PR #{release.releasePr.number} {plainTitle(release.releasePr.title)}
                      </a>
                    )}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {runs.length > 0 && (
        <Section
          name="runs"
          title="Runs"
          count={runs.length}
          evidence={evidence}
          prefixes={service ? [`/services/${serviceIndex}/runs`] : []}
        >
          <OpenList
            label={`${id} runs`}
            opener={opener}
            rows={runs.map((run) => ({
              key: run.id,
              selection: { kind: "run", id: run.id },
              body: (
                <>
                  <span className="service-row-title">{run.workflow}</span>
                  <span data-result={run.result} data-tone={resultTone(run.result)}>
                    {run.result}
                  </span>
                  <Time at={run.time} />
                </>
              ),
            }))}
          />
        </Section>
      )}
      {opening && marked && anchor && (
        <Popover anchor={anchor} selection={marked} content={opening.content} onClose={close}>
          <PopoverFields fields={opening.fields} />
        </Popover>
      )}
    </section>
  );
}
