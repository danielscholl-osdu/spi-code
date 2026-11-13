// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ActionItem } from "../act/action-item.js";
import type { UpstreamActions } from "../act/upstream.js";
import type { CoreContext } from "../context.js";
import type { CanvasTone } from "../tone.js";
import type { Voice } from "../voice.js";

export interface UpstreamRow {
  text: string;
  trailing?: string;
  href?: string;
  chip?: { label: string; tone: CanvasTone };
  glyph?: CanvasTone;
  action?: { type: string; payload: { id: string } };
}

export interface UpstreamCell {
  value?: string;
  href?: string;
  badges?: { text: string; tone: CanvasTone }[];
}

export interface UpstreamCards {
  kind: "cards";
  title: string;
  items: {
    title: string;
    edge: CanvasTone;
    fields: { label: string; value: string; href?: string }[];
    actions?: ActionItem[];
  }[];
}

export type UpstreamSection =
  | { kind: "rows"; title?: string; items: UpstreamRow[] }
  | {
      kind: "table";
      title: string;
      columns: { key: string; label: string }[];
      rows: Record<string, string | UpstreamCell>[];
    }
  | {
      kind: "bars";
      title: string;
      items: { label: string; value: number | null; total: number; trailing: string }[];
    }
  | UpstreamCards;

export interface UpstreamBoard {
  view: "board";
  title: string;
  header: { status: { label: string; tone: CanvasTone }; chip: string };
  sections: UpstreamSection[];
}

export interface UpstreamBoardOptions {
  blocked?: string;
  extra?: UpstreamSection[];
  /** How the board names the actor; defaults to SPI Code. */
  voice?: Voice;
  context?: Pick<CoreContext, "timeStyle">;
}

export function inspectRow(id: string): Pick<UpstreamRow, "action"> {
  return { action: { type: "inspect", payload: { id } } };
}

export function nextCard(
  title: string,
  why: string,
  verbs: UpstreamActions,
  links: { value: string; href: string }[],
  edge: CanvasTone,
): UpstreamCards {
  return {
    kind: "cards",
    title: "Next step",
    items: [
      {
        title,
        edge,
        fields: [
          ...(why ? [{ label: "", value: why }] : []),
          ...links.map((l) => ({ label: "", value: l.value, href: l.href })),
        ],
        actions: [verbs.primary, ...verbs.secondary],
      },
    ],
  };
}
