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
import { type KeyboardEvent, type ReactNode, useId } from "react";
import { useStore } from "zustand";
import {
  ReadList,
  SelectionEvidence,
  SelectionEvidenceChip,
} from "../components/evidence/index.js";
import { PANEL_TABS, type PanelTab, type SelectionStore } from "./selection.js";
import "./panels.css";

const TAB_LABEL: Readonly<Record<PanelTab, string>> = {
  inspector: "Inspector",
  evidence: "Evidence",
  log: "Log",
};

function Field({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd data-field={label.toLowerCase()}>{value || "Not stated"}</dd>
    </>
  );
}

function Inspector({ result, onEvidence }: { result: InspectResult; onEvidence(): void }) {
  const base = useId();
  return (
    <article className="inspector" data-class={result.class}>
      <p className="inspector-kicker">
        <span data-field="class">{result.class}</span> · {result.id}
      </p>
      <SelectionEvidenceChip result={result} onOpen={onEvidence} />
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

/** `sweepEvidence` is the Evidence tab's body when the sweep line opened it or nothing is selected. */
export function RightPanel({
  store,
  sweepEvidence,
}: {
  store: SelectionStore;
  sweepEvidence?: ReactNode;
}) {
  const base = useId();
  const selected = useStore(store, (state) => state.selected);
  const request = useStore(store, (state) => state.request);
  const result = useStore(store, (state) => state.result);
  const error = useStore(store, (state) => state.error);
  const missing = useStore(store, (state) => state.missing);
  const tab = useStore(store, (state) => state.tab);
  const setTab = useStore(store, (state) => state.setTab);
  const evidenceScope = useStore(store, (state) => state.evidenceScope);
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
    tab === "evidence" &&
    sweepEvidence !== undefined &&
    (evidenceScope === "sweep" || selected === null) ? (
      sweepEvidence
    ) : selected === null ? (
      <p className="panel-empty">No selection</p>
    ) : error !== null ? (
      <p role="alert">{error}</p>
    ) : missing !== null ? (
      <p className="panel-empty">{missing}</p>
    ) : result === null ? (
      <p className="panel-empty" role="status">
        Reading {selected}…
      </p>
    ) : tab === "inspector" ? (
      <Inspector result={result} onEvidence={() => setTab("evidence")} />
    ) : tab === "evidence" ? (
      <SelectionEvidence result={result} />
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
