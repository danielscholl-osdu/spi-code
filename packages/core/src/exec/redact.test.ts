// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { REDACTED, redact } from "./redact.js";

describe("JSON-safe credential redaction", () => {
  it.each([
    ["Authorization:\nopaque-credential", `Authorization:\n${REDACTED}`],
    ["Authorization:\r\nopaque-credential", `Authorization:\r\n${REDACTED}`],
    ['Bearer "opaque-credential"', `Bearer "${REDACTED}"`],
    ["Authorization:\nBearer \"opaque-credential\"", `Authorization:\n${REDACTED}"${REDACTED}"`],
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

  it("preserves nested JSON syntax when an authorization value ends at an escaped quote", () => {
    const body = JSON.stringify({ Authorization: "opaque-credential", count: 1 });
    const safe = JSON.parse(redact(JSON.stringify({ body })));
    expect(JSON.parse(safe.body)).toEqual({ Authorization: REDACTED, count: 1 });
  });

  it("keeps the URL after a quoted curl authorization header", () => {
    const text = 'curl -H "Authorization: Bearer opaque-credential" https://x';
    const expected = `curl -H "Authorization: ${REDACTED}" https://x`;
    expect(redact(text)).toBe(expected);
    expect(JSON.parse(redact(JSON.stringify(text)))).toBe(expected);
  });

  it.each(["\n", "\t", "\r\n", "\r", "\b", "\f"])(
    "redacts credentials after JSON-escaped whitespace %j",
    (boundary) => {
      for (const introduction of ["Authorization: ", "Bearer "]) {
        const text = `line${boundary}${introduction}opaque-credential`;
        const safe = redact(JSON.stringify({ body: text }));
        expect(JSON.parse(safe)).toEqual({ body: `line${boundary}${introduction}${REDACTED}` });
        expect(safe).not.toContain("opaque-credential");
      }
    },
  );

  it.each([
    String.raw`Authorization\: opaque-credential`,
    String.raw`Authorization: \opaque-credential`,
  ])("keeps legacy plain-text redaction for %j", (text) => {
    expect(redact(text)).toContain(REDACTED);
    expect(redact(text)).not.toContain("opaque-credential");
  });

  it.each([" ", "\n", "\t", "\r\n", "\b", "\f"])(
    "preserves JSON syntax and strips an opaque token planted at word boundaries after %j",
    (boundary) => {
      const token = "plantedCredential123";
      const corpus = [
        "", "plain text", '"quoted"', "\\", "\\\\", "\\n", "\n\r\t\b\f",
        '[]{}:;,"\'=', "\u0000\u001f", "before\nline\tafter",
      ];
      const introductions = ["Authorization:", "Authorization:\n", "Bearer ", 'Bearer "'];
      for (const context of corpus) {
        for (let position = 0; position <= context.length; position++) {
          for (const introduction of introductions) {
            const text = context.slice(0, position) + boundary + introduction + token +
              " " + context.slice(position);
            const safe = redact(JSON.stringify(text));
            const parsed = JSON.parse(safe);
            expect(typeof parsed).toBe("string");
            expect(safe).not.toContain(token);
            expect(parsed).not.toContain(token);
            expect(safe).toContain(REDACTED);
          }
        }
      }
    },
  );
});
