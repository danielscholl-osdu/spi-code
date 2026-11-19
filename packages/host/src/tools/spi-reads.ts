// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type AreaName, resolvePointer, type ViewSnapshot } from "@spi-code/contracts";
import { z } from "zod";
import type { JsonValue, ModelRedactor } from "../threads/context/seams.js";
import {
  areaEnvelopes,
  governedBy,
  type LatestSweep,
  NOT_READ,
  type ReadState,
  readState,
  readStateAt,
  type SavedSweep,
  sourcesAt,
} from "../threads/context/sweep.js";
import { estimateTokens, type TokenEstimate } from "../threads/context/tokens.js";
import { buildGatedTool, checkStubTier, type GatedTool, type TierCheck } from "./registry.js";
import { APPENDIX_A_TOOLS, type ToolMetadata } from "./tool-names.js";

export const SPI_RESULT_TOKEN_BUDGET = 6000;

type Fields = Record<string, unknown>;
type Answer =
  | { readonly found: false; readonly reason: string }
  | {
      readonly place: string;
      /** A JSON pointer into the saved sweep that spi_evidence can take. */
      readonly at?: string;
      readonly state: ReadState;
      readonly value: Fields;
      /** Top-level lists that give up whole items, in order, to fit the result budget. */
      readonly lists?: readonly string[];
    };

interface SpiRead<A> {
  readonly metadata: ToolMetadata;
  readonly description: string;
  readonly args: z.ZodType<A>;
  read(sweep: SavedSweep, args: A): Answer | Promise<Answer>;
}
const define = <A>(read: SpiRead<A>) => read as unknown as SpiRead<Fields>;

const metadata = (name: string): ToolMetadata =>
  APPENDIX_A_TOOLS.find((entry) => entry.name === name) ?? { name, tier: "Read", milestone: "M3" };

const reading = (view: ViewSnapshot, match: (anchor: Fields) => boolean) =>
  view.readings.find(({ anchor }) => match(anchor))?.content ?? NOT_READ;

const place = (
  name: string,
  anchor: string,
  areas: readonly AreaName[],
  extra: (view: ViewSnapshot) => Fields = () => ({}),
  lists?: readonly string[],
  at?: string,
) => ({
  read: ({ view }: SavedSweep): Answer => ({
    place: name,
    ...(at === undefined ? {} : { at }),
    state: readState(areaEnvelopes(view, areas)),
    value: { reading: reading(view, (entry) => entry.kind === anchor), ...extra(view) },
    ...(lists ? { lists } : {}),
  }),
});

/** A list the sweep did not read is said so, never shown as empty. */
const listed = (list: {
  read?: boolean | undefined;
  count: number | null;
  partial: boolean;
  rows: unknown[];
}) =>
  list.read === true && list.count !== null
    ? { count: list.count, partial: list.partial, rows: list.rows }
    : NOT_READ;

