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

  // JSON writers other than JSON.stringify spell control characters as \u00XX escapes.
  const unicodeEscapes = (json: string) =>
    json.replace(/\\(?:u[0-9a-f]{4}|.)/g, (unit) => {
      const code = { "\\b": 8, "\\t": 9, "\\n": 10, "\\f": 12, "\\r": 13 }[unit];
      return code === undefined ? unit : `\\u${code.toString(16).padStart(4, "0")}`;
    });
  const encodings: [string, (text: string) => string, number][] = [
    ["JSON", (text) => JSON.stringify(text), 1],
    ["\\u00XX JSON", (text) => unicodeEscapes(JSON.stringify(text)), 1],
    ["double-encoded JSON", (text) => JSON.stringify(JSON.stringify(text)), 2],
    ["double-encoded \\u00XX JSON",
      (text) => unicodeEscapes(JSON.stringify(unicodeEscapes(JSON.stringify(text)))), 2],
  ];

  it.each(
    encodings.flatMap(([name, encode, depth]) =>
      [" ", "\n", "\t", "\r\n", "\r", "\b", "\f", "\v"].map((boundary) => [name, boundary, encode, depth] as const)),
  )(
    "preserves %s syntax and strips an opaque token planted at word boundaries after %j",
    (_name, boundary, encode, depth) => {
      const token = "plantedCredential123";
      const corpus = [
        "", "plain text", '"quoted"', "\\", "\\\\", "\\n", "\n\r\t\b\f",
        '[]{}:;,"\'=', "\u0000\u001f", "before\nline\tafter",
      ];
      const introductions = [
        "Authorization:", "Authorization:\n", "Authorization:\v", "Bearer ", 'Bearer "', "bearer\t", "bearer\v",
        '"Authorization": "',
      ];
      for (const context of corpus) {
        for (let position = 0; position <= context.length; position++) {
          for (const introduction of introductions) {
            const text = context.slice(0, position) + boundary + introduction + token +
              " " + context.slice(position);
            const safe = redact(encode(text));
            let parsed: unknown = safe;
            for (let level = 0; level < depth; level++) {
              parsed = JSON.parse(parsed as string);
              expect(typeof parsed).toBe("string");
            }
            expect(safe).not.toContain(token);
            expect(parsed).not.toContain(token);
            expect(safe).toContain(REDACTED);
          }
        }
      }
    },
  );

  it.each([
    String.raw`line\u000aAuthorization: opaque-credential`,
    String.raw`line\u000dBearer opaque-credential`,
    String.raw`line\u000cauthorization=opaque-credential`,
    String.raw`line\u0008Bearer opaque-credential`,
    String.raw`line\u000bAuthorization:\u000bopaque-credential`,
    String.raw`line\u000bBearer\u000bopaque-credential`,
    String.raw`line\\u000bBearer\\u000bopaque-credential`,
    String.raw`line\\u000aBearer\\u0009opaque-credential`,
    String.raw`line\\nAuthorization: opaque-credential`,
    String.raw`line\\nbearer\\topaque-credential`,
  ])("redacts a header after the escaped boundary in %s", (text) => {
    expect(redact(text)).not.toContain("opaque-credential");
    expect(redact(text)).toContain(REDACTED);
  });

  it("keeps every level of nested JSON intact around a redacted authorization field", () => {
    const inner = JSON.stringify({ Authorization: "opaque-credential", count: 1 });
    const safe = redact(JSON.stringify({ body: JSON.stringify({ body: inner }) }));
    expect(safe).not.toContain("opaque-credential");
    const middle = JSON.parse(JSON.parse(safe).body);
    expect(JSON.parse(middle.body)).toEqual({ Authorization: REDACTED, count: 1 });
  });
});
