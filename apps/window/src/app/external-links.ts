// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

/**
 * Mirrors the desktop link bridge's allowlist (apps/desktop/src/external-links.ts): only
 * HTTPS GitHub and community.opengroup.org URLs without credentials open. The parity test in
 * detail-kinds.test.tsx keeps both gates aligned; an action the bridge refuses never renders.
 */
export function bridgeOpens(url: string) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      (parsed.origin === "https://github.com" ||
        parsed.origin === "https://community.opengroup.org") &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}
