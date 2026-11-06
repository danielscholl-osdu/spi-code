// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

/** How operator-facing text names the actor and its host. */
export interface Voice {
  /** A button's actor suffix: "Start · SPI Code". */
  readonly label: string;
  /** The actor inside a sentence: "SPI Code dispatches it". */
  readonly name: string;
  /** The reason a host cannot register a durable wait. */
  readonly noOps: string;
  /** The host restart phrase, including its article. */
  readonly restart: string;
  /** Optional guidance appended to an existing wait's disabled reason. */
  readonly existingWaitSuffix?: string;
}

export const APP_VOICE: Voice = Object.freeze({
  label: "SPI Code",
  name: "SPI Code",
  noOps: "SPI Code has no durable ops here",
  restart: "An SPI Code restart",
});

/** The Keelson rib's own wording, for a rib that renders core output in its console. */
export const RIB_VOICE: Voice = Object.freeze({
  label: "rib",
  name: "the rib",
  noOps: "this Keelson has no durable ops",
  restart: "A Keelson restart",
  existingWaitSuffix: "; run_cancel drops it",
});

/** The actor opening a sentence. */
export function actor(voice: Voice): string {
  return voice.name.charAt(0).toUpperCase() + voice.name.slice(1);
}
