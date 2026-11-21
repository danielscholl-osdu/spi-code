// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SecurityPill, SecurityRepoRow, SecurityRepoRule } from "@spi-code/contracts";
import { type MouseEvent, useId, useState } from "react";
import { navigate, routeHash } from "../../../app/navigation.js";
import { LinkPill } from "../../../components/kit/LinkPill.js";
import { REPOSITORY_ATTR, type SectionProps, type SecurityActions } from "./state.js";
import { Words, wordsText } from "./Words.js";
import "./ByRepository.css";

const BAR_SHARE = 78;
const EVIDENCE = { kind: "evidence", from: { kind: "security" } } as const;

/** A scanner's title, with its backticked words drawn as code. */
function Title({ title }: { title: string }) {
  return title.split("`").map((part, index) =>
    // biome-ignore lint/suspicious/noArrayIndexKey: a title's parts never reorder.
    index % 2 ? <code key={index}>{part}</code> : part,
  );
}

function Pill({ pill }: { pill: SecurityPill }) {
  return (
    <span className="security-repo-alert" data-heavy={pill.heavy || undefined}>
      <LinkPill
        link={{ label: pill.label, url: pill.url }}
        label={pill.label}
        accessibleName={pill.name}
      />
    </span>
  );
}

/** A fork's name opens its service page; a program repository's opens on GitHub. */
function RepoName({ row, id }: { row: SecurityRepoRow; id: string }) {
  if (row.program)
    return (
      <a
        id={id}
        className="security-repo-link"
        href={row.url}
        title={row.url}
        onClick={(event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          void window.spi?.openExternal(row.url);
        }}
      >
        {row.repository}
        <span aria-hidden="true"> ↗</span>
      </a>
    );
  const service = { kind: "service", id: row.repository } as const;
  return (
    <a
      id={id}
      className="security-repo-link"
      href={routeHash(service)}
      onClick={(event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        navigate(service);
      }}
    >
      {row.repository}
    </a>
  );
}

function Rule({
  row,
  rule,
  actions,
  shown,
  show,
}: {
  row: SecurityRepoRow;
  rule: SecurityRepoRule;
  actions: SecurityActions;
  shown: ReadonlySet<string>;
  show: (key: string) => void;
}) {
  const name = wordsText(rule.name);
  return (
    <div className="security-repo-rule">
      <span className="security-repo-rule-head">
        <button
          type="button"
          className="security-repo-rule-pill"
          title={name}
          aria-label={name}
          onClick={() => actions.openRule(rule.key, row.repository)}
        >
          <Title title={rule.title} />
        </button>
        <small>
          <Words words={rule.words} />
        </small>
      </span>
      {rule.files.length > 0 ? (
        <span className="security-repo-files">
          {rule.files.map((file) => {
            const key = `${row.repository}\n${rule.key}\n${file.path}`;
            const open = shown.has(key);
            return (
              <span key={file.path} className="security-repo-file">
                <span className="security-repo-file-name" title={file.path}>
                  <Words words={file.words} />
                </span>
                <span className="security-repo-pills">
                  {file.more ? (
                    <button
                      type="button"
                      className="security-repo-more"
                      aria-expanded={open}
                      onClick={() => show(key)}
                    >
                      <Words words={file.more} />
                      <span aria-hidden="true">{open ? " ⌃" : " ⌄"}</span>
                    </button>
                  ) : (
                    file.alerts.map((pill) => <Pill key={pill.url} pill={pill} />)
                  )}
                </span>
                {file.more && open && (
                  <span className="security-repo-all">
                    {file.alerts.map((pill) => (
                      <Pill key={pill.url} pill={pill} />
                    ))}
                  </span>
                )}
              </span>
            );
          })}
        </span>
      ) : (
        <span className="security-repo-pills">
          {rule.alerts.map((pill) => (
            <Pill key={pill.url} pill={pill} />
          ))}
        </span>
      )}
    </div>
  );
}

