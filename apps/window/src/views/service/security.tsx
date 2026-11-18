// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ServiceAlertRow } from "@spi-code/contracts";
import { Fragment, useState } from "react";
import { LinkPill } from "../../components/kit/LinkPill.js";
import { ListSection, listsOf, NotRead } from "./lists.js";
import type { ServiceTab, TabProps } from "./tabs.js";

type Alert = ServiceAlertRow["alerts"][number];

const GROUPS = [
  { id: "spi", label: "Shipped SPI code" },
  { id: "upstream", label: "Shipped upstream code" },
  { id: "tests", label: "In tests" },
] as const;
const SOURCE = { dependabot: "Dependabot", code: "CodeQL" } as const;

const word = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
const severityOf = (alert: Pick<Alert, "severity" | "ruleSeverity">) =>
  alert.severity
    ? word(alert.severity)
    : alert.ruleSeverity
      ? word(alert.ruleSeverity)
      : "No severity";
const heavy = (severity: Alert["severity"]) => severity === "critical" || severity === "high";

function titleOf(row: ServiceAlertRow) {
  if (row.source === "code") return row.title;
  const name = row.title.split(":").at(-1) ?? row.title;
  return row.fix === null ? `${name} · no fixed version` : row.fix ? `${name} → ${row.fix}` : name;
}

function whereOf(row: ServiceAlertRow) {
  const paths = [...new Set(row.alerts.flatMap(({ path }) => (path ? [path] : [])))];
  return paths.length > 1 ? `${paths.length} files` : paths[0];
}

function AlertPill({
  row,
  alert,
  severity,
}: {
  row: ServiceAlertRow;
  alert: Alert;
  severity?: boolean;
}) {
  const label = `${SOURCE[row.source]} #${alert.number}${severity ? ` · ${severityOf(alert)}` : ""}`;
  return (
    <>
      {alert.closedPr && (
        <LinkPill
          link={{
            label: `PR #${alert.closedPr.number} closed`,
            url: alert.closedPr.url,
            kind: "other",
          }}
        />
      )}
      <LinkPill link={{ label, url: alert.url, kind: "other" }} />
    </>
  );
}

function AlertItem({ row }: { row: ServiceAlertRow }) {
  const [open, setOpen] = useState(false);
  const [single] = row.alerts;
  const grouped = row.alerts.length > 1;
  const sub = [row.detail, whereOf(row)].filter(Boolean).join(" · ");
  return (
    <li data-alert-row={row.id} data-open={open || undefined}>
      <div className="service-alert-row">
        <span className="service-alert-severity" data-heavy={heavy(row.severity) || undefined}>
          {severityOf(row.severity ? row : (single ?? row))}
        </span>
        <span className="service-list-what">
          <span className="service-list-title">{titleOf(row)}</span>
          {sub && <span className="service-list-sub">{sub}</span>}
        </span>
        <span className="service-list-pills">
          {grouped ? (
            <button
              type="button"
              className="kit-link kit-link--muted service-alert-count"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              {row.alerts.length} {SOURCE[row.source]} alerts {open ? "⌃" : "⌄"}
            </button>
          ) : (
            single && <AlertPill row={row} alert={single} />
          )}
        </span>
      </div>
      {grouped && open && (
        <div className="service-alert-open">
          {row.alerts.map((alert) => (
            <AlertPill key={alert.number} row={row} alert={alert} severity />
          ))}
        </div>
      )}
    </li>
  );
}

/** Every open alert, grouped by whether it ships and whose code it is in. */
export function Security({ id, snapshot }: TabProps) {
  const lists = listsOf(snapshot, id);
  if (!lists) return <NotRead id={id} what="Security alerts" />;
  const { dependabot, code, rows } = lists.security;
  const unread = (
    <>
      {!dependabot.read && <NotRead id={id} what="Dependabot alerts" at={dependabot.at} />}
      {!code.read && <NotRead id={id} what="Code scanning alerts" at={code.at} />}
    </>
  );
  return (
    <div className="service-lists">
      <ListSection id="security" before={unread}>
        {rows.length === 0 && dependabot.read && code.read ? (
          <li className="service-list-empty">No open alerts.</li>
        ) : rows.length > 0 ? (
          GROUPS.map((group) => {
            const members = rows.filter((row) => row.group === group.id);
            if (members.length === 0) return null;
            const tooling = members.some((row) => row.tooling);
            return (
              <Fragment key={group.id}>
                <li className="service-alert-group" data-group={group.id}>
                  <span>{tooling ? `${group.label} and tooling` : group.label}</span>
                  <span>{members.reduce((n, row) => n + row.alerts.length, 0)}</span>
                </li>
                {members.map((row) => (
                  <AlertItem key={row.id} row={row} />
                ))}
              </Fragment>
            );
          })
        ) : undefined}
      </ListSection>
    </div>
  );
}

export const SECURITY_TAB: ServiceTab = {
  id: "security",
  label: "Security",
  count: ({ id, snapshot }) => listsOf(snapshot, id)?.security.count ?? null,
  Panel: Security,
};
