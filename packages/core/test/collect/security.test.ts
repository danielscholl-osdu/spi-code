// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  HELP_MAX,
  parseCodeAlert,
  parseDependencyAlert,
  readSecurity,
} from "../../src/collect/security.js";
import { SECURITY_EVERY_MS } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { envelopeOf } from "../../src/evidence/index.js";
import type { Exec, ExecResult } from "../../src/exec/port.js";
import { Gh, GraphqlBudget } from "../../src/forge.js";

const DEP = {
  number: 82,
  severity: "high",
  package: "com.fasterxml.jackson.core:jackson-databind",
  ecosystem: "maven",
  manifest: "pom.xml",
  scope: "runtime",
  fixed: "2.21.7",
  advisory: "GHSA-0000-0000-0000",
  cve: null,
  summary: "jackson-databind: unbounded number parse",
  url: "https://github.com/Azure/osdu-spi-partition/security/dependabot/82",
  createdAt: "2026-10-04T20:20:40Z",
};
const CODE = {
  number: 3,
  severity: null,
  ruleSeverity: "error",
  rule: "java/spring-disabled-csrf-protection",
  description: "Disabled Spring CSRF protection",
  tool: "CodeQL",
  path: "provider/partition-azure/src/main/java/Config.java",
  url: "https://github.com/Azure/osdu-spi-partition/security/code-scanning/3",
  createdAt: "2026-02-27T00:01:04Z",
};
const NOW = "2026-11-05T08:00:00.000Z";
const BEFORE = "2026-11-05T06:00:00.000Z";
const ctx = createContext({ clock: { now: () => new Date(NOW) } });

function gh(answer: (path: string) => ExecResult<string>): Gh {
  const exec: Exec = {
    runJSON: async () => ({ ok: false, error: "unused", code: 1 }),
    runText: async (_cmd, args) => {
      expect(args[1]).toBe("--paginate");
      return answer(args[2] ?? "");
    },
  };
  return new Gh(exec, { calls: 0 }, new GraphqlBudget(ctx.clock));
}
const empty = () => ({ ok: true as const, data: "" });
const failed = () => ({ ok: false as const, error: "gh: Bad Gateway (HTTP 502)", code: 1 });
const envelope = (reads: Parameters<typeof envelopeOf>[0]) =>
  envelopeOf(reads, { intervalMs: SECURITY_EVERY_MS, now: Date.parse(NOW) });

