// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Tone } from "../brief/index.js";
import {
  alertLine,
  changeLine,
  dependencyLine,
  KIND_LABEL,
  REPO_PREFIX,
  type RepoLine,
  repositoriesOf,
} from "../brief/repos.js";
import type { Model } from "../model/index.js";
import type { AlertGroup, RepoRow } from "../model/repos.js";
import { needsHuman } from "../model/work.js";
import type { CanvasTone } from "../tone.js";
import { plural, stamp } from "../util.js";

const LIST_MAX = 25;

const TONE: Readonly<Record<Tone, CanvasTone>> = Object.freeze({
  bad: "error",
  warn: "warn",
  ok: "ok",
  neutral: "neutral",
});

export interface RepoItem {
  chip?: { label: string; tone: CanvasTone };
  glyph?: CanvasTone;
  text: string;
  detail?: string;
  trailing?: string;
  href?: string;
}

export interface RepoRows {
  title?: string;
  items: RepoItem[];
}

export interface RepoTab {
  label: string;
  badge: string;
  sections: RepoRows[];
}

export interface RepoInspection {
  title: string;
  status: { label: "PROGRAM" | "FORK"; tone: CanvasTone };
  chip: string;
  summary: string;
  tabs: RepoTab[];
  links: { text: string; href: string }[];
}

function row(line: RepoLine, href?: string, trailing?: string): RepoItem {
  return {
    chip: { label: line.tag, tone: TONE[line.tone] },
    text: line.text,
    detail: line.sub,
    ...(trailing ? { trailing } : {}),
    ...(href ? { href } : {}),
  };
}

// What the row says without opening: the fix, or the scanner for a code finding.
function fixMark(g: AlertGroup): string {
  if (g.source === "code") return g.tool || "code scanning";
  const fix = g.fix ? `fix ${g.fix}` : "no fix";
  return g.pr ? `${fix} · bump #${g.pr}` : fix;
}

// One alert opens on itself; a group opens GitHub's list filtered to it.
export function groupUrl(r: RepoRow, g: AlertGroup): string {
  if (g.count === 1) return g.url;
  const q =
    g.source === "dependabot"
      ? `is:open package:${g.name} manifest:${g.where}`
      : `is:open${g.tool ? ` tool:${g.tool}` : ""}${g.rule ? ` rule:${g.rule}` : ""}`;
  const page = g.source === "dependabot" ? "dependabot?q=" : "code-scanning?query=";
  return `${r.url}/security/${page}${encodeURIComponent(q)}`;
}

function capped(title: string, items: RepoItem[], more: string): RepoRows | undefined {
  if (items.length === 0) return undefined;
  const shown = items.slice(0, LIST_MAX);
  if (items.length > LIST_MAX) {
    shown.push({ glyph: "neutral", text: `${items.length - LIST_MAX} more on GitHub`, href: more });
  }
  return { title: `${title} · ${items.length}`, items: shown };
}

function alertsTab(r: RepoRow, source: AlertGroup["source"]): RepoTab {
  const groups = r.alerts.filter((g) => g.source === source);
  const rows = (keep: (g: AlertGroup) => boolean) =>
    groups.filter(keep).map((g) => row(alertLine(g), groupUrl(r, g), fixMark(g)));
  const list = `${r.url}/security/${source === "dependabot" ? "dependabot" : "code-scanning"}`;
  const sections = [
    capped(
      "Ours",
      rows((g) => g.owner !== "upstream" && g.reach !== "tests"),
      list,
    ),
    capped(
      "Upstream",
      rows((g) => g.owner === "upstream" && g.reach !== "tests"),
      list,
    ),
    capped(
      "Tests",
      rows((g) => g.reach === "tests"),
      list,
    ),
  ].filter((s): s is RepoRows => s !== undefined);
  const read = source === "dependabot" ? r.dependabotAlerts : r.codeAlerts;
  if (read === undefined) {
    sections.push({
      items: [
        {
          glyph: "neutral",
          text: `${source === "dependabot" ? "Dependabot alerts" : "Code-scanning alerts"} are not readable with this token, or not read yet.`,
        },
      ],
    });
  } else if (sections.length === 0) {
    sections.push({
      items: [
        {
          glyph: "ok",
          text: `No open ${source === "dependabot" ? "vulnerabilities" : "code-scanning alerts"}.`,
        },
      ],
    });
  }
  return { label: KIND_LABEL[source], badge: String(groups.length), sections };
}

