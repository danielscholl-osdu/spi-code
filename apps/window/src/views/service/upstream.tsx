// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ServiceUpstream } from "@spi-code/contracts";
import { LinkPill } from "../../components/kit/LinkPill.js";
import { PendingRequests } from "../../threads/PendingRequests.js";
import { RequestOwner } from "../../threads/RequestOwner.js";
import { When } from "../../time.js";
import { ListSection, listsOf, NotRead } from "./lists.js";
import type { ServiceTab, TabProps } from "./tabs.js";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function MrRow({
  iid,
  title,
  url,
  sub,
  at,
}: {
  iid: number;
  title: string;
  url: string;
  sub?: string | undefined;
  at: string;
}) {
  return (
    <li>
      <div className="service-list-row">
        <span>
          <LinkPill link={{ label: `MR !${iid}`, url, kind: "mr" }} filled />
          <RequestOwner url={url} compact />
        </span>
        <span className="service-list-what">
          <span className="service-list-title">{title}</span>
          {sub && <span className="service-list-sub">{sub}</span>}
        </span>
        <span className="service-row-age">
          <When at={at} />
        </span>
      </div>
    </li>
  );
}

function NextSync({ id, nextSync }: { id: string; nextSync: ServiceUpstream["nextSync"] }) {
  const { queue } = nextSync;
  const unread = !nextSync.read && <NotRead id={id} what="Upstream's queue" at={nextSync.at} />;
  if (!queue) return <ListSection id="next-sync" label="Next sync" before={unread} />;
  const { held, next, behind, head } = queue;
  if (behind === 0 && !nextSync.read)
    return <ListSection id="next-sync" label="Next sync" before={unread} />;
  return (
    <ListSection id="next-sync" label="Next sync" before={unread}>
      <li>
        <div className="service-list-line">
          <span>
            {behind === 0 ? (
              <>
                Nothing queued for the next sync.
                {head && (
                  <>
                    {" "}
                    The fork is at upstream's latest commit,{" "}
                    <span className="service-list-mono">{head.slice(0, 8)}</span>.
                  </>
                )}
              </>
            ) : (
              <>
                {held &&
                  (held.count === behind
                    ? `PR #${held.pr.number} holds upstream's ${plural(held.count, "new commit")}.`
                    : `PR #${held.pr.number} holds ${held.count} of upstream's ${behind} new commits.`)}
                {held && next.length > 0 && " "}
                {next.length > 0 &&
                  `${plural(next.length, "commit")} ${held ? "more come" : next.length === 1 ? "is queued" : "are queued"} with the next sync.`}
              </>
            )}
          </span>
          {held && (
            <LinkPill
              link={{ label: `PR #${held.pr.number}`, url: held.pr.url, kind: "pr" }}
              filled
            />
          )}
        </div>
      </li>
      {next.map((commit) => (
        <li key={commit.sha}>
          <div className="service-list-row">
            <span>
              <LinkPill link={{ label: commit.sha, url: commit.url, kind: "commit" }} />
            </span>
            <span className="service-list-what">
              <span className="service-list-title">{commit.title}</span>
            </span>
            <span />
          </div>
        </li>
      ))}
    </ListSection>
  );
}

/** What upstream holds for this fork: provider changes to port, the next sync, and its open MRs. */
export function Upstream({ id, snapshot }: TabProps) {
  const lists = listsOf(snapshot, id);
  if (!lists) return <NotRead id={id} what="Upstream" />;
  const { toPort, nextSync, open } = lists.upstream;
  const rest = open.list
    ? [
        open.list.drafts ? plural(open.list.drafts, "draft") : "",
        open.list.idle ? `${open.list.idle} idle over 30 days` : "",
      ].filter(Boolean)
    : [];
  return (
    <div className="service-lists">
      <ListSection
        id="to-port"
        label="To port"
        count={toPort.read ? toPort.mrs?.length : undefined}
        tag="Counted on Upstream"
        before={!toPort.read && <NotRead id={id} what="Provider changes to port" at={toPort.at} />}
      >
        {toPort.mrs &&
          (toPort.mrs.length === 0
            ? toPort.read && <li className="service-list-empty">Nothing to port.</li>
            : toPort.mrs.map((mr) => (
                <MrRow key={mr.iid} {...mr} sub={mr.trees.join(" · ")} at={mr.mergedAt} />
              )))}
      </ListSection>
      <NextSync id={id} nextSync={nextSync} />
      <ListSection
        id="open-upstream"
        label="Open upstream"
        count={open.read ? open.list?.total : undefined}
        before={
          <>
            {!open.read && <NotRead id={id} what="Open upstream" at={open.at} />}
            <PendingRequests sweep={snapshot} scope={id} forge="gitlab" />
          </>
        }
        after={
          open.list &&
          open.list.total > 0 && (
            <p className="service-list-note">
              {open.list.shown.length === 0
                ? "None moved within 30 days."
                : `Shown: ${plural(open.list.shown.length, "MR")} that moved within 30 days, newest first.`}
              {rest.length > 0 && ` Not shown: ${rest.join(", ")}.`}
            </p>
          )
        }
      >
        {open.list?.total === 0
          ? open.read && <li className="service-list-empty">None open.</li>
          : open.list?.shown.length
            ? open.list.shown.map((mr) => (
                <MrRow key={mr.iid} {...mr} sub={mr.author} at={mr.updatedAt} />
              ))
            : undefined}
      </ListSection>
    </div>
  );
}

export const UPSTREAM_TAB: ServiceTab = {
  id: "upstream",
  label: "Upstream",
  count: ({ id, snapshot }) => listsOf(snapshot, id)?.upstream.count ?? null,
  Panel: Upstream,
};
