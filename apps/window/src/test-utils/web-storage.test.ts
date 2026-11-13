// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, it } from "vitest";
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
