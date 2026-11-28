// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { AREAS, type AreaName, type Facts } from "../facts.js";
import type { Model } from "../model/index.js";
import type { QueueItem } from "../model/queue.js";

/** The areas read by buildQueue and the item readings, excluding credentials and fleet discovery. */
const SWEEP_AREAS = AREAS.filter((area) => area !== "fleet" && area !== "auth");

export interface ItemEvidence {
  areas: AreaName[];
  attributed: "item" | "sweep";
  notRead: string[];
}

function evidenceOf(model: Model, item: QueueItem): ItemEvidence {
  const areas = new Set<AreaName>();
  const notRead: string[] = [];
  const line = model.lines.find((line) => item.id === `${item.kind}:${line.fork.id}`);
  const pr = item.kind === "gate1" ? line?.syncPr : item.kind === "gate2" ? line?.cascadePr : undefined;
  if (pr) {
    for (const failure of pr.failures) {
      if (failure.cls === "UNREAD") notRead.push(`${failure.check} job`);
    }
    // A sweep's lane occupancy does not confirm that the lanes have drained before a re-run.
    if (pr.failures.some((failure) => failure.cls === "ENV")) {
      notRead.push("Whether the other lanes have drained");
    }
  }
  if (!pr && item.cls === "UNREAD" && item.kind !== "main" && item.kind !== "lane-deploy") {
    const check = item.cause.find((fact) => fact.label === "check")?.value;
    notRead.push(`${check ?? "Failed check"} job`);
  }
  if (item.kind === "lanes" && item.judgement?.response !== "stop") {
    notRead.push("Whether the other lanes have drained");
  }
  if (item.kind === "lane-deploy" && line) notRead.push("Deployment failure's cause");
  if (item.kind === "main" && line?.mainRed && !line.mainRed.jobsRead) {
    notRead.push("Failed main run's job");
  }

  if (line && pr && item.cls !== "TOOLCHAIN") {
    areas.add("github");
    if (pr.failures.length > 0) areas.add("details");
    if (item.kind === "gate1") areas.add("upstream");
    // The briefing's blocker is the stack or lanes item that folded the environment failure.
    if (pr.failures.some((failure) => failure.cls === "ENV")) areas.add("lifecycle");
  } else if (line && item.kind === "lane-deploy") {
    areas.add("github");
    areas.add("lifecycle");
    const sha = line.lane.last?.sha;
    if (sha && line.prs.some((pr) => pr.pr.headSha === sha && pr.failures.length > 0)) {
      areas.add("details");
    }
  } else if (line && item.kind === "main") {
    // Main jobs are collected alongside the workflow run, not by the PR detail collector.
    areas.add("runs");
  } else if (line && item.kind === "sync-run") {
    areas.add("github");
    areas.add("runs");
    if (item.cause.some((fact) => fact.label === "reason" && fact.value.includes("step was not read")))
      notRead.push("Failed Sync Upstream step");
  } else if (line && item.kind === "cascade-missed") {
    areas.add("github");
    areas.add("runs");
  } else if (line && item.kind === "template-run") {
    areas.add("runs");
  } else if (line && ["labels", "conflict", "cascade"].includes(item.kind)) {
    areas.add("github");
  }
  return areas.size > 0
    ? { areas: AREAS.filter((area) => areas.has(area)), attributed: "item", notRead }
    : { areas: [...SWEEP_AREAS], attributed: "sweep", notRead };
}

/** One attribution for an item's inspect body and its briefing row, including folded members. */
export function itemEvidence(model: Model, ids: readonly string[]): ItemEvidence {
  const members = ids.map((id) => {
    const item = model.queue.items.find((item) => item.id === id);
    return item
      ? evidenceOf(model, item)
      : { areas: [...SWEEP_AREAS], attributed: "sweep" as const, notRead: [] };
  });
  if (members.length === 0) return { areas: [...SWEEP_AREAS], attributed: "sweep", notRead: [] };
  return {
    areas: AREAS.filter((area) => members.some((member) => member.areas.includes(area))),
    attributed: members.some((member) => member.attributed === "sweep") ? "sweep" : "item",
    notRead: [...new Set(members.flatMap((member) => member.notRead))],
  };
}

/** The same missing-read vocabulary for a workflow, even when no queue item could be raised. */
export function workflowEvidence(
  model: Model, facts: Facts, service: string, workflow: "sync" | "template", from: string, to: string, read = true,
): ItemEvidence & { runsRead: boolean } {
  const line = model.lines.find((line) => line.fork.id === service);
  const history = line && facts.runs.data?.[line.fork.repo];
  const coverage = history?.history?.[workflow];
  const completed = history?.[workflow].some((run) => run.status === "completed" &&
    Date.parse(run.updatedAt) > Date.parse(from) && Date.parse(run.updatedAt) <= Date.parse(to));
  const runsRead = read && !!history && (!!completed || !!coverage?.complete ||
    (coverage?.from !== undefined && Date.parse(coverage.from) <= Date.parse(from)));
  const ids = model.queue.items.filter((item) => item.scope === service &&
    item.kind === (workflow === "sync" ? "sync-run" : "template-run")).map((item) => item.id);
  const own = itemEvidence(model, ids);
  return { ...own, areas: ["runs"], attributed: "item", runsRead,
    notRead: [...own.notRead, ...(!runsRead
      ? [`${workflow === "sync" ? "Sync Upstream" : "Sync Template"} runs on ${service}`] : [])],
  };
}
