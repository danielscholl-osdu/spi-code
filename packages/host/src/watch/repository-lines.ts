// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  alertLine,
  changeLine,
  dependencyLine,
  groupUrl,
  type Model,
  type RepoLine,
  type Repositories,
} from "@spi-code/core";

const signature = ({ tag, tone, text, sub, upstream }: RepoLine) =>
  JSON.stringify([tag, tone, text, sub, upstream]);

export function repositoryLines(repositories: Repositories, model: Model, now: Date) {
  return {
    ...repositories,
    rows: repositories.rows.map((entry) => {
      const repo = model.repositories.rows.find((row) => `repo:${row.name}` === entry.id);
      if (!repo) throw new TypeError(`No model repository for ${entry.id}`);
      const prs = [
        ...repo.changes.map((change) => ({
          section: "Pull Requests",
          line: changeLine(change, now),
          pr: change.pr,
        })),
        ...repo.dependabot.map((dep) => ({
          section: "Dependabot Bumps",
          line: dependencyLine(dep),
          pr: dep.pr,
        })),
      ];
      const identities = new Map<string, { id: string; url: string }[]>();
      const add = (section: string, line: RepoLine, id: string, url: string) => {
        const key = `${section}:${signature(line)}`;
        const list = identities.get(key) ?? [];
        list.push({ id, url });
        identities.set(key, list);
      };
      for (const { section, line, pr } of prs) {
        add(section, line, `pr:${repo.repo}:${pr.number}`, pr.url);
      }
      for (const group of repo.alerts) {
        add(
          group.source === "dependabot" ? "Vulnerabilities" : "Code scanning",
          alertLine(group),
          `alert:${repo.repo}:${group.id}`,
          groupUrl(repo, group),
        );
      }
      const issues = new Map(
        Object.values(repo.issues)
          .flat()
          .map((issue) => [
            `${issue.title} · #${issue.number}`,
            { id: `issue:${repo.repo}:${issue.number}`, url: issue.url },
          ]),
      );
      return {
        ...entry,
        sections: entry.sections.map((section) => ({
          ...section,
          lines: section.lines.map((line) => {
            const identity =
              section.title === "Issues"
                ? issues.get(line.text)
                : identities.get(`${section.title}:${signature(line)}`)?.shift();
            if (!identity)
              throw new TypeError(`No recorded identity for ${entry.id}: ${line.text}`);
            return { ...line, ...identity };
          }),
        })),
      };
    }),
  };
}
