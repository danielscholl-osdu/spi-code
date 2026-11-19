// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  githubUrl,
  gitlabUrl,
  KNOWN_SERVICES,
  plannedRepo,
  type ServiceDef,
  STACK_REPO,
  TEMPLATE_REPO,
} from "@spi-code/core";

export interface ScopeRemote {
  readonly repo: string;
  readonly url: string;
}

type ScopeIdentity = {
  readonly id: string;
  readonly title: string;
  readonly canStart: boolean;
};

export type ProgramScope = ScopeIdentity & { readonly kind: "program" };
export type RepositoryScope = ScopeIdentity & {
  readonly kind: "service" | "template" | "environment";
  readonly origin: ScopeRemote;
  readonly upstream?: ScopeRemote;
};
export type Scope = ProgramScope | RepositoryScope;

function github(repo: string): ScopeRemote {
  return { repo, url: githubUrl(repo, ".git") };
}

function serviceScope(service: ServiceDef, canStart: boolean): RepositoryScope {
  return {
    id: service.id,
    title: service.id,
    kind: "service",
    canStart,
    origin: github(service.repo ?? plannedRepo(service)),
    upstream: { repo: service.upstream, url: gitlabUrl(service.upstream, ".git") },
  };
}

export class ScopeRegistry {
  private readonly scopes = new Map<string, Scope>();

  constructor(
    services: readonly ServiceDef[] = KNOWN_SERVICES,
    previouslyKnown: readonly ServiceDef[] = [],
  ) {
    this.scopes.set("program", {
      id: "program",
      title: "Program",
      kind: "program",
      canStart: true,
    });
    for (const service of [...KNOWN_SERVICES, ...previouslyKnown]) {
      this.scopes.set(service.id, serviceScope(service, false));
    }
    this.scopes.set("template", {
      id: "template",
      title: "Template",
      kind: "template",
      canStart: true,
      origin: github(TEMPLATE_REPO),
    });
    this.scopes.set("environment", {
      id: "environment",
      title: "Environment",
      kind: "environment",
      canStart: true,
      origin: github(STACK_REPO),
    });
    this.replaceServices(services);
  }

  replaceServices(services: readonly ServiceDef[]): void {
    const present = new Map(services.map((service) => [service.id, service]));
    for (const [id, scope] of this.scopes) {
      if (scope.kind === "service" && !present.has(id)) {
        this.scopes.set(id, { ...scope, canStart: false });
      }
    }
    for (const service of present.values()) {
      const existing = this.scopes.get(service.id);
      if (!existing || existing.kind === "service") {
        this.scopes.set(service.id, serviceScope(service, true));
      }
    }
  }

  list(): readonly Scope[] {
    return [...this.scopes.values()];
  }

  lookup(id: string): Scope | undefined {
    return this.scopes.get(id);
  }
}
