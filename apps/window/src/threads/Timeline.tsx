// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useCallback, useMemo, useState } from "react";
import { Icon } from "../components/icons/Icon.js";
import { Markdown } from "./Markdown.js";
import { type TimelineRow, timelineRows, workSummary } from "./rows.js";
import type { StepStatus, TimelineEntry, ToolCall } from "./types.js";
import { VirtualList } from "./VirtualList.js";

const STATUS_WORDS: Record<StepStatus, string> = {
  running: "Running",
  done: "Done",
  failed: "Failed",
  unknown: "Outcome not known",
};

const TURN_END_WORDS = {
  cancelled: "Cancelled. Copilot stopped before it finished.",
  failed: "The turn failed.",
  unknown: "This turn's end is not known. The host lost it before it finished.",
} as const;

function StatusMark({ status }: { status: StepStatus }) {
  if (status === "running")
    return (
      <span className="thread-mark thread-mark--running" role="img" aria-label="Running">
        <Icon name="loader" size={12} />
      </span>
    );
  if (status === "failed")
    return (
      <span className="thread-mark thread-mark--failed" role="img" aria-label="Failed">
        ✕
      </span>
    );
  if (status === "unknown")
    return (
      <span className="thread-mark" role="img" aria-label="Outcome not known">
        ?
      </span>
    );
  return (
    <span className="thread-mark" aria-hidden="true">
      ›
    </span>
  );
}

function Call({ call, open, onToggle }: { call: ToolCall; open: boolean; onToggle(): void }) {
  return (
    <li className="thread-call" data-status={call.status}>
      <button type="button" aria-expanded={open} onClick={onToggle} className="thread-call-head">
        <StatusMark status={call.status} />
        <span className="thread-call-label">{call.label}</span>
        {call.status !== "done" && (
          <span className="thread-call-status">{STATUS_WORDS[call.status]}</span>
        )}
      </button>
      {open && (
        <div className="thread-call-body">
          <p className="thread-call-part">Arguments</p>
          <pre>{call.args ?? "None recorded."}</pre>
          <p className="thread-call-part">{call.status === "failed" ? "Error" : "Result"}</p>
          <pre>
            {call.result ?? (call.status === "running" ? "Still running." : "No result recorded.")}
          </pre>
        </div>
      )}
    </li>
  );
}

type Item = TimelineRow | ToolCall;

interface RowProps {
  row: Item;
  open: ReadonlySet<string>;
  toggle(id: string): void;
  onOpenLink?: (url: string) => void;
}

function Row({ row, open, toggle, onOpenLink }: RowProps) {
  switch (row.kind) {
    case "user":
      return (
        <div className="thread-user">
          {row.chips && row.chips.length > 0 && (
            <div className="thread-chips">
              {row.chips.map((chip) => (
                <span key={chip} className="thread-chip">
                  {chip}
                </span>
              ))}
            </div>
          )}
          <p>{row.text}</p>
        </div>
      );
    case "assistant":
      return (
        <article className="thread-assistant" aria-busy={row.streaming || undefined}>
          <p className="thread-who">Copilot</p>
          <Markdown text={row.text} {...(onOpenLink ? { onOpenLink } : {})} />
          {row.streaming && (
            <span className="thread-streaming" role="status">
              Writing…
            </span>
          )}
        </article>
      );
    case "work": {
      const groupOpen = !open.has(`${row.id}:closed`);
      return (
        <section className="thread-work" aria-label="Work log">
          <button
            type="button"
            className="thread-work-head"
            aria-expanded={groupOpen}
            onClick={() => toggle(`${row.id}:closed`)}
          >
            <Icon name={groupOpen ? "chevD" : "chevR"} size={12} />
            {workSummary(row.calls)}
          </button>
        </section>
      );
    }
    case "call":
      return (
        <ul className="thread-work thread-work-call">
          <Call call={row} open={open.has(row.id)} onToggle={() => toggle(row.id)} />
        </ul>
      );
    case "setup":
      return (
        <div className="thread-setup" data-status={row.status}>
          <StatusMark status={row.status} />
          <span>{row.label}</span>
          {row.status !== "done" && (
            <span className="thread-call-status">{STATUS_WORDS[row.status]}</span>
          )}
          {row.detail && <span className="thread-setup-detail">{row.detail}</span>}
        </div>
      );
    case "turn-end":
      return (
        <p className="thread-turn-end" data-state={row.state}>
          {TURN_END_WORDS[row.state]}
          {row.detail ? ` ${row.detail}` : ""}
        </p>
      );
    case "model-switch":
      return <p className="thread-turn-end">Switched to {row.to}</p>;
  }
}

const ESTIMATES: Record<Item["kind"], number> = {
  user: 64,
  assistant: 96,
  work: 24,
  call: 22,
  setup: 32,
  "turn-end": 32,
  "model-switch": 32,
};

export function Timeline({
  entries,
  contextLine,
  running,
  onOpenLink,
}: {
  entries: readonly TimelineEntry[];
  contextLine?: string | undefined;
  running: boolean;
  onOpenLink?: ((url: string) => void) | undefined;
}) {
  const rows = useMemo(() => timelineRows(entries), [entries]);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback(
    (id: string) =>
      setOpen((current) => {
        const next = new Set(current);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );
  const items = useMemo(
    () =>
      rows.flatMap((row): Item[] =>
        row.kind === "work" && !open.has(`${row.id}:closed`) ? [row, ...row.calls] : [row],
      ),
    [rows, open],
  );
  const itemKey = useCallback((row: Item) => row.id, []);
  const estimate = useCallback((row: Item) => ESTIMATES[row.kind], []);
  return (
    <div className="thread-timeline">
      {contextLine && <p className="thread-context-line">{contextLine}</p>}
      <VirtualList
        items={items}
        itemKey={itemKey}
        estimate={estimate}
        className="thread-scroll"
        label="Thread timeline"
        busy={running}
      >
        {(row) => (
          <Row row={row} open={open} toggle={toggle} {...(onOpenLink ? { onOpenLink } : {})} />
        )}
      </VirtualList>
    </div>
  );
}
