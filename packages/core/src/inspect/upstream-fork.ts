// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { forkActions } from "../act/upstream.js";
import { carriesText, LINE_COLUMNS, tag } from "../brief/upstream.js";
import type { Model } from "../model/index.js";
import type { Cell } from "../model/rollout.js";
import {
  UPSTREAM_ITEM,
  UPSTREAM_PREFIX,
  type UpFork,
  type UpstreamModel,
} from "../model/upstream.js";
import type { CanvasTone } from "../tone.js";
import { names, plural, stamp, whose } from "../util.js";
import {
  inspectRow,
  nextCard,
  type UpstreamBoard,
  type UpstreamBoardOptions,
  type UpstreamSection as Section,
} from "./upstream-shared.js";

const PHASE_LABEL: Readonly<Record<UpFork["phase"], { label: string; tone: CanvasTone }>> =
  Object.freeze({
    unread: { label: "UNREAD", tone: "neutral" },
    current: { label: "CURRENT", tone: "ok" },
    idle: { label: "BEHIND UPSTREAM", tone: "caution" },
    halted: { label: "SYNC HALTS", tone: "error" },
    preparing: { label: "PREPARING", tone: "info" },
    prepared: { label: "PREPARED", tone: "caution" },
    merged: { label: "CASCADE OWED", tone: "caution" },
    cascading: { label: "IN CASCADE", tone: "info" },
    stopped: { label: "P1 · CASCADE STOPPED", tone: "error" },
    review: { label: "SYNC TO MAIN", tone: "caution" },
    main: { label: "MAIN RUN", tone: "info" },
    red: { label: "MAIN RED", tone: "error" },
    done: { label: "ON MAIN", tone: "ok" },
  });

function carriesSection(model: Model, f: UpFork): Section | undefined {
  const svc = Object.hasOwn(model.radar.services, f.service)
    ? model.radar.services[f.service]
    : undefined;
  if (!svc || !f.behind) return undefined;
  const items = svc.certain.map((v) => ({
    chip: {
      label: v.bucket,
      tone: v.bucket === "Halt" ? ("error" as const) : ("neutral" as const),
    },
    text: v.value ?? v.entry ?? plural(v.paths.length, "path"),
    trailing: plural(v.paths.length, "path"),
  }));
  if (items.length === 0) return undefined;
  return {
    kind: "rows",
    title: `What the next sync carries · ${plural(f.behind, "commit")}`,
    items,
  };
}

function forkTitle(f: UpFork): string {
  switch (f.phase) {
    case "stopped":
      return `${whose(f.service)} cascade ${f.stop?.label ?? "stopped"}`;
    case "idle":
      return `${f.service} is ${plural(f.behind ?? 0, "commit")} behind upstream`;
    case "halted":
      return `${whose(f.service)} next sync halts on ${f.halt?.entry ?? "an unlisted entry"}`;
    case "prepared":
      return `${whose(f.service)} sync PR #${f.syncPr?.number} is prepared`;
    case "merged":
      return `${whose(f.service)} sync PR merged; the cascade has not run`;
    case "cascading":
      return `${whose(f.service)} cascade is running`;
    case "review":
      return `${whose(f.service)} Sync to Main #${f.toMain?.number} is open`;
    case "main":
      return `${whose(f.service)} main run is testing`;
    case "red":
      return `${whose(f.service)} main run went red after Sync to Main`;
    case "done":
      return `${f.service} is on main`;
    default:
      return f.service;
  }
}

