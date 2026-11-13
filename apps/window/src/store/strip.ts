// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { isStoppedFork, type StationSubstate, type ViewSnapshot } from "@spi-code/contracts";
import { openHold } from "../views/environment/hold.js";

/** The four pip states a pinned service row draws; a scheduled station has nothing due from a person. */
export type PipState = "stopped" | "needs-person" | "in-progress" | "nothing-due";

export const PIPS: Readonly<Record<PipState, { mark: string; words: string }>> = {
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
export type StripState = { text: string; tone: StripTone; label: string };

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
const state = (name: string, text: string, tone: StripTone, sentence: string): StripState => ({
  text,
  tone,
  label: `${name}: ${text}. ${sentence}`,
});

/** A service's worst sub-state over its line stations; the stack lane is not one of them. */
function worst(stations: Stations): StationSubstate {
  if (isStoppedFork(stations)) return "stopped";
  return stations
    .filter(({ id }) => id !== "lane")
    .reduce<StationSubstate>(
      (held, { substate }) => (RANK[substate] > RANK[held] ? substate : held),
      "ready",
    );
}

const unreadLine = (stations: Stations) =>
  stations.some(({ id, state }) => id !== "lane" && state === "unknown");

function forksState(snapshot: ViewSnapshot, pips: readonly StripPip[]): StripState {
  if (pips.length === 0)
    return state("Forks", NOT_READ, "plain", "The forks' stations were not read.");
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
    );
  if (waiting.length > 0)
    return state(
      "Forks",
      `${waiting.length} waiting`,
      "warn",
      `Waiting on a person: ${list(waiting)}.${notRead}`,
    );
  if (unread.length > 0) return state("Forks", NOT_READ, "plain", notRead.trim());
  return state("Forks", "Flowing", "ok", `All ${pips.length} forks are flowing.`);
}

function templateState(rollout: Rollout | undefined): StripState {
  if (!rollout || rollout.slots.length === 0)
    return state("Templates", NOT_READ, "plain", "The template rollout was not read.");
  const of = (...states: string[]) =>
    rollout.slots.filter(({ state }) => states.includes(state)).map(({ service }) => service);
  const failed = of("broken");
  const pending = of("empty", "occupied", "waiting");
  const unread = of("unknown");
  const target = rollout.target.slice(0, 7);
  const notRead = unread.length > 0 ? ` Not read yet on ${list(unread)}.` : "";
  const pendingOn = pending.length > 0 ? `pending on ${list(pending)}` : "";
  if (failed.length > 0)
    return state(
      "Templates",
      `${failed.length} failed${pending.length > 0 ? ` · ${pending.length} pending` : ""}`,
      "bad",
      `Template ${target} failed on ${list(failed)}${pendingOn ? `; ${pendingOn}` : ""}.${notRead}`,
    );
  if (pending.length > 0)
    return state(
      "Templates",
      `${pending.length} pending`,
      "warn",
      `Template ${target} is ${pendingOn}.${notRead}`,
    );
  if (unread.length > 0)
    return state(
      "Templates",
      NOT_READ,
      "plain",
      `Template ${target} was not read on ${list(unread)}.`,
    );
  return state("Templates", "Current", "ok", `Every fork is on template ${target}.`);
}

function environmentState(snapshot: ViewSnapshot): StripState {
  const fact = snapshot.briefing.facts.find(({ label }) => label === "Environment");
  if (!fact || fact.figure === "?")
    return state("Environment", NOT_READ, "plain", "The environment's state was not read.");
  const version = fact.figure;
  const hold = openHold(snapshot);
  const held = hold?.label
    ? `${version} has been in maintenance for ${hold.label}`
    : `${version} is in maintenance`;
  if (fact.tone === "warn") {
    const run = fact.sub.split(" · ")[0]?.trim() || "a run is in flight";
    return state("Environment", `Maintenance · ${run}`, "warn", `${held}; ${run}.`);
  }
  if (hold || fact.tone === "bad")
    return state(
      "Environment",
      hold?.label ? `Maintenance ${hold.label}` : "Maintenance",
      "bad",
      `${held}, and nothing is running to clear it.`,
    );
  if (fact.tone === "ok" && /^deployable\b/.test(fact.sub))
    return state("Environment", "Ready", "ok", `${version} is ready.`);
  return state("Environment", NOT_READ, "plain", `The state of ${version} was not read.`);
}

/** The strip's fields from a snapshot, pips in the snapshot's fleet order. */
export function selectStrip(snapshot: ViewSnapshot): StripFields {
  const pips = snapshot.stations.map(({ service, stations }) => ({
    service,
    state: PIP_OF[worst(stations)],
  }));
  const rollout = snapshot.briefing.places?.find(({ place }) => place === "engineering")?.visual;
  const fields: StripFields = {
    pips,
    stopped: pips.filter(({ state }) => state === "stopped").map(({ service }) => service),
    environment: environmentState(snapshot),
    template: templateState(rollout?.kind === "rollout" ? rollout : undefined),
    forks: { ...forksState(snapshot, pips), services: pips.length },
  };
  const { nextSyncAt } = snapshot.briefing;
  if (nextSyncAt !== undefined) fields.nextSync = nextSyncAt;
  return fields;
}
