// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT
//
// Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import type { InspectResult } from "@spi-code/contracts";
import { type KeyboardEvent, useId } from "react";
import { useStore } from "zustand";
import { InferredMarker, ReadList } from "../components/evidence/index.js";
import { PANEL_TABS, type PanelTab, type SelectionStore } from "./selection.js";
import "./panels.css";

const TAB_LABEL: Readonly<Record<PanelTab, string>> = { inspector: "Inspector", log: "Log" };

function Field({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd data-field={label.toLowerCase()}>{value || "Not stated"}</dd>
    </>
  );
}

function Inspector({ result }: { result: InspectResult }) {
  const base = useId();
  return (
    <article className="inspector" data-class={result.class}>
      <p className="inspector-kicker">
        <span data-field="class">{result.class}</span> · {result.id}
      </p>
      <dl>
        <Field label="Cause" value={result.cause} />
        <Field label="Effect" value={result.effect} />
        <Field label="Next" value={result.next} />
        {result.why && <Field label="Why" value={result.why} />}
      </dl>
      {result.evidence.length > 0 && (
        <>
          <h3>Evidence</h3>
          <ul aria-label="Evidence">
            {result.evidence.map((record) => (
              <li key={`${record.source}/${record.object}`}>
                {record.source} · {record.object}
                {record.inferred === true && <InferredMarker />}
              </li>
            ))}
          </ul>
        </>
      )}
      {result.related.length > 0 && (
        <>
          <h3>Related</h3>
          <ul aria-label="Related">
            {result.related.map((related) => (
              <li key={`${related.text}/${related.state}`}>
                {related.url ? (
                  <a href={related.url} target="_blank" rel="noreferrer">
                    {related.text}
                  </a>
                ) : (
                  related.text
                )}{" "}
                · {related.state}
              </li>
            ))}
          </ul>
        </>
      )}
      {result.approval && (
        <>
          <h3>Approval</h3>
          <p data-approval={result.approval.state}>
            {result.approval.state} · {result.approval.reason}
          </p>
        </>
      )}
      {result.actions.length > 0 && (
        <ul className="inspector-actions" aria-label="Actions">
          {result.actions.map((action) => {
            const reason = `${base}-${action.id}`;
            return (
              <li key={action.id} data-action={action.id}>
                <button type="button" disabled aria-describedby={reason}>
                  {action.label}
                </button>
                <p id={reason} className="inspector-reason">
                  {action.disabledReason}
                </p>
                {action.eligibilityReason && (
                  <p className="inspector-reason">{action.eligibilityReason}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}

export function RightPanel({ store }: { store: SelectionStore }) {
  const base = useId();
  const selected = useStore(store, (state) => state.selected);
  const request = useStore(store, (state) => state.request);
  const result = useStore(store, (state) => state.result);
  const error = useStore(store, (state) => state.error);
  const tab = useStore(store, (state) => state.tab);
  const setTab = useStore(store, (state) => state.setTab);
  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next =
      PANEL_TABS[(PANEL_TABS.indexOf(tab) + step + PANEL_TABS.length) % PANEL_TABS.length];
    if (next) {
      setTab(next);
      document.getElementById(`${base}-tab-${next}`)?.focus();
    }
  };
  const body =
    selected === null ? (
      <p className="panel-empty">No selection</p>
    ) : error !== null ? (
      <p role="alert">{error}</p>
    ) : result === null ? (
      <p className="panel-empty" role="status">
        Reading {selected}…
      </p>
    ) : tab === "inspector" ? (
      <Inspector result={result} />
    ) : result.evidence.length > 0 ? (
      <ReadList records={result.evidence} />
    ) : (
      <p className="panel-empty">No reads recorded for {result.id}</p>
    );
  return (
    <aside aria-label="Inspector" className="right-panel" aria-busy={request !== null}>
      <div role="tablist" aria-label="Right panel" className="panel-tabs">
        {PANEL_TABS.map((id) => (
          <button
            key={id}
            id={`${base}-tab-${id}`}
            type="button"
            role="tab"
            aria-selected={tab === id}
            aria-controls={`${base}-panel`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            onKeyDown={onKeyDown}
          >
            {TAB_LABEL[id]}
          </button>
        ))}
      </div>
      <div
        id={`${base}-panel`}
        role="tabpanel"
        aria-labelledby={`${base}-tab-${tab}`}
        className="panel-body"
      >
        {body}
      </div>
    </aside>
  );
}