function forkNext(u: UpstreamModel, f: UpFork): { title: string; why: string } {
  const sameMove = u.forks.filter((o) => o !== f && ["review", "main", "done"].includes(o.phase));
  switch (f.verb) {
    case "prepare":
      return {
        title: "Prepare: dispatch Sync Upstream",
        why: "Opens a sync PR into fork_upstream with the filtered tree and a tracking issue. Nothing merges, and no lane is taken.",
      };
    case "start":
      return {
        title: `Start: merge #${f.syncPr?.number}, then dispatch the cascade`,
        why: "The cascade merges main and upstream into fork_integration and builds core and azure. A green one opens a Sync to Main PR that borrows a lane.",
      };
    case "dispatch":
      return {
        title: "Dispatch the cascade",
        why: "The sync PR merged and no cascade ran. The monitor would dispatch it within 6 hours; this runs it now.",
      };
    case "rerun":
      return f.wait
        ? {
            title: `Fix ${f.service} on fork_integration, then re-run the cascade`,
            why:
              sameMove.length > 0 && f.stop?.label === "build failed"
                ? `${names(sameMove.map((o) => o.service))} took the same move green, so this is ${whose(f.service)} own provider code, not the toolchain. A fix lands as a PR into fork_integration.`
                : "A fix lands as a PR into fork_integration; Re-run opens once it does.",
          }
        : {
            title: "Re-run the cascade",
            why: "A fix landed on fork_integration after the failure.",
          };
    case "review":
      return {
        title: `Review Sync to Main #${f.toMain?.number} on GitHub`,
        why: "Its validation borrows a lane, and it auto-merges once approved and green. The rib never approves.",
      };
    default:
      return { title: forkTitle(f), why: f.wait ?? f.planWait ?? "" };
  }
}

function failedSection(u: UpstreamModel, f: UpFork, now: Date): Section | undefined {
  const s = f.stop;
  if (!s) return undefined;
  const passed = u.forks
    .filter((o) => ["review", "main", "done"].includes(o.phase))
    .map((o) => o.service);
  const same = u.stops.filter((o) => o !== f && o.stop?.error && o.stop.error === s.error);
  return {
    kind: "cards",
    title: "What failed",
    items: [
      {
        title: f.service,
        edge: "error",
        fields: [
          {
            label: "Stage",
            value: [s.run?.name ?? "Cascade Integration", s.job?.name, s.job?.failedStep]
              .filter(Boolean)
              .join(" · "),
            ...(s.job?.url || s.run?.url ? { href: (s.job?.url ?? s.run?.url) as string } : {}),
          },
          ...(s.issue
            ? [{ label: "Issue", value: `#${s.issue.number} ${s.issue.title}`, href: s.issue.url }]
            : []),
          { label: "First error", value: s.error ?? "unread" },
          {
            label: "Failed",
            value: stamp(s.run?.updatedAt, now) ?? "?",
          },
          {
            label: "Same cause",
            value:
              same.length > 0
                ? `${names(same.map((o) => o.service))}: the wave pauses`
                : `none${passed.length > 0 ? ` · ${names(passed)} passed the cascade` : ""}`,
          },
          {
            label: "fork_integration",
            value:
              s.fixLanded === null
                ? "not read yet"
                : s.fixLanded
                  ? "a commit landed after the failure"
                  : "no commit since the failure",
          },
        ],
      },
    ],
  };
}

function lineRows(f: UpFork): Section {
  const cells = [f.cells.sync, f.cells.cascade, f.cells.toMain, f.cells.main];
  const tone = (c: Cell): CanvasTone =>
    c.tone === "bad"
      ? "error"
      : c.tone === "ok"
        ? "ok"
        : c.tone === "run"
          ? "info"
          : c.tone === "warn"
            ? "caution"
            : "neutral";
  return {
    kind: "rows",
    title: `${whose(f.service)} line`,
    items: [
      ...cells.map((c, i) => ({
        chip: { label: c.text === "·" ? "idle" : c.text, tone: tone(c) },
        text: LINE_COLUMNS[i] as string,
        ...(c.note ? { trailing: c.note } : {}),
        ...(c.url ? { href: c.url } : {}),
      })),
      {
        chip: {
          label: f.releasePr ? `#${f.releasePr.number} waits` : "·",
          tone: "neutral" as const,
        },
        text: "Release",
        ...(f.releasePr ? { href: f.releasePr.url } : {}),
      },
    ],
  };
}

