// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type {
  SecurityAdvisories,
  SecurityAdvisory,
  SecurityPane,
  SecurityPill,
  SecurityWhere,
} from "@spi-code/contracts";
import { useState } from "react";
import { navigate, openEvidence } from "../../../app/navigation.js";
import { LinkPill } from "../../../components/kit/LinkPill.js";
import { placePin } from "../../../store/pins.js";
import { AskAboutThis, useAskAbout } from "../../../threads/AskAboutThis.js";
import { type OpenedRuleProps, REPOSITORY_ATTR } from "./state.js";
import { Words } from "./Words.js";
import "./OpenedRule.css";

/** An opened rule or package: its facts, Where, and Ask about this. */
export function OpenedRule({ pane, state, actions, rule }: OpenedRuleProps) {
  const { facts, where, also, ask } = rule.opened;
  return (
    <div className="security-opened">
      <dl className="security-facts">
        {facts.map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd>
              <Words words={fact.words} />
              {fact.advisories && <Advisories advisories={fact.advisories} />}
            </dd>
          </div>
        ))}
      </dl>
      <div className="security-where">
        {where.map((line, index) => (
          <WhereLine
            // biome-ignore lint/suspicious/noArrayIndexKey: core's lines never reorder.
            key={index}
            line={line}
            pane={pane}
            marked={state.mark === line.repository}
          />
        ))}
      </div>
      {(also.length > 0 || ask) && (
        <div className="security-opened-acts">
          {also.map(({ key, words }) => (
            <button
              key={key}
              type="button"
              className="security-also"
              onClick={() => actions.openRule(key)}
            >
              <Words words={words} />
            </button>
          ))}
          {ask && <Ask fork={ask.fork} title={rule.title} />}
        </div>
      )}
    </div>
  );
}

function Ask({ fork, title }: { fork: string; title: string }) {
  const ask = useAskAbout({
    subject: placePin("security"),
    label: title,
    scope: fork,
    origin: `Started from Security › ${title}`,
  });
  return ask ? <AskAboutThis ask={ask} /> : null;
}

function Advisory({ advisory }: { advisory: SecurityAdvisory }) {
  return (
    <span className="security-advisory">
      <b>{advisory.id}</b> <Words words={advisory.words} />{" "}
      <span className="security-advisory-fix">
        <Words words={advisory.fix} />
      </span>
    </span>
  );
}

function Advisories({ advisories }: { advisories: SecurityAdvisories }) {
  const [all, setAll] = useState(false);
  const { preview, rest, disclosure } = advisories;
  return (
    <>
      {(all ? [...preview, ...rest] : preview).map((advisory) => (
        <Advisory key={advisory.id} advisory={advisory} />
      ))}
      {disclosure && (
        <button
          type="button"
          className="security-disclosure"
          aria-expanded={all}
          onClick={() => setAll(!all)}
        >
          <Words words={all ? disclosure.fewer : disclosure.more} />
        </button>
      )}
    </>
  );
}

function Pill({ pill, pr }: { pill: SecurityPill; pr?: boolean }) {
  return (
    <span className="security-pill" data-heavy={pill.heavy || undefined}>
      <LinkPill
        link={{ label: pill.label, url: pill.url, kind: pr ? "pr" : "other" }}
        label={pill.label}
        accessibleName={pill.name}
      />
    </span>
  );
}

function RepositoryName({ name, pane }: { name: string; pane: SecurityPane }) {
  const repository = pane.repositories.find((entry) => entry.name === name);
  if (repository?.program)
    return <LinkPill link={{ label: name, url: repository.url, kind: "other" }} label={name} />;
  return (
    <button
      type="button"
      className="security-where-name"
      onClick={() => navigate({ kind: "service", id: name, tab: "security" })}
    >
      {name}
    </button>
  );
}

function WhereLine({
  line,
  pane,
  marked,
}: {
  line: SecurityWhere;
  pane: SecurityPane;
  marked: boolean;
}) {
  const [open, setOpen] = useState(false);
  const attrs = { [REPOSITORY_ATTR]: line.repository };
  return (
    <div
      className="security-where-line"
      {...attrs}
      data-first={line.first || undefined}
      data-unread={!line.read || undefined}
      data-marked={marked || undefined}
    >
      <span className="security-where-repo">
        {line.first && (
          <>
            <RepositoryName name={line.repository} pane={pane} />
            {line.count.length > 0 && (
              <small>
                <Words words={line.count} />
              </small>
            )}
          </>
        )}
      </span>
      <span className="security-where-files">
        <Words words={line.files} />
        {line.needs.length > 0 && (
          <span className="security-where-needs">
            {" · "}
            <Words words={line.needs} />
          </span>
        )}
      </span>
      <span className="security-where-pills">
        {line.more ? (
          <button
            type="button"
            className="kit-link kit-link--muted"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {line.more} {open ? "⌃" : "⌄"}
          </button>
        ) : (
          line.alerts.map((pill) => <Pill key={pill.url} pill={pill} />)
        )}
        {line.prs.map((pill) => (
          <Pill key={pill.url} pill={pill} pr />
        ))}
        {!line.read && (
          <button type="button" className="security-evidence" onClick={() => openEvidence()}>
            Evidence ›
          </button>
        )}
      </span>
      {line.more && open && (
        <span className="security-where-all">
          {line.alerts.map((pill) => (
            <Pill key={pill.url} pill={pill} />
          ))}
        </span>
      )}
    </div>
  );
}