describe("alert parsing", () => {
  test("keeps a Dependabot alert's fix and scope, and reads moderate as medium", () => {
    expect(parseDependencyAlert(DEP)).toMatchObject({ severity: "high", fixed: "2.21.7" });
    expect(parseDependencyAlert(DEP)?.cve).toBeUndefined();
    const moderate = parseDependencyAlert({ ...DEP, severity: "moderate", fixed: null });
    expect(moderate?.severity).toBe("medium");
    expect(moderate && "fixed" in moderate).toBe(false);
    expect(parseDependencyAlert({ ...DEP, manifest: null })).toBeUndefined();
  });

  test("a code-scanning rule without a security severity keeps only its rule severity", () => {
    const a = parseCodeAlert(CODE);
    expect(a?.severity).toBeUndefined();
    expect(a).toMatchObject({ ruleSeverity: "error", tool: "CodeQL" });
    expect(parseCodeAlert({ ...CODE, severity: "high" })?.severity).toBe("high");
  });

  test("keeps a rule's help on one line and its tags, and leaves both out when the scanner gave none", () => {
    const a = parseCodeAlert({
      ...CODE,
      fullDescription:
        "  Disabling CSRF protection makes the\n  application vulnerable to a `CSRF` attack.\n",
      tags: ["security", "external/cwe/cwe-352", 7, null, ""],
    });
    expect(a?.fullDescription).toBe(
      "Disabling CSRF protection makes the application vulnerable to a CSRF attack.",
    );
    expect(a?.tags).toEqual(["security", "external/cwe/cwe-352"]);
    for (const gone of [
      {},
      { fullDescription: null, tags: null },
      { fullDescription: " \n", tags: "security" },
      { tags: [] },
    ]) {
      const b = parseCodeAlert({ ...CODE, ...gone });
      expect(b).toMatchObject({ rule: CODE.rule, number: CODE.number });
      expect(b && ("fullDescription" in b || "tags" in b)).toBe(false);
    }
  });

  test("drops control and format characters from a rule's help before folding and the cap", () => {
    const help = (fullDescription: string) =>
      parseCodeAlert({ ...CODE, fullDescription })?.fullDescription;
    expect(
      help("Use\u202E safe\u0000 strings\u001B[31m with\u200B care\uFEFF.\u2066x\u2069\u0085"),
    ).toBe("Use safe strings[31m with care.x");
    expect(help("Café naïve 跨站请求伪造\tcheck")).toBe("Café naïve 跨站请求伪造 check");
    expect(help("\u200B\u202E\u0000")).toBeUndefined();
    const exact = "y".repeat(HELP_MAX);
    expect(help(`\u200F${[...exact].join("\u200B")}`)).toBe(exact);
  });

  test("cuts a long help at HELP_MAX characters and keeps at most 20 tags of 100 characters", () => {
    const long = parseCodeAlert({
      ...CODE,
      fullDescription: "word ".repeat(200),
      tags: ["x".repeat(101), ...Array.from({ length: 30 }, (_, i) => `tag-${i}`)],
    });
    expect(HELP_MAX).toBe(300);
    expect([...(long?.fullDescription ?? "")]).toHaveLength(HELP_MAX);
    expect(long?.fullDescription?.endsWith("word…")).toBe(true);
    expect(long?.tags).toHaveLength(20);
    expect(long?.tags?.[0]).toBe("tag-0");
    const exact = "y".repeat(HELP_MAX);
    expect(parseCodeAlert({ ...CODE, fullDescription: exact })?.fullDescription).toBe(exact);
  });

  test("never cuts help inside a word, so a credential across the cap leaves nothing", () => {
    const token = "fixture-scanner-credential-across-the-cap";
    const lead = `${"word ".repeat(59)}a `;
    const help = parseCodeAlert({
      ...CODE,
      fullDescription: `${lead}${token} tail`,
    })?.fullDescription;
    expect([...lead].length).toBeLessThan(HELP_MAX);
    expect([...lead, ...token].length).toBeGreaterThan(HELP_MAX);
    expect(help).toBe(`${lead.trimEnd()}…`);
    expect(help).not.toContain(token.slice(0, 2));
    expect(
      parseCodeAlert({ ...CODE, fullDescription: "安".repeat(HELP_MAX + 1) }),
    ).not.toHaveProperty("fullDescription");
  });

  test("keeps a rule's title as the scanner gave it, at any length", () => {
    const title = (description: unknown) => parseCodeAlert({ ...CODE, description });
    for (const long of [
      "安".repeat(10_000),
      "安全 ".repeat(3_400),
      `${"w ".repeat(55)}${"x".repeat(80)}\n  tail`,
    ]) {
      expect(title(long)?.description).toBe(long);
      expect(title(long)).not.toHaveProperty("cut");
    }
    expect(title(undefined)?.description).toBe(CODE.rule);
  });

  test.each([
    ["Plain help.", "verbatim"],
    ["y".repeat(HELP_MAX), "verbatim"],
    ["Help that ends in an ellipsis…", "verbatim"],
    ["Uses `eval` on input.", "cut"],
    ["A\ttab.", "cut"],
    ["CRLF\r\nhere.", "cut"],
    ["password: |\n  QzFixtureOnlyYamlPassword", "cut"],
    ["Two  spaces.", "cut"],
    [" Leading space.", "cut"],
    ["Trailing space. ", "cut"],
    ["Zero\u200bwidth.", "cut"],
    ["No\u00a0break.", "cut"],
    ["word ".repeat(200), "cut"],
    ["安".repeat(HELP_MAX + 1), "cut"],
    ["   ", "none"],
    [undefined, "none"],
  ] as const)("says whether help %j is the scanner's byte for byte: %s", (raw, said) => {
    const parsed = parseCodeAlert({ ...CODE, fullDescription: raw });
    expect(parsed?.verbatim === true).toBe(said === "verbatim");
    expect(parsed?.cut === true).toBe(said === "cut");
    if (said === "verbatim") expect(parsed?.fullDescription).toBe(raw);
    if (said === "none") expect(parsed).not.toHaveProperty("fullDescription");
  });
});