export function inspectUpstreamFork(
  model: Model,
  service: string,
  now: Date,
  opts: UpstreamBoardOptions = {},
): UpstreamBoard | undefined {
  const u = model.upstream;
  const f = u.forks.find((x) => x.service === service);
  if (!f) return undefined;
  const verbs = forkActions(u, f, {
    swept: model.sweptAt ?? "",
    load: model.lanes,
    now,
    ...(opts.blocked ? { blocked: opts.blocked } : {}),
  });
  const next = forkNext(u, f);
  const links = [
    ...(f.syncPr ? [{ value: `Sync PR #${f.syncPr.number}`, href: f.syncPr.url }] : []),
    ...(f.tracking
      ? [{ value: `Tracking issue #${f.tracking.number}`, href: f.tracking.url }]
      : []),
    ...(f.stop?.job?.url ? [{ value: "Open the failing job", href: f.stop.job.url }] : []),
    ...(f.toMain
      ? [{ value: `Sync to Main #${f.toMain.number} on GitHub`, href: f.toMain.url }]
      : []),
    ...(f.held === "halt" && f.halt?.url
      ? [{ value: "Open the fork's filter", href: f.halt.url }]
      : []),
    ...(f.templatePr
      ? [{ value: `Start waits for template PR #${f.templatePr.number}`, href: f.templatePr.url }]
      : []),
  ];
  const sub = [
    f.behind !== undefined && f.behind > 0
      ? `${plural(f.behind, "upstream commit")} queued · carries ${carriesText(f)}`
      : undefined,
    f.phase === "stopped" ? "Sync to Main not opened" : undefined,
    f.phase === "stopped" ? "the rest of the plan keeps going" : undefined,
    f.planWait ? `the plan: ${f.planWait}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const sections: Section[] = [];
  if (sub) sections.push({ kind: "rows", items: [{ text: sub }] });
  sections.push(
    nextCard(
      `${next.title}.`,
      next.why,
      verbs,
      links,
      f.phase === "stopped" || f.phase === "red" ? "error" : "brand",
    ),
  );
  const failed = failedSection(u, f, now);
  if (failed) sections.push(failed);
  if (f.phase === "stopped") {
    sections.push({
      kind: "rows",
      title: "When a second fork fails the same way",
      items: [
        {
          text: "The rib pauses the wave and turns the rest into Absorb items: the move is the toolchain, not one fork. Forks already past the cascade carry on.",
        },
      ],
    });
  }
  sections.push(lineRows(f));
  const carries = carriesSection(model, f);
  if (carries) sections.push(carries);
  const waits = u.ordering.filter((o) => o.after.includes(f.service)).map((o) => o.service);
  if (waits.length > 0 || f.heldBy.length > 0) {
    sections.push({
      kind: "rows",
      title: `Who waits on ${f.service}`,
      items: [
        ...waits.map((w) => ({
          text: w,
          trailing: `rollout.json orders it after ${names(u.ordering.find((o) => o.service === w)?.after ?? [])}`,
          ...inspectRow(`${UPSTREAM_PREFIX}${w}`),
        })),
        ...(f.heldBy.length > 0
          ? [{ glyph: "neutral" as const, text: `${f.service} waits on ${names(f.heldBy)}` }]
          : []),
      ],
    });
  }
  const at = stamp(u.schedule.upstream, now);
  if (at && f.phase === "stopped") {
    sections.push({
      kind: "rows",
      title: `Before ${at}`,
      items: [
        {
          text: "A blocked cascade doesn't stop Sync Upstream, so new upstream commits can arrive as a fresh sync PR. The rib shows it as Prepared and doesn't offer Start until this cascade clears.",
        },
      ],
    });
  }
  sections.push({
    kind: "rows",
    items: [{ text: "Back to the upstream plan", ...inspectRow(UPSTREAM_ITEM) }],
  });
  sections.push(...(opts.extra ?? []));
  const role = tag(f);
  return {
    view: "board",
    title: forkTitle(f),
    header: {
      status: { ...PHASE_LABEL[f.phase] },
      chip: [f.service, role, "upstream sync plan"].filter(Boolean).join(" · "),
    },
    sections,
  };
}
