// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Scope } from "../../scopes/registry.js";

export type ScopeKind = Scope["kind"];

/** The tool that reads a guide; the instructions list guides only when it is offered. */
export const SPI_GUIDE = "spi_guide";

interface Rule {
  /** The scope kinds the rule is sent to; omitted means every thread. */
  readonly kinds?: readonly ScopeKind[];
  readonly text: string;
}

export interface Guide {
  readonly id: string;
  readonly title: string;
  /** One line for the instructions: the situation the guide is for. */
  readonly when: string;
  readonly kinds: readonly ScopeKind[];
  /** What the steps were checked against, and when. */
  readonly checked: string;
  readonly steps: string;
}

const TEMPLATE_CHECK = "Azure/osdu-spi main db4159d on 2026-11-27";
const STACK_CHECK = "Azure/osdu-spi-stack main at v0.35.10 on 2026-11-27";

const RULES: readonly Rule[] = [
  {
    text: "The pull request a cascade opens from release/upstream-* into main is the Upstream Sync to Main PR. A release is the release-please pull request and its tag, never the sync.",
  },
  {
    text: "A fork's release marks a clean state. It waits until that fork has no open issue or pull request, even when the image would not change, so list what must close first.",
  },
  {
    text: "The shared backing environment exists for the forks' Deploy and Test lanes, and no person holds a role on it. Judge trouble there by the lanes it blocks. When several forks fail the same way at once, suspect the environment before any fork.",
  },
  {
    text: "A fork pull request or merge to main that changes what is built borrows that environment; one that changes only workflows, docs or legal notices does not. Nothing queues lanes across forks. Never suggest dispatching or re-running across the fleet at once; the template's .github/fleet/rollout.json sets how many lanes may run.",
  },
  {
    text: "A failure annotated Environment is the environment's: one re-run, after the other lanes drain. Any other failure, and an environment failure already re-run once, belongs to the change.",
  },
  {
    text: "On a pull request a bot opened, license/cla never completes and is not required. A pull request with merge conflicts starts only a few checks, so nothing pending does not mean everything passed.",
  },
  {
    text: "Size a fix to how often the failure happens and what it costs, and offer the smallest change that covers the common case first. One failure is not a pattern: fix it and say what to watch for. A change to the template's workflows or the stack's gates waits until the failure recurs.",
  },
  {
    text: "These repositories are public and are production. Text meant for an issue, pull request or commit names no person and carries no user, tenant or subscription id, and says the shared backing environment in full.",
  },
  {
    text: "Approving a pull request is a review a person signs. When a merge is blocked on review, say so and stop there.",
  },
  {
    kinds: ["service"],
    text: "The root pom and the shared modules are upstream's. Align a dependency in the provider's pom, by overriding the parent's version property or adjusting the provider's BOM imports.",
  },
  {
    kinds: ["service"],
    text: ".github/ apart from upstream-filter.yml and CODEOWNERS, build/ and the release-please config come from the template, and template sync overwrites them. Change the template instead.",
  },
  {
    kinds: ["service"],
    text: "A pull request into main that changes a file upstream owns fails Check Paths unless it carries the port label, which declares it a deliberate port.",
  },
  {
    kinds: ["service"],
    text: "A fork change that depends on a stack change waits until the shared backing environment has been upgraded to the stack release that carries it.",
  },
  {
    kinds: ["template"],
    text: "A template change reaches every fork through the daily template sync from the template's main, not from its release. A sync that changes only workflows borrows no environment; one that changes what is built, such as build/, borrows it in each fork. Say how the change will be paced before proposing it.",
  },
  {
    kinds: ["template"],
    text: "Never patch one fork by hand to get a template change green. Stop and fix forward in the template.",
  },
  {
    kinds: ["template"],
    text: "Each fork owns its .github/upstream-filter.yml; the template's copy under .github/fork-resources only seeds a new fork. A filter change for the fleet is one pull request per fork.",
  },
  {
    kinds: ["template"],
    text: "The bodies of bot pull requests are computed from git, on purpose without a model. Do not propose generating them.",
  },
  {
    kinds: ["environment"],
    text: "The stack repository merges by squash only and never retargets a pull request stacked on another's branch. Branch from origin/main and open against main.",
  },
  {
    kinds: ["environment"],
    text: "When an Environment Upgrade or Environment Refresh run fails, read its first attempt before any re-run. A later attempt can fail only because the first one already changed maintenance.",
  },
  {
    kinds: ["environment"],
    text: "A fork's first acceptance or load image is published private, and one private package fails image resolution for every service during an upgrade. Making it public is part of onboarding the fork.",
  },
];

