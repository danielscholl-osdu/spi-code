// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import * as ts from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/sync";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFixture } from "../../../../scripts/watch-generated.mjs";
import { directoryPaths } from "./directory-paths.test.js";
import { fixtureLoader, installSpi, stubActEnvironment } from "./harness.js";
import { WATCH_INSPECTIONS, WATCH_SNAPSHOTS } from "./watch-fixtures.test-helper.js";

const loadFixture = fixtureLoader(readFixture);

const virtualRoot = `${process.cwd().replaceAll("\\", "/")}/build/window-spi-guard`;
const configPath = `${virtualRoot}/tsconfig.json`;
const sourcePath = `${virtualRoot}/scan.test.tsx`;
const fs = createVirtualFileSystem({
  [configPath]: JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, types: [], jsx: "preserve" },
    files: ["scan.test.tsx"],
  }),
  [sourcePath]: "",
});
let api: API;
beforeAll(() => {
  api = new API({ fs });
  api.updateSnapshot({ openProjects: [configPath] }).dispose();
});
afterAll(() => api.close());

function assignments(source: string): boolean {
  fs.writeFile?.(sourcePath, source);
  const snapshot = api.updateSnapshot({ fileChanges: { changed: [sourcePath] } });
  api.clearSourceFileCache();
  let found = false;
  function visit(node: ts.Node) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left;
      if (
        ((ts.isPropertyAccessExpression(left) && left.name.text === "spi") ||
          (ts.isElementAccessExpression(left) &&
            ts.isStringLiteral(left.argumentExpression) &&
            left.argumentExpression.text === "spi")) &&
        ts.isIdentifier(left.expression) &&
        left.expression.text === "window"
      )
        found = true;
    }
    node.forEachChild(visit);
  }
  try {
    const file = snapshot.getProject(configPath)?.program.getSourceFile(sourcePath);
    if (!file) throw new Error("Missing SPI scan source file");
    visit(file);
    return found;
  } finally {
    snapshot.dispose();
  }
}

it("keeps hand-written SPI assignments only in the harness", () => {
  const files = directoryPaths("apps/window/src")
    .filter((file) => /\.tsx?$/.test(file))
    .filter((file) => assignments(readFileSync(`apps/window/src/${file}`, "utf8")));
  expect(files).toEqual(["test-utils/harness.ts"]);
});

it.each([
  [["window.spi", "= {}"].join(" "), true],
  ['window["spi"] = other', true],
  ["window.spi = previous", true],
  ["window.spi.openExternal = fn", false],
  [['const text = "window.spi', '= {}"'].join(" "), false],
])("recognizes SPI assignments in %s", (source, found) => {
  expect(assignments(source)).toBe(found);
});

it("loads every named snapshot and inspect feed with its parsed type", () => {
  for (const name of WATCH_SNAPSHOTS) expect(loadFixture(name).cursor).toBeGreaterThan(0);
  for (const name of WATCH_INSPECTIONS)
    expect(loadFixture(name)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: expect.any(String) })]),
    );
});

it("returns a fresh parsed snapshot on each load", () => {
  const first = loadFixture("snapshot-1106.json");
  const second = loadFixture("snapshot-1106.json");
  expect(first).toEqual(second);
  expect(first).not.toBe(second);
  expect(first.briefing).not.toBe(second.briefing);
});

it.each(["snapshot-unknown.json", "inspect-unknown.json", "toString", "__proto__"])(
  "throws naming unknown fixture %s before reading it",
  (name) => {
    const read = vi.fn(() => "{}");
    expect(() => loadFixture(name, read)).toThrow(name);
    expect(read).not.toHaveBeenCalled();
  },
);

it.each(["{}", '{"cursor": 1}', "not JSON"])(
  "rejects an invalid snapshot file containing %s",
  (raw) => {
    expect(() => loadFixture("snapshot-1106.json", () => raw)).toThrow();
  },
);

it.each(["{}", '[{"id":"partial"}]', "not JSON"])(
  "rejects an invalid inspect feed containing %s",
  (raw) => {
    expect(() => loadFixture("inspect-1106.json", () => raw)).toThrow();
  },
);

it("passes the named repository path to the fixture reader", () => {
  const read = vi.fn((path: string) => readFileSync(path, "utf8"));
  expect(loadFixture("snapshot-1106.json", read)).toEqual(loadFixture("snapshot-1106.json"));
  expect(read).toHaveBeenCalledExactlyOnceWith("fixtures/watch/snapshot-1106.json");
});

it("reads a generated snapshot from fixtures/watch/generated", () => {
  const read = vi.fn(readFixture);
  expect(loadFixture("snapshot-calm.json", read).cursor).toBeGreaterThan(0);
  expect(read).toHaveBeenCalledExactlyOnceWith("fixtures/watch/generated/snapshot-calm.json");
});

it("names the generator when a generated snapshot cannot be read", () => {
  const missing = () => {
    throw new Error("ENOENT");
  };
  expect(() => loadFixture("snapshot-calm.json", missing)).toThrow(
    "pnpm build && node scripts/watch-generated.mjs",
  );
});

const previous = window.spi;
const actDescriptor = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe.sequential("SPI teardown between cases", () => {
  it("installs complete typed spies and replaces the stub during the case", async () => {
    const harness = installSpi();
    cleanups.push(harness.restore);
    expect(window.spi).toBe(harness.spi);
    expect(harness.spi.proof).toBe(false);
    expect(Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")).toBe(true);
    for (const name of ["openExternal", "postMessage", "onMessage"] as const)
      expect(vi.isMockFunction(harness.spi[name])).toBe(true);
    const listener = vi.fn();
    expect(harness.spi.onMessage(listener)).toBeTypeOf("function");
    expect(harness.spi.onMessage).toHaveBeenCalledExactlyOnceWith(listener);
    expect(await harness.spi.openExternal("https://example.com")).toBe(false);
    Reflect.set(window, "spi", { replaced: true });
  });

  it("sees the exact earlier SPI value and act descriptor in the next case", () => {
    expect(window.spi).toBe(previous);
    expect(Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT")).toEqual(
      actDescriptor,
    );
  });
});

it("restores nested stubs by identity and forwards overrides through spies", async () => {
  const first = installSpi();
  cleanups.push(first.restore);
  const openExternal = vi.fn(async () => true);
  const second = installSpi({ proof: true, openExternal });
  cleanups.push(second.restore);
  expect(second.spi.proof).toBe(true);
  expect(await second.spi.openExternal("https://example.com")).toBe(true);
  expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com");
  second.restore();
  expect(window.spi).toBe(first.spi);
});

it("restores an existing act-environment value exactly", () => {
  const restore = stubActEnvironment();
  cleanups.push(restore);
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: false,
  });
  const restoreFalse = stubActEnvironment();
  expect(Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")).toBe(true);
  restoreFalse();
  expect(Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")).toBe(false);
});
