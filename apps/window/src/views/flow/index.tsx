// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { Fragment, useState } from "react";
import { useStore } from "zustand";
import { lineColumns, Stations } from "../../components/stations/index.js";
import { watchStore } from "../../store/watch.js";

export default function Flow() {
  const snapshot = useStore(watchStore, (state) => state.snapshot);
  const [picked, setPicked] = useState("plan");
  if (!snapshot)
    return (
      <>
        <h1>Flow</h1>
        <p>Waiting for a Watch snapshot</p>
      </>
    );
  const view = snapshot.body.briefing.flow;
  const selected = view.rows.some((row) => row.fork === picked) ? picked : "plan";
  const flight = view.mode === "flight";
  const inspect = (id: string) => watchStore.getState().select(id);
  return (
    <>
      <div className="watch-flow" data-view-pane="flow">
        <h2>{view.headline}</h2>
        {view.sub && <p>{view.sub}</p>}
        <div className="watch-tiles">
          {view.tiles.map((tile) => (
            <div
              className="watch-tile"
              key={tile.label}
              data-tone={tile.tone === "run" ? "neutral" : tile.tone}
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
        <div className="watch-split">
          {view.rows.length > 0 && (
            <div className="watch-table">
              <table>
                <thead>
                  <tr>
                    {(flight
                      ? ["Fork", ...lineColumns, "Next"]
                      : ["Fork", "Next sync carries", "Before it can start", "Line", "Plan"]
                    ).map((label) => (
                      <th key={label}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {view.rows.map((row) => (
                    <tr key={row.fork} data-up={row.fork}>
                      <th scope="row">
                        <button
                          type="button"
                          data-up={row.fork}
                          aria-pressed={selected === row.fork}
                          onClick={() => setPicked(row.fork)}
                        >
                          {row.fork}
                        </button>
                        {flight && row.tag && <> {row.tag}</>}
                      </th>
                      {flight ? (
                        <>
                          {row.line.map((cell, index) => (
                            <td key={lineColumns[index] ?? index} data-tone={cell.tone}>
                              {cell.text}
                            </td>
                          ))}
                          <td
                            className="flow-next"
                            data-tone={row.next.tone}
                            data-strong={row.next.strong || undefined}
                          >
                            {row.next.strong ? <strong>{row.next.text}</strong> : row.next.text}
                          </td>
                        </>
                      ) : (
                        <>
                          <td>
                            <b>{row.behind}</b> {row.carries}
                          </td>
                          <td data-tone={row.ready.tone}>{row.ready.text}</td>
                          <td
                            aria-label={lineColumns
                              .map(
                                (label, index) =>
                                  `${label} ${row.line[index]?.text === "·" ? "idle" : row.line[index]?.text}`,
                              )
                              .join(", ")}
                          >
                            {row.line.map((cell, index) => (
                              <span
                                key={lineColumns[index] ?? index}
                                className="line-dot"
                                data-tone={cell.tone}
                              />
                            ))}
                            {row.line[0]?.text !== "·" && row.line[0]?.text}
                          </td>
                          <td data-tone={row.plan.tone}>{row.plan.text}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p>Line: {lineColumns.join(" · ")}. Select a row, then open it in the inspector.</p>
            </div>
          )}
          <div>
            <section data-up-detail="plan" hidden={selected !== "plan"}>
              <p>{flight ? "Next step" : "Proposed plan"}</p>
              <h3>{flight ? view.next.title : view.plan.title}</h3>
              {flight ? (
                <>
                  {view.next.text && <p>{view.next.text}</p>}
                  <button
                    type="button"
                    data-inspect={view.inspect}
                    onClick={() => inspect(view.inspect)}
                  >
                    {view.next.button}
                  </button>
                  {view.also.length > 0 && (
                    <>
                      <p>Also waiting</p>
                      <ul>
                        {view.also.map((item) => (
                          <li key={item.text}>
                            {item.inspect ? (
                              <button
                                type="button"
                                data-inspect={item.inspect}
                                onClick={() => item.inspect && inspect(item.inspect)}
                              >
                                {item.text}
                              </button>
                            ) : (
                              item.text
                            )}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              ) : (
                <>
                  {view.plan.lines.length > 0 && (
                    <dl>
                      {view.plan.lines.map((line) => (
                        <Fragment key={line.label}>
                          <dt>{line.label}</dt>
                          <dd>{line.text}</dd>
                        </Fragment>
                      ))}
                    </dl>
                  )}
                  {view.plan.note && <p>{view.plan.note}</p>}
                  <button
                    type="button"
                    data-inspect={view.inspect}
                    onClick={() => inspect(view.inspect)}
                  >
                    {view.plan.button}
                  </button>
                  {view.schedule && (
                    <>
                      <p>{view.schedule.title}</p>
                      <p>{view.schedule.text}</p>
                    </>
                  )}
                </>
              )}
            </section>
            {view.rows.map((row) => (
              <section key={row.fork} data-up-detail={row.fork} hidden={selected !== row.fork}>
                <p>
                  <button type="button" data-up="plan" onClick={() => setPicked("plan")}>
                    Plan
                  </button>{" "}
                  › {row.fork}
                </p>
                <h3 data-tone={row.next.tone === "run" ? "neutral" : row.next.tone}>
                  {row.detail.title}
                </h3>
                <p>{row.next.text}</p>
                <ul>
                  {row.detail.lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                <button
                  type="button"
                  data-inspect={row.inspect}
                  onClick={() => inspect(row.inspect)}
                >
                  Open in inspector · {row.fork}
                </button>
              </section>
            ))}
          </div>
        </div>
      </div>
      <Stations services={snapshot.body.stations} />
    </>
  );
}
