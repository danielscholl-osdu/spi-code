// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { Fragment, type ReactNode, useRef } from "react";
import { useStore } from "zustand";
import { openSheet } from "../../app/navigation.js";
import { ariaShortcut } from "../../app/shortcuts.js";
import { PIPS, type PipState, selectStrip } from "../../store/strip.js";
import { watchStore } from "../../store/watch.js";
import { clockTime, Time } from "../../time.js";
import { firstSweepForms, SweepLine } from "../evidence/SweepLine.js";
import { useNow } from "../evidence/useNow.js";
import { PinMenu } from "../pin/PinMenu.js";
import { openFreshness } from "../sweep/reveal.js";
import { STRIP_FIELDS, type StripField } from "./fold-plan.js";
import { MEASURE, useFoldPlan } from "./use-fold-plan.js";
import "./strip.css";

const SHAPES: Readonly<Record<PipState, string>> = {
  stopped: "diamond",
  "needs-person": "filled",
  "in-progress": "half",
  "nothing-due": "hollow",
};

const RIGHT: readonly StripField[] = ["due", "nextSync", "freshness"];

/** The top row's pips and fields in PS-18 reading order, folded and wrapped by its fold plan. */
export function Strip() {
  const snapshot = useStore(watchStore, (state) => state.snapshot?.body);
  const progress = useStore(watchStore, (state) => state.progress);
  const root = useRef<HTMLDivElement>(null);
  const plan = useFoldPlan(root, snapshot);
  const now = useNow();
  const freshness = (
    <SweepLine
      key="freshness"
      snapshot={snapshot ?? null}
      progress={progress}
      short={plan?.freshness === "short"}
      onOpen={() => openFreshness(snapshot)}
    />
  );
  if (!snapshot) {
    const forms = firstSweepForms(null, progress);
    return (
      <div className="strip" data-strip="" ref={root}>
        {freshness}
        {forms && (
          <div className="strip-ruler" aria-hidden inert>
            <span className="sweep-line" data-measure={MEASURE.freshnessFull}>
              <span className="evidence-dot" />
              {forms.full}
            </span>
            <span className="sweep-line" data-measure={MEASURE.freshnessShort}>
              <span className="evidence-dot" />
              {forms.short}
            </span>
          </div>
        )}
      </div>
    );
  }
  const { pips, stopped, environment, template, due, nextSync } = selectStrip(snapshot);
  const counts = [
    ["stopped", "stopped"],
    ["needs-person", "need a person"],
    ["in-progress", "in progress"],
    ["nothing-due", "nothing due"],
  ] as const;
  const name = counts
    .map(([state, words]) => {
      const count = pips.filter((pip) => pip.state === state).length;
      return count > 0 ? `${count} ${words}` : null;
    })
    .filter(Boolean)
    .join(", ");
  const stoppedNames = `${stopped.join(", ")} stopped`;
  const environmentFull = environment
    ? `env ${environment.version}${environment.state ? ` ${environment.state}` : ""}`
    : "";
  // Folded fields keep their unfolded text as their accessible name, read as <Time> reads it.
  const dueFull = due ? `${due.count} due before ${clockTime(due.before, { now })}` : "";
  const fields: Partial<Record<"pips" | StripField, ReactNode>> = {
    ...(pips.length > 0 && {
      pips: (
        <button
          key="pips"
          type="button"
          className="strip-pips"
          aria-label={`Line: ${name}`}
          aria-keyshortcuts={ariaShortcut("l")}
          aria-controls="app-line-sheet"
          onClick={() => openSheet()}
        >
          {pips.map(({ service, state }) => (
            <PinMenu
              key={service}
              service={service}
              render={
                <span
                  role="img"
                  className="strip-pip-target"
                  data-pip={state}
                  data-service={service}
                  aria-label={`${service}: ${PIPS[state].words}`}
                  title={`${service}: ${PIPS[state].words}`}
                >
                  <span className="strip-pip-mark" data-shape={SHAPES[state]} aria-hidden />
                </span>
              }
            />
          ))}
        </button>
      ),
    }),
    ...(stopped.length > 0 && {
      stopped: (
        <button
          key="stopped"
          type="button"
          data-field="stopped"
          data-tone="bad"
          {...(plan?.stopped === "count" && { title: stoppedNames, "aria-label": stoppedNames })}
          onClick={() => openSheet()}
        >
          {plan?.stopped === "count" ? `${stopped.length} stopped` : stoppedNames}
        </button>
      ),
    }),
    ...(environment && {
      environment: (
        <button
          key="environment"
          type="button"
          data-field="environment"
          {...(plan?.environment === "version" && {
            title: environmentFull,
            "aria-label": environmentFull,
          })}
          onClick={() => openSheet()}
        >
          env <b>{environment.version}</b>
          {plan?.environment !== "version" && environment.state && ` ${environment.state}`}
        </button>
      ),
    }),
    ...(template && {
      template: (
        <button
          key="template"
          type="button"
          data-field="template"
          title={`${template.verified} of ${template.total} forks on template${template.target ? ` ${template.target}` : ""}`}
          onClick={() => openSheet()}
        >
          template{" "}
          <b>
            {template.verified}/{template.total}
          </b>
        </button>
      ),
    }),
    ...(due && {
      due: (
        <button
          key="due"
          type="button"
          data-field="due"
          data-tone="warn"
          {...(plan?.due === "count" && {
            title: dueFull,
            "aria-label": dueFull,
          })}
          onClick={() => openSheet()}
        >
          {plan?.due === "count" ? (
            `${due.count} due`
          ) : (
            <>
              {due.count} due before <Time at={due.before} />
            </>
          )}
        </button>
      ),
    }),
    ...(nextSync && {
      nextSync: (
        <button key="next-sync" type="button" data-field="next-sync" onClick={() => openSheet()}>
          next sync{" "}
          <b>
            <Time at={nextSync} />
          </b>
        </button>
      ),
    }),
    freshness,
  };
  const wrapFrom = plan?.second[0] ? STRIP_FIELDS.indexOf(plan.second[0]) : STRIP_FIELDS.length;
  const order = (["pips", ...STRIP_FIELDS] as const).filter((field) => fields[field]);
  const second = order.filter(
    (field): field is StripField => field !== "pips" && STRIP_FIELDS.indexOf(field) >= wrapFrom,
  );
  const first = order.filter((field) => !second.includes(field as StripField));
  const push = first.find((field) => RIGHT.includes(field as StripField));
  return (
    <div
      className="strip"
      data-strip=""
      data-rows={second.length > 0 ? 2 : 1}
      data-pips={plan?.pips ?? "full"}
      ref={root}
    >
      {first.map((field) => (
        <Fragment key={field}>
          {field === push && <span className="strip-push" hidden />}
          {fields[field]}
        </Fragment>
      ))}
      <div className="strip-second" data-strip-row="second">
        {second.map((field) => fields[field])}
      </div>
      <div className="strip-ruler" aria-hidden inert>
        {stopped.length > 0 && (
          <>
            <span data-measure={MEASURE.stoppedNames}>{stoppedNames}</span>
            <span data-measure={MEASURE.stoppedCount}>{stopped.length} stopped</span>
          </>
        )}
        {environment && (
          <>
            <span data-measure={MEASURE.environmentFull}>
              env <b>{environment.version}</b>
              {environment.state && ` ${environment.state}`}
            </span>
            <span data-measure={MEASURE.environmentVersion}>
              env <b>{environment.version}</b>
            </span>
          </>
        )}
        {template && (
          <span data-measure={MEASURE.template}>
            template{" "}
            <b>
              {template.verified}/{template.total}
            </b>
          </span>
        )}
        {due && (
          <>
            <span data-measure={MEASURE.dueFull}>
              {due.count} due before <Time at={due.before} />
            </span>
            <span data-measure={MEASURE.dueCount}>{due.count} due</span>
          </>
        )}
        {nextSync && (
          <span data-measure={MEASURE.nextSync}>
            next sync{" "}
            <b>
              <Time at={nextSync} />
            </b>
          </span>
        )}
      </div>
    </div>
  );
}
