// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { REDACTED, redact } from "./redact.js";

describe("JSON-safe credential redaction", () => {
  it.each([
    ["Authorization:\nopaque-credential", `Authorization:\n${REDACTED}`],
    ["Authorization:\r\nopaque-credential", `Authorization:\r\n${REDACTED}`],
    ['Bearer "opaque-credential"', `Bearer "${REDACTED}"`],
    ["Authorization:\nBearer \"opaque-credential\"", `Authorization:\n${REDACTED}`],
    ["Authorization: opaque\\credential", `Authorization: ${REDACTED}`],
    ["Bearer opaque\\credential", `Bearer ${REDACTED}`],
    ["Authorization:\nopaque-credential\nkept", `Authorization:\n${REDACTED}\nkept`],
    ['Bearer "opaque-credential"\nkept', `Bearer "${REDACTED}"\nkept`],
  ])("redacts JSON-escaped %j without breaking its escapes", (text, expected) => {
    const safe = redact(JSON.stringify({ body: text }));
    expect(JSON.parse(safe)).toEqual({ body: expected });
    expect(safe).not.toContain("opaque");
    expect(safe).not.toContain("credential");
  });

  it("redacts JSON authorization fields without changing unrelated values", () => {
    const text = JSON.stringify({ Authorization: "opaque\\credential", count: 42, nested: ["kept"] });
    expect(JSON.parse(redact(text))).toEqual({
      Authorization: REDACTED, count: 42, nested: ["kept"],
    });
  });

  it.each([
    String.raw`Authorization\: opaque-credential`,
    String.raw`Authorization: \opaque-credential`,
  ])("keeps legacy plain-text redaction for %j", (text) => {
    expect(redact(text)).toContain(REDACTED);
    expect(redact(text)).not.toContain("opaque-credential");
  });

  it("preserves JSON syntax and strips a planted token at every position in an escape corpus", () => {
    const token = "ghp_plantedCredential123";
    const corpus = [
      "", "plain text", '"quoted"', "\\", "\\\\", "\\n", "\n\r\t\b\f",
      '[]{}:;,"\'=', "\u0000\u001f", "before\nAuthorization:\nBearer \"after\"",
    ];
    const introductions = ["", "Authorization:", "Authorization:\n", "Bearer ", 'Bearer "'];
    for (const context of corpus) {
      for (let position = 0; position <= context.length; position++) {
        for (const introduction of introductions) {
          const text = context.slice(0, position) + introduction + token + context.slice(position);
          const safe = redact(JSON.stringify(text));
          const parsed = JSON.parse(safe);
          expect(typeof parsed).toBe("string");
          expect(safe).not.toContain(token);
          expect(parsed).not.toContain(token);
          expect(safe).toContain(REDACTED);
        }
      }
    }
  });
});
