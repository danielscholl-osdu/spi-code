// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { CanWaitCause, CanWaitCauses, ViewSnapshot } from "@spi-code/contracts";
import { Fragment, useEffect, useRef } from "react";
import {
  navigate,
  openEvidence,
  openSelection,
  setOpenSelection,
  useOpenSelection,
} from "../../app/navigation.js";
import { LinkPill } from "../../components/kit/LinkPill.js";
import { plainTitle } from "../../text.js";
import { forksWord } from "./fleet.js";
import { ageInOneUnit, ForkName, Section } from "./parts.js";

const PLACES = {
  releases: { label: "Releases", destination: { kind: "releases" } },
  security: { label: "Security", destination: { kind: "security" } },
} as const;

const UNITS: Readonly<Record<CanWaitCause["kind"], [string, string]>> = {
  release: ["PR", "PRs"],
  dependabot: ["PR", "PRs"],
  other: ["PR", "PRs"],
  issue: ["issue", "issues"],
  alert: ["alert", "alerts"],
};

const KIND_NAMES: Readonly<Record<CanWaitCause["kind"], string>> = {
  release: "Release PRs",
  dependabot: "Dependabot PRs",
  other: "Other PRs",
  issue: "Issues",
  alert: "Alerts",
};

const isCause = (open: { kind: string; id: string } | null, id: string) =>
  open?.kind === "cause" && open.id === id;

/** Opens a Can wait cause on Yours, the way a door does. */
export function openCause(row: string) {
  navigate({ kind: "today" });
  setOpenSelection({ kind: "cause", id: row });
}

type Fork = CanWaitCause["forks"][number];

/** What a fork holds of a cause: its PR's age, its one object, or its count. */
function forkDetail(kind: CanWaitCause["kind"], fork: Fork): string {
  const [only] = fork.objects;
  if (kind === "release" && only?.age) return ageInOneUnit(only.age) ?? only.age;
  if ((kind === "other" || kind === "issue") && fork.objects.length === 1 && only)
    return only.label;
  return String(fork.count);
}

/** A fork opens its service page with the row holding the object open, or the cause's place. */
function ForkPill({
  cause,
  fork,
  snapshot,
}: {
  cause: CanWaitCause;
  fork: Fork;
  snapshot: ViewSnapshot;
}) {
  const words = `${fork.fork} ${forkDetail(cause.kind, fork)}`;
  const home = snapshot.services?.find(({ service }) => service === fork.fork)?.home;
  const urls = new Set(fork.objects.map(({ url }) => url));
  const row = home?.overview.find(({ links }) => links.some(({ url }) => urls.has(url)));
  const place = cause.place && PLACES[cause.place];
  const [first] = fork.objects;
  if (!home && !place)
    return first ? <LinkPill link={{ kind: "other", label: words, url: first.url }} /> : null;
  return (
    <button
      type="button"
      className="today-cause-fork"
      data-fork={fork.fork}
      onClick={() =>
        navigate(
          home
            ? { kind: "service", id: fork.fork, ...(row ? { tab: "overview", row: row.id } : {}) }
            : (place?.destination ?? { kind: "today" }),
        )
      }
    >
      {words} ›
    </button>
  );
}

function CauseBody({
  cause,
  notRead,
  snapshot,
  onClose,
}: {
  cause: CanWaitCause;
  notRead: readonly string[];
  snapshot: ViewSnapshot;
  onClose(): void;
}) {
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [onClose]);
  useEffect(
    () => () => {
      if (isCause(openSelection(), cause.id)) setOpenSelection(null);
    },
    [cause.id],
  );
  const { packages = [], rules } = cause;
  return (
    <div className="opened-body today-cause-body">
      {packages.length > 0 && (
        <ul className="today-cause-packages" aria-label="On more than one fork">
          {packages.map(({ ecosystem, name, forks }) => (
            <li key={`${ecosystem}/${name}`}>
              {ecosystem}/{name} on {forks.join(", ")}
            </li>
          ))}
        </ul>
      )}
      {rules && (
        <p className="today-cause-rules">
          Most alerts: {rules.mostAlerts.name} ({rules.mostAlerts.count}). On the most forks:{" "}
          {rules.mostForks.name} ({forksWord(rules.mostForks.count)}).
        </p>
      )}
      <nav className="today-cause-forks" aria-label={`${plainTitle(cause.headline)} by fork`}>
        {cause.forks.map((fork) => (
          <ForkPill key={fork.fork} cause={cause} fork={fork} snapshot={snapshot} />
        ))}
      </nav>
      {notRead.length > 0 && <NotRead forks={notRead} />}
    </div>
  );
}