describe("readSecurity", () => {
  test("a hidden list reads as undefined, never as an empty one", async () => {
    for (const status of [403, 404]) {
      const out = await readSecurity(
        gh((path) =>
          path.includes("code-scanning")
            ? { ok: false, error: `gh: hidden (HTTP ${status})`, code: 1 }
            : { ok: true, data: `${JSON.stringify(DEP)}\n` },
        ),
        undefined,
        ctx,
      );
      const first = out.data[ctx.fleet.repos[0] as string];
      expect(first?.dependabot).toHaveLength(1);
      expect(first?.code).toBeUndefined();
      expect(envelope(out.reads).state).toBe("fresh");
    }
  });

  test("a repository whose read fails keeps its last good lists", async () => {
    const failing = ctx.fleet.repos[1] as string;
    const before = createContext({ clock: { now: () => new Date(BEFORE) } });
    const prev = await readSecurity(gh(empty), undefined, before);
    const client = gh((path) => (path.includes(failing) ? failed() : empty()));
    const out = await readSecurity(client, prev, ctx);
    expect(out.data[failing]).toBe(prev.data[failing]);
    expect(out.data[ctx.fleet.repos[0] as string]).toEqual({ dependabot: [], code: [] });
    expect(out.reads.find((r) => r.source === failing)).toMatchObject({
      observedAt: NOW,
      retainedFrom: BEFORE,
      failure: expect.stringContaining("HTTP 502"),
    });
    expect(envelope(out.reads).state).toBe("failed");
    expect(envelope(out.reads).observedAt).toBe(BEFORE);
    for (const record of out.reads.filter((r) => r.source !== failing)) {
      expect(record.observedAt).toBe(NOW);
      expect(record.failure).toBeUndefined();
      expect(envelope([record]).state).toBe("fresh");
    }
    const repeated = await readSecurity(client, out, ctx);
    expect(repeated.reads.find((r) => r.source === failing)?.retainedFrom).toBe(BEFORE);
    const timeout = gh(() => ({ ok: false, error: "timeout", code: 1 }));
    await expect(readSecurity(timeout, undefined, ctx)).rejects.toThrow("timeout");
    await expect(readSecurity(timeout, out, ctx)).rejects.toThrow("timeout");
    const legacy = await readSecurity(client, { data: prev.data, reads: [], at: BEFORE }, ctx);
    expect(legacy.reads.find((r) => r.source === failing)?.retainedFrom).toBe(BEFORE);
    const bare = await readSecurity(client, { data: prev.data, reads: [] }, ctx);
    expect(bare.reads.find((r) => r.source === failing)?.retainedFrom).toBeUndefined();
    const recovered = await readSecurity(gh(empty), out, ctx);
    expect(recovered.reads.every((r) => !r.failure && !r.retainedFrom)).toBe(true);
  });

  test("reads only the caller's fleet and keeps each fleet independent", async () => {
    const run = async (repo: string) => {
      const context = createContext({
        ...ctx,
        fleet: { ...ctx.fleet, services: [{ id: repo, repo, upstream: repo }] },
      });
      const paths: string[] = [];
      const result = await readSecurity(
        gh((path) => {
          paths.push(path);
          return empty();
        }),
        undefined,
        context,
      );
      expect(paths).toHaveLength(context.fleet.repos.length * 2);
      expect(paths.every((path) => path.includes("state=open&per_page=100"))).toBe(true);
      expect(Object.keys(result.data).sort()).toEqual([...context.fleet.repos].sort());
      return result;
    };
    const [one, two] = await Promise.all([run("one/service"), run("two/service")]);
    expect(one.data["two/service"]).toBeUndefined();
    expect(two.data["one/service"]).toBeUndefined();
  });
});
