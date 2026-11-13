// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { Fragment, type ReactNode, useId, useRef } from "react";
import { useStore } from "zustand";
import { navigate, openSheet } from "../../app/navigation.js";
import { ariaShortcut } from "../../app/shortcuts.js";
import { type StripState, selectStrip } from "../../store/strip.js";
import { watchStore } from "../../store/watch.js";
import { Time } from "../../time.js";
import { firstSweepForms, SweepLine } from "../evidence/SweepLine.js";
import { useSidebar } from "../sidebar/ui-sidebar.js";
import { openFreshness } from "../sweep/reveal.js";
import { STRIP_FIELDS, type StripField } from "./fold-plan.js";
import { MEASURE, useFoldPlan } from "./use-fold-plan.js";
import "./strip.css";

function State({ state }: { state: StripState }) {
  return (
    <span className="strip-state" data-tone={state.tone}>
      {state.text}
    </span>
  );
}

const RIGHT: readonly StripField[] = ["nextSync", "freshness"];

/** The top row's fields in PS-18 reading order, folded and wrapped by its fold plan. */
export function Strip() {
  const snapshot = useStore(watchStore, (state) => state.snapshot?.body);
  const progress = useStore(watchStore, (state) => state.progress);
  const nextSweepAt = useStore(watchStore, (state) => state.sweep?.nextSweepAt);
  const root = useRef<HTMLDivElement>(null);
  const { isMobile } = useSidebar();
  const plan = useFoldPlan(root, snapshot, isMobile);
  const stoppedLabel = useId();
  const firstStopped =
    !snapshot && (progress?.outcome === "failed" || progress?.outcome === "cancelled");
  const stoppedForms = { full: "first sweep stopped", short: "stopped" };
  const freshness = firstStopped ? (
    <button
      key="freshness"
      type="button"
      className="sweep-line"
      data-sweep-line=""
      data-field="freshness"
      data-tone="bad"
      aria-labelledby={stoppedLabel}
      title={stoppedForms.full}
      onClick={() => openFreshness(snapshot)}
    >
      <span className="evidence-dot" data-tone="bad" aria-hidden />
      <span id={stoppedLabel} className="visually-hidden">
        {stoppedForms.full}
      </span>
      <span data-sweep-display="" aria-hidden>
        {plan?.freshness === "short" ? stoppedForms.short : stoppedForms.full}
      </span>
    </button>
  ) : (
    <SweepLine
      key="freshness"
      snapshot={snapshot ?? null}
      progress={progress}
      nextSweepAt={nextSweepAt}
      short={plan?.freshness === "short"}
      onOpen={() => openFreshness(snapshot)}
    />
  );
  if (!snapshot) {
    const forms = firstStopped ? stoppedForms : firstSweepForms(null, progress);
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
  const { environment, template, forks, nextSync } = selectStrip(snapshot);
  const fields: Partial<Record<StripField, ReactNode>> = {
    environment: (
      <button
        key="environment"
        type="button"
        data-field="environment"
        title={environment.label}
        aria-label={environment.label}
        onClick={() => navigate({ kind: "environment" })}
      >
        {plan?.environment === "short" ? "Env" : "Environment"}
        <State state={environment} />
      </button>
    ),
    template: (
      <button
        key="template"
        type="button"
        data-field="template"
        title={template.label}
        aria-label={template.label}
        onClick={() => navigate({ kind: "engineering-system" })}
      >
        Templates
        <State state={template} />
      </button>
    ),
    forks: (
      <button
        key="forks"
        type="button"
        data-field="forks"
        data-services={forks.services}
        title={forks.label}
        aria-label={forks.label}
        aria-keyshortcuts={ariaShortcut("l")}
        aria-controls="app-line-sheet"
        onClick={() => openSheet()}
      >
        Forks
        <State state={forks} />
      </button>
    ),
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
  const order = STRIP_FIELDS.filter((field) => fields[field]);
  const second = order.filter((field) => STRIP_FIELDS.indexOf(field) >= wrapFrom);
  const first = order.filter((field) => !second.includes(field));
  const push = first.find((field) => RIGHT.includes(field));
  return (
    <div className="strip" data-strip="" data-rows={second.length > 0 ? 2 : 1} ref={root}>
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
        <span data-measure={MEASURE.environmentFull}>
          Environment
          <State state={environment} />
        </span>
        <span data-measure={MEASURE.environmentShort}>
          Env
          <State state={environment} />
        </span>
        <span data-measure={MEASURE.template}>
          Templates
          <State state={template} />
        </span>
        <span data-measure={MEASURE.forks}>
          Forks
          <State state={forks} />
        </span>
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
