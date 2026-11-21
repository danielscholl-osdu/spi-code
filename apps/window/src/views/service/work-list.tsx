// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ServiceIssue, ServicePull, ViewSnapshot } from "@spi-code/contracts";
import { type ReactNode, useState } from "react";
import { navigate } from "../../app/navigation.js";
import { LinkPill } from "../../components/kit/LinkPill.js";
import { RequestOwner } from "../../threads/RequestOwner.js";
import { When } from "../../time.js";
import { NotRead } from "./lists.js";
import "./work-list.css";

export const serviceWorkOf = (snapshot: ViewSnapshot, id: string) =>
  snapshot.services?.find(({ service }) => service === id)?.work;

type Row = ServicePull | ServiceIssue;
type Filter = "open" | "done" | "all";
type RowContent = {
  subtitle: (string | undefined)[];
  status: ReactNode;
  summary: ReactNode;
  companion?: { number: number; url: string } | undefined;
};

const actionable = (row: Row) => row.state === "open" && !("tracks" in row && row.tracks);
const scrollToRow = (button: HTMLButtonElement | null) =>
  button?.closest("li")?.scrollIntoView?.({ block: "nearest" });

export function WorkList<T extends Row>({
  kind,
  repo,
  service,
  rows,
  count,
  partial,
  historyRead,
  read,
  at,
  row,
  render,
}: {
  kind: "pr" | "issue";
  repo: string;
  service: string;
  rows: readonly T[];
  count: number | null;
  partial: boolean;
  historyRead: boolean;
  /** False when this sweep's read failed; the rows are then what an earlier read held. */
  read?: boolean | undefined;
  at?: string | undefined;
  row: string | undefined;
  render: (row: T) => RowContent;
}) {
  const selected = rows.find((entry) => String(entry.number) === row);
  const [localOpen, setLocalOpen] = useState<string>();
  const open = row ?? localOpen;
  const [filter, setFilter] = useState<Filter>(selected && !actionable(selected) ? "all" : "open");
  const [query, setQuery] = useState("");
  const [previousRow, setPreviousRow] = useState(row);
  const done = kind === "pr" ? "merged" : "closed";
  const tab = kind === "pr" ? "pulls" : "issues";
  const word = kind === "pr" ? "pull requests" : "issues";
  const needle = query.trim().toLowerCase();
  const shown = rows.filter(
    (entry) =>
      (filter === "all" || (filter === "open" ? actionable(entry) : entry.state === done)) &&
      `#${entry.number} ${entry.title} ${entry.author ?? ""}`.toLowerCase().includes(needle),
  );
  if (row !== previousRow) {
    setPreviousRow(row);
    if (selected && !shown.includes(selected)) {
      setFilter(actionable(selected) ? "open" : "all");
      setQuery("");
    }
  }
  const toggle = (id: string, expanded: boolean) => {
    if (row) {
      setLocalOpen(undefined);
      navigate({ kind: "service", id: service, tab, ...(expanded ? {} : { row: id }) });
    } else setLocalOpen(expanded ? undefined : id);
  };
  const unreadOpen = filter !== "done" && count === null && !partial;
  const unreadPast = filter !== "open" && !historyRead;
  return (
    <section
      className="service-work"
      data-work={kind}
      aria-label={kind === "pr" ? "Pull requests" : "Issues"}
    >
      {read === false && (count !== null || partial || rows.length > 0) && (
        <NotRead id={service} what={kind === "pr" ? "Pull requests" : "Issues"} at={at} />
      )}
      <div className="work-filters">
        <button type="button" aria-pressed={filter === "open"} onClick={() => setFilter("open")}>
          Open {count ?? "⌀"}
        </button>
        <button type="button" aria-pressed={filter === "done"} onClick={() => setFilter("done")}>
          {done === "merged"
            ? `Merged ${historyRead ? rows.filter((entry) => entry.state === done).length : "⌀"}`
            : "Closed"}
        </button>
        <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
          All
        </button>
        <input
          type="search"
          aria-label={`Filter ${word}`}
          placeholder="Filter by title, author or number"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <LinkPill
          link={{
            kind: "other",
            label: "All on GitHub",
            url: `https://github.com/${repo}/${kind === "pr" ? "pulls" : "issues"}`,
          }}
        />
      </div>
      {unreadOpen && <p>⌀ Open {word} were not read.</p>}
      {unreadPast && (
        <p>
          ⌀ Recent {done === "merged" ? "merged and closed" : done} {word} were not read.
        </p>
      )}
      {filter !== "done" && partial && (
        <p>
          Read the newest {rows.filter((entry) => entry.state === "open").length} open {word}. The
          list is partial.
        </p>
      )}
      <ul className="service-section-box">
        {shown.length === 0 && !unreadOpen && !unreadPast && (
          <li className="work-empty">
            {needle
              ? "Nothing matches."
              : `No ${filter === "done" ? `recent ${done}` : filter === "open" ? "open" : "recent"} ${word}.`}
          </li>
        )}
        {shown.map((entry) => {
          const id = String(entry.number);
          const expanded = open === id;
          const { subtitle, status, summary, companion } = render(entry);
          return (
            <li key={id} data-row={id} data-open={expanded || undefined}>
              <div className="work-row">
                <LinkPill
                  link={{ kind, label: `${kind === "pr" ? "PR" : "Issue"} #${id}`, url: entry.url }}
                />
                <div>
                  <button
                    type="button"
                    className="service-row-head"
                    aria-expanded={expanded}
                    ref={entry === selected ? scrollToRow : undefined}
                    onClick={() => toggle(id, expanded)}
                  >
                    {entry.title}
                  </button>
                  <div className="work-subtitle">
                    {subtitle.filter(Boolean).join(" · ")}
                    {kind === "pr" && <RequestOwner url={entry.url} compact />}
                  </div>
                  {companion && (
                    <LinkPill
                      link={{
                        kind: "issue",
                        label: `Issue #${companion.number}`,
                        url: companion.url,
                      }}
                    />
                  )}
                </div>
                <div className="work-status">{status}</div>
                <span className="service-row-age">
                  {entry.createdAt && <When at={entry.createdAt} />}
                </span>
              </div>
              {expanded && <div className="work-summary">{summary}</div>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
