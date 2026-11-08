// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type KeyboardEvent, useState } from "react";
import { useStore } from "zustand";
import { openSheet } from "../../app/navigation.js";
import { ariaShortcut, shortcutLabel } from "../../app/shortcuts.js";
import { PIPS, selectStrip } from "../../store/strip.js";
import { watchStore } from "../../store/watch.js";
import { PinMenu } from "../pin/PinMenu.js";
import "./strip.css";
import { Time } from "../../time.js";

/**
 * The strip under the title bar (PS-18): one pip per service in fleet order, then the fields a
 * snapshot carries. A field with no data takes no space. A click anywhere opens the Line sheet. The
 * pips take one tab stop, arrows move between them, and each opens its service's pin menu.
 */
export function Strip() {
  const [focusable, setFocusable] = useState(0);
  const snapshot = useStore(watchStore, (state) => state.snapshot?.body);
  if (!snapshot) return null;
  const { pips, stopped, environment, template, due, nextSync } = selectStrip(snapshot);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the Line button and ⌘L reach the same sheet from the keyboard
    // biome-ignore lint/a11y/noStaticElementInteractions: the whole strip is a pointer target for the sheet
    <div className="strip" data-strip="" onClick={() => openSheet()}>
      {pips.length > 0 && (
        <ul className="strip-pips" aria-label="Services">
          {pips.map(({ service, state }, index) => (
            <PinMenu
              key={service}
              service={service}
              render={
                <li
                  role="img"
                  className="strip-pip"
                  data-pip={state}
                  data-service={service}
                  aria-label={`${service}: ${PIPS[state].words}`}
                  title={`${service}: ${PIPS[state].words}`}
                  tabIndex={index === Math.min(focusable, pips.length - 1) ? 0 : -1}
                  onKeyDown={(event) => movePipFocus(event, index, setFocusable)}
                >
                  {PIPS[state].mark}
                </li>
              }
            />
          ))}
        </ul>
      )}
      {stopped.length > 0 && (
        <span data-field="stopped" data-tone="bad">
          {stopped.join(", ")} stopped
        </span>
      )}
      {environment && (
        <span data-field="environment">
          env <b>{environment.version}</b>
          {environment.state && ` ${environment.state}`}
        </span>
      )}
      {template && (
        <span
          data-field="template"
          title={`${template.verified} of ${template.total} forks on template${template.target ? ` ${template.target}` : ""}`}
        >
          template{" "}
          <b>
            {template.verified}/{template.total}
          </b>
        </span>
      )}
      <span className="strip-space" />
      {due && (
        <span data-field="due" data-tone="warn">
          {due.count} due before <Time at={due.before} />
        </span>
      )}
      {nextSync && (
        <span data-field="next-sync">
          next sync{" "}
          <b>
            <Time at={nextSync} />
          </b>
        </span>
      )}
      <button
        type="button"
        className="strip-line"
        aria-keyshortcuts={ariaShortcut("l")}
        onClick={(event) => {
          event.stopPropagation();
          openSheet();
        }}
      >
        Line {shortcutLabel("l")}
      </button>
    </div>
  );
}

function movePipFocus(
  event: KeyboardEvent<HTMLLIElement>,
  index: number,
  setFocusable: (index: number) => void,
) {
  const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
  if (!step) return;
  const next = event.currentTarget.parentElement?.children[index + step];
  if (!(next instanceof HTMLElement)) return;
  event.preventDefault();
  setFocusable(index + step);
  next.focus();
}
