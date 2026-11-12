// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const markdownUnder = (directory: string): string[] =>
  readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? markdownUnder(`${directory}/${entry.name}`)
      : entry.name.endsWith(".md")
        ? [`${directory}/${entry.name}`]
        : [],
  );
const processDocs = ["AGENTS.md", "docs/sdlc.md", ...markdownUnder(".agents")];

it("keeps docs/sdlc.md to the process, short enough to read before every bead", () => {
  const lines = readFileSync(join(root, "docs/sdlc.md"), "utf8").split("\n");
  expect(lines.length).toBeLessThanOrEqual(150);
});

it("names only files that exist in the process docs and skills", () => {
  const missing = processDocs.flatMap((doc) =>
    [
      ...readFileSync(join(root, doc), "utf8").matchAll(
        /`((?:scripts|\.agents|docs|design)\/[\w./-]+)`/g,
      ),
    ]
      .map(([, path]) => path as string)
      .filter((path) => !existsSync(join(root, path)))
      .map((path) => `${doc} names ${path}`),
  );
  expect(missing).toEqual([]);
});
