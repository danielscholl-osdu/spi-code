// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { UpRow, UpText } from "@spi-code/contracts";
import { useStore } from "zustand";
import { navigate } from "../../app/routes.js";
import { SectionEvidence } from "../../components/evidence/SectionEvidence.js";
import "../../components/stations/stations.css";
import { selectionStore } from "../../panels/selection.js";
import { selectionRows } from "../../panels/selection-rows.js";
import { watchStore } from "../../store/watch.js";
import { blankCell, type LensColumn, LensTable } from "../lenses/table.js";

const words = (cell: UpText) => <span data-tone={cell.tone}>{blankCell(cell.text)}</span>;
const columns: LensColumn<UpRow>[] = [
  {
    label: "Fork",
    value: (row) => row.fork,
    render: (row) => (
      <>
        {row.fork}
        {row.tag && <small>{blankCell(row.tag)}</small>}
      </>
    ),
  },
  { label: "Plan", value: (row) => row.plan.text, render: (row) => words(row.plan) },
  { label: "Behind", value: (row) => row.behind },
  { label: "Carries", value: (row) => row.carries },
  { label: "Ready", value: (row) => row.ready.text, render: (row) => words(row.ready) },
  ...["Sync PR", "Cascade", "Sync to main", "Main run"].map(
    (label, index): LensColumn<UpRow> => ({
      label,
      value: (row) => row.line[index]?.text ?? "",
      render: (row) => (row.line[index] ? words(row.line[index]) : ""),
    }),
  ),
  {
    label: "Next",
    value: (row) => row.next.text,
    render: (row) => (
      <span className="flow-next" data-tone={row.next.tone} data-strong={row.next.strong}>
        {row.next.strong ? <strong>{blankCell(row.next.text)}</strong> : blankCell(row.next.text)}
      </span>
    ),
  },
];

export default function Flow() {
  const snapshot = useStore(watchStore, (state) => state.snapshot);
  const evidence = snapshot?.body;
  const view = evidence?.briefing.flow;
  const select = (id: string) => {
    const row = evidence ? selectionRows(evidence).find((row) => row.id === id) : undefined;
    selectionStore.getState().select(id, row);
  };
  return (
    <section className="lens watch-flow" data-view-pane="flow" aria-label="Flow">
      <div className="lens-toolbar">
        <h1>Flow</h1>
        {view && <span className="lens-sub">{view.mode}</span>}
        <button type="button" disabled={!view} onClick={() => view && select(view.inspect)}>
          Plan
        </button>
      </div>
      {!view || !evidence ? (
        <p>Waiting for a Watch snapshot</p>
      ) : (
        <>
          <SectionEvidence
            evidence={evidence}
            prefixes={["/briefing/flow/mode", "/briefing/flow/headline", "/briefing/flow/sub"]}
          />
          <h2 data-pointer="/briefing/flow/headline">{view.headline}</h2>
          {view.sub && <p data-pointer="/briefing/flow/sub">{view.sub}</p>}
          <SectionEvidence evidence={evidence} prefixes={["/briefing/flow/tiles"]} />
          <div className="watch-tiles">
            {view.tiles.map((tile, index) => (
              <div
                className="watch-tile"
                key={tile.label}
                data-tone={tile.tone === "run" ? "neutral" : tile.tone}
                data-pointer={`/briefing/flow/tiles/${index}`}
              >
                <div>{tile.label}</div>
                <b>{tile.value}</b>
                {tile.meter && (
                  <meter
                    aria-label={tile.label}
                    min={0}
                    max={tile.meter.cap}
                    value={tile.meter.busy}
                  />
                )}
                <div>{tile.sub}</div>
              </div>
            ))}
          </div>
          <SectionEvidence evidence={evidence} prefixes={["/briefing/flow/rows"]} />
          <LensTable
            lens="flow"
            columns={columns}
            rows={view.rows.map((row, index) => ({
              reading: row,
              pointer: `/briefing/flow/rows/${index}`,
              selection: {
                id: row.inspect,
                title: row.detail.title || row.fork,
                kind: "flow",
                prefixes: [`/briefing/flow/rows/${index}`],
              },
            }))}
            onOpen={(row) => navigate({ kind: "service", id: row.fork })}
          />
          <SectionEvidence
            evidence={evidence}
            prefixes={["/briefing/flow/next", "/briefing/flow/also", "/briefing/flow/schedule"]}
          />
          <section className="lens-followup" data-pointer="/briefing/flow/next">
            <h3>{view.next.title}</h3>
            {view.next.text && <p>{view.next.text}</p>}
            <button type="button" onClick={() => select(view.inspect)}>
              {view.next.button}
            </button>
          </section>
          {view.also.length > 0 && (
            <section className="lens-followup" aria-label="Also waiting">
              <h3>Also waiting</h3>
              <ul>
                {view.also.map((item, index) => (
                  <li key={item.text} data-pointer={`/briefing/flow/also/${index}`}>
                    {item.inspect ? (
                      <button
                        type="button"
                        className="lens-link"
                        onClick={() => item.inspect && select(item.inspect)}
                      >
                        {item.text}
                      </button>
                    ) : (
                      item.text
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {view.schedule && (
            <section className="lens-followup" data-pointer="/briefing/flow/schedule">
              <h3>{view.schedule.title}</h3>
              <p>{view.schedule.text}</p>
            </section>
          )}
        </>
      )}
    </section>
  );
}
