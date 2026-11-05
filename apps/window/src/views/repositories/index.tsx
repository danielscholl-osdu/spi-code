// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { RepoCell, RepoEntry } from "@spi-code/contracts";
import { useState } from "react";
import { useStore } from "zustand";
import { AreaEnvelopes, InferredMark } from "../../components/evidence/AreaEnvelopes.js";
import type { Evidence } from "../../store/evidence.js";
import { watchStore } from "../../store/watch.js";
import "./panes.css";

function Cell({
  cell,
  evidence,
  pointer,
}: {
  cell: RepoCell;
  evidence: Evidence;
  pointer: string;
}) {
  return (
    <span className="repo-cell" data-pointer={pointer}>
      <span data-tone={cell.tone} data-muted={cell.text === "0"}>
        {cell.text}
      </span>
      {cell.rest && <span data-muted={cell.fade || cell.rest === " · 0"}>{cell.rest}</span>}
      <InferredMark evidence={evidence} pointer={pointer} />
    </span>
  );
}

function Detail({
  repo,
  selected,
  evidence,
  pointer,
}: {
  repo: RepoEntry;
  selected: boolean;
  evidence: Evidence;
  pointer: string;
}) {
  const sections = [
    ...repo.sections.filter((section) => section.weight !== "quiet"),
    ...repo.sections.filter((section) => section.weight === "quiet"),
  ];
  return (
    <section data-repo-detail={repo.id} data-pointer={pointer} hidden={!selected}>
      <p>{repo.name}</p>
      <h3 data-tone={repo.tone}>
        {repo.title}
        <InferredMark evidence={evidence} pointer={pointer} />
      </h3>
      <p>{repo.sub}</p>
      {sections.map((section) => (
        <div key={section.title} data-weight={section.weight}>
          <p className="repo-section-title">
            <span>{section.title}</span>
            <span>
              {section.count}
              {section.rest && <span data-muted>{section.rest}</span>}
            </span>
          </p>
          {section.lines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: line text repeats across manifests and lines have no id
            <div className="repo-line" data-upstream={line.upstream} key={index}>
              <span data-tone={line.tone}>{line.tag}</span>
              <span>{line.text}</span>
              <span data-muted>{line.sub}</span>
            </div>
          ))}
        </div>
      ))}
      {repo.note && <p data-muted>{repo.note}</p>}
      <button type="button" onClick={() => watchStore.getState().select(repo.id)}>
        Open in inspector
      </button>
    </section>
  );
}

export default function Repositories() {
  const evidence = useStore(watchStore, (state) => state.snapshot?.body);
  const repositories = evidence?.briefing.repositories;
  const [picked, pick] = useState<string | null>(null);
  const selected = repositories?.rows.some((repo) => repo.id === picked)
    ? picked
    : repositories?.first;
  return (
    <>
      <h1>Repositories</h1>
      <div className="watch-pane" data-view-pane="repositories">
        {!repositories || !evidence ? (
          <p role="status">No repositories read yet.</p>
        ) : (
          <>
            <AreaEnvelopes evidence={evidence} prefixes={["/briefing/repositories/headline"]} />
            <h2 data-pointer="/briefing/repositories/headline">
              {repositories.headline}
              <InferredMark evidence={evidence} pointer="/briefing/repositories/headline" />
            </h2>
            {!!repositories.facts.length && (
              <>
                <AreaEnvelopes evidence={evidence} prefixes={["/briefing/repositories/facts"]} />
                <div className="pane-facts">
                  {repositories.facts.map((fact, index) => {
                    const pointer = `/briefing/repositories/facts/${index}/figure`;
                    return (
                      <div
                        className="pane-fact"
                        data-tone={fact.tone}
                        data-pointer={pointer}
                        key={fact.label}
                      >
                        <div>{fact.label}</div>
                        <strong>{fact.figure}</strong>
                        <InferredMark evidence={evidence} pointer={pointer} />
                        <div>{fact.sub}</div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            {!!repositories.rows.length && (
              <AreaEnvelopes evidence={evidence} prefixes={["/briefing/repositories/rows"]} />
            )}
            {!!repositories.rows.length && (
              <div className="pane-split">
                <div className="repo-table">
                  <div className="repo-grid">
                    <div className="repo-head">
                      <span>Repository</span>
                      <span>
                        Issues
                        <small>
                          human<span data-muted> · other</span>
                        </small>
                      </span>
                      <span>Pull Requests</span>
                      <span>Dependabot Bumps</span>
                      <span>
                        Vulnerabilities
                        <small>
                          ours<span data-muted> · upstream</span>
                        </small>
                      </span>
                      <span>
                        Code scanning
                        <small>
                          ours<span data-muted> · upstream</span>
                        </small>
                      </span>
                    </div>
                    {(["program", "fork"] as const).map((group) => {
                      const rows = repositories.rows.filter((repo) => repo.group === group);
                      return rows.length ? (
                        <div key={group}>
                          <p>{group === "program" ? "Program" : "Forks"}</p>
                          {rows.map((repo) => {
                            const pointer = `/briefing/repositories/rows/${repositories.rows.indexOf(repo)}`;
                            const cell = (name: keyof RepoEntry["cells"]) => (
                              <Cell
                                cell={repo.cells[name]}
                                evidence={evidence}
                                pointer={`${pointer}/cells/${name}`}
                              />
                            );
                            return (
                              <button
                                className="repo-row"
                                type="button"
                                key={repo.id}
                                data-repo={repo.id}
                                aria-pressed={repo.id === selected}
                                onClick={() => pick(repo.id)}
                              >
                                <span data-pointer={pointer}>
                                  {repo.name}
                                  <InferredMark evidence={evidence} pointer={pointer} />
                                </span>
                                {cell("issues")}
                                {cell("changes")}
                                {cell("dependabot")}
                                {cell("vulnerabilities")}
                                {cell("codeScanning")}
                              </button>
                            );
                          })}
                        </div>
                      ) : null;
                    })}
                  </div>
                  <p data-muted>
                    Vulnerabilities are Dependabot alerts on the libraries a service uses. Code
                    scanning is CodeQL and Scorecard findings in the source itself. Both count
                    critical and high alerts in shipped code only. Pipeline PRs stay on Flow.
                  </p>
                </div>
                <div>
                  {repositories.rows.map((repo, index) => (
                    <Detail
                      key={repo.id}
                      repo={repo}
                      selected={repo.id === selected}
                      evidence={evidence}
                      pointer={`/briefing/repositories/rows/${index}`}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
