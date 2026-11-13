// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { directoryPaths } from "./directory-paths.test.js";
import { installWebStorage } from "./web-storage.js";

it("gives the window's storage in place of storage that is not the window's", () => {
  const global = Object.defineProperties(
    {},
    {
      localStorage: { configurable: true, get: () => undefined },
      sessionStorage: { configurable: true, get: () => ({ getItem: () => null }) },
    },
  ) as typeof globalThis;
  installWebStorage(global);
  expect(global.localStorage).toBeInstanceOf(Storage);
  expect(global.sessionStorage).toBeInstanceOf(Storage);
  expect(global.localStorage).not.toBe(global.sessionStorage);
  global.localStorage.setItem("key", "value");
  expect(global.localStorage.getItem("key")).toBe("value");
  expect(global.sessionStorage.getItem("key")).toBeNull();
});

it("keeps the window's own storage", () => {
  const storage = { localStorage: new Storage(), sessionStorage: new Storage() };
  const global = { ...storage } as typeof globalThis;
  installWebStorage(global);
  expect(global).toEqual(storage);
  expect(global.localStorage).toBe(storage.localStorage);
  expect(global.sessionStorage).toBe(storage.sessionStorage);
});

it("runs every window test that reads storage on the window's storage", () => {
  expect(localStorage).toBeInstanceOf(Storage);
  expect(sessionStorage).toBeInstanceOf(Storage);
  const unprotected = directoryPaths("apps/window/src")
    .filter(
      (file) => /\.test(-helper)?\.tsx?$/.test(file) && file !== "test-utils/web-storage.test.ts",
    )
    .filter((file) => {
      const source = readFileSync(`apps/window/src/${file}`, "utf8");
      return (
        /\b(localStorage|sessionStorage)\b/.test(source) &&
        !/from "[./]*(test-utils\/)?harness\.js"|import "[./]*(test-utils\/)?web-storage\.js"/.test(
          source,
        )
      );
    });
  expect(unprotected).toEqual([]);
});
