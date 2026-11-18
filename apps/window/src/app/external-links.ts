// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

/**
 * Mirrors the desktop link bridge's allowlist (apps/desktop/src/external-links.ts): only
 * HTTPS GitHub, GitHub deployment details and community.opengroup.org URLs without credentials open.
 * The parity test in
 * external-links.test.ts keeps both gates aligned; an action the bridge refuses never renders.
 */
export function bridgeOpens(url: string) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      (parsed.origin === "https://github.com" ||
        parsed.origin === "https://community.opengroup.org" ||
        /^https:\/\/api\.github\.com\/repos\/[\w.-]+\/[\w.-]+\/deployments\/[1-9]\d*$/.test(
          parsed.href,
        )) &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}
