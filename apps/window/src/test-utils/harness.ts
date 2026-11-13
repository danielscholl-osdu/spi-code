// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type InspectResult,
  InspectResultSchema,
  type ViewSnapshot,
  ViewSnapshotSchema,
} from "@spi-code/contracts";
import { vi } from "vitest";
import {
  type Read,
  WATCH_INSPECTIONS,
  WATCH_SNAPSHOTS,
  watchFixtureText,
} from "./watch-fixtures.test-helper.js";

export function stubActEnvironment() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    writable: true,
    value: true,
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previous);
    else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  };
}

export function installSpi(overrides: Partial<Window["spi"]> = {}) {
  const previous = window.spi;
  const restoreAct = stubActEnvironment();
  window.spi = {
    proof: overrides.proof ?? false,
    openExternal: vi.fn(overrides.openExternal ?? (async () => false)),
    setAppearance: vi.fn(overrides.setAppearance ?? (async () => true)),
    postMessage: vi.fn(overrides.postMessage ?? (() => {})),
    onMessage: vi.fn(overrides.onMessage ?? (() => () => {})),
    ...(overrides.onNavigate ? { onNavigate: vi.fn(overrides.onNavigate) } : {}),
    ...(overrides.onLeave ? { onLeave: vi.fn(overrides.onLeave) } : {}),
  } satisfies Window["spi"];
  const spi = vi.mocked(window.spi);
  return {
    spi,
    restore() {
      window.spi = previous;
      restoreAct();
    },
  };
}

export type SnapshotName = (typeof WATCH_SNAPSHOTS)[number];
export type InspectionName = `inspect-${string}.json`;

export function fixtureLoader(read: Read) {
  function loadFixture(name: SnapshotName, reader?: Read): ViewSnapshot;
  function loadFixture(name: InspectionName, reader?: Read): InspectResult[];
  function loadFixture(name: string, reader?: Read): ViewSnapshot | InspectResult[];
  function loadFixture(name: string, reader: Read = read): ViewSnapshot | InspectResult[] {
    if (![...WATCH_SNAPSHOTS, ...WATCH_INSPECTIONS].includes(name))
      throw new Error(`Unknown watch fixture: ${name}`);
    const input: unknown = JSON.parse(watchFixtureText(name, reader));
    return name.startsWith("snapshot-")
      ? ViewSnapshotSchema.parse(input)
      : InspectResultSchema.array().parse(input);
  }
  return loadFixture;
}
