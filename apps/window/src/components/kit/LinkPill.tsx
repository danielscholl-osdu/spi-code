// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Link, LinkKind } from "@spi-code/contracts";
import type { MouseEvent } from "react";
import { Octicon, type OcticonName } from "../icons/Octicon.js";
import "./kit.css";

export type LinkPillTone = "accent" | "work" | "upstream" | "muted";

const KINDS: Record<LinkKind, { icon?: OcticonName; tone: LinkPillTone }> = {
  pr: { icon: "pullRequest", tone: "accent" },
  issue: { icon: "issueOpened", tone: "work" },
  mr: { icon: "pullRequest", tone: "upstream" },
  commit: { icon: "gitCommit", tone: "muted" },
  compare: { icon: "gitCommit", tone: "muted" },
  run: { icon: "play", tone: "muted" },
  job: { icon: "play", tone: "muted" },
  deploy: { icon: "play", tone: "muted" },
  other: { tone: "muted" },
};

const numbered = (label: string, word: string, mark: "#" | "!") => {
  const n = label.match(mark === "#" ? /#(\d+)/ : /!(\d+)/)?.[1];
  return n ? `${word} ${mark}${n}` : word;
};

/** The pill's words, from the kind core sent and the number or hash in core's label; never from the URL. */
export function linkPillText(link: Link): string {
  switch (link.kind) {
    case "pr":
      return numbered(link.label, "PR", "#");
    case "issue":
      return numbered(link.label, "Issue", "#");
    case "mr":
      return numbered(link.label, "MR", "!");
    case "commit": {
      const sha = link.label.match(/\b[0-9a-f]{7,40}\b/)?.[0];
      return sha ? `Commit ${sha.slice(0, 7)}` : "Commit";
    }
    case "compare":
      return "Template change";
    case "run": {
      const workflow = link.label.match(/Sync (Upstream|Template)/)?.[0];
      return workflow ? `${workflow} run` : "Run";
    }
    case "job":
      return "Failed job";
    case "deploy":
      return "Deployments";
    default:
      return link.label;
  }
}

export interface LinkPillProps {
  link: Link;
  /** Words to show instead of the kind and number, where the place already names the object. */
  label?: string;
  /** Sit on the tone's surface at rest, for a pill on a neutral row. */
  filled?: boolean;
}

/** An outlined pill that opens a link's source and does nothing else. */
export function LinkPill({ link, label, filled }: LinkPillProps) {
  const kind = link.kind ?? "other";
  const { icon, tone } = KINDS[kind];
  const open = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    void window.spi?.openExternal(link.url);
  };
  return (
    <a
      className={`kit-link kit-link--${tone}`}
      data-kind={kind}
      {...(filled ? { "data-filled": "" } : {})}
      href={link.url}
      title={link.url}
      onClick={open}
    >
      {icon && <Octicon name={icon} />}
      {label ?? linkPillText(link)}
      <span className="kit-link-out" aria-hidden="true">
        ↗
      </span>
    </a>
  );
}
