// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

export interface ReleaseFact {
  tag: string;
  at: string;
  body: string;
}

// What a service builds against at one release tag; null when no pom names it.
export interface BuildPins {
  lib: string | null;
  java: string | null;
}

export interface ReleaseReads {
  at?: string;
  releases: Record<string, ReleaseFact[]>;
  created: Record<string, string>;
  pins: Record<string, BuildPins>;
  errors: Record<string, string>;
}

export function pinKey(repo: string, tag: string): string {
  return `${repo}@${tag}`;
}
