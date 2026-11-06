// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { RepoEntry } from "@spi-code/contracts";
import { useStore } from "zustand";
import { navigate } from "../../app/routes.js";
import { SectionEvidence } from "../../components/evidence/SectionEvidence.js";
import { watchStore } from "../../store/watch.js";
import { blankCell, type LensColumn, type LensRow, LensTable } from "../lenses/table.js";
import "./panes.css";

const columns: LensColumn<RepoEntry>[] = [
  { label: "Repository", value: (row) => row.name },
  ...(
    [
      ["Issues", "issues", "human · other"],
      ["Pull Requests", "changes", ""],
      ["Dependabot Bumps", "dependabot", ""],
      ["Vulnerabilities", "vulnerabilities", "ours · upstream"],
      ["Code scanning", "codeScanning", "ours · upstream"],
    ] as const
  ).map(
    ([label, key, sub]): LensColumn<RepoEntry> => ({
      label,
      heading: (
        <>
          {label}
          {sub && <small>{sub}</small>}
        </>
      ),
      value: (row) => `${blankCell(row.cells[key].text)}${blankCell(row.cells[key].rest ?? "")}`,
      render: (row) => {
        const cell = row.cells[key];
        return (
          <span className="repo-cell">
            <span data-tone={cell.tone} data-muted={cell.text === "0"}>
              {blankCell(cell.text)}
            </span>
            {cell.rest && (
              <span data-muted={cell.fade || cell.rest === " · 0"}>{blankCell(cell.rest)}</span>
            )}
          </span>
        );
      },
    }),
  ),
  {
    label: "Needs",
    value: (row) => row.title,
    render: (row) => <span data-tone={row.tone}>{blankCell(row.title)}</span>,
  },
];

export default function Repositories() {
  const evidence = useStore(watchStore, (state) => state.snapshot?.body);
  const repositories = evidence?.briefing.repositories;
  return (
    <section className="lens watch-pane" data-view-pane="repositories" aria-label="Repositories">
      <h1>Repositories</h1>
      {!repositories || !evidence ? (
        <p role="status">No repositories read yet.</p>
      ) : (
        <>
          <SectionEvidence evidence={evidence} prefixes={["/briefing/repositories/headline"]} />
          <h2 data-pointer="/briefing/repositories/headline">{repositories.headline}</h2>
          {repositories.facts.length > 0 && (
            <>
              <SectionEvidence evidence={evidence} prefixes={["/briefing/repositories/facts"]} />
              <div className="pane-facts">
                {repositories.facts.map((fact, index) => (
                  <div
                    className="pane-fact"
                    data-tone={fact.tone}
                    data-pointer={`/briefing/repositories/facts/${index}/figure`}
                    key={fact.label}
                  >
                    <div>{fact.label}</div>
                    <strong>{fact.figure}</strong>
                    <div>{fact.sub}</div>
                  </div>
                ))}
              </div>
            </>
          )}
          {repositories.rows.length > 0 && (
            <SectionEvidence evidence={evidence} prefixes={["/briefing/repositories/rows"]} />
          )}
          <LensTable
            lens="repositories"
            columns={columns}
            rows={repositories.rows
              .map(
                (row, index): LensRow<RepoEntry> => ({
                  reading: row,
                  group: row.group === "program" ? "Program" : "Forks",
                  pointer: `/briefing/repositories/rows/${index}`,
                  selection: {
                    id: row.id,
                    title: row.title,
                    kind: "repository",
                    prefixes: [`/briefing/repositories/rows/${index}`],
                  },
                }),
              )
              .sort((a, b) =>
                a.reading.group === b.reading.group ? 0 : a.reading.group === "program" ? -1 : 1,
              )}
            onOpen={(row) =>
              navigate(
                row.name === "osdu-spi"
                  ? { kind: "template" }
                  : row.name === "osdu-spi-stack"
                    ? { kind: "environment" }
                    : { kind: "service", id: row.id.replace(/^repo:/, "") },
              )
            }
          />
          <p className="lens-sub">
            Vulnerabilities are Dependabot alerts on the libraries a service uses. Code scanning is
            CodeQL and Scorecard findings in the source itself. Both count critical and high alerts
            in shipped code only. Pipeline PRs stay on Flow.
          </p>
        </>
      )}
    </section>
  );
}
