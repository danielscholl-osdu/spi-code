// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const directory = fileURLToPath(new URL("../fixtures/rib-59d6895/oracle/", import.meta.url));
const classes = [
  "ACCESS",
  "BUILD",
  "CONFLICT",
  "ENV",
  "HALT",
  "INFRA",
  "POLICY",
  "TEST",
  "TOOLCHAIN",
  "UNREAD",
];
const expectedFiles = [
  "briefing.json",
  "console.html",
  "environment-place.json",
  "lines.json",
  "releases.json",
  ...classes.map((cls) => `inspect/${cls}.json`),
].sort();

function verify(directory: string) {
  const manifest: { files: Record<string, string> } = JSON.parse(
    readFileSync(join(directory, "manifest.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(manifest.files).sort(), expectedFiles, "Payload list differs");
  for (const name of expectedFiles) {
    const actual = createHash("sha256")
      .update(readFileSync(join(directory, name)))
      .digest("hex");
    assert.equal(actual, manifest.files[name], `Hash differs: ${name}`);
  }
  return manifest;
}

describe("frozen rib payload oracle", () => {
  it("verifies every committed payload and all ten inspector classes without Bun", () => {
    const manifest = verify(directory);
    expect(Object.keys(manifest.files).filter((name) => name.startsWith("inspect/"))).toEqual(
      classes.map((cls) => `inspect/${cls}.json`),
    );
    for (const cls of classes) {
      const board = JSON.parse(readFileSync(join(directory, `inspect/${cls}.json`), "utf8"));
      expect(board.header.status.label).toMatch(new RegExp(`^P[012] · ${cls}$`));
    }
  });

  it.each(["edit", "missing", "unlisted"] as const)("rejects a planted %s", (change) => {
    const temporary = mkdtempSync(join(tmpdir(), "spi-code-oracle-test-"));
    try {
      cpSync(directory, temporary, { recursive: true });
      const target = join(temporary, "briefing.json");
      if (change === "edit") writeFileSync(target, `${readFileSync(target, "utf8")} `);
      if (change === "missing") unlinkSync(target);
      if (change === "unlisted") {
        const manifest = JSON.parse(readFileSync(join(temporary, "manifest.json"), "utf8"));
        delete manifest.files["inspect/ENV.json"];
        writeFileSync(join(temporary, "manifest.json"), JSON.stringify(manifest));
      }
      expect(() => verify(temporary)).toThrow(
        change === "edit"
          ? "Hash differs: briefing.json"
          : change === "missing"
            ? "ENOENT"
            : "Payload list differs",
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
