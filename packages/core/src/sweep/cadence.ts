// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

export function due(at: string | undefined, interval: number, now: Date, force = false): boolean {
  const last = Date.parse(at ?? "");
  return force || !Number.isFinite(last) || now.getTime() - last >= interval;
}
