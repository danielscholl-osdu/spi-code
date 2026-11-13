// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

/**
 * Node 26 defines its own localStorage and sessionStorage on globalThis, and vitest's happy-dom
 * environment leaves those in place of the window's, so the window project's setup file installs the window's.
 */
export function installWebStorage(global: typeof globalThis = globalThis) {
  for (const name of ["localStorage", "sessionStorage"] as const)
    if (!(global[name] instanceof Storage))
      Object.defineProperty(global, name, {
        configurable: true,
        enumerable: true,
        value: new Storage(),
      });
}

installWebStorage();