function Row({
  row,
  barMax,
  open,
  actions,
  shown,
  show,
}: {
  row: SecurityRepoRow;
  barMax: number;
  open: boolean;
  actions: SecurityActions;
  shown: ReadonlySet<string>;
  show: (key: string) => void;
}) {
  const id = useId();
  const toggle = () => actions.openRepository(open ? null : row.repository);
  const lower = row.alerts.n - row.high;
  return (
    <div
      className="security-repo"
      {...{ [REPOSITORY_ATTR]: row.repository }}
      data-open={open || undefined}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: the count button is the row's keyboard control. */}
      <div className="security-repo-grid security-repo-head" onClick={toggle}>
        <span className="security-repo-name">
          <RepoName row={row} id={`${id}-name`} />
          {row.sub.length > 0 && (
            <small>
              <Words words={row.sub} />
            </small>
          )}
          <small className="security-repo-page" title={wordsText(row.pageName)}>
            <Words words={row.page} />
          </small>
        </span>
        <button
          type="button"
          className="security-repo-alerts"
          aria-expanded={open}
          aria-labelledby={`${id}-name ${id}-count`}
          onClick={(event) => {
            event.stopPropagation();
            toggle();
          }}
        >
          <span
            className="security-repo-bar"
            aria-hidden="true"
            style={{ width: `${(row.alerts.n / Math.max(1, barMax)) * BAR_SHARE}%` }}
          >
            {row.high > 0 && <span data-part="high" style={{ flexGrow: row.high }} />}
            {lower > 0 && <span data-part="lower" style={{ flexGrow: lower }} />}
          </span>
          <b id={`${id}-count`}>
            <Words words={[row.alerts]} />
          </b>
          {!row.read && (
            <span className="security-repo-unread" aria-hidden="true" title={wordsText(row.unread)}>
              ⌀
            </span>
          )}
        </button>
        <span className="security-repo-top">
          <Words words={row.top} />
        </span>
      </div>
      {open && (
        <div className="security-repo-open">
          {row.rules.map((rule) => (
            <Rule
              key={rule.key}
              row={row}
              rule={rule}
              actions={actions}
              shown={shown}
              show={show}
            />
          ))}
          {row.unread.length > 0 && (
            <p className="security-repo-unreadline">
              <Words words={row.unread} />{" "}
              <a
                href={routeHash(EVIDENCE)}
                onClick={(event) => {
                  event.preventDefault();
                  navigate(EVIDENCE);
                }}
              >
                Evidence ›
              </a>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** The chosen lane by repository, with the repositories that hold nothing on one line. */
export function ByRepository({ lane, state, actions }: SectionProps) {
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const [cleanLane, setCleanLane] = useState<string | null>(null);
  const { columns, barMax, rows, clean, cleanShort } = lane.byRepository;
  if (rows.length === 0) return null;
  const show = (key: string) =>
    setShown((was) => {
      const next = new Set(was);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return (
    <div className="security-repos" data-lane={lane.id}>
      <div className="security-repo-grid security-repos-head">
        <span>{columns.repository}</span>
        <span>{columns.alerts}</span>
        <span data-column="top">{columns.top}</span>
      </div>
      {rows.map((row) => (
        <Row
          key={row.repository}
          row={row}
          barMax={barMax}
          open={state.repository === row.repository}
          actions={actions}
          shown={shown}
          show={show}
        />
      ))}
      {clean.length > 0 && (
        <p className="security-repos-clean">
          {cleanShort && cleanLane !== lane.id ? (
            <>
              <Words words={cleanShort.words} />
              <button type="button" aria-expanded={false} onClick={() => setCleanLane(lane.id)}>
                <Words words={cleanShort.more} />
              </button>
            </>
          ) : (
            <Words words={clean} />
          )}
        </p>
      )}
    </div>
  );
}
