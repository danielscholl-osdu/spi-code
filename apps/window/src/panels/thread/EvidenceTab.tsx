// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ReadRecord, ReadRecordSchema, type ThreadWireEvent } from "@spi-code/contracts";
import { useStore } from "zustand";
import { ReadLines, readLine, SelectionPage } from "../../components/evidence/EvidencePage.js";
import { serviceEvidence } from "../../components/evidence/page-evidence.js";
import { useNow } from "../../components/evidence/useNow.js";
import { watchStore } from "../../store/watch.js";
import { PLACE_SCOPES, scopeLabel } from "../../threads/scopes.js";
import { threadStore } from "../../threads/store.js";
import { clockTime } from "../../time.js";
import { PROGRAM, type ThreadTab, type ThreadTabProps } from "./tab.js";
import "../../components/evidence/evidence.css";

type SentChip = {
  title: string | undefined;
  sweptAt: string;
  evidence: readonly (ReadRecord | string)[];
};

/** The starting chip as the thread's first message carried it; null when that message holds none. */
function sentChip(
  events: readonly ThreadWireEvent[] | undefined,
  subject: string,
): SentChip | null {
  const first = events?.find((event) => event.type === "message.sent");
  if (first?.type !== "message.sent") return null;
  const attachment = first.message.attachments?.find(({ name }) => name === `context:${subject}`);
  if (!attachment) return null;
  let chip: unknown;
  try {
    chip = JSON.parse(attachment.content);
  } catch {
    return null;
  }
  if (typeof chip !== "object" || chip === null) return null;
  const { title, sweptAt, evidence } = chip as Record<string, unknown>;
  if (typeof sweptAt !== "string" || !Array.isArray(evidence)) return null;
  return {
    title: typeof title === "string" ? title : undefined,
    sweptAt,
    evidence: evidence.flatMap((entry: unknown): (ReadRecord | string)[] => {
      if (typeof entry === "string") return [entry];
      const record = ReadRecordSchema.safeParse(entry);
      return record.success ? [record.data] : [];
    }),
  };
}

function StartedFrom({ id, subject, now }: { id: string; subject: string; now: number }) {
  const events = useStore(threadStore, (state) => state.events[id]);
  const chip = sentChip(events, subject);
  if (!chip)
    return (
      <section aria-label="Started from" data-evidence-for="chip">
        <p className="panel-empty" data-quiet="unavailable">
          ⌀ The chip this thread started from is not available.
        </p>
      </section>
    );
  const lines = chip.evidence.map((entry) =>
    typeof entry === "string"
      ? { key: entry, name: entry, time: "" }
      : readLine({ fork: entry.source, record: entry }, true, now),
  );
  return (
    <section aria-label="Started from" data-evidence-for="chip">
      <p className="evidence-lede">
        {`${chip.title ?? subject} · sweep ended ${clockTime(chip.sweptAt, { now, hint: false })}`}
      </p>
      {lines.length > 0 ? (
        <section aria-label="Evidence references" data-evidence-part="references">
          <h3>Evidence references</h3>
          <ReadLines label="Evidence references" lines={lines} />
        </section>
      ) : (
        <p className="panel-empty" data-quiet="none">
          ⌀ This chip was sent with no evidence references.
        </p>
      )}
    </section>
  );
}

/** The row the thread started from as its chip was sent, then what the latest sweep read for its scope. */
function EvidenceTab({ id, summary }: ThreadTabProps) {
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
  const subject = summary.thread.subject;
  const started = subject && <StartedFrom id={id} subject={subject} now={now} />;
  if (!snapshot)
    return (
      <div className="evidence thread-evidence">
        {started}
        <p className="panel-empty" data-quiet="unread">
          ⌀ No sweep has been read yet.
        </p>
      </div>
    );
  const logged =
    run?.sources.flatMap(({ source, state }) =>
      state === "read" || state === "cut" ? [source] : [],
    ) ?? [];
  const page = { areas: snapshot.areas, sweptAt: snapshot.sweptAt, logged, now };
  const place = scope === PROGRAM || PLACE_SCOPES.some(({ id }) => id === scope);
  const home = place ? null : serviceEvidence(scope, snapshot);
  return (
    <div className="evidence thread-evidence">
      {started}
      <section aria-label={`${scope} evidence`} data-evidence-for="scope">
        <p className="evidence-lede">
          {scopeLabel(scope)}
          {` · sweep ended ${clockTime(snapshot.sweptAt, { now, hint: false })}`}
        </p>
        {home ? (
          <SelectionPage evidence={home} subject="service" {...page} />
        ) : (
          <p className="panel-empty" data-quiet="unread">
            {scope === PROGRAM
              ? "⌀ The program's evidence comes with a later build."
              : place
                ? `⌀ ${scopeLabel(scope)}'s evidence comes with a later build.`
                : "⌀ This fork was not read."}
          </p>
        )}
      </section>
    </div>
  );
}

export const EVIDENCE_TAB: ThreadTab = { id: "evidence", label: "Evidence", Panel: EvidenceTab };
