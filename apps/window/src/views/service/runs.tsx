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

type ReadHistory = Extract<ReturnType<typeof historyOf>, { kind: "read" }>;

const resultWord = (result: string) => result.replaceAll("_", " ");

function FailureRow({
  failure: { run, job, step, main },
  now,
}: {
  failure: ReadHistory["failing"][number];
  now: number;
}) {
  const onMain = main?.id === run.id && main.attempt === run.attempt;
  const startedAt = run.startedAt ?? run.createdAt;
  return (
    <li className="service-run-failure">
      <strong className="service-run-name" title={run.name}>
        {run.name}
      </strong>
      <span>{`› ${[job, step ?? "Failing step unavailable"].filter(Boolean).join(" › ")}`}</span>
      {!onMain && (
        <span className="service-run-attempt">
          <time dateTime={startedAt}>{when(startedAt, { now })}</time>
          <LinkPill
            link={{ kind: "run", label: "Run", url: `${run.url}/attempts/${run.attempt}` }}
          />
        </span>
      )}
      {main && (
        <span className="service-run-attempt">
          <span>
            on main
            {main.failedAt && (
              <>
                {" "}
                · failed <time dateTime={main.failedAt}>{when(main.failedAt, { now })}</time>
              </>
            )}
          </span>
          <LinkPill link={{ kind: "run", label: "Run", url: main.url }} />
        </span>
      )}
    </li>
  );
}

function WorkflowRow({
  workflow: { name, runs, label },
  now,
}: {
  workflow: ReadHistory["workflows"][number];
  now: number;
}) {
  const retried = new Set(runs.filter(({ attempt }) => attempt > 1).map(({ id }) => id));
  return (
    <li className="service-run-workflow">
      <strong className="service-run-name" title={name}>
        {name}
      </strong>
      <div className="service-run-strip">
        {runs.map((run) => {
          const time = when(run.startedAt ?? run.createdAt, { now });
          const attempts = retried.has(run.id);
          const url = attempts ? `${run.url}/attempts/${run.attempt}` : run.url;
          const label = [
            name,
            time,
            resultWord(run.result),
            attempts ? `attempt ${run.attempt}` : "",
            "↗",
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <a
              key={`${run.id}#${run.attempt}`}
              className="service-run-square"
              data-state={run.tone}
              data-result={run.result}
              href={url}
              title={label}
              onClick={(event) => {
                event.preventDefault();
                void window.spi?.openExternal(url);
              }}
            >
              <span className="service-run-square-label">{label}</span>
            </a>
          );
        })}
      </div>
      <span className="service-run-latest" data-state={label.tone}>
        {resultWord(label.result)}
        {label.branch ? ` on ${label.branch}` : " · any branch"}{" "}
        <time dateTime={label.at}>{when(label.at, { now })}</time>
      </span>
    </li>
  );
}

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

  const shown = history.workflows.filter(({ automation }) => !automation);
  const automation = history.workflows.filter((workflow) => workflow.automation);
  const oldest = history.cut
    ? history.workflows
        .flatMap(({ runs }) => runs.map((run) => run.createdAt))
        .sort((a, b) => Date.parse(a) - Date.parse(b))[0]
    : undefined;
  const period = oldest
    ? ` · since ${when(oldest, { now })}`
    : history.cut
      ? ""
      : " · last 14 days";

  return (
    <div className="service-runs">
      {history.failing.length > 0 && (
        <section className="service-section service-runs-failing" aria-label="Failing now">
          <h2 className="service-section-head">
            <span className="service-section-dot" aria-hidden="true" />
            Failing now <span className="service-section-count">{history.count}</span>
          </h2>
          <ul className="service-section-box">
            {history.failing.map((failure) => (
              <FailureRow
                key={
                  failure.run.workflowId === undefined
                    ? `run:${failure.run.id}`
                    : `workflow:${failure.run.workflowId}`
                }
                failure={failure}
                now={now}
              />
            ))}
          </ul>
        </section>
      )}
      <section className="service-section" aria-label="Every workflow">
        <h2 className="service-section-head">Every workflow{period}</h2>
        {history.workflows.length === 0 ? (
          <p className="service-runs-note">
            {history.cut ? "⌀ Run history is incomplete." : "No runs in the last 14 days."}
          </p>
        ) : (
          <ul className="service-section-box">
            {shown.map((workflow) => (
              <WorkflowRow key={workflow.id} workflow={workflow} now={now} />
            ))}
            {automation.length > 0 && (
              <li>
                <details key={id} className="service-run-automation">
                  <summary>
                    {automation.length} automation{" "}
                    {automation.length === 1 ? "workflow" : "workflows"}
                  </summary>
                  <ul>
                    {automation.map((workflow) => (
                      <WorkflowRow key={workflow.id} workflow={workflow} now={now} />
                    ))}
                  </ul>
                </details>
              </li>
            )}
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
