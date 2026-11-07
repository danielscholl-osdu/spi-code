// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { planActions } from "../act/upstream.js";
import {
  carriesText,
  flowStatement,
  LINE_COLUMNS,
  planOrder,
  stepWhy,
  tag,
  upstreamView,
} from "../brief/upstream.js";
import type { Model } from "../model/index.js";
import type { Cell, CellTone } from "../model/rollout.js";
import { planStep, UPSTREAM_PREFIX, type UpFork, type UpstreamModel } from "../model/upstream.js";
import type { CanvasTone } from "../tone.js";
import { names, plural, stamp, whose } from "../util.js";
import { APP_VOICE, actor, type Voice } from "../voice.js";
import {
  inspectRow,
  nextCard,
  type UpstreamBoard,
  type UpstreamBoardOptions,
  type UpstreamSection as Section,
} from "./upstream-shared.js";

const CELL_TONE: Readonly<Record<CellTone, CanvasTone>> = Object.freeze({
  ok: "ok",
  run: "info",
  warn: "caution",
  bad: "error",
  idle: "neutral",
});

function badge(c: Cell) {
  return c.text === "·"
    ? { value: "·" }
    : {
        badges: [{ text: c.text.replace(/ /g, " "), tone: CELL_TONE[c.tone] }],
        ...(c.url ? { href: c.url } : {}),
      };
}

function lineNotes(forks: readonly UpFork[]): Section | undefined {
  const items = forks.flatMap((f) => {
    const why =
      f.stop?.error ??
      f.wait ??
      f.planWait ??
      [f.cells.toMain, f.cells.main, f.cells.cascade, f.cells.sync].find((c) => c.note)?.note;
    return why
      ? [{ text: f.service, trailing: why, ...inspectRow(`${UPSTREAM_PREFIX}${f.service}`) }]
      : [];
  });
  return items.length > 0 ? { kind: "rows", title: "Why each fork waits", items } : undefined;
}

function lineTable(forks: readonly UpFork[], title: string): Section {
  return {
    kind: "table",
    title,
    columns: [
      { key: "fork", label: "Fork" },
      { key: "sync", label: LINE_COLUMNS[0] as string },
      { key: "cascade", label: LINE_COLUMNS[1] as string },
      { key: "toMain", label: LINE_COLUMNS[2] as string },
      { key: "main", label: LINE_COLUMNS[3] as string },
    ],
    rows: forks.map((f) => ({
      fork: { value: f.service, href: f.url },
      sync: badge(f.cells.sync),
      cascade: badge(f.cells.cascade),
      toMain: badge(f.cells.toMain),
      main: badge(f.cells.main),
    })),
  };
}

function laneMeter(u: UpstreamModel): Section | undefined {
  if (u.lanes.cap === null) return undefined;
  return {
    kind: "bars",
    title: "Lanes on the shared environment",
    items: [
      {
        label: "Lanes",
        value: u.lanes.unread ? null : u.lanes.busy,
        total: u.lanes.cap,
        trailing: u.lanes.unread
          ? `unknown until ${u.lanes.unread} are read`
          : `${u.lanes.busy} of ${u.lanes.cap} busy${u.lanes.claims ? ` · ${plural(u.lanes.claims, "cascade")} claiming` : ""}${u.lanes.holders.length ? ` · ${names(u.lanes.holders)}` : ""}`,
      },
    ],
  };
}

function stepsSection(voice: Voice): Section {
  return {
    kind: "rows",
    title: "What each fork goes through",
    items: [
      {
        chip: { label: `you · ${voice.label}`, tone: "ok" },
        text: "Prepare",
        trailing: "Dispatch Sync Upstream. Opens a sync PR into fork_upstream. No lane.",
      },
      {
        chip: { label: `you · ${voice.label}`, tone: "ok" },
        text: "Start",
        trailing: `Merge the sync PR. ${actor(voice)} dispatches the cascade at once, no 6 hour wait.`,
      },
      {
        chip: { label: "automatic", tone: "neutral" },
        text: "Cascade",
        trailing: "Merges into fork_integration and builds with the Azure provider. No lane.",
      },
      {
        chip: { label: "you · GitHub", tone: "caution" },
        text: "Review",
        trailing: "Approve the Sync to Main PR. Its validation takes a lane; it auto-merges green.",
      },
      {
        chip: { label: "automatic", tone: "neutral" },
        text: "Main run",
        trailing: "Takes a lane. Green ends the fork; its release PR waits for Releases.",
      },
      {
        glyph: "neutral",
        text: "You press three times per fork: Prepare, Start, and the review on GitHub. A plan batches the first two across a wave.",
      },
    ],
  };
}

function wavesSection(u: UpstreamModel): Section | undefined {
  const rows: Record<string, string>[] = [];
  if (u.pilot.length > 0) {
    rows.push({ wave: "Pilot", forks: u.pilot.join(", "), starts: "you press Start" });
  }
  for (const w of u.waves) {
    rows.push({
      wave: w.name,
      forks: w.forks.join(", "),
      starts: w.gate ?? "open now: Start tops up to the free lanes",
    });
  }
  if (u.held.length > 0) {
    rows.push({
      wave: "Held",
      forks: u.held.map((f) => f.service).join(", "),
      starts: "each fork's blocker clears",
    });
  }
  if (rows.length === 0) return undefined;
  return {
    kind: "table",
    title: "Waves",
    columns: [
      { key: "wave", label: "Wave" },
      { key: "forks", label: "Forks" },
      { key: "starts", label: "Starts when" },
    ],
    rows,
  };
}

