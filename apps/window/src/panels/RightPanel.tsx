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

import type { InspectResult, ReadRecord, ViewSnapshot } from "@spi-code/contracts";
import { type KeyboardEvent, type ReactNode, useId } from "react";
import { useStore } from "zustand";
import { SelectionEvidence, SelectionEvidenceChip } from "../components/evidence/index.js";
import { plainTitle, sentenceCase } from "../text.js";
import { Time, TimedText } from "../time.js";
import { detailAction, runDetailAction } from "./detail-action.js";
import { PANEL_TABS, type PanelTab, type SelectionStore } from "./selection.js";
import { type SelectionKind, type SelectionRow, selectionRows } from "./selection-rows.js";
import "./panels.css";

const TAB_LABEL: Readonly<Record<PanelTab, string>> = { detail: "Detail", evidence: "Evidence" };
const KIND_LABEL: Readonly<Record<SelectionKind, string>> = {
  queue: "queue item",
  flow: "upstream sync",
  plan: "wave plan",
  repository: "repository",
  "repository-line": "repository line",
  run: "run",
  "template-step": "template step",
  theme: "theme",
  environment: "lane event",
  release: "release month",
  station: "station",
};

function Field({ label, value }: { label: string; value: string }) {
  const text = sentenceCase(plainTitle(value));
  if (!text) return null;
  return (
    <>
      <dt>{label}</dt>
      <dd data-field={label.toLowerCase()}>
        <TimedText text={text} />
      </dd>
    </>
  );
}

