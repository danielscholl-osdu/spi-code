// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { RepoLine, ViewSnapshot } from "@spi-code/contracts";
import { type ReactNode, useId } from "react";
import { useStore } from "zustand";
import { navigate } from "../../app/routes.js";
import { SectionEvidence } from "../../components/evidence/SectionEvidence.js";
import { inScope } from "../../components/sidebar/attention.js";
import { Stations } from "../../components/stations/index.js";
import { type SelectionStore, selectionStore } from "../../panels/selection.js";
import { type SelectionRow, selectionRows } from "../../panels/selection-rows.js";
import { useSelectionList } from "../../panels/useSelectionList.js";
import { type createWatchStore, watchStore } from "../../store/watch.js";
import { treeServices } from "../inbox/queue.js";
import "../repositories/panes.css";
import "./service.css";

type WatchStore = ReturnType<typeof createWatchStore>;

const THREADS_UNAVAILABLE = "Threads are not available yet.";
const LINE_LABELS = ["Sync PR", "Cascade", "Sync to main", "Main run"];

const openExternal = (url: string | undefined) => {
  if (url) void window.spi?.openExternal(url);
};

const resultTone = (result: string) =>
  result === "success" ? "ok" : result === "failure" || result === "timed_out" ? "bad" : undefined;

const utc = (time: string) => `${time.slice(0, 16).replace("T", " ")} UTC`;

type IdLine = RepoLine & { id: string };

function lineRow(line: IdLine): SelectionRow {
  return {
    id: line.id,
    title: line.text,
    kind: "repository-line",
    fields: [
      { label: "Tag", value: line.tag },
      { label: "Reading", value: line.sub },
      ...(line.url ? [{ label: "Link", value: line.url }] : []),
    ],
  };
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
    <section className="service-section" data-section={name} aria-labelledby={heading}>
      <div className="service-section-header">
        <h2 id={heading}>{title}</h2>
        {count !== undefined && <span className="service-section-count">{count}</span>}
      </div>
      {prefixes.length > 0 && <SectionEvidence evidence={evidence} prefixes={prefixes} />}
      {children}
    </section>
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

function LineBody({ line }: { line: RepoLine }) {
  return (
    <>
      <span className="service-tag" data-tone={line.tone}>
        {line.tag}
      </span>
      <span className="service-row-body" data-upstream={line.upstream || undefined}>
        <span className="service-row-title">{line.text}</span>
        <span className="service-row-sub">{line.sub}</span>
      </span>
    </>
  );
}

function Toolbar({
  id,
  sub,
  fallback,
  store,
}: {
  id: string;
  sub: string | undefined;
  fallback: SelectionRow | undefined;
  store: SelectionStore;
}) {
  const reason = useId();
  const showDetail = () => {
    const state = store.getState();
    if (state.selected === null && fallback) state.select(fallback.id, fallback);
    state.setOpen(true);
    state.setTab("detail");
  };
  return (
    <div className="service-tool">
      <h1>{id}</h1>
      {sub && <span className="service-tool-sub">{sub}</span>}
      <span className="service-tool-actions">
        <button type="button" onClick={showDetail}>
          Detail
        </button>
        {["Ask", "Add to chat", "+ Thread"].map((label) => (
          <button key={label} type="button" disabled aria-describedby={reason}>
            {label}
          </button>
        ))}
        <span id={reason} className="service-tool-reason">
          {THREADS_UNAVAILABLE}
        </span>
      </span>
    </div>
  );
}

/** One service line's page (PS-05): the six stations, then its sections in a fixed order. */
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
  if (!evidence) {
    return (
      <section className="service-page" data-view-pane="service" aria-label={id}>
        <h1>{id}</h1>
        <p role="status">No sweep has read {id} yet.</p>
      </section>
    );
  }
  return <ServiceBody id={id} evidence={evidence} selection={selection} />;
}