const none = z.strictObject({});
const READS: readonly SpiRead<Fields>[] = [
  define({
    metadata: metadata("spi_brief"),
    description:
      "Today: the briefing's headline, verdict, decisions and Today lines with their members.",
    args: none,
    read: ({ view }) => ({
      place: "Today",
      at: "/briefing/today",
      state: readStateAt(view, "/briefing/today") ?? readState([]),
      value: {
        headline: view.briefing.headline,
        summary: view.briefing.summary,
        verdict: view.briefing.verdict,
        decisions: view.briefing.decisions,
        lines: (view.briefing.lines ?? []).map(({ members, ...line }) => ({
          ...line,
          members: members.map(({ id, fork, station, cause, evidence }) => ({
            id,
            fork,
            ...(station === undefined ? {} : { station }),
            cause,
            notRead: evidence.notRead,
          })),
        })),
      },
      lists: ["lines"],
    }),
  }),
  define({
    metadata: metadata("spi_line"),
    description:
      "One service's home: its reading, stations, release, open pull requests and issues.",
    args: z.strictObject({ service: z.string().min(1) }),
    read: ({ view }, { service }) => {
      const index = view.services?.findIndex((entry) => entry.service === service) ?? -1;
      const entry = view.services?.[index];
      if (!entry) return { found: false, reason: `The saved sweep has no service ${service}.` };
      return {
        place: `Service ${service}`,
        at: entry.home ? `/services/${index}/home` : `/services/${index}`,
        state: entry.home
          ? (readStateAt(view, `/services/${index}/home`) ?? readState([]))
          : readState([]),
        value: {
          reading: reading(view, (anchor) => anchor.kind === "service" && anchor.id === service),
          home: entry.home ?? NOT_READ,
          stations: view.stations.find((row) => row.service === service)?.stations ?? NOT_READ,
          releases: entry.releases,
          pulls: entry.work ? listed(entry.work.pulls) : NOT_READ,
          issues: entry.work ? listed(entry.work.issues) : NOT_READ,
        },
        lists: ["pulls.rows", "issues.rows"],
      };
    },
  }),
  define({
    metadata: metadata("spi_radar"),
    description: "Upstream: what the next sync carries per fork and the MRs that would break one.",
    args: none,
    ...place("Upstream", "upstream", ["upstream", "radar"]),
  }),
  define({
    metadata: metadata("spi_template"),
    description: "Template: which template commit each fork runs and what it has not adopted.",
    args: none,
    ...place("Template", "engineering", ["template"]),
  }),
  define({
    metadata: metadata("spi_stack"),
    description: "Environment: the stack's state, who holds it, its facts and lanes.",
    args: none,
    ...place(
      "Environment",
      "environment",
      ["lifecycle"],
      ({ briefing: { environment } }) => {
        const { borrows: _b, activity: _a, ...rest } = environment;
        return rest;
      },
      ["lanes"],
      "/briefing/environment",
    ),
  }),
  define({
    metadata: metadata("spi_release_notes"),
    description: "Releases: release lines, today's release state, what is forming, by month.",
    args: z.strictObject({
      month: z
        .string()
        .regex(/^\d{4}-\d{2}$/)
        .optional(),
    }),
    read: ({ view }, { month }) => ({
      place: "Releases",
      at: "/releases",
      state: governedBy(readStateAt(view, "/releases/lines") ?? readState([]), "releases"),
      value: {
        lines: view.releases.lines,
        today: view.releases.today ?? NOT_READ,
        forming: view.releases.forming ?? NOT_READ,
        month: reading(
          view,
          (anchor) => anchor.kind === "release-month" && (!month || anchor.month === month),
        ),
      },
    }),
  }),
  define({
    metadata: metadata("spi_security"),
    description: "Security: SPI-owned and upstream-origin findings across the forks.",
    args: none,
    ...place("Security", "security", ["security"]),
  }),
  define({
    metadata: metadata("spi_inspect"),
    description:
      "One item by id (a Today member, station:, upstream:, release:, run:, hold:, theme:, pr:, issue: and the like): cause, effect, next step, evidence and what was not read.",
    args: z.strictObject({ id: z.string().min(1) }),
    read: async (sweep, { id }) => {
      const answer = await sweep.inspect(id);
      if (!answer) return { found: false, reason: `Nothing in the saved sweep has the id ${id}.` };
      return {
        place: `Item (${answer.kind})`,
        state: readState(answer.result.areas ?? []),
        value: { item: answer.result },
      };
    },
  }),
  define({
    metadata: metadata("spi_evidence"),
    description:
      "The sources behind one value, by the JSON pointer another SPI tool gave as at: its areas, their states and the reads behind them.",
    args: z.strictObject({ path: z.string() }),
    read: ({ view }, { path }) => {
      if (!resolvePointer(view, path).found) {
        return { found: false, reason: `The saved sweep has no value at ${path}.` };
      }
      const sources = sourcesAt(view, path);
      const state = readStateAt(view, path);
      const own = sources.length === 1 ? sources[0] : undefined;
      if (!state) {
        return {
          found: false,
          reason: `No source is recorded for the value at ${path}, so its read is not known.`,
        };
      }
      const areas = new Set<string>(sources.flatMap((source) => source.areas));
      return {
        place: "Evidence",
        at: path,
        state,
        value: {
          recordedAt: own ? own.path : `${sources.length} values below ${path}`,
          ...(own?.attributed ? { attributed: own.attributed } : {}),
          reads: view.reads.filter(({ source: from }) => areas.has(from)),
        },
        lists: ["reads"],
      };
    },
  }),
];

