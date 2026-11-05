// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ActionItem } from "../act/action-item.js";
import type { UpstreamActions } from "../act/upstream.js";
import type { CanvasTone } from "../tone.js";

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
  | ReturnType<typeof nextCard>;

export interface UpstreamBoard {
  view: "board";
  title: string;
  header: { status: { label: string; tone: CanvasTone }; chip: string };
  sections: UpstreamSection[];
}

export interface UpstreamBoardOptions {
  blocked?: string;
  extra?: UpstreamSection[];
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
) {
  return {
    kind: "cards" as const,
    title: "Next step",
    items: [
      {
        title,
        edge,
        fields: [
          ...(why ? [{ label: "", value: why }] : []),
          ...links.map((l) => ({ label: "", value: l.value, href: l.href })),
        ],
        actions: [verbs.primary, ...verbs.secondary] satisfies ActionItem[],
      },
    ],
  };
}