const GUIDES: readonly Guide[] = [
  {
    id: "cascade",
    title: "A cascade that stopped or will not start",
    when: "a cascade stopped on a conflict, will not start, or an open Sync to Main PR needs a newer upstream fix",
    kinds: ["service", "program"],
    checked: TEMPLATE_CHECK,
    steps: [
      "How it runs: Cascade Integration merges main into fork_integration first, then fork_upstream, builds, and opens the Upstream Sync to Main PR from a release/upstream-* branch.",
      'What holds it: it will not start while a release/upstream-* pull request into main is open, or while an issue labelled conflict and cascade-blocked is open. It exits green and opens "Upstream Changes Held". Closing what holds it is what frees it.',
      [
        "A conflict:",
        "1. Read the conflict issue first. Its steps come from the fork's own workflow and win over this guide.",
        "2. On fork_integration, merge origin/main first, then origin/fork_upstream. Skipping main lets the upstream merge delete a file the fork owns without a conflict.",
        "3. A modify/delete conflict on a file the filter now strips, such as README.md or NOTICE, is expected once after that filter change. Keep the fork's copy. It does not recur.",
        "4. Push fork_integration, then close the conflict issue before any retry: an open one still reads as busy.",
        "5. Retry by dispatching Cascade Integration with the tracking issue's number. Removing human-required from a tracking issue that still carries cascade-failed lets the hourly Cascade Monitor retry instead.",
      ].join("\n"),
      "An open Sync to Main PR that needs a newer upstream fix cannot receive it, because that open pull request holds the cascade. Close it, dispatch Integration Branch Cleanup to reset fork_integration, merge the waiting sync pull request into fork_upstream, then run the cascade. The new Sync to Main PR carries both changes.",
      'A Sync to Main PR that is approved but does not merge: look for "Could not arm auto-merge" in the Cascade Integration log. The repository\'s auto-merge setting is off, and the weekly Settings Apply turns it back on.',
    ].join("\n\n"),
  },
  {
    id: "filter",
    title: "Change what a fork takes from upstream",
    when: "a sync halted on an entry the filter does not list, or a fork should own or drop an upstream file",
    kinds: ["service", "program"],
    checked: TEMPLATE_CHECK,
    steps: [
      ".github/upstream-filter.yml on the fork's main decides what a sync keeps. A top-level entry is keep or strip, and strip is how a fork takes ownership of a top-level file such as README.md or NOTICE. provider/ and devops/ are dropped whole on purpose: upstream is removing its providers, and the Azure provider lives only in the fork.",
      "A halt: the sync stops rather than guess when upstream adds an entry the filter does not list, and its issue names the entry. Classify the entry in the filter with a pull request into main, then re-run Sync Upstream and close the halt issue. Keep schemathesis-tests in every fork. Other forks usually lack the same entry, so say which ones.",
      "A filter change regenerates fork_upstream on the next sync, and the result arrives through the normal Sync to Main PR.",
      "Taking ownership of a file upstream still carries: the pull request that first edits it on main needs the port label, because the file is still on fork_upstream. Put the new content and the strip rule in that one pull request. The next cascade stops once on a modify/delete conflict for that file; keep the fork's copy, as the cascade guide says.",
      "Each fork owns its filter. The template's copy under .github/fork-resources only seeds a new fork, so a fleet-wide filter change is one pull request per fork.",
    ].join("\n\n"),
  },
  {
    id: "release",
    title: "Get a fork ready to release",
    when: "a fork's release is being weighed, or Dependabot pull requests have piled up on it",
    kinds: ["service", "program"],
    checked: TEMPLATE_CHECK,
    steps: [
      "A release marks a clean state, so start by listing what is open on the fork: issues, pull requests, coding agent follow-ups and anything still running. Each one closes before the release pull request merges, even a test-only change that would not alter the image.",
      [
        "Dependabot:",
        "1. Batch the open bumps into one pull request per fork, so the fork builds and borrows the environment once. Bumps to the same pom conflict with each other when merged one at a time.",
        "2. Leave out a bump that fails its own Dependabot validation, and close it with the reason.",
        '3. After the batch merges, Dependabot closes the superseded pull requests itself, most within half an hour. A comment "@dependabot recreate" on a straggler makes it re-check at once.',
        "4. Closing a Dependabot pull request by hand only ignores that exact version.",
      ].join("\n"),
      "The release pull request comes from release-please. It is a bot's pull request, so license/cla stays pending on it and is not required.",
    ].join("\n\n"),
  },
  {
    id: "rollout",
    title: "Roll one change out across the forks",
    when: "a template change, a Dependabot batch or any other fleet-wide pull request has to reach every fork",
    kinds: ["template", "program"],
    checked: TEMPLATE_CHECK,
    steps: [
      "The template repository carries the working procedure and its script: .github/skills/spi-fleet/SKILL.md and fleet.py beside it. In a Template thread, read that file; it wins over this summary.",
      [
        "- The fleet is the forks list in the stack's ops/environments/shared.yaml. The template's .github/fleet/rollout.json sets lanes, the number of validations allowed at once, and the few ordering exceptions.",
        "- Start no more than lanes validations, then wait until none is pending before starting more. Forks take a template change from the template's main through Sync Template, daily at 08:00 UTC or dispatched.",
        "- Judge each fork by the Validation run for its pull request's head commit. A failure titled Environment means the environment stayed undeployable, the pin stayed refused or the digest never went live: one re-run, after the other lanes drain. Anything else is a failure of the change.",
        "- Merge green, approved pull requests in fleet order into the lanes left free, wait for each merge's run on main, and stop the line on any failure.",
        "- Never patch a fork by hand to get it green. Fix forward in the template.",
        "- Approving, merging and re-running are the operator's decisions.",
      ].join("\n"),
    ].join("\n\n"),
  },
  {
    id: "libraries",
    title: "Move a fork to a new library or Spring Boot line",
    when: "an upstream sync changes Spring Boot, Java or os-core-common, or a service fails to start after a dependency bump",
    kinds: ["service", "environment", "program"],
    checked:
      "the maintainer's ruling of 2026-11-16 and the storage and entitlements cascades since",
    steps: [
      "core-lib-azure 5.x is the Spring Boot 4 line, and 4.x is the Spring Boot 3.5 line.",
      "When an upstream batch moves the root pom's Spring Boot major, move the provider's core-lib-azure major in the same cascade, on fork_integration. It cannot go ahead on main, because main still builds against the old root pom.",
      "The root pom is upstream's, so the provider's pom is where the fork aligns. A child's BOM import beats the parent's BOM import. A parent's explicit dependencyManagement entry beats a child's BOM import, so for those override the parent's version property.",
      "os-core-common and core-lib-azure have to be a pair that links. Build, unit tests and the cascade's validation can all pass while the service dies at startup on a missing bean or class, and only Deploy and Test catches that. Check the pair against each other before pinning, and treat a startup failure after a bump as a pairing problem first.",
      "The stack's download init containers for the reference services pin the same JDK image digest as the runtime stage of the service template's build/Dockerfile. Bump the two together.",
    ].join("\n\n"),
  },
  {
    id: "environment",
    title: "The shared backing environment refuses lanes",
    when: "lanes are refused, maintenance stays set, or an Environment Upgrade or Environment Refresh run failed",
    kinds: ["environment", "service", "program"],
    checked: STACK_CHECK,
    steps: [
      "The lifecycle runs in the stack repository: Environment Refresh on weekdays at 04:00 UTC, Environment Upgrade when a change to ops/environments/shared.yaml merges to main, and Environment Reset only by hand.",
      "Each run sets maintenance while it works and clears it only after its own verification passes. A run that fails before that leaves maintenance set and every fork's lane refused. One that fails later, loading data, has already cleared it, so read the environment's current state from the sweep instead of inferring it from the run's result. Maintenance is fail-closed: the fix is a run that passes, never clearing the flag by hand.",
      [
        "When a run failed:",
        "1. Read its first attempt before any re-run. A later attempt can fail only because the first already changed maintenance.",
        "2. If image resolution was refused by the registry for every service, a fork has published a new acceptance or load package that is still private. Make that package public, then re-run the failed jobs.",
        "3. If several forks' lanes fail the same way, read the environment's own state before any fork's code.",
      ].join("\n"),
      "A stack release shows as a draft for two or three minutes after its release pull request merges, while its assets upload. That is not a failure.",
      "A fork pull request that depends on a stack change waits until an Environment Upgrade has brought the shared backing environment to the stack release that carries it.",
    ].join("\n\n"),
  },
];

/** The standing rules for one scope kind, in the order they are written. */
export function programRules(kind: ScopeKind): string[] {
  return RULES.filter(({ kinds }) => !kinds || kinds.includes(kind)).map(({ text }) => text);
}

/** The guides whose subject a thread of this kind can meet. */
export function guidesFor(kind: ScopeKind): readonly Guide[] {
  return GUIDES.filter(({ kinds }) => kinds.includes(kind));
}

export const allGuides = (): readonly Guide[] => GUIDES;

export const findGuide = (id: string): Guide | undefined =>
  GUIDES.find((guide) => guide.id === id.trim().toLowerCase());
