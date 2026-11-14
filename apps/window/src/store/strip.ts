// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { isStoppedFork, type StationSubstate, type ViewSnapshot } from "@spi-code/contracts";
import { openHold } from "../views/environment/hold.js";

export type PipState = "stopped" | "needs-person" | "in-progress" | "nothing-due" | "unread";

export const PIPS: Readonly<Record<PipState, { mark: string; words: string }>> = {
  unread: { mark: "—", words: "not read yet" },
  stopped: { mark: "✕", words: "stopped" },
  "needs-person": { mark: "!", words: "needs a person" },
  "in-progress": { mark: "◐", words: "in progress" },
  "nothing-due": { mark: "○", words: "nothing due" },
};

const RANK: Readonly<Record<StationSubstate, number>> = {
  stopped: 4,
  "waiting-on-person": 3,
  "in-progress": 2,
  "waiting-on-clock": 1,
  ready: 0,
};

const PIP_OF: Readonly<Record<StationSubstate, PipState>> = {
  stopped: "stopped",
  "waiting-on-person": "needs-person",
  "in-progress": "in-progress",
  "waiting-on-clock": "nothing-due",
  ready: "nothing-due",
};

export type StripPip = { service: string; state: PipState };

/** ok is a fine word on a green tint, warn and bad a count, plain a state core did not read. */
export type StripTone = "ok" | "warn" | "bad" | "plain";

/** A state field's word or count, and the sentence behind it for its hover and accessible name. */
export type StripState = {
  text: string;
  tone: StripTone;
  label: string;
  classification:
    | "fine"
    | "unread"
    | "maintenance"
    | "refreshing"
    | "failed"
    | "pending"
    | "stopped"
    | "waiting";
  count?: number;
};

export const NOT_READ = "not read yet";

/** The strip's fields; next sync is absent when the snapshot carries none. */
export type StripFields = {
  pips: StripPip[];
  stopped: string[];
  environment: StripState;
  template: StripState;
  forks: StripState & { services: number };
  nextSync?: string;
};

type Stations = ViewSnapshot["stations"][number]["stations"];
type Rollout = Extract<
  NonNullable<NonNullable<ViewSnapshot["briefing"]["places"]>[number]["visual"]>,
  { kind: "rollout" }
>;

const list = (names: readonly string[]) => names.join(", ");
const state = (
  name: string,
  text: string,
  tone: StripTone,
  sentence: string,
  classification: StripState["classification"],
  count?: number,
): StripState => ({
  text,
  tone,
  label: `${name}: ${text}. ${sentence}`,
  classification,
  ...(count !== undefined ? { count } : {}),
});

const unreadLine = (stations: Stations) => {
  const line = stations.filter(({ id }) => id !== "lane");
  return line.length === 0 || line.some(({ state }) => state === "unknown");
};

function worst(stations: Stations): PipState {
  if (isStoppedFork(stations)) return "stopped";
  const worstSubstate = stations
    .filter(({ id }) => id !== "lane")
    .reduce<StationSubstate>(
      (held, { substate }) => (RANK[substate] > RANK[held] ? substate : held),
      "ready",
    );
  if (worstSubstate === "waiting-on-person") return "needs-person";
  return unreadLine(stations) ? "unread" : PIP_OF[worstSubstate];
}

function forksState(snapshot: ViewSnapshot, pips: readonly StripPip[]): StripState {
  if (pips.length === 0)
    return state("Forks", NOT_READ, "plain", "The forks' stations were not read.", "unread");
  const named = (wanted: PipState) =>
    pips.filter(({ state }) => state === wanted).map(({ service }) => service);
  const stopped = named("stopped");
  const waiting = named("needs-person");
  const unread = snapshot.stations
    .filter(
      ({ service, stations }) =>
        !stopped.includes(service) && !waiting.includes(service) && unreadLine(stations),
    )
    .map(({ service }) => service);
  const notRead = unread.length > 0 ? ` Not read yet: ${list(unread)}.` : "";
  if (stopped.length > 0)
    return state(
      "Forks",
      `${stopped.length} stopped`,
      "bad",
      `Stopped: ${list(stopped)}.${notRead}`,
      "stopped",
      stopped.length,
    );
  if (waiting.length > 0)
    return state(
      "Forks",
      `${waiting.length} waiting`,
      "warn",
      `Waiting on a person: ${list(waiting)}.${notRead}`,
      "waiting",
      waiting.length,
    );
  if (unread.length > 0) return state("Forks", NOT_READ, "plain", notRead.trim(), "unread");
  return state("Forks", "Flowing", "ok", `All ${pips.length} forks are flowing.`, "fine");
}

