// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { FocusItem, RepoCell, RepoEntry, RepoLine, ViewSnapshot } from "@spi-code/contracts";
import { useEffect, useState } from "react";
import { setOpenSelection, useOpenSelection } from "../../app/navigation.js";
import { SectionEvidence } from "../../components/evidence/SectionEvidence.js";
import { isReadFigure } from "../../components/place/RepositoryFacts.js";
import { RepositoryLine, repositorySelectionId } from "../../components/place/RepositoryLine.js";
import { plainTitle } from "../../text.js";
import "./repositories.css";

const LISTED = ["Issues", "Pull Requests", "Dependabot Bumps"];
const SECURITY = ["Vulnerabilities", "Code scanning"];

export function todayItems({ briefing }: ViewSnapshot): FocusItem[] {
  return [...briefing.focus, ...briefing.rest];
}

/** The Today member core resolved the line to; a line core left unassociated claims nothing. */
export function lineItem(line: RepoLine, items: readonly FocusItem[]): FocusItem | undefined {
  const id = line.onToday?.id;
  return id === undefined ? undefined : items.find((item) => item.id === id);
}

function sourceOf(url: string) {
  const match = /\/(pull|issues)\/(\d+)(?:[/?#]|$)/.exec(url);
  if (!match) return undefined;
  return { kind: match[1] === "pull" ? "PR" : "Issue", number: match[2] };
}

export function SourcePill({ url }: { url: string }) {
  const source = sourceOf(url);
  if (!source) return null;
  const label = `${source.kind} #${source.number}`;
  return (
    <button
      type="button"
      className="repos-pill"
      data-kind={source.kind}
      aria-label={`Open ${label} on GitHub`}
      onClick={() => void window.spi.openExternal(url)}
    >
      {label} ↗
    </button>
  );
}

function Cell({ cell }: { cell: RepoCell }) {
  if (!isReadFigure(cell.text)) {
    return (
      <td title="not read" aria-label="not read" data-unread="">
        ⌀
      </td>
    );
  }
  if (cell.text === "0" && !cell.rest) {
    return (
      <td aria-label="none" data-zero="">
        ·
      </td>
    );
  }
  return (
    <td>
      {cell.text}
      {cell.rest && <span className="repos-rest">{cell.rest}</span>}
    </td>
  );
}

function Lines({
  entry,
  items,
  snapshot,
  pointer,
  onSecurity,
}: {
  entry: RepoEntry;
  items: readonly FocusItem[];
  snapshot: ViewSnapshot;
  pointer: string;
  onSecurity: () => void;
}) {
  const listed = entry.sections
    .map((section, index) => ({ section, pointer: `${pointer}/sections/${index}` }))
    .filter(({ section: { title, lines } }) => LISTED.includes(title) && lines.length > 0);
  const security = entry.sections.filter(({ title }) => SECURITY.includes(title));
  return (
    <div className="repos-lines">
      {listed.length === 0 && <p className="repos-quiet">No lines listed here.</p>}
      {listed.map(({ section, pointer }) => (
        <section
          className="repos-line-section"
          key={section.title}
          aria-label={`${entry.name} ${section.title}`}
        >
          <h3>
            {section.title} · {section.count}
            {section.rest}
          </h3>
          <ul>
            {section.lines.map((line, index) => {
              const item = lineItem(line, items);
              return (
                <li key={line.id ?? index} data-line={line.id} data-on-today={item?.id}>
                  <RepositoryLine
                    repository={entry.name}
                    section={section.title}
                    line={line}
                    pointer={`${pointer}/lines/${index}`}
                    snapshot={snapshot}
                    className="repos-line-text"
                  >
                    {plainTitle(line.text)}{" "}
                    <span className="repos-line-sub">{plainTitle(line.sub)}</span>
                  </RepositoryLine>
                  {item ? (
                    <button
                      type="button"
                      className="repos-on-today"
                      onClick={() =>
                        setOpenSelection({
                          kind: "rline",
                          id: repositorySelectionId(entry.name, line, `${pointer}/lines/${index}`),
                        })
                      }
                    >
                      On Today · {plainTitle(item.title)}
                    </button>
                  ) : (
                    <span />
                  )}
                  {line.url ? <SourcePill url={line.url} /> : <span />}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {security.length > 0 && (
        <section aria-label={`${entry.name} Security`}>
          <h3>Security</h3>
          <button type="button" className="repos-security" onClick={onSecurity}>
            {security.map(({ title, count }) => `${title} ${count}`).join(" · ")} › on Security
          </button>
        </section>
      )}
    </div>
  );
}

export function Repositories({
  snapshot,
  onSecurity,
}: {
  snapshot: ViewSnapshot;
  onSecurity: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const { rows } = snapshot.briefing.repositories;
  const marked = useOpenSelection();
  useEffect(() => {
    if (marked?.kind !== "rline") return;
    const entry = rows.find((entry, row) =>
      entry.sections.some((section, at) =>
        section.lines.some(
          (line, index) =>
            repositorySelectionId(
              entry.name,
              line,
              `/briefing/repositories/rows/${row}/sections/${at}/lines/${index}`,
            ) === marked.id,
        ),
      ),
    );
    setOpen(entry?.id ?? null);
    if (!entry) setOpenSelection(null);
  }, [marked?.kind, marked?.id, rows]);
  if (rows.length === 0) return null;
  const items = todayItems(snapshot);
  return (
    <section className="repos" aria-label="Repositories">
      <div className="repos-head">
        <h2>Repositories</h2>
        <SectionEvidence evidence={snapshot} prefixes={["/briefing/repositories"]} />
      </div>
      <table>
        <thead>
          <tr>
            <th scope="col">Repository</th>
            <th scope="col">
              Issues <small>· human · other</small>
            </th>
            <th scope="col">
              PRs <small>· all</small>
            </th>
            <th scope="col">
              Dependabot <small>· all</small>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((entry, index) => {
            const expanded = open === entry.id;
            const onToday = entry.sections.some(({ lines }) =>
              lines.some((line) => lineItem(line, items)),
            );
            return [
              <tr
                key={entry.id}
                className="repos-row"
                data-repo={entry.name}
                data-pointer={`/briefing/repositories/rows/${index}`}
              >
                <th scope="row">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : entry.id)}
                  >
                    <span aria-hidden="true">{expanded ? "▾" : "▸"}</span> {entry.name}
                    {onToday && <span className="repos-mark"> · on Today</span>}
                  </button>
                </th>
                <Cell cell={entry.cells.issues} />
                <Cell cell={entry.cells.changes} />
                <Cell cell={entry.cells.dependabot} />
              </tr>,
              expanded && (
                <tr key={`${entry.id}:lines`} className="repos-expanded">
                  <td colSpan={4}>
                    <Lines
                      entry={entry}
                      items={items}
                      snapshot={snapshot}
                      pointer={`/briefing/repositories/rows/${index}`}
                      onSecurity={onSecurity}
                    />
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>
    </section>
  );
}
