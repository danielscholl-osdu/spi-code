// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { RepoEntry } from "@spi-code/contracts";

const COLUMNS = [
  ["issues", "Issues", "human · other"],
  ["changes", "Pull Requests", ""],
  ["dependabot", "Dependabot Bumps", ""],
  ["vulnerabilities", "Vulnerabilities", "ours · upstream"],
  ["codeScanning", "Code scanning", "ours · upstream"],
] as const;

export const isReadFigure = (value: string) => !/^(?:\?|not read yet)?$/i.test(value.trim());

export function RepositoryFacts({
  repository,
  pointer,
}: {
  repository: RepoEntry;
  pointer: string;
}) {
  const columns = COLUMNS.filter(([key]) => isReadFigure(repository.cells[key].text));
  if (columns.length === 0) return null;
  return (
    <section className="repository-counts" data-pointer={`${pointer}/cells`}>
      <h3>
        {repository.group === "program" ? "Program" : "Forks"} · {repository.name}
      </h3>
      <dl>
        {columns.map(([key, label, sub]) => {
          const cell = repository.cells[key];
          return (
            <div key={key} data-pointer={`${pointer}/cells/${key}`}>
              <dt>
                {label}
                {sub && <small> · {sub}</small>}
              </dt>
              <dd>
                <span data-tone={cell.tone}>{cell.text}</span>
                {cell.rest && <span data-muted={cell.fade || undefined}>{cell.rest}</span>}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
