// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

/** Who presses the buttons and reads the files, as operator-facing text names it. */
export interface Voice {
  /** A button's actor suffix: "Start · SPI Code". */
  readonly label: string;
  /** The actor inside a sentence: "SPI Code dispatches it". */
  readonly name: string;
}

export const APP_VOICE: Voice = Object.freeze({ label: "SPI Code", name: "SPI Code" });

/** The Keelson rib's own wording, for a rib that renders core output in its console. */
export const RIB_VOICE: Voice = Object.freeze({ label: "rib", name: "the rib" });

/** The actor opening a sentence. */
export function actor(voice: Voice): string {
  return voice.name.charAt(0).toUpperCase() + voice.name.slice(1);
}
