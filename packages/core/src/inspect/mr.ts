// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { githubUrl } from "../config.js";
import type { CoreContext } from "../context.js";
import type { Model } from "../model/index.js";
import type { Bucket } from "../model/radar.js";
import type { CanvasTone } from "../tone.js";
import { clip, names, plural, timeClause, whose } from "../util.js";

export const MR_PREFIX = "mr:";
const FILTER_BLOB = "/blob/main/.github/upstream-filter.yml";
const BUCKET_ORDER: readonly Bucket[] = [
  "Halt", "Toolchain", "Port", "Interface", "Shared", "Filtered",
];

export interface MrInspection {
  view: "board";
  header: { status: { label: string; tone: CanvasTone }; chip?: string };
  sections: {
    kind: "rows";
    title?: string;
    items: {
      text: string;
      glyph?: CanvasTone;
      icon?: string;
      trailing?: string;
      detail?: string;
      href?: string;
    }[];
  }[];
}

function parseId(id: string): { fork: string; iid: number } | undefined {
  const m = /^mr:([\w-]+):(\d+)$/.exec(id);
  const iid = Number(m?.[2]);
  return m?.[1] && Number.isSafeInteger(iid) && iid > 0 && id === `mr:${m[1]}:${iid}`
    ? { fork: m[1], iid }
    : undefined;
}

export function mrTitle(model: Model, id: string): string | undefined {
  const at = parseId(id);
  const service =
    at && Object.hasOwn(model.radar.services, at.fork) ? model.radar.services[at.fork] : undefined;
  const mr = service?.possible.find((v) => v.mr?.iid === at?.iid)?.mr;
  return at && mr ? `${at.fork} · !${mr.iid} ${clip(mr.title, 48)}` : undefined;
}

export function mrBoard(
  model: Model,
  id: string,
  now: Date,
  context: CoreContext,
): MrInspection {
  const at = parseId(id);
  const service =
    at && Object.hasOwn(model.radar.services, at.fork) ? model.radar.services[at.fork] : undefined;
  const verdicts = (service?.possible ?? []).filter((v) => v.mr?.iid === at?.iid);
  const mr = verdicts[0]?.mr;
  const def = context.fleet.forks.find((f) => f.id === at?.fork);
  if (!at || !mr || !def) {
    return {
      view: "board",
      header: { status: { label: "CLOSED", tone: "neutral" } },
      sections: [
        {
          kind: "rows",
          items: [{ glyph: "ok", text: "The MR is no longer open upstream; the panel redrew." }],
        },
      ],
    };
  }
  const halts = verdicts.filter((v) => v.bucket === "Halt");
  const tools = verdicts.filter((v) => v.bucket === "Toolchain");
  const said =
    halts.length > 0
      ? `Merged, it halts ${whose(at.fork)} next Sync Upstream on ${names(halts.map((v) => v.entry ?? ""))} (${[...new Set(halts.map((v) => v.code))].join(", ")}).`
      : tools.length > 0
        ? `Merged, it carries ${names(tools.map((v) => v.value ?? ""))} into ${whose(at.fork)} next Sync Upstream.`
        : `Merged, it syncs into ${at.fork} without a halt or a toolchain move.`;
  const sections: MrInspection["sections"] = [
    {
      kind: "rows",
      items: [
        { glyph: halts.length > 0 ? "warn" : tools.length > 0 ? "info" : "ok", text: said },
        ...(mr.draft
          ? [
              {
                glyph: "neutral" as const,
                text: "Draft: it counts toward nothing until it is marked ready.",
              },
            ]
          : []),
      ],
    },
  ];
  for (const bucket of BUCKET_ORDER) {
    const group = verdicts.filter((v) => v.bucket === bucket);
    if (group.length === 0) continue;
    const paths = new Set(group.flatMap((v) => v.paths)).size;
    sections.push({
      kind: "rows",
      title: `${bucket} · ${plural(paths, "path")}`,
      items: group.map((v) => ({
        text: v.value ?? v.entry ?? bucket,
        trailing: [v.code, v.map, plural(v.paths.length, "path")].filter(Boolean).join(" · "),
        detail: clip(v.paths.join(", "), 400),
      })),
    });
  }
  const elsewhere = [...new Set(halts.flatMap((v) => v.elsewhere ?? []))];
  sections.push({
    kind: "rows",
    title: "Forks it reaches",
    items: [
      {
        glyph: halts.length > 0 ? "warn" : "info",
        text: at.fork,
        trailing: "its upstream project",
      },
      ...(elsewhere.length > 0
        ? [
            {
              glyph: "neutral" as const,
              text: names(elsewhere),
              trailing: "their filters lack the entry too",
            },
          ]
        : []),
    ],
  });
  sections.push({
    kind: "rows",
    title: "Evidence",
    items: [
      { icon: "↗", text: "Open MR", trailing: `!${mr.iid}`, href: mr.url },
      {
        icon: "↗",
        text: "Open filter",
        trailing: ".github/upstream-filter.yml",
        href: githubUrl(def.repo, FILTER_BLOB),
      },
    ],
  });
  return {
    view: "board",
    header: {
      status: {
        label: halts.length > 0 ? "HALT" : tools.length > 0 ? "TOOLCHAIN" : "NO BREAK",
        tone: halts.length > 0 ? "warn" : tools.length > 0 ? "info" : "ok",
      },
      chip: [
        `${at.fork} · !${mr.iid}`,
        mr.draft ? "draft" : undefined,
        timeClause(mr.createdAt, now, context, "opened "),
      ]
        .filter(Boolean)
        .join(" · "),
    },
    sections,
  };
}
