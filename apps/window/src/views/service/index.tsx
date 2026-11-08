// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { RepoLine, ViewSnapshot } from "@spi-code/contracts";
import { type ReactNode, useId } from "react";
import { useStore } from "zustand";
import { navigate } from "../../app/navigation.js";
import { treeServices } from "../../app/queue.js";
import { SectionEvidence } from "../../components/evidence/SectionEvidence.js";
import { Place } from "../../components/place/Place.js";
import { RepositoryFacts } from "../../components/place/RepositoryFacts.js";
import { inScope } from "../../components/sidebar/attention.js";
import { type SelectionStore, selectionStore } from "../../panels/selection.js";
import {
  repositoryLineRow,
  runRow,
  type SelectionRow,
  selectionRows,
} from "../../panels/selection-rows.js";
import { useSelectionList } from "../../panels/useSelectionList.js";
import { togglePin, usePins } from "../../store/pins.js";
import { type createWatchStore, watchStore } from "../../store/watch.js";
import { plainTitle } from "../../text.js";
import { Time } from "../../time.js";
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
    <details className="service-details" data-section={name}>
      <summary id={heading}>
        {title}
        {count !== undefined && <span className="service-section-count">{count}</span>}
      </summary>
      <section className="service-section" aria-labelledby={heading}>
        {prefixes.length > 0 && <SectionEvidence evidence={evidence} prefixes={prefixes} />}
        {children}
      </section>
    </details>
  );
}

function SelectList({
  label,
  rows,
  open,
  store,
  render,
}: {
  label: string;
  rows: readonly SelectionRow[];
  open?: (row: SelectionRow) => void;
  store: SelectionStore;
  render(row: SelectionRow): ReactNode;
}) {
  const list = useSelectionList(rows, open, store);
  return (
    <div className="service-rows" role="listbox" aria-label={label} data-selection-list="">
      {rows.map((row) => {
        const { tabIndex, ...props } = list.rowProps(row);
        return (
          <div key={row.id} className="service-row" role="option" tabIndex={tabIndex} {...props}>
            {render(row)}
          </div>
        );
      })}
    </div>
  );
}

