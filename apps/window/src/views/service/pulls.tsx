// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ServicePull } from "@spi-code/contracts";
import { LinkPill } from "../../components/kit/LinkPill.js";
import { PendingRequests } from "../../threads/PendingRequests.js";
import { When } from "../../time.js";
import type { TabProps } from "./tabs.js";
import { serviceWorkOf, WorkList } from "./work-list.js";

export const pullCount = ({ snapshot, id }: Pick<TabProps, "snapshot" | "id">) =>
  serviceWorkOf(snapshot, id)?.pulls.count ?? null;

export const pullsHeld = ({ snapshot, id }: Pick<TabProps, "snapshot" | "id">) =>
  serviceWorkOf(snapshot, id)?.pulls.read === false;

export function Pulls({ id, home, snapshot, row }: TabProps) {
  const list = serviceWorkOf(snapshot, id)?.pulls;
  return (
    <>
      <PendingRequests sweep={snapshot} scope={id} forge="github" />
      <WorkList
        key={id}
        kind="pr"
        repo={home.repo}
        service={id}
        rows={list?.rows ?? []}
        count={list?.count ?? null}
        partial={list?.partial ?? false}
        historyRead={list?.pastRead ?? false}
        read={list?.read}
        at={list?.at}
        row={row}
        render={(pr) => ({
          subtitle: pr.state === "open" ? [pr.author, `into ${pr.base}`] : [pr.author],
          status: <PullStatus pr={pr} />,
          summary: <PullSummary pr={pr} />,
          companion: pr.companion,
        })}
      />
    </>
  );
}

function PullStatus({ pr }: { pr: ServicePull }) {
  if (pr.state !== "open") {
    return (
      <span>
        {pr.state === "merged" ? `Merged into ${pr.base}` : "Closed without merging"}
        {pr.finishedAt && (
          <>
            {" "}
            · <When at={pr.finishedAt} />
          </>
        )}
      </span>
    );
  }
  const { passed, failed, skipped, state } = pr.checks;
  const neutral =
    skipped === undefined
      ? "Checks not read"
      : skipped > 0
        ? `${skipped} skipped`
        : "No checks reported";
  return (
    <>
      {pr.labels.length > 0 && (
        <span>
          {pr.labels.map((label) => (
            <span className="service-tag" key={label}>
              {label}
            </span>
          ))}
        </span>
      )}
      <span>
        {passed > 0 && <span data-tone="success">{passed} passed</span>}
        {failed.length > 0 && <span data-tone="error">{failed.join(", ")} failed</span>}
        {state === "pending" && <span>Checks pending</span>}
        {state === null && <span>{neutral}</span>}
      </span>
      {pr.gate && <span data-tone={pr.waiting ? "warning" : undefined}>{pr.gate}</span>}
    </>
  );
}

function PullSummary({ pr }: { pr: ServicePull }) {
  return (
    <>
      {pr.state === "open" && pr.carries && <p>{pr.carries}</p>}
      <p>
        <code>{pr.head}</code> → <code>{pr.base}</code>
      </p>
      {pr.state === "open" && (
        <>
          <p>
            Reviewers{" "}
            {pr.reviewers?.length
              ? pr.reviewers.join(", ")
              : pr.reviewers && !pr.reviewersCut
                ? "None"
                : "⌀ not read"}
            {pr.reviewersCut && !!pr.reviewers?.length && " · partial"}
          </p>
          <LinkPill link={{ kind: "other", label: "Checks", url: `${pr.url}/checks` }} />
          <LinkPill link={{ kind: "other", label: "Files", url: `${pr.url}/files` }} />
        </>
      )}
    </>
  );
}