/** The forks a read missed, and the way to Evidence. */
export function NotRead({ forks, what }: { forks: readonly string[]; what?: string }) {
  return (
    <p className="today-not-read">
      ⌀ {what ? `${what} not read` : "Not read"} on {forks.join(", ")}.{" "}
      <button type="button" onClick={() => openEvidence(null)}>
        Evidence ›
      </button>
    </p>
  );
}

/** Can wait by cause: each row opens in place into its forks; Release and Security open their place. */
export function CanWait({
  causes,
  snapshot,
  services,
}: {
  causes: CanWaitCauses;
  snapshot: ViewSnapshot;
  services: ReadonlySet<string>;
}) {
  const open = useOpenSelection();
  const heads = useRef(new Map<string, HTMLButtonElement | null>());
  const openCauseId = open?.kind === "cause" ? open.id : undefined;
  useEffect(() => {
    const head = openCauseId && heads.current.get(openCauseId);
    if (!head) return;
    head.focus({ preventScroll: true });
    head.closest("tr")?.scrollIntoView?.({ block: "nearest" });
  }, [openCauseId]);
  const kinds = new Set(causes.rows.map(({ kind }) => kind));
  const unread = (Object.keys(causes.notRead) as CanWaitCause["kind"][]).filter(
    (kind) => causes.notRead[kind].length > 0 && !kinds.has(kind),
  );
  if (causes.rows.length === 0 && unread.length === 0) return null;
  return (
    <Section id="can-wait" label="Can wait">
      <tbody>
        {causes.rows.map((cause) => {
          const opened = isCause(open, cause.id);
          const place = cause.place && PLACES[cause.place];
          const [one] = cause.forks;
          const notRead = causes.notRead[cause.kind];
          const [singular, plural] = UNITS[cause.kind];
          const close = () => {
            setOpenSelection(null);
            heads.current.get(cause.id)?.focus();
          };
          return (
            <Fragment key={cause.id}>
              <tr
                className="today-row today-row--cause"
                data-row={cause.id}
                data-cause={cause.kind}
                data-fork-count={cause.forkCount}
                {...(opened ? { "data-open": "" } : {})}
              >
                <td className="today-row-fork">
                  {cause.forks.length === 1 && one ? (
                    <ForkName fork={one.fork} services={services} />
                  ) : (
                    <span className="today-fork-name">
                      {forksWord(cause.forkCount || cause.forks.length)}
                    </span>
                  )}
                </td>
                <td className="today-row-what">
                  <button
                    type="button"
                    aria-expanded={opened}
                    ref={(button) => {
                      heads.current.set(cause.id, button);
                    }}
                    onClick={() =>
                      setOpenSelection(opened ? null : { kind: "cause", id: cause.id })
                    }
                  >
                    {plainTitle(cause.headline)}
                  </button>
                </td>
                <td className="today-row-open">
                  {place && (
                    <button
                      type="button"
                      className="today-row-place"
                      data-place={cause.place}
                      onClick={() => navigate(place.destination)}
                    >
                      {place.label} ›
                    </button>
                  )}
                </td>
                <td className="today-row-age">
                  {notRead.length > 0 && (
                    <span className="today-row-gaps" title={notRead.join(", ")}>
                      ⌀{" "}
                    </span>
                  )}
                  {cause.count} {cause.count === 1 ? singular : plural}
                </td>
              </tr>
              {opened && (
                <tr className="today-row-body" data-open="">
                  <td />
                  <td colSpan={3}>
                    <CauseBody
                      cause={cause}
                      notRead={notRead}
                      snapshot={snapshot}
                      onClose={close}
                    />
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
      {unread.length > 0 && (
        <tfoot>
          {unread.map((kind) => (
            <tr key={kind} className="today-row today-row--unread" data-unread={kind}>
              <td colSpan={4}>
                <NotRead forks={causes.notRead[kind]} what={KIND_NAMES[kind]} />
              </td>
            </tr>
          ))}
        </tfoot>
      )}
    </Section>
  );
}
