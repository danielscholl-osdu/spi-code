// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { AUTOMATION_APP } from "../config.js";
import type { CheckFact, PrFact, RepoFact } from "../facts.js";

export interface NoiseRule {
  id: string;
  check: string;
  conclusion?: string;
  appOnly?: boolean;
  reason: string;
}

// Checks that say nothing about a PR, taken out of its state before anything counts them.
export const NOISE: readonly NoiseRule[] = [
  {
    id: "license-cla-app-authored",
    check: "license/cla",
    appOnly: true,
    reason: "never completes on a PR an app opened, and is not required",
  },
  {
    id: "docker-build-skipped",
    check: "Docker Build",
    conclusion: "SKIPPED",
    reason:
      "skipped by design on the pull_request_target lane; the pull_request lane builds the image",
  },
];

export function appAuthored(pr: PrFact): boolean {
  if (pr.authorApp !== undefined) return pr.authorApp;
  const who = pr.author ?? "";
  return who === AUTOMATION_APP || who.startsWith("app/") || /\[bot\]$/.test(who);
}

export function noiseRule(pr: PrFact, check: CheckFact): NoiseRule | undefined {
  return NOISE.find(
    (n) =>
      n.check === check.name &&
      (!n.conclusion || n.conclusion === (check.conclusion ?? "").toUpperCase()) &&
      (!n.appOnly || appAuthored(pr)),
  );
}

// Open PRs with the noisy checks removed, and how many each rule took out.
export function withoutNoise(repos: Record<string, RepoFact>): {
  repos: Record<string, RepoFact>;
  ignored: Record<string, number>;
} {
  const ignored: Record<string, number> = {};
  const out: Record<string, RepoFact> = {};
  for (const [name, repo] of Object.entries(repos)) {
    out[name] = {
      ...repo,
      prs: repo.prs.map((pr) => {
        const checks = pr.checks.filter((c) => {
          const rule = noiseRule(pr, c);
          if (rule) ignored[rule.id] = (ignored[rule.id] ?? 0) + 1;
          return !rule;
        });
        return checks.length === pr.checks.length ? pr : { ...pr, checks };
      }),
    };
  }
  return { repos: out, ignored };
}
