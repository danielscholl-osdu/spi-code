// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useEffect } from "react";
import {
  navigate,
  type OpenSelection,
  openEvidence,
  openSelection,
  routeHash,
  setOpenSelection,
} from "../../app/navigation.js";
import { LinkPill } from "../kit/LinkPill.js";
import { bodySources, type OpenedContent, restatesHeadline } from "./content.js";
import "./opened-body.css";

export type OpenedBodyProps = {
  content: OpenedContent;
  selection: OpenSelection;
  origin: "today" | "place";
  /** The source already on the collapsed row; only secondary pills are omitted for it. */
  rowUrl?: string;
  onClose(): void;
};

/** One body for an expanded Today row or a place's anchored popover; the caller owns its mount. */
export function OpenedBody({ content, selection, origin, rowUrl, onClose }: OpenedBodyProps) {
  const sources = bodySources(content, origin === "today" ? rowUrl : undefined);
  const primary = content.primary && sources.find(({ url }) => url === content.primary?.url);
  useEffect(() => {
    setOpenSelection(selection, content.subject);
    return () => {
      if (openSelection() === selection) setOpenSelection(null);
    };
  }, [selection, content.subject]);

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

  const { place, subject, cause, effect, steps = [], deadline } = content;
  const notRead = new Set(content.notRead ?? []).size;
  return (
    <div className="opened-body">
      {origin === "today" ? (
        <a
          className="opened-body-place"
          href={place.destination.kind === "line" ? "#today" : routeHash(place.destination)}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            navigate(place.destination);
            if (place.selection) setOpenSelection(place.selection, subject);
          }}
        >
          {place.label} ›
        </a>
      ) : (
        <>
          {subject && content.section && (
            <a
              className="opened-body-place"
              href={routeHash({ kind: "today" })}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                navigate({ kind: "today" });
                setOpenSelection(subject);
              }}
            >
              On Today · {content.section === "blocked" ? "Blocked" : "Waiting on you"} ›
            </a>
          )}
          <h3>{content.title}</h3>
        </>
      )}
      {deadline && (
        <p className="opened-body-deadline">
          <span aria-hidden="true">◷</span> <time dateTime={deadline.at}>{deadline.reason}</time>
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
      {sources.length > 0 && (
        <nav className="opened-body-sources" aria-label="Sources">
          {sources.map((link) => (
            <LinkPill key={link.url} link={link} />
          ))}
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