function ServiceBody({
  id,
  evidence,
  selection,
}: {
  id: string;
  evidence: ViewSnapshot;
  selection: SelectionStore;
}) {
  const { briefing } = evidence;
  const rows = selectionRows(evidence);
  const services = treeServices(evidence.tree);

  const stationIndex = evidence.stations.findIndex(({ service }) => service === id);
  const stations = evidence.stations[stationIndex];
  const stationRows = rows.filter(
    (row) => row.kind === "station" && row.id.startsWith(`station:${id}:`),
  );
  const stationList = useSelectionList(stationRows, undefined, selection);

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
  const runRows = runs.map(
    (run): SelectionRow => ({
      id: run.id,
      title: `${run.workflow} · ${run.result}`,
      kind: "run",
      prefixes: [`/services/${serviceIndex}/runs`],
      fields: [
        { label: "Workflow", value: run.workflow },
        { label: "Result", value: run.result },
        { label: "When", value: utc(run.time) },
        { label: "Link", value: run.url },
      ],
    }),
  );

  return (
    <section className="service-page watch-pane" data-view-pane="service" aria-label={id}>
      <Toolbar id={id} sub={attention[0]?.item.title} fallback={flowRow} store={selection} />

      <div className="service-stations-strip" data-section="stations">
        {stations ? (
          <Stations
            services={[stations]}
            evidence={evidence}
            from={stationIndex}
            named={false}
            tileProps={(_, station) => {
              const row = stationRows.find((row) => row.id === `station:${id}:${station.id}`);
              return row ? stationList.rowProps(row) : {};
            }}
          />
        ) : (
          <p className="service-empty">No stations were read for {id}.</p>
        )}
      </div>

      <Section
        name="attention"
        title="Attention"
        count={attention.length}
        evidence={evidence}
        prefixes={attention.flatMap(({ row }) => row.prefixes ?? [])}
      >
        {attention.length === 0 ? (
          <p className="service-empty">Nothing in the queue names {id}.</p>
        ) : (
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
                        {item.title}
                        <span className="service-class">{item.cls}</span>
                      </span>
                      <span className="service-row-sub">{item.sub}</span>
                    </span>
                  </>
                )
              );
            }}
          />
        )}
      </Section>

      <Section name="threads" title="Threads" evidence={evidence} prefixes={[]}>
        <p className="service-empty">{THREADS_UNAVAILABLE}</p>
      </Section>

      <Section
        name="upstream"
        title="Upstream sync"
        count={flow && <span data-tone={flow.ready.tone}>{flow.ready.text}</span>}
        evidence={evidence}
        prefixes={flow ? [`/briefing/flow/rows/${flowIndex}`] : []}
      >
        {flow && flowRow ? (
          <SelectList
            label={`${id} upstream sync`}
            rows={[flowRow]}
            store={selection}
            render={() => (
              <dl className="service-kv" data-pointer={`/briefing/flow/rows/${flowIndex}`}>
                <dt>Behind</dt>
                <dd>{flow.behind}</dd>
                <dt>Carries</dt>
                <dd>{flow.carries}</dd>
                <dt>Plan</dt>
                <dd data-tone={flow.plan.tone}>{flow.plan.text}</dd>
                <dt>Line</dt>
                <dd className="service-line">
                  {flow.line.map((cell, index) => (
                    <span key={LINE_LABELS[index]} data-tone={cell.tone}>
                      {LINE_LABELS[index]}
                      {cell.text === "·" ? "" : ` ${cell.text}`}
                    </span>
                  ))}
                </dd>
                <dt>Next</dt>
                <dd data-tone={flow.next.tone}>
                  {flow.next.strong ? <strong>{flow.next.text}</strong> : flow.next.text}
                </dd>
                {flow.detail.lines.length > 0 && (
                  <>
                    <dt>Detail</dt>
                    <dd>
                      {flow.detail.lines.map((line) => (
                        <span key={line} className="service-detail-line">
                          {line}
                        </span>
                      ))}
                    </dd>
                  </>
                )}
              </dl>
            )}
          />
        ) : (
          <p className="service-empty">The flow has no row for {id}.</p>
        )}
      </Section>

      <Section
        name="repository"
        title="Repository"
        count={repo && <span data-tone={repo.tone}>{repo.title}</span>}
        evidence={evidence}
        prefixes={repo ? [`/briefing/repositories/rows/${repoIndex}`] : []}
      >
        {repo ? (
          <>
            {repoRow && (
              <SelectList
                label={`${id} repository`}
                rows={[repoRow]}
                store={selection}
                render={() => <span className="service-row-sub">{repo.sub}</span>}
              />
            )}
            {repo.sections.map((section) => {
              const selectable = section.lines.filter((line): line is IdLine => Boolean(line.id));
              const plain = section.lines.filter((line) => !line.id);
              return (
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
                  {selectable.length > 0 && (
                    <SelectList
                      label={`${id} ${section.title}`}
                      rows={selectable.map(lineRow)}
                      open={(row) => openExternal(selectable.find((l) => l.id === row.id)?.url)}
                      store={selection}
                      render={(row) => {
                        const line = selectable.find((l) => l.id === row.id);
                        return line && <LineBody line={line} />;
                      }}
                    />
                  )}
                  {plain.length > 0 && (
                    <ul className="service-rows">
                      {plain.map((line) => (
                        <li key={`${line.tag}:${line.text}`} className="service-row" data-plain="">
                          <LineBody line={line} />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
            {repo.note && <p className="service-empty">{repo.note}</p>}
          </>
        ) : (
          <p className="service-empty">No repository was read for {id}.</p>
        )}
      </Section>

      {evidence.services !== undefined && (
        <Section
          name="release"
          title="Release"
          count={service?.releases.length ?? 0}
          evidence={evidence}
          prefixes={service ? [`/services/${serviceIndex}/releases`] : []}
        >
          {service && service.releases.length > 0 ? (
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
                          gate {release.gate.state} · {release.gate.text}
                        </span>
                      )}
                      {release.releasePr && (
                        <a
                          href={release.releasePr.url}
                          onClick={(event) => {
                            event.preventDefault();
                            openExternal(release.releasePr?.url);
                          }}
                        >
                          PR #{release.releasePr.number} {release.releasePr.title}
                        </a>
                      )}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="service-empty">No release rows were read for {id}.</p>
          )}
        </Section>
      )}

      {evidence.services !== undefined && (
        <Section
          name="runs"
          title="Runs"
          count={runRows.length}
          evidence={evidence}
          prefixes={service ? [`/services/${serviceIndex}/runs`] : []}
        >
          {runRows.length > 0 ? (
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
                      <time dateTime={run.time}>{utc(run.time)}</time>
                    </>
                  )
                );
              }}
            />
          ) : (
            <p className="service-empty">No runs were read for {id}.</p>
          )}
        </Section>
      )}
    </section>
  );
}
