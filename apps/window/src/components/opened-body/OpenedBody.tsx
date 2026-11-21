// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useEffect } from "react";
import {
  type OpenSelection,
  openEvidence,
  openSelection,
  routeHash,
  setOpenSelection,
} from "../../app/navigation.js";
import { AskAboutThis, useAskAbout } from "../../threads/AskAboutThis.js";
import { type AskTarget, threadStore } from "../../threads/store.js";
import { TimedText } from "../../time.js";
import { LinkPill, linkPillText } from "../kit/LinkPill.js";
import { bodySources, type OpenedContent, restatesHeadline } from "./content.js";
import "./opened-body.css";

export type OpenedBodyProps = {
  content: OpenedContent;
  selection: OpenSelection;
  origin: "today" | "place";
  /** The source already on the collapsed Today row. */
  rowUrl?: string;
  onClose(): void;
};

/** What Ask about this and a draft's Needs you row carry from a row: its subject, title and fork. */
export function askTarget(content: OpenedContent): AskTarget | null {
  if (!content.subject) return null;
  return {
    subject: content.subject.id,
    label: content.title,
    urls: [...new Set(bodySources(content).map(({ url }) => url))],
    ...(content.scope ? { scope: content.scope } : {}),
    origin: `Started from ${content.place.label} › ${content.title}`,
  };
}

/** One body for an expanded Today row or a place's anchored popover; the caller owns its mount. */
export function OpenedBody({ content, selection, origin, rowUrl, onClose }: OpenedBodyProps) {
  const sources = bodySources(content, origin === "today" ? rowUrl : undefined);
  const primary =
    content.primary && bodySources(content).find(({ url }) => url === content.primary?.url);
  const { kind, id } = selection;
  const subjectKind = content.subject?.kind;
  const subjectId = content.subject?.id;
  useEffect(() => {
    const registered = { kind, id };
    setOpenSelection(
      registered,
      subjectKind && subjectId ? { kind: subjectKind, id: subjectId } : null,
    );
    return () => {
      if (openSelection() === registered) setOpenSelection(null);
    };
  }, [kind, id, subjectKind, subjectId]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && primary) {
        event.preventDefault();
        event.stopPropagation();
        void window.spi?.openExternal(primary.url);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [primary, onClose]);

  const target = askTarget(content);
  const ask = useAskAbout(target);
  const targetKey = target && JSON.stringify(target);
  useEffect(() => {
    if (!targetKey) return;
    const registered: AskTarget = JSON.parse(targetKey);
    threadStore.getState().setTarget(registered);
    return () => {
      const { target: current, setTarget } = threadStore.getState();
      if (current?.subject === registered.subject) setTarget(null);
    };
  }, [targetKey]);

  const { subject, cause, effect, steps = [], deadline } = content;
  const notRead = new Set(content.notRead ?? []).size;
  return (
    <div className="opened-body">
      {origin === "place" && <h3>{content.title}</h3>}
      {deadline && (
        <p className="opened-body-deadline">
          <span aria-hidden="true">◷</span>{" "}
          <time dateTime={deadline.at}>
            <TimedText text={deadline.reason} hint={false} />
          </time>
        </p>
      )}
      {cause && !restatesHeadline(cause, content.title) && <p>{cause}</p>}
      {effect && !/^Nothing (?:else )?waits(?: on it)?[.!]?$/i.test(effect.trim()) && (
        <p className="opened-body-effect">{effect}</p>
      )}
      {steps.length > 1 ? (
        <ol>
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      ) : (
        steps[0] && <p className="opened-body-step">{steps[0]}</p>
      )}
      {(sources.length > 0 || ask) && (
        <nav className="opened-body-sources" aria-label="Sources">
          {sources.map((link) => (
            <LinkPill
              key={link.url}
              link={link}
              {...(content.fork ? { label: `${content.fork} · ${linkPillText(link)}` } : {})}
            />
          ))}
          {ask && <AskAboutThis ask={ask} />}
        </nav>
      )}
      {notRead > 0 && (
        <a
          className="opened-body-evidence"
          href={routeHash({ kind: "evidence", ...(subject ? { selection: subject } : {}) })}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setOpenSelection(selection, subject);
            openEvidence(subject);
          }}
        >
          ⌀ {notRead} not read · Evidence ›
        </a>
      )}
    </div>
  );
}