function RepoLines({
  label,
  lines,
  repoIndex,
  sectionIndex,
  store,
}: {
  label: string;
  lines: readonly RepoLine[];
  repoIndex: number;
  sectionIndex: number;
  store: SelectionStore;
}) {
  const lineRows = lines.map((line, index) =>
    repositoryLineRow(line, repoIndex, sectionIndex, index),
  );
  const rows = lineRows.filter((row): row is SelectionRow => row !== undefined);
  const list = useSelectionList(
    rows,
    (row) => openExternal(lines.find((line) => line.id === row.id)?.url),
    store,
  );
  if (rows.length === 0) {
    return (
      <ul className="service-rows">
        {lines.map((line) => (
          <li key={`${line.tag}:${line.text}`} className="service-row" data-plain="">
            <LineBody line={line} />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="service-rows" role="listbox" aria-label={label} data-selection-list="">
      {lines.map((line, index) => {
        const row = lineRows[index];
        if (!row) {
          return (
            <div
              key={`${line.tag}:${line.text}`}
              className="service-row"
              role="option"
              aria-selected={false}
              aria-disabled="true"
              tabIndex={-1}
              data-plain=""
            >
              <LineBody line={line} />
            </div>
          );
        }
        const { tabIndex, ...props } = list.rowProps(row);
        return (
          <div key={row.id} className="service-row" role="option" tabIndex={tabIndex} {...props}>
            <LineBody line={line} />
          </div>
        );
      })}
    </div>
  );
}

function LineBody({ line }: { line: RepoLine }) {
  return (
    <>
      <span className="service-tag" data-tone={line.tone}>
        {line.tag}
      </span>
      <span className="service-row-body" data-upstream={line.upstream || undefined}>
        <span className="service-row-title">{plainTitle(line.text)}</span>
        <span className="service-row-sub">{plainTitle(line.sub)}</span>
      </span>
    </>
  );
}

export default function ServicePage({
  id,
  store = watchStore,
  selection = selectionStore,
}: {
  id: string;
  store?: WatchStore;
  selection?: SelectionStore;
}) {
  const evidence = useStore(store, (state) => state.snapshot?.body);
  const pinned = usePins().includes(id);
  if (!evidence) {
    return (
      <section className="service-page" data-view-pane="service" aria-label={id}>
        <Place
          name={id}
          reading={{ anchor: { kind: "service", id }, content: null }}
          onNavigate={navigate}
          onPin={() => togglePin(id)}
          pinned={pinned}
        />
      </section>
    );
  }
  return <ServiceBody id={id} evidence={evidence} selection={selection} pinned={pinned} />;
}

function ServiceBody({
  id,
  evidence,
  selection,
  pinned,
}: {
  id: string;
  evidence: ViewSnapshot;
  selection: SelectionStore;
  pinned: boolean;
}) {
  const { briefing } = evidence;
  const rows = selectionRows(evidence);
  const services = treeServices(evidence.tree);
  const reading = evidence.readings.find(
    ({ anchor }) => anchor.kind === "service" && anchor.id === id,
  );
  const selected = useStore(selection, (state) => state.selected);
  const select = (row: SelectionRow) => {
    selection.getState().select(row.id, row);
    selection.getState().setTab("detail");
  };
  const stationRows = rows.filter(
    (row) => row.kind === "station" && row.id.startsWith(`station:${id}:`),
  );

  const attention = [...briefing.focus, ...briefing.rest]
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => inScope(item, `service:${id}`, services))
    .sort((a, b) => a.item.rung - b.item.rung || a.index - b.index)
    .flatMap(({ item }) => {
      const row = rows.find((row) => row.kind === "queue" && row.id === item.id);
      return row ? [{ item, row }] : [];
    });

  const flowIndex = briefing.flow.rows.findIndex(({ fork }) => fork === id);
  const flow = briefing.flow.rows[flowIndex];
  const flowRow = flow && rows.find((row) => row.kind === "flow" && row.id === flow.inspect);

  const repoIndex = briefing.repositories.rows.findIndex((row) => row.id === `repo:${id}`);
  const repo = briefing.repositories.rows[repoIndex];
  const repoRow = repo && rows.find((row) => row.kind === "repository" && row.id === repo.id);

  const serviceIndex = evidence.services?.findIndex(({ service }) => service === id) ?? -1;
  const service = evidence.services?.[serviceIndex];
  const runs = [...(service?.runs ?? [])].sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  const runRows = runs.map((run) => runRow(run, serviceIndex));

  return (
    <section className="service-page watch-pane" data-view-pane="service" aria-label={id}>
      <Place
        name={id}
        reading={reading ?? { anchor: { kind: "service", id }, content: null }}
        services={services}
        onNavigate={navigate}
        onPin={() => togglePin(id)}
        pinned={pinned}
        onSelect={(itemId) => {
          const row = rows.find((row) => row.id === itemId);
          if (row) select(row);
        }}
        {...(selected !== null ? { selectedId: selected } : {})}
        actions={
          flow &&
          flowRow && (
            <button type="button" data-service-detail="upstream" onClick={() => select(flowRow)}>
              Upstream sync · {flow.ready.text}
            </button>
          )
        }
      />
      {stationRows.length > 0 && (
        <nav className="service-station-actions" aria-label={`${id} station details`}>
          {evidence.stations
            .find(({ service }) => service === id)
            ?.stations.map((station) => {
              const row = stationRows.find((row) => row.id === `station:${id}:${station.id}`);
              return (
                row && (
                  <button
                    key={station.id}
                    type="button"
                    data-station={station.id}
                    data-selection-id={row.id}
                    aria-pressed={selected === row.id}
                    onClick={() => select(row)}
                  >
                    {STATION_LABELS[station.id]}
                  </button>
                )
              );
            })}
        </nav>
      )}
      {attention.length > 0 && (
        <Section
          name="attention"
          title="Attention"
          count={attention.length}
          evidence={evidence}
          prefixes={attention.flatMap(({ row }) => row.prefixes ?? [])}
        >
          <SelectList
            label={`${id} attention`}
            rows={attention.map(({ row }) => row)}
            store={selection}
            render={(row) => {
              const item = attention.find(({ item }) => item.id === row.id)?.item;
              return (
                item && (
                  <>
                    <span className="service-priority" data-rung={item.rung}>
                      P{item.rung}
                    </span>
                    <span className="service-row-body">
                      <span className="service-row-title">
                        {plainTitle(item.title)}
                        <span className="service-class">{item.cls}</span>
                      </span>
                      <span className="service-row-sub">{plainTitle(item.sub)}</span>
                    </span>
                  </>
                )
              );
            }}
          />
        </Section>
      )}

      {repo && (
        <Section
          name="repository"
          title="Repository"
          count={<span data-tone={repo.tone}>{plainTitle(repo.title)}</span>}
          evidence={evidence}
          prefixes={[`/briefing/repositories/rows/${repoIndex}`]}
        >
          <RepositoryFacts repository={repo} pointer={`/briefing/repositories/rows/${repoIndex}`} />
          {repoRow && (
            <SelectList
              label={`${id} repository`}
              rows={[repoRow]}
              store={selection}
              render={() => <span className="service-row-sub">{plainTitle(repo.sub)}</span>}
            />
          )}
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
                    label={`${id} ${section.title}`}
                    lines={section.lines}
                    repoIndex={repoIndex}
                    sectionIndex={sectionIndex}
                    store={selection}
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

      {runRows.length > 0 && (
        <Section
          name="runs"
          title="Runs"
          count={runRows.length}
          evidence={evidence}
          prefixes={service ? [`/services/${serviceIndex}/runs`] : []}
        >
          <SelectList
            label={`${id} runs`}
            rows={runRows}
            open={(row) => openExternal(runs.find((run) => run.id === row.id)?.url)}
            store={selection}
            render={(row) => {
              const run = runs.find((run) => run.id === row.id);
              return (
                run && (
                  <>
                    <span className="service-row-title">{run.workflow}</span>
                    <span data-result={run.result} data-tone={resultTone(run.result)}>
                      {run.result}
                    </span>
                    <Time at={run.time} />
                  </>
                )
              );
            }}
          />
        </Section>
      )}
    </section>
  );
}
