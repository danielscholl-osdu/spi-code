// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { internalNames, wordCount } from "../src/readings/index.js";

const root = fileURLToPath(new URL("../../../fixtures/watch/", import.meta.url));
const fixtures = readdirSync(root)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => ({ name, body: JSON.parse(readFileSync(`${root}${name}`, "utf8")) as unknown }));

// Fields the window draws only in Detail or as read evidence.
const DETAIL = new Set(["detail", "evidence", "envelope", "reads", "provenance"]);
// Identifiers and enums, never drawn as copy.
const KEYS = new Set(["id", "ids", "inspect", "kind"]);

type Leaf = { path: string; text: string; detail: boolean };

function leaves(value: unknown, path: string[] = [], detail = false): Leaf[] {
  if (typeof value === "string") return [{ path: `/${path.join("/")}`, text: value, detail }];
  if (Array.isArray(value)) return value.flatMap((v, i) => leaves(v, [...path, String(i)], detail));
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([key, v]) =>
      KEYS.has(key) ? [] : leaves(v, [...path, key], detail || DETAIL.has(key)),
    );
  return [];
}

describe.each(fixtures)("the text rules on $name", ({ name, body }) => {
  // An inspect fixture is a Detail panel through and through.
  const all = leaves(body, [], name.startsWith("inspect-"));
  const headlines = all.filter((leaf) => leaf.path.endsWith("/headline"));

  it("keeps every headline to at most 12 words", () => {
    if (!name.startsWith("inspect-")) expect(headlines.length).toBeGreaterThan(0);
    expect(
      headlines
        .filter((leaf) => wordCount(leaf.text) > 12)
        .map(({ path, text }) => ({ path, text })),
    ).toEqual([]);
  });

  it("keeps internal names in Detail and Evidence", () => {
    expect(
      all
        .filter((leaf) => !leaf.detail && internalNames(leaf.text).length > 0)
        .map(({ path, text }) => ({ path, text })),
    ).toEqual([]);
  });
});
