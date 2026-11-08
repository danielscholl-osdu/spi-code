// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useStore } from "zustand";
import { openSheet } from "../../app/navigation.js";
import { ariaShortcut } from "../../app/shortcuts.js";
import { selectionStore } from "../../panels/selection.js";
import { PIPS, type PipState, selectStrip } from "../../store/strip.js";
import { watchStore } from "../../store/watch.js";
import { SweepLine } from "../evidence/SweepLine.js";
import { PinMenu } from "../pin/PinMenu.js";
import "./strip.css";
import { Time } from "../../time.js";

const SHAPES: Readonly<Record<PipState, string>> = {
  stopped: "diamond",
  "needs-person": "filled",
  "in-progress": "half",
  "nothing-due": "hollow",
};

/** The top row's pips and fields, in PS-18 reading order. */
export function Strip() {
  const snapshot = useStore(watchStore, (state) => state.snapshot?.body);
  const freshness = (
    <SweepLine
      snapshot={snapshot ?? null}
      onOpen={() => selectionStore.getState().openSweepEvidence()}
    />
  );
  if (!snapshot)
    return (
      <div className="strip" data-strip="">
        {freshness}
      </div>
    );
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
  return (
    <div className="strip" data-strip="">
      {pips.length > 0 && (
        <button
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
                  tabIndex={-1}
                >
                  <span className="strip-pip-mark" data-shape={SHAPES[state]} aria-hidden />
                </span>
              }
            />
          ))}
        </button>
      )}
      {stopped.length > 0 && (
        <button type="button" data-field="stopped" data-tone="bad" onClick={() => openSheet()}>
          {stopped.join(", ")} stopped
        </button>
      )}
      {environment && (
        <button type="button" data-field="environment" onClick={() => openSheet()}>
          env <b>{environment.version}</b>
          {environment.state && ` ${environment.state}`}
        </button>
      )}
      {template && (
        <button
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
      )}
      <span className="strip-space" />
      {due && (
        <button type="button" data-field="due" data-tone="warn" onClick={() => openSheet()}>
          {due.count} due before <Time at={due.before} />
        </button>
      )}
      {nextSync && (
        <button type="button" data-field="next-sync" onClick={() => openSheet()}>
          next sync{" "}
          <b>
            <Time at={nextSync} />
          </b>
        </button>
      )}
      {freshness}
    </div>
  );
}