function Inspector({
  result,
  store,
  row,
  snapshot,
}: {
  result: InspectResult;
  store: SelectionStore;
  row: SelectionRow | null;
  snapshot: ViewSnapshot | undefined;
}) {
  const relatedEntries = result.related.filter((related) => plainTitle(related.text));
  return (
    <article className="inspector" data-class={result.class}>
      <p className="inspector-kicker">
        <span data-field="class">{result.class}</span> · {result.id}
      </p>
      {[result.cause, result.effect, result.next, result.why].some((value) =>
        plainTitle(value),
      ) && (
        <dl>
          <Field label="Cause" value={result.cause} />
          <Field label="Effect" value={result.effect} />
          <Field label="Next" value={result.next} />
          <Field label="Why" value={result.why} />
        </dl>
      )}
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
      {relatedEntries.length > 0 && (
        <>
          <h3>Related</h3>
          <dl className="inspector-related" aria-label="Related">
            {relatedEntries.map((related) => (
              <div key={`${related.text}/${related.state}`}>
                {plainTitle(related.state) && <dt>{sentenceCase(plainTitle(related.state))}</dt>}
                <dd>
                  {related.inspect ? (
                    <button
                      type="button"
                      onClick={() => {
                        const id = related.inspect;
                        const relatedRow = snapshot
                          ? selectionRows(snapshot).find((candidate) => candidate.id === id)
                          : undefined;
                        if (id)
                          store.getState().select(
                            id,
                            relatedRow ?? {
                              id,
                              title: related.text,
                              kind: id.startsWith("step:") ? "template-step" : "queue",
                              ...(row?.prefixes ? { prefixes: row.prefixes } : {}),
                            },
                          );
                      }}
                    >
                      <TimedText text={sentenceCase(plainTitle(related.text))} />
                    </button>
                  ) : related.url ? (
                    <a href={related.url} target="_blank" rel="noreferrer">
                      <TimedText text={sentenceCase(plainTitle(related.text))} />
                    </a>
                  ) : (
                    <TimedText text={sentenceCase(plainTitle(related.text))} />
                  )}
                </dd>
              </div>
            ))}
          </dl>
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
      {/* The host's result.actions are writes that arrive at M4; an unshipped action takes no space. */}
    </article>
  );
}

/**
 * `sweepEvidence` is the Evidence tab's body when the sweep line opened it or nothing is selected.
 * `reads` is the sweep's reads; a selection's Evidence keeps its repository's.
 */
export function RightPanel({
  store,
  snapshot,
  sweepEvidence,
  reads = snapshot?.reads ?? [],
  onClose,
}: {
  store: SelectionStore;
  snapshot?: ViewSnapshot;
  sweepEvidence?: ReactNode;
  reads?: readonly ReadRecord[] | undefined;
  onClose?(): void;
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
  const ownRow = useStore(store, (state) => state.row);
  const candidates = snapshot
    ? selectionRows(snapshot).filter(
        ({ id, kind }) => id === selected && (!ownRow || kind === ownRow.kind),
      )
    : [];
  // A refresh can move a row; its id still finds it when no other row shares it.
  // Folded kinds such as environment events share ids, so only their pointer proves identity.
  const matched =
    candidates.find(
      ({ prefixes }) => !ownRow?.prefixes || prefixes?.join("|") === ownRow.prefixes.join("|"),
    ) ??
    ((ownRow?.kind === "repository-line" ||
      ownRow?.kind === "flow" ||
      ownRow?.kind === "repository") &&
    candidates.length === 1
      ? candidates[0]
      : undefined);
  const row = matched ?? ownRow;
  // A station leads with its own label, state word and text; the host's reading follows.
  const leads = row?.kind === "station";
  const action = selected === null ? undefined : detailAction(row, result, snapshot);
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
  const reading =
    selected === null ? (
      <p className="panel-empty">No selection</p>
    ) : error !== null ? (
      <p role="alert">{error}</p>
    ) : missing !== null ? (
      <p className="panel-empty">{missing}</p>
    ) : result === null && row?.inspectId !== null ? (
      <p className="panel-empty" role="status">
        Reading {selected}…
      </p>
    ) : result ? (
      <Inspector result={result} store={store} row={row} snapshot={snapshot} />
    ) : null;
  return (
    <aside aria-label="Detail" className="right-panel" aria-busy={request !== null}>
      <div role="tablist" aria-label="Right panel" className="panel-tabs pane-header">
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
        {onClose && (
          <button
            type="button"
            className="panel-close panel-toggle"
            aria-label="Close detail"
            onClick={onClose}
          >
            ×
          </button>
        )}
      </div>
      <div
        id={`${base}-panel`}
        role="tabpanel"
        aria-labelledby={`${base}-tab-${tab}`}
        className="panel-body"
      >
        {tab === "evidence" ? (
          sweepEvidence !== undefined && (evidenceScope === "sweep" || selected === null) ? (
            sweepEvidence
          ) : result ? (
            <SelectionEvidence result={result} reads={reads} />
          ) : (
            (reading ?? <p className="panel-empty">No evidence for this selection.</p>)
          )
        ) : (
          <>
            {selected !== null && (
              <>
                <p className="inspector-kicker">{row ? KIND_LABEL[row.kind] : "selection"}</p>
                <h2 className="detail-title">
                  {plainTitle(row?.title ?? result?.title ?? selected)}
                </h2>
                {result && (
                  <SelectionEvidenceChip
                    result={result}
                    reads={reads}
                    onOpen={() => setTab("evidence")}
                  />
                )}
              </>
            )}
            {!leads && reading}
            {row?.fields && (
              <dl className="detail-row-fields" aria-label="Row reading">
                {row.fields.map(({ label, value, href, dateTime }) => (
                  <div key={`${label}-${value}`}>
                    <dt>{label}</dt>
                    <dd>
                      {href ? (
                        <a
                          href={href}
                          onClick={(event) => {
                            event.preventDefault();
                            void window.spi?.openExternal(href);
                          }}
                        >
                          {value}
                        </a>
                      ) : dateTime ? (
                        <Time at={dateTime} />
                      ) : value === "·" ? (
                        ""
                      ) : (
                        value
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {leads && reading}
            {action && (
              <div className="detail-action">
                <button
                  type="button"
                  data-detail-action={action.kind}
                  onClick={() => runDetailAction(action)}
                >
                  {action.label}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