function templateState(rollout: Rollout | undefined, fleet: readonly string[]): StripState {
  if (!rollout || rollout.slots.length === 0 || fleet.length === 0)
    return state("Templates", NOT_READ, "plain", "The template rollout was not read.", "unread");
  const of = (...states: string[]) =>
    rollout.slots.filter(({ state }) => states.includes(state)).map(({ service }) => service);
  const failed = of("broken");
  const pending = of("empty", "occupied", "waiting");
  const slotted = new Set(rollout.slots.map(({ service }) => service));
  const unread = [...of("unknown"), ...fleet.filter((service) => !slotted.has(service))];
  const target = rollout.target.slice(0, 7);
  const notRead = unread.length > 0 ? ` Not read yet on ${list(unread)}.` : "";
  const pendingOn = pending.length > 0 ? `pending on ${list(pending)}` : "";
  if (failed.length > 0)
    return state(
      "Templates",
      `${failed.length} failed`,
      "bad",
      `Template ${target} failed on ${list(failed)}${pendingOn ? `; ${pendingOn}` : ""}.${notRead}`,
      "failed",
      failed.length,
    );
  if (pending.length > 0)
    return state(
      "Templates",
      `${pending.length} pending`,
      "warn",
      `Template ${target} is ${pendingOn}.${notRead}`,
      "pending",
      pending.length,
    );
  if (unread.length > 0)
    return state(
      "Templates",
      NOT_READ,
      "plain",
      `Template ${target} was not read on ${list(unread)}.`,
      "unread",
    );
  return state("Templates", "Current", "ok", `Every fork is on template ${target}.`, "fine");
}

function environmentState(snapshot: ViewSnapshot): StripState {
  const fact = snapshot.briefing.facts.find(({ label }) => label === "Environment");
  if (!fact?.figure.trim() || fact.figure === "?")
    return state(
      "Environment",
      NOT_READ,
      "plain",
      "The environment's state was not read.",
      "unread",
    );
  const version = fact.figure;
  const hold = openHold(snapshot);
  const held = hold?.label
    ? `${version} has been in maintenance for ${hold.label}`
    : `${version} is in maintenance`;
  if (fact.tone === "warn") {
    const run = fact.sub.split(" · ")[0]?.trim() || "a run is in flight";
    return state("Environment", `Maintenance · ${run}`, "warn", `${held}; ${run}.`, "refreshing");
  }
  if (hold || fact.tone === "bad")
    return state(
      "Environment",
      hold?.label ? `Maintenance ${hold.label}` : "Maintenance",
      "bad",
      `${held}, and nothing is running to clear it.`,
      "maintenance",
    );
  if (fact.tone === "ok" && /^deployable\b/.test(fact.sub))
    return state("Environment", "Ready", "ok", `${version} is ready.`, "fine");
  return state("Environment", NOT_READ, "plain", `The state of ${version} was not read.`, "unread");
}

/** The strip's fields from a snapshot, pips in the snapshot's fleet order. */
export function selectStrip(snapshot: ViewSnapshot): StripFields {
  const pips = snapshot.stations.map(({ service, stations }) => ({
    service,
    state: worst(stations),
  }));
  const rollout = snapshot.briefing.places?.find(({ place }) => place === "engineering")?.visual;
  const fields: StripFields = {
    pips,
    stopped: pips.filter(({ state }) => state === "stopped").map(({ service }) => service),
    environment: environmentState(snapshot),
    template: templateState(
      rollout?.kind === "rollout" ? rollout : undefined,
      pips.map(({ service }) => service),
    ),
    forks: { ...forksState(snapshot, pips), services: pips.length },
  };
  const { nextSyncAt } = snapshot.briefing;
  if (nextSyncAt !== undefined) fields.nextSync = nextSyncAt;
  return fields;
}
