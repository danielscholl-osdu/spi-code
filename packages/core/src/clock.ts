// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = Object.freeze({ now: () => new Date() });
