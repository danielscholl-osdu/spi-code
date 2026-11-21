// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { resolvePointer, type ViewSnapshot } from "@spi-code/contracts";
import { z } from "zod";
import { readPlace } from "../threads/context/places.js";
import { redactSpiText, redactSpiValue, type SpiRedactor } from "../threads/context/redaction.js";
import { paneReading, ruleReading, unreadLists } from "../threads/context/security.js";
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
  withRecords,
} from "../threads/context/sweep.js";
import {
  buildGatedTool,
  checkStubTier,
  type GatedTool,
  type TierCheck,
  ToolRefusedError,
} from "./registry.js";
import { APPENDIX_A_TOOLS, type ToolMetadata } from "./tool-names.js";

export const SPI_RESULT_BYTE_BUDGET = 12_000;

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
      /** Shown even when not read, as evidence names what was and was not read. */
      readonly always?: boolean;
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

const place = (id: string) => ({
  read: ({ view }: SavedSweep): Answer => {
    const found = readPlace(view, id);
    if (!found) return { found: false, reason: `The saved sweep has no place ${id}.` };
    const { reading: content, ...rest } = found;
    return { ...rest, value: { reading: content } };
  },
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
        lines:
          view.briefing.lines?.map(({ members, ...line }) => ({
            ...line,
            members: members.map(({ id, fork, station, cause, evidence }) => ({
              id,
              fork,
              ...(station === undefined ? {} : { station }),
              cause,
              notRead: evidence.notRead,
            })),
          })) ?? NOT_READ,
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
      const found = readPlace(view, `service:${service}`);
      const entry = view.services?.find((row) => row.service === service);
      if (!found || !entry) {
        return { found: false, reason: `The saved sweep has no service ${service}.` };
      }
      const { reading: content, ...rest } = found;
      return {
        ...rest,
        value: {
          reading: content,
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
    ...place("place:upstream"),
  }),
  define({
    metadata: metadata("spi_template"),
    description: "Template: which template commit each fork runs and what it has not adopted.",
    args: none,
    ...place("place:engineering-system"),
  }),
  define({
    metadata: metadata("spi_stack"),
    description: "Environment: the stack's state, who holds it, its facts and lanes.",
    args: none,
    read: ({ view }) => {
      const { borrows: _b, activity: _a, ...rest } = view.briefing.environment;
      return {
        place: "Environment",
        at: "/briefing/environment",
        state: readState(areaEnvelopes(view, ["lifecycle"])),
        value: { reading: reading(view, (entry) => entry.kind === "environment"), ...rest },
        lists: ["lanes"],
      };
    },
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
    read: ({ view }, { month }) => {
      const found = readPlace(view, "place:releases");
      if (!found) return { found: false, reason: "The saved sweep has no Releases place." };
      const { reading: _reading, ...head } = found;
      return {
        ...head,
        value: {
          lines: view.releases.lines,
          today: view.releases.today ?? NOT_READ,
          forming: view.releases.forming ?? NOT_READ,
          month: reading(
            view,
            (anchor) => anchor.kind === "release-month" && (!month || anchor.month === month),
          ),
        },
      };
    },
  }),
  define({
    metadata: metadata("spi_security"),
    description:
      "Security: open alerts by lane (shipped SPI code, shipped upstream code, tests and tooling), each rule or package with its forks, fix and age, and the lists not read. With rule (a rule's key), that rule's facts and where it sits by repository and file.",
    args: z.strictObject({ rule: z.string().min(1).optional() }),
    read: ({ view }, { rule }) => {
      const state = readState(areaEnvelopes(view, ["security"]));
      const notRead = unreadLists(view.security);
      const lists = notRead.length > 0 ? { listsNotRead: notRead } : {};
      if (rule === undefined) {
        const reading = paneReading(view.security, true);
        return {
          place: "Security",
          at: "/security",
          state,
          value: { ...lists, ...(typeof reading === "string" ? { reading } : reading) },
          lists: ["rules"],
        };
      }
      const { title, at, reading } = ruleReading(view, rule);
      return {
        place: title,
        at: at ?? "/security",
        state,
        value: { ...lists, ...(typeof reading === "string" ? { reading } : reading) },
        lists: ["where"],
      };
    },
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
    read: ({ view, reads }, { path }) => {
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
      const readers = sources.flatMap(({ envelope }) => (envelope ? [envelope.source] : []));
      const collectors = [...new Set([...sources.flatMap((source) => source.areas), ...readers])];
      const records = (name: string) =>
        (reads as Record<string, SavedSweep["reads"]["fleet"]>)[name];
      return {
        place: "Evidence",
        at: path,
        state: readers.reduce(governedBy, state),
        always: true,
        value: {
          recordedAt: own ? own.path : `${sources.length} values below ${path}`,
          ...(own?.attributed ? { attributed: own.attributed } : {}),
          collectors: collectors.map((name) => ({
            collector: name,
            state: state.areas.find(({ area }) => area === name)?.state ?? "unread",
            reads: state.notRead.includes(name) ? NOT_READ : (records(name)?.length ?? NOT_READ),
          })),
          reads: collectors.flatMap((name) =>
            (records(name) ?? []).map((record) => ({ collector: name, ...record })),
          ),
        },
        lists: ["reads"],
      };
    },
  }),
];

export function isSpiReadTool(name: string): boolean {
  return READS.some(({ metadata }) => metadata.name === name && metadata.tier === "Read");
}

/** Whole items only: each named list (`key` or `key.list`) keeps what fits, in order, and says what it left out. */
function fit(value: Fields, lists: readonly string[]): Fields {
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
  let used = Buffer.byteLength(JSON.stringify({ ...result, leftOut: room }));
  const leftOut: Record<string, number> = {};
  for (const { path, parent, key, items } of slots) {
    const kept: unknown[] = [];
    for (const item of items) {
      const cost = Buffer.byteLength(JSON.stringify(item)) + 1;
      if (used + cost > SPI_RESULT_BYTE_BUDGET) break;
      kept.push(item);
      used += cost;
    }
    parent[key] = kept;
    if (kept.length < items.length) leftOut[path] = items.length - kept.length;
  }
  return Object.keys(leftOut).length ? { ...result, leftOut } : result;
}

const WITHHELD = "SPI tool output withheld.";

function resultJson(value: Fields, lists: readonly string[], journal: SpiRedactor): string {
  try {
    const safe = redactSpiValue(value, journal);
    if (safe === null || typeof safe !== "object" || Array.isArray(safe)) {
      throw new Error(WITHHELD);
    }
    return JSON.stringify(lists.length ? fit(safe as Fields, lists) : safe);
  } catch {
    throw new Error(WITHHELD);
  }
}

async function answerFor(
  sweep: SavedSweep | undefined,
  answer: (sweep: SavedSweep) => Answer | Promise<Answer>,
  journal: SpiRedactor,
): Promise<string> {
  const render = (value: Fields, lists: readonly string[] = []) =>
    resultJson(value, lists, journal);
  if (!sweep) return render({ read: NOT_READ, reason: "No sweep has been saved." });
  const found = await answer(sweep);
  if ("found" in found)
    return render({ sweptAt: sweep.view.sweptAt, found: false, reason: found.reason });
  const { place: name, at, state, value, lists, always } = found;
  const head = {
    place: name,
    sweptAt: sweep.view.sweptAt,
    ...(at === undefined ? {} : { at }),
    read: state.read,
    areas: withRecords(state.areas, sweep.reads),
    ...(state.notRead.length ? { notRead: state.notRead } : {}),
    ...(state.failed.length ? { failed: state.failed } : {}),
  };
  return state.read === NOT_READ && !always ? render(head) : render({ ...head, ...value }, lists);
}

/** The SDK forwards thrown messages to the model. */
function redacted(error: unknown, journal: SpiRedactor): Error {
  try {
    const message = redactSpiText(error instanceof Error ? error.message : String(error), journal);
    return error instanceof ToolRefusedError ? new ToolRefusedError(message) : new Error(message);
  } catch {
    return new Error(WITHHELD);
  }
}

/** The SPI read tools over the latest saved sweep, with journal redaction on results and errors. */
export function spiReadTools(
  latest: LatestSweep,
  journal: SpiRedactor,
  check: TierCheck = checkStubTier,
): GatedTool[] {
  return READS.map(({ metadata: meta, description, args, read }) => {
    const gated = buildGatedTool(
      meta,
      args,
      check,
      (parsed) => answerFor(latest(), (sweep) => read(sweep, parsed), journal),
      description,
    );
    const { handler } = gated.tool;
    return {
      ...gated,
      tool: {
        ...gated.tool,
        async handler(args, invocation) {
          try {
            return await handler(args, invocation);
          } catch (error) {
            throw redacted(error, journal);
          }
        },
      },
    };
  });
}

/** The engine's tools seam: the same tools for every turn. */
export function spiToolProvider(tools: readonly GatedTool[]) {
  return { offer: () => tools.map(({ tool }) => tool) };
}

export const offeredTools = (tools: readonly GatedTool[]) =>
  tools.map(({ name, tool }) => ({ name, description: tool.description ?? name }));
