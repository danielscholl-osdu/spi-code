// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { AttentionTier } from "../attention.js";
import type { Facts } from "../facts.js";
import type { Model } from "../model/index.js";
import { stationSubstateOf } from "../model/substate.js";
import { verifiedForks } from "../model/verified.js";
import type { SweepReads } from "../sweep/sweeper.js";
import { horizonWaitServices } from "./horizon.js";
import { groupName } from "./repos.js";

type PlaceId = "line" | "environment" | "engineering" | "security";
type SlotState = "empty" | "occupied" | "done" | "waiting" | "broken" | "unknown";
interface Slot {
  service: string;
  state: SlotState;
  origin?: "system" | "upstream";
  text: string;
}
export type PlaceVisual =
  | { kind: "pips"; slots: Slot[]; stopped: string[]; horizon?: { count: number; text: string } }
  | {
      kind: "lifecycle";
      lanes: {
        lane: "refresh" | "upgrade" | "smoke" | "sweeper";
        green: number;
        total: number;
        state: "read" | "unknown";
        text: string;
      }[];
      greenSince?: string;
    }
  | { kind: "rollout"; target: string; slots: Slot[] }
  | {
      kind: "forkColumns";
      columns: { service: string; count: number | null; rules: string[]; text: string }[];
      largest?: { label: string; forks: number; text: string };
    };

export interface VisualSource {
  model: Model;
  facts: Facts;
  reads: SweepReads;
  cards?: readonly { itemIds: readonly string[]; services: readonly { service: string }[] }[];
}
interface TieredItem {
  id: string;
  ids: readonly string[];
  attention: AttentionTier;
}
const RANK: Readonly<Record<SlotState, number>> = Object.freeze({
  broken: 0,
  waiting: 1,
  unknown: 2,
  occupied: 3,
  done: 4,
  empty: 5,
});
const STATE = Object.freeze({
  stopped: "broken",
  "waiting-on-person": "waiting",
  "waiting-on-clock": "occupied",
  "in-progress": "occupied",
  ready: "empty",
} as const);

function lineVisual({ model, facts, cards }: VisualSource, items: readonly TieredItem[]): PlaceVisual {
  const waiting = horizonWaitServices(model, facts, items);
  const onHorizon = cards ? horizonWaitServices(model, facts, items, cards) : waiting;
  const slots = model.lines.map((line): Slot => {
    if (!line.repoRead)
      return {
        service: line.fork.id,
        state: "unknown",
        text: `${line.fork.id}: repository stations not read yet`,
      };
    const stations = line.stations
      .map((station) => ({
        station,
        state:
          station.state === "unknown"
            ? ("unknown" as const)
            : STATE[stationSubstateOf(station, line, facts)],
      }))
      .sort((a, b) => RANK[a.state] - RANK[b.state]);
    const worst = stations[0];
    const state = worst?.state ?? "unknown";
    return {
      service: line.fork.id,
      state,
      ...(state === "waiting"
        ? {
            origin:
              waiting.has(line.fork.id) &&
              stations.some(
                ({ station, state }) =>
                  state === "waiting" && (station.id === "upstream" || station.id === "sync"),
              )
                ? ("upstream" as const)
                : ("system" as const),
          }
        : {}),
      text: `${line.fork.id}: ${
        stations
          .filter((s) => s.state === state)
          .map(({ station }) => `${station.id}: ${station.text}`)
          .join("; ") || "stations not read yet"
      }`,
    };
  });
  return {
    kind: "pips",
    slots,
    stopped: slots.filter((slot) => slot.state === "broken").map((slot) => slot.service),
    ...(onHorizon.size
      ? { horizon: { count: onHorizon.size, text: `⇣ ${onHorizon.size} on the horizon` } }
      : {}),
  };
}

