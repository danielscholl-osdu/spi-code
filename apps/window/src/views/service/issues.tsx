// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { LinkPill } from "../../components/kit/LinkPill.js";
import { When } from "../../time.js";
import type { TabProps } from "./tabs.js";
import { serviceWorkOf, WorkList } from "./work-list.js";

export const issueCount = ({ snapshot, id }: Pick<TabProps, "snapshot" | "id">) =>
  serviceWorkOf(snapshot, id)?.issues.count ?? null;

export const issuesHeld = ({ snapshot, id }: Pick<TabProps, "snapshot" | "id">) =>
  serviceWorkOf(snapshot, id)?.issues.read === false;

export function Issues({ id, home, snapshot, row }: TabProps) {
  const list = serviceWorkOf(snapshot, id)?.issues;
  return (
    <WorkList
      key={`${id}:${row ?? ""}`}
      kind="issue"
      repo={home.repo}
      service={id}
      rows={list?.rows ?? []}
      count={list?.count ?? null}
      partial={list?.partial ?? false}
      historyRead={list?.closedRead ?? false}
      read={list?.read}
      at={list?.at}
      row={row}
      render={(issue) => ({
        subtitle: [issue.author, issue.tracks && `tracks PR #${issue.tracks.number}`],
        status: (
          <>
            <span>
              {issue.labels.map((label) => (
                <span className="service-tag" key={label}>
                  {label}
                </span>
              ))}
            </span>
            {issue.state === "closed" && (
              <span>
                Closed
                {issue.closedAt && (
                  <>
                    {" "}
                    · <When at={issue.closedAt} />
                  </>
                )}
              </span>
            )}
          </>
        ),
        summary: (
          <>
            {issue.halt && <p>{issue.halt}</p>}
            {issue.createdAt && (
              <p>
                Opened <When at={issue.createdAt} />
              </p>
            )}
            {issue.tracks && (
              <LinkPill
                link={{ kind: "pr", label: `PR #${issue.tracks.number}`, url: issue.tracks.url }}
              />
            )}
          </>
        ),
      })}
    />
  );
}
