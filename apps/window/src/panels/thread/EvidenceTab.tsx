// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useStore } from "zustand";
import { SelectionPage } from "../../components/evidence/EvidencePage.js";
import { pageEvidence, serviceEvidence } from "../../components/evidence/page-evidence.js";
import { useNow } from "../../components/evidence/useNow.js";
import { watchStore } from "../../store/watch.js";
import { clockTime } from "../../time.js";
import { PROGRAM, type ThreadTab, type ThreadTabProps } from "./tab.js";
import "../../components/evidence/evidence.css";

/** What the sweep read for the row the thread started from, then for its scope. */
function EvidenceTab({ summary }: ThreadTabProps) {
  const now = useNow();
  const snapshot = useStore(watchStore, (state) => state.snapshot?.body ?? null);
  const run = useStore(watchStore, (state) => state.progress ?? state.completed);
  const scope = summary?.thread.scope;
  if (!scope)
    return (
      <p className="panel-empty" data-quiet="not-known">
        ⌀ This thread's scope is not known.
      </p>
    );
  if (!snapshot)
    return (
      <p className="panel-empty" data-quiet="unread">
        ⌀ No sweep has been read yet.
      </p>
    );
  const logged =
    run?.sources.flatMap(({ source, state }) =>
      state === "read" || state === "cut" ? [source] : [],
    ) ?? [];
  const page = { areas: snapshot.areas, sweptAt: snapshot.sweptAt, logged, now };
  const ended = ` · sweep ended ${clockTime(snapshot.sweptAt, { now, hint: false })}`;
  const subject = summary.thread.subject;
  const lines = snapshot.briefing.lines ?? [];
  const item = subject ? pageEvidence({ kind: "item", id: subject }, lines, snapshot.reads) : null;
  const line =
    subject && !item ? pageEvidence({ kind: "line", id: subject }, lines, snapshot.reads) : null;
  const home = scope === PROGRAM ? null : serviceEvidence(scope, snapshot);
  return (
    <div className="evidence thread-evidence">
      {subject && (
        <section aria-label="Started from" data-evidence-for="chip">
          <p className="evidence-lede">
            {(item ?? line)?.title ?? "Today holds nothing for the row this thread started from"}
            {ended}
          </p>
          {item && <SelectionPage evidence={item} subject="item" {...page} />}
          {line && <SelectionPage evidence={line} subject="row" {...page} />}
        </section>
      )}
      <section aria-label={`${scope} evidence`} data-evidence-for="scope">
        <p className="evidence-lede">
          {scope === PROGRAM ? "Program" : scope}
          {ended}
        </p>
        {home ? (
          <SelectionPage evidence={home} subject="service" {...page} />
        ) : (
          <p className="panel-empty" data-quiet="unread">
            {scope === PROGRAM
              ? "⌀ The program's evidence comes with a later build."
              : "⌀ This fork was not read."}
          </p>
        )}
      </section>
    </div>
  );
}

export const EVIDENCE_TAB: ThreadTab = { id: "evidence", label: "Evidence", Panel: EvidenceTab };
