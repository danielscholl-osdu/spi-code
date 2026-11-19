// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { GITLAB_HOST, KNOWN_SERVICES, STACK_REPO, TEMPLATE_REPO } from "@spi-code/core";
import { describe, expect, it } from "vitest";
import { ScopeRegistry } from "./registry.js";

describe("thread scopes", () => {
  it("derives all 16 scopes and their remotes from core", () => {
    const registry = new ScopeRegistry();
    const scopes = registry.list();
    expect(scopes).toHaveLength(16);
    expect(scopes.map(({ id }) => id)).toEqual([
      "program",
      ...KNOWN_SERVICES.map(({ id }) => id),
      "template",
      "environment",
    ]);
    expect(registry.lookup("program")).toEqual({
      id: "program",
      title: "Program",
      kind: "program",
      canStart: true,
    });
    for (const service of KNOWN_SERVICES) {
      expect(registry.lookup(service.id)).toMatchObject({
        kind: "service",
        canStart: true,
        origin: { repo: service.repo, url: `https://github.com/${service.repo}.git` },
        upstream: { repo: service.upstream, url: `https://${GITLAB_HOST}/${service.upstream}.git` },
      });
    }
    for (const [id, repo] of [
      ["template", TEMPLATE_REPO],
      ["environment", STACK_REPO],
    ]) {
      expect(registry.lookup(id ?? "")).toMatchObject({ origin: { repo } });
      expect(registry.lookup(id ?? "")).not.toHaveProperty("upstream");
    }
  });

  it("keeps a dropped scope known, and leaves a never-seen scope unknown", () => {
    const [first, ...remaining] = KNOWN_SERVICES;
    if (!first) throw new Error("Expected a core service");
    const registry = new ScopeRegistry();
    const scope = registry.lookup(first.id);
    registry.replaceServices(remaining);

    expect(registry.list().find(({ id }) => id === first.id)?.canStart).toBe(false);
    expect(registry.lookup(first.id)).toEqual({ ...scope, canStart: false });
    expect(new ScopeRegistry(remaining).lookup(first.id)).toEqual({ ...scope, canStart: false });
    expect(registry.lookup("never-seen")).toBeUndefined();

    registry.replaceServices(KNOWN_SERVICES);
    expect(registry.lookup(first.id)).toEqual(scope);
  });

  it("retains a service first learned from the live fleet", () => {
    const known = KNOWN_SERVICES[0];
    if (!known) throw new Error("Expected a core service");
    const added = { ...known, id: "added-from-fleet" };
    const registry = new ScopeRegistry([added]);
    const scope = registry.lookup(added.id);
    expect(scope?.canStart).toBe(true);
    registry.replaceServices([]);
    expect(registry.lookup(added.id)).toEqual({ ...scope, canStart: false });
    expect(new ScopeRegistry([], [added]).lookup(added.id)).toEqual({ ...scope, canStart: false });
  });
});