function lifecycleVisual({ model, reads }: VisualSource): PlaceVisual {
  const stack = model.stack;
  const read =
    reads.lifecycle?.some(
      (record) => record.failure === undefined || record.retainedFrom !== undefined,
    ) ?? false;
  return {
    kind: "lifecycle",
    lanes: (["refresh", "upgrade", "smoke", "sweeper"] as const).map((lane) => {
      const { green, total } = stack.lifecycle[lane];
      return {
        lane,
        green,
        total,
        state: read && total > 0 ? ("read" as const) : ("unknown" as const),
        text:
          read && total > 0
            ? `${lane}: ${green} of ${total} green in 21 days`
            : `${lane}: 21-day pass rate not read yet`,
      };
    }),
    ...(read &&
    stack.deployable.state === "yes" &&
    stack.maintenance.since &&
    Object.values(stack.lifecycle).some((stat) => stat.total > 0)
      ? { greenSince: stack.maintenance.since }
      : {}),
  };
}

function rolloutVisual({ model, facts }: VisualSource): PlaceVisual | undefined {
  const target = model.rollout?.target.sha ?? model.template.head?.sha;
  if (!target) return undefined;
  const slots = model.lines.map((line): Slot => {
    const row = model.template.rows.find((row) => row.service === line.fork.id);
    const fork = model.rollout?.forks.find((fork) => fork.service === line.fork.id);
    const verified =
      verifiedForks(
        [line],
        model.rollout && fork ? { ...model.rollout, forks: [fork] } : undefined,
        facts.runs.data,
      ) > 0;
    const state: SlotState =
      row?.behind === undefined || fork?.unread
        ? "unknown"
        : verified
          ? "done"
          : fork?.red || row?.verdict === "red"
            ? "broken"
            : row?.pr?.draft ||
                row?.pr?.reviewDecision === "CHANGES_REQUESTED" ||
                row?.pr?.reviewDecision === "REVIEW_REQUIRED"
              ? "waiting"
              : row?.pr || row?.syncing || row?.behind === 0
                ? "occupied"
                : "empty";
    const words = {
      unknown: "template position not read yet",
      done: "verified on",
      broken: "template validation failed for",
      waiting: "template PR waits for review on",
      occupied: "template verification pending on",
      empty: "no template delivery open for",
    };
    return { service: line.fork.id, state, text: `${line.fork.id}: ${words[state]} ${target}` };
  });
  return { kind: "rollout", target, slots };
}

function securityVisual({ model }: VisualSource): PlaceVisual {
  const groups = new Map<string, { label: string; forks: Set<string> }>();
  const columns = model.lines.map((line) => {
    const row = model.repositories.rows.find((row) => row.repo === line.fork.repo);
    const count =
      row?.vulnerabilities && row.codeScanning
        ? row.vulnerabilities.ours + row.codeScanning.ours
        : null;
    const rules = [
      ...new Set(
        (row?.alerts ?? [])
          .filter(
            (alert) =>
              alert.owner !== "upstream" &&
              alert.reach === "shipped" &&
              (alert.counts.high ?? 0) + (alert.counts.critical ?? 0) > 0,
          )
          .map((alert) => {
            const label = groupName(alert);
            const key =
              alert.source === "code"
                ? `code:${alert.tool}:${alert.rule}`
                : `dep:${alert.name.toLowerCase()}`;
            const group = groups.get(key) ?? { label, forks: new Set<string>() };
            group.forks.add(line.fork.id);
            groups.set(key, group);
            return label;
          }),
      ),
    ];
    return {
      service: line.fork.id,
      count,
      rules,
      text:
        count === null
          ? `${line.fork.id}: Security not fully read yet`
          : `${line.fork.id}: ${count} high or critical${rules.length ? ` · ${rules.join(", ")}` : ""}`,
    };
  });
  const largest = [...groups.values()].sort(
    (a, b) => b.forks.size - a.forks.size || a.label.localeCompare(b.label),
  )[0];
  return {
    kind: "forkColumns",
    columns,
    ...(largest
      ? {
          largest: {
            label: largest.label,
            forks: largest.forks.size,
            text: `${largest.label} · ${largest.forks.size} ${largest.forks.size === 1 ? "fork" : "forks"}`,
          },
        }
      : {}),
  };
}

export function placeVisuals(
  source: VisualSource,
  items: readonly TieredItem[],
): Partial<Record<PlaceId, PlaceVisual>> {
  const rollout = rolloutVisual(source);
  return {
    line: lineVisual(source, items),
    environment: lifecycleVisual(source),
    security: securityVisual(source),
    ...(rollout ? { engineering: rollout } : {}),
  };
}
