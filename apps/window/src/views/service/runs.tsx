// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { navigate, routeHash } from "../../app/navigation.js";
import { useNow } from "../../components/evidence/useNow.js";
import { LinkPill } from "../../components/kit/LinkPill.js";
import { when } from "../../time.js";
import type { ServiceTab, TabProps } from "./tabs.js";
import "./runs.css";

function historyOf({ id, snapshot }: Pick<TabProps, "id" | "snapshot">) {
  return snapshot.services?.find(({ service }) => service === id)?.runHistory;
}

const resultWord = (result: string) => result.replaceAll("_", " ");

function Runs({ id, snapshot }: TabProps) {
  const history = historyOf({ id, snapshot });
  const now = useNow();
  if (history?.kind !== "read") {
    const evidence = { kind: "evidence", from: { kind: "service", id, tab: "runs" } } as const;
    return (
      <p className="service-quiet" data-quiet="unread">
        ⌀ Runs were not read.{" "}
        <a
          href={routeHash(evidence)}
          onClick={(event) => {
            event.preventDefault();
            navigate(evidence);
          }}
        >
          Evidence ›
        </a>
      </p>
    );
  }

  return (
    <div className="service-runs">
      {history.failing.length > 0 && (
        <section className="service-section service-runs-failing" aria-label="Failing now">
          <h2 className="service-section-head">
            <span className="service-section-dot" aria-hidden="true" />
            Failing now <span className="service-section-count">{history.count}</span>
          </h2>
          <ul className="service-section-box">
            {history.failing.map(({ run, job, step }) => (
              <li className="service-run-failure" key={run.workflowId}>
                <strong>{run.name}</strong>
                <span>{[job, step ?? "Failing step unavailable"].filter(Boolean).join(" · ")}</span>
                {run.startedAt && (
                  <time dateTime={run.startedAt}>{when(run.startedAt, { now })}</time>
                )}
                <LinkPill
                  link={{ kind: "run", label: "Run", url: `${run.url}/attempts/${run.attempt}` }}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="service-section" aria-label="Every workflow">
        <h2 className="service-section-head">Every workflow · last 14 days</h2>
        {history.cut && (
          <p className="service-runs-note">Run history is limited to the runs shown.</p>
        )}
        {history.workflows.length === 0 ? (
          <p className="service-runs-note">
            {history.cut ? "No runs returned." : "No runs in the last 14 days."}
          </p>
        ) : (
          <ul className="service-section-box">
            {history.workflows.map(({ id: workflowId, name, runs }) => {
              const latest = runs.at(-1);
              return (
                <li className="service-run-workflow" key={workflowId}>
                  <strong>{name}</strong>
                  <div className="service-run-strip">
                    {runs.map((run) => {
                      const time = run.startedAt && when(run.startedAt, { now });
                      const label = [name, time, resultWord(run.result), "↗"]
                        .filter(Boolean)
                        .join(" · ");
                      return (
                        <a
                          key={run.id}
                          className="service-run-square"
                          data-state={run.tone}
                          href={run.url}
                          title={label}
                          onClick={(event) => {
                            event.preventDefault();
                            void window.spi?.openExternal(run.url);
                          }}
                        >
                          <span className="service-run-square-label">{label}</span>
                        </a>
                      );
                    })}
                  </div>
                  {latest && (
                    <span className="service-run-latest" data-state={latest.tone}>
                      {resultWord(latest.result)}
                      {latest.startedAt && (
                        <>
                          {" "}
                          <time dateTime={latest.startedAt}>{when(latest.startedAt, { now })}</time>
                        </>
                      )}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

export const runsTab: ServiceTab = {
  id: "runs",
  label: "Runs",
  count: (props) => historyOf(props)?.count ?? null,
  Panel: Runs,
};
