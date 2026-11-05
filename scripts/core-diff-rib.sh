#!/usr/bin/env bash
# Copyright 2026, Daniel Scholl
# SPDX-License-Identifier: MIT

set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
rib="${1:-/Users/danielscholl/keelson/keelson-rib-spi}"

# Exit 1 means diff found changes; 2 means the comparison could not run.
# Compare the selected modules and the exact release/notes extraction, not collectors.
# Only license headers and relative .ts/.js import suffixes are normalized.
# The core-native dependency test has no rib counterpart and is excluded by name.
node --input-type=module - "$rib" "$root/packages/core/src" <<'NODE'
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [rib, core] = process.argv.slice(2);
const temp = mkdtempSync(join(tmpdir(), "core-diff-rib-"));
const reference = join(temp, "rib");
const actual = join(temp, "core");
const exported = join(temp, "export");
const header = /^\/\/ Copyright 2026, Daniel Scholl\n(?:\/\/ SPDX-License-Identifier: MIT\n|\/\/\n\/\/ Licensed under the Apache License, Version 2\.0 \(the "License"\);\n\/\/ you may not use this file except in compliance with the License\.\n\/\/ You may obtain a copy of the License at\n\/\/\n\/\/     http:\/\/www\.apache\.org\/licenses\/LICENSE-2\.0\n)\n/;

function normalize(text) {
  return text.replace(header, "").replace(
    /((?:from\s+|import\s*)["']\.{1,2}\/[^"']+)\.ts(["'])/g,
    "$1.js$2",
  );
}

function normalizeTree(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) normalizeTree(path);
    else writeFileSync(path, normalize(readFileSync(path, "utf8")));
  }
}

try {
  mkdirSync(exported);
  const archive = execFileSync("git", ["-C", rib, "archive", "59d6895"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  execFileSync("tar", ["-x", "-C", exported], { input: archive });
  mkdirSync(reference);
  cpSync(core, actual, { recursive: true });
  rmSync(join(actual, "dependencies.test.ts"));
  for (const name of ["config.ts", "facts.ts", "rollout.ts", "util.ts", "model", "brief"]) {
    cpSync(join(exported, "src", name), join(reference, name), { recursive: true });
  }
  const releases = readFileSync(join(exported, "src/collect/releases.ts"), "utf8");
  writeFileSync(join(reference, "releases.ts"),
    releases.slice(releases.indexOf("export interface ReleaseFact"), releases.indexOf("const readsSchema")) +
    releases.slice(releases.indexOf("export function pinKey"), releases.indexOf("const JAVA_PROPS")).trimEnd() + "\n",
  );
  const notes = readFileSync(join(exported, "src/notes/file.ts"), "utf8");
  writeFileSync(join(reference, "notes.ts"),
    'import { z } from "@keelson/shared";\n\n' +
    notes.slice(notes.indexOf("// The written half"), notes.indexOf("// RIB_SPI_NOTES_DIR")).trimEnd() + "\n",
  );
  normalizeTree(reference);
  normalizeTree(actual);
  const result = spawnSync("diff", ["-r", "-u", reference, actual], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 2;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
NODE
