// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { parseCodeAlert, parseDependencyAlert, readSecurity } from "../../src/collect/security.js";
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
    const down = await readSecurity(
      gh(() => ({ ok: false, error: "timeout", code: 1 })),
      undefined,
      ctx,
    );
    expect(down.data).toEqual({});
    expect(down.reads).toHaveLength(ctx.fleet.repos.length);
    expect(down.reads.every((r) => r.failure?.includes("timeout") && !r.retainedFrom)).toBe(true);
    expect(envelope(down.reads).state).toBe("failed");
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
