// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  GENERATED,
  generatedFixture,
  inputsDigest,
  verifyGenerated,
  writeGenerated,
} from "./watch-generated.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A checkout with one generator input and a generated folder stamped with its digest. */
function checkout() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "spi-watch-generated-")));
  roots.push(root);
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write("packages/core/src/brief.ts", "export const text = 1;\n");
  write(`${GENERATED}/snapshot-calm.json`, "{}\n");
  write(`${GENERATED}/inputs.sha256`, `${inputsDigest(root)}\n`);
  return { root, write };
}

it("serves a generated fixture while its digest matches the sources", () => {
  const { root } = checkout();

  expect(generatedFixture("snapshot-calm.json", root)).toBe(
    join(root, GENERATED, "snapshot-calm.json"),
  );
});

it("refuses generated fixtures, naming the generator, once a source they come from changed", () => {
  const { root, write } = checkout();
  write("packages/core/src/brief.ts", "export const text = 2;\n");

  expect(() => verifyGenerated(root)).toThrow(
    `${GENERATED} was generated from other sources: run pnpm build && node scripts/watch-generated.mjs`,
  );
});

it("keeps them current when only a test beside the sources changed", () => {
  const { root, write } = checkout();
  write("packages/core/src/brief.test.ts", "it.todo('x');\n");

  expect(() => verifyGenerated(root)).not.toThrow();
});

it("refuses a missing generated folder, naming the generator", () => {
  const { root } = checkout();
  rmSync(join(root, GENERATED), { recursive: true });

  expect(() => generatedFixture("snapshot-calm.json", root)).toThrow(
    "is missing or its generation failed: run pnpm build && node scripts/watch-generated.mjs",
  );
});

it("leaves no generated folder behind when generation fails", async () => {
  const { root } = checkout();

  await expect(writeGenerated(root)).rejects.toThrow("pnpm build");
  expect(existsSync(join(root, GENERATED))).toBe(false);
});