function prsTab(r: RepoRow, now: Date): RepoTab {
  const changes = r.changes.map((c) => row(changeLine(c, now), c.pr.url, c.state));
  const bumps = [...r.dependabot]
    .sort((a, b) => b.closes - a.closes)
    .map((d) => row(dependencyLine(d), d.pr.url, d.state));
  const sections = [
    capped("Pull Requests", changes, `${r.url}/pulls`),
    capped("Dependabot Bumps", bumps, `${r.url}/pulls/app%2Fdependabot`),
  ].filter((s): s is RepoRows => s !== undefined);
  const notes: RepoItem[] = [];
  if (r.pipeline > 0) {
    notes.push({
      glyph: "neutral",
      text: `${plural(r.pipeline, "pipeline PR")} (sync, template, release), on Flow.`,
    });
  }
  if (sections.length === 0 && notes.length === 0) {
    notes.push({ glyph: "ok", text: "No pull requests or Dependabot bumps open." });
  }
  const all: RepoRows[] = [...sections];
  if (notes.length > 0) all.push({ items: notes });
  return { label: "PRs", badge: String(r.changes.length + r.dependabot.length), sections: all };
}

function issuesTab(r: RepoRow, now: Date): RepoTab {
  const kinds: [keyof RepoRow["issues"], string][] = [
    ["bug", "bug"],
    ["enhancement", "enhancement"],
    ["other", "issue"],
    ["automation", "sync engine"],
  ];
  const rows: RepoItem[] = kinds.flatMap(([kind, tag]) =>
    r.issues[kind].map((i) => {
      const since = stamp(i.createdAt, now);
      const human = needsHuman(i);
      return {
        chip: human
          ? { label: "human-required", tone: "error" as const }
          : { label: tag, tone: "neutral" as const },
        text: `${i.title} · #${i.number}`,
        detail: [
          since ? `opened ${since}` : undefined,
          plural(i.comments, "comment"),
          kind === "automation" ? "from the sync engine, on Today" : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
        href: i.url,
      };
    }),
  );
  const items = [
    ...rows.filter((x) => x.chip?.label === "human-required"),
    ...rows.filter((x) => x.chip?.label !== "human-required"),
  ];
  const list = capped("Open", items, `${r.url}/issues`);
  return {
    label: "Issues",
    badge: String(items.length),
    sections: [list ?? { items: [{ glyph: "ok", text: "No issues open." }] }],
  };
}

function find(model: Model, id: string): RepoRow | undefined {
  return model.repositories.rows.find((r) => `${REPO_PREFIX}${r.name}` === id);
}

export function repoTitle(model: Model, id: string): string | undefined {
  const r = find(model, id);
  return r ? r.repo.split("/")[1] : undefined;
}

/** A watched repository's detail; undefined when the id names no watched repository. */
export function inspectRepo(model: Model, id: string, now: Date): RepoInspection | undefined {
  const r = find(model, id);
  const entry = repositoriesOf(model, now).rows.find((e) => e.id === id);
  if (!r || !entry) return undefined;
  const read = model.repositories.alertsAt ? stamp(model.repositories.alertsAt, now) : undefined;
  return {
    title: entry.title,
    status: { label: r.group === "program" ? "PROGRAM" : "FORK", tone: TONE[entry.tone] },
    chip: [r.repo, read ? `alerts read ${read}` : "alerts not read yet"].join(" · "),
    summary: entry.sub,
    tabs: [issuesTab(r, now), prsTab(r, now), alertsTab(r, "dependabot"), alertsTab(r, "code")],
    links: [
      { text: "Security overview", href: `${r.url}/security` },
      { text: "Pull requests", href: `${r.url}/pulls` },
      { text: "Issues", href: `${r.url}/issues` },
    ],
  };
}