/** Whole items only: each named list (`key` or `key.list`) keeps what fits, in order, and says what it left out. */
function fit(value: Fields, lists: readonly string[], estimate: TokenEstimate): Fields {
  const result: Fields = { ...value };
  const slots = lists.flatMap((path) => {
    const [head = "", name] = path.split(".");
    if (name !== undefined) {
      const parent = value[head];
      if (parent === null || typeof parent !== "object" || Array.isArray(parent)) return [];
      result[head] = { ...parent };
    }
    const parent = (name === undefined ? result : result[head]) as Fields;
    const key = name ?? head;
    const items = parent[key];
    if (!Array.isArray(items)) return [];
    parent[key] = [];
    return [{ path, parent, key, items }];
  });
  const room = Object.fromEntries(slots.map(({ path, items }) => [path, items.length]));
  let used = estimate(JSON.stringify({ ...result, leftOut: room }));
  const leftOut: Record<string, number> = {};
  for (const { path, parent, key, items } of slots) {
    const kept: unknown[] = [];
    for (const item of items) {
      const cost = estimate(JSON.stringify(item)) + 1;
      if (used + cost > SPI_RESULT_TOKEN_BUDGET) break;
      kept.push(item);
      used += cost;
    }
    parent[key] = kept;
    if (kept.length < items.length) leftOut[path] = items.length - kept.length;
  }
  return Object.keys(leftOut).length ? { ...result, leftOut } : result;
}

export function answerFor(
  sweep: SavedSweep | undefined,
  answer: (sweep: SavedSweep) => Answer | Promise<Answer>,
  estimate: TokenEstimate = estimateTokens,
): Promise<Fields> | Fields {
  if (!sweep) return { read: NOT_READ, reason: "No sweep has been saved." };
  const shape = (found: Answer): Fields => {
    if ("found" in found)
      return { sweptAt: sweep.view.sweptAt, found: false, reason: found.reason };
    const { place: name, at, state, value, lists } = found;
    const head = {
      place: name,
      sweptAt: sweep.view.sweptAt,
      ...(at === undefined ? {} : { at }),
      read: state.read,
      areas: state.areas,
      ...(state.notRead.length ? { notRead: state.notRead } : {}),
      ...(state.failed.length ? { failed: state.failed } : {}),
    };
    return state.read === NOT_READ ? head : fit({ ...head, ...value }, lists ?? [], estimate);
  };
  const found = answer(sweep);
  return found instanceof Promise ? found.then(shape) : shape(found);
}

/** The SPI read tools over the latest saved sweep, each result through the model profile. */
export function spiReadTools(
  latest: LatestSweep,
  redactor: ModelRedactor,
  check: TierCheck = checkStubTier,
  estimate: TokenEstimate = estimateTokens,
): GatedTool[] {
  return READS.map(({ metadata: meta, description, args, read }) =>
    buildGatedTool(
      meta,
      args,
      check,
      async (parsed) => {
        const result = await answerFor(latest(), (sweep) => read(sweep, parsed), estimate);
        return JSON.stringify(redactor.value(result as JsonValue));
      },
      description,
    ),
  );
}

/** The engine's tools seam: the same tools for every turn. */
export function spiToolProvider(tools: readonly GatedTool[]) {
  return { offer: () => tools.map(({ tool }) => tool) };
}

export const offeredTools = (tools: readonly GatedTool[]) =>
  tools.map(({ name, tool }) => ({ name, description: tool.description ?? name }));