function heldSection(u: UpstreamModel): Section | undefined {
  if (u.held.length === 0) return undefined;
  return {
    kind: "rows",
    title: "Held, and what clears it",
    items: u.held.map((f) =>
      f.held === "snapshot"
        ? {
            chip: { label: "SNAPSHOT", tone: "caution" as const },
            text: f.service,
            trailing: `upstream moved to ${f.snapshot}; clears when upstream pins a release, or take it anyway from ${whose(f.service)} inspector`,
            ...inspectRow(`${UPSTREAM_PREFIX}${f.service}`),
          }
        : {
            chip: { label: "filter", tone: "error" as const },
            text: f.service,
            trailing: `the sync halts on ${f.halt?.entry ?? "an unlisted entry"}; clears when the fork's filter carries a rule for it`,
            ...(f.halt?.url ? { href: f.halt.url } : {}),
          },
    ),
  };
}

function scheduleSection(u: UpstreamModel, now: Date, voice: Voice): Section | undefined {
  const s = upstreamView(u, now, voice).schedule;
  if (!s) return undefined;
  return {
    kind: "rows",
    title: "Schedule",
    items: [
      { chip: { label: stamp(u.schedule.upstream, now) ?? "?", tone: "neutral" }, text: s.text },
      {
        glyph: "neutral",
        text: "A sync PR the schedule opens is adopted as Prepared; a fork already in the plan keeps its PR, updated in place.",
      },
    ],
  };
}

function serviceSection(u: UpstreamModel): Section {
  return {
    kind: "rows",
    title: "One service",
    items: u.forks
      .filter((f) => f.phase !== "current" && f.phase !== "unread")
      .map((f) => ({
        text: f.service,
        trailing: [tag(f), f.cells.sync.text !== "·" ? f.cells.sync.text : carriesText(f)]
          .filter(Boolean)
          .join(" · "),
        ...inspectRow(`${UPSTREAM_PREFIX}${f.service}`),
      })),
  };
}

export function inspectUpstreamPlan(
  model: Model,
  now: Date,
  opts: UpstreamBoardOptions = {},
): UpstreamBoard {
  const u = model.upstream;
  const voice = opts.voice ?? APP_VOICE;
  const view = upstreamView(u, now, voice);
  const step = planStep(u);
  const verbs = planActions(u, {
    swept: model.sweptAt ?? "",
    load: model.lanes,
    now,
    ...(opts.blocked ? { blocked: opts.blocked } : {}),
  });
  const planned = u.pilot.length + u.waves.reduce((n, w) => n + w.forks.length, 0);
  const waves = (u.pilot.length > 0 ? 1 : 0) + u.waves.length;
  const sub = [
    plural(u.commits, "commit"),
    u.pilot.length > 0 ? "pilot first" : undefined,
    u.held.length > 0 ? `${plural(u.held.length, "fork")} held` : undefined,
    u.lanes.cap !== null ? `${plural(u.needed, "lane")}, ${u.lanes.cap} at a time` : "unpaced",
  ]
    .filter(Boolean)
    .join(" · ");
  const links = [
    ...u.reviews.map((f) => ({
      value: `Review ${whose(f.service)} Sync to Main #${f.toMain?.number} on GitHub`,
      href: f.toMain?.url as string,
    })),
  ];
  const targets = step.forks.map((f) => f.repo);
  const sections: Section[] = [
    { kind: "rows", items: [{ text: sub }, { text: flowStatement(u) }] },
    nextCard(
      `${view.next.title}.`,
      [stepWhy(u, step, now, voice), targets.length ? `Touches ${targets.join(", ")}.` : ""]
        .filter(Boolean)
        .join(" "),
      verbs,
      links,
      u.paused || u.stops.length > 0 ? "error" : "brand",
    ),
  ];
  if (u.paused) {
    sections.push({
      kind: "rows",
      title: "Paused: absorb the move",
      items: [
        {
          glyph: "error",
          text: `${names(u.paused.forks)} failed the cascade with the same first error`,
          trailing: u.paused.error,
        },
        ...u.forks
          .filter((f) => f.verb === "start" || f.verb === "prepare")
          .map((f) => ({
            chip: { label: "absorb", tone: "caution" as const },
            text: f.service,
            trailing: "absorb the move on main before its cascade",
            ...inspectRow(`${UPSTREAM_PREFIX}${f.service}`),
          })),
      ],
    });
  }
  const meter = laneMeter(u);
  if (meter) sections.push(meter);
  const shown = planOrder(u).filter((f) => f.phase !== "current" && f.phase !== "unread");
  sections.push(lineTable(shown, `Forks · ${plural(planned, "fork")} in ${plural(waves, "wave")}`));
  const notes = lineNotes(shown);
  if (notes) sections.push(notes);
  const w = wavesSection(u);
  if (w) sections.push(w);
  const held = heldSection(u);
  if (held) sections.push(held);
  if (u.mode !== "flight") sections.push(stepsSection(voice));
  const sched = scheduleSection(u, now, voice);
  if (sched) sections.push(sched);
  sections.push({
    kind: "rows",
    title: "Lanes",
    items: [
      {
        text: `Sync PRs and cascades build on GitHub runners and take no lane. Sync to Main and the main run take one each: ${plural(u.needed, "lane")} to go${u.lanes.cap !== null ? `, ${u.lanes.cap} at a time` : ""}, in one ledger with the template rollout.`,
      },
    ],
  });
  sections.push(serviceSection(u));
  sections.push(...(opts.extra ?? []));
  return {
    view: "board",
    title: `Sync ${plural(planned, "fork")} from upstream in ${plural(waves, "wave")}`,
    header: {
      status: {
        label: u.paused ? "UPSTREAM PLAN PAUSED" : "UPSTREAM PLAN",
        tone: u.paused ? "error" : "caution",
      },
      chip: `fleet · ${u.mode === "flight" ? "in flight" : "plan"}`,
    },
    sections,
  };
}
