// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { heldRadar } from "../attention.js";
import type { Model } from "../model/index.js";
import type { QueueItem } from "../model/queue.js";
import { syncSplit } from "../model/upstream.js";
import { plural } from "../util.js";

export type Origin = "system" | "upstream";

export interface HorizonStages {
  upstream: { count: number; text: string };
  nextSync: { at?: string; count: number; services: string[]; text: string };
  held: {
    count: number;
    prs: { service: string; pr: { number: number; url?: string; inspect?: string } }[];
    services: string[];
    text: string;
  };
  forks: { services: string[]; text: string };
  wontLand: { service: string; reason: "stopped" | "halted"; count: number; text: string }[];
}

export interface Horizon {
  headline: string;
  stages: HorizonStages;
  owed: { count: number; services: { service: string; count: number }[]; text: string };
}

// Only the fork's own open Gate-1 item can carry a held radar item's decision.
export function radarSyncPr(model: Model, item: QueueItem): QueueItem | undefined {
  if (!heldRadar(item, model)) return undefined;
  const fork = model.upstream.forks.find((f) => f.service === item.scope);
  return model.queue.items.find(
    (q) => q.kind === "gate1" && q.scope === item.scope && q.url === fork?.syncPr?.url,
  );
}

export function itemOrigin(item: QueueItem): Origin {
  return item.kind === "radar" || item.kind === "halt" || item.kind === "port" || item.kind === "gate1"
    ? "upstream"
    : "system";
}

export function horizonStages(model: Model): HorizonStages {
  const forks = model.upstream.forks;
  const stages: HorizonStages = {
    upstream: { count: 0, text: "" },
    nextSync: {
      ...(model.upstream.schedule.upstream ? { at: model.upstream.schedule.upstream } : {}),
      count: 0,
      services: [],
      text: "",
    },
    held: { count: 0, prs: [], services: [], text: "" },
    forks: { services: [], text: "" },
    wontLand: [],
  };
  for (const fork of forks) {
    if (fork.behind === undefined) continue;
    stages.upstream.count += fork.behind;
    if (fork.behind === 0) {
      stages.forks.services.push(fork.service);
      continue;
    }
    const line = model.lines.find((line) => line.fork.id === fork.service);
    const reason = fork.halt || fork.phase === "halted"
      ? "halted"
      : fork.phase === "stopped" || line?.stations.some((s) => s.id === "sync" && s.state === "stopped")
        ? "stopped"
        : undefined;
    if (reason) {
      stages.wontLand.push({
        service: fork.service,
        reason,
        count: fork.behind,
        text: `${fork.service} won't land: sync ${reason === "halted" && !fork.halt?.open ? "will halt" : reason}`,
      });
      continue;
    }
    const split = syncSplit(fork);
    if (split.next > 0) {
      stages.nextSync.count += split.next;
      stages.nextSync.services.push(fork.service);
    }
    if (split.held > 0 && fork.syncPr) {
      stages.held.count += split.held;
      stages.held.services.push(fork.service);
      const gate = model.queue.items.find(
        (q) => q.kind === "gate1" && q.scope === fork.service && q.url === fork.syncPr?.url,
      );
      stages.held.prs.push({
        service: fork.service,
        pr: {
          number: fork.syncPr.number,
          url: fork.syncPr.url,
          ...(gate ? { inspect: gate.id } : {}),
        },
      });
    }
  }
  const unread = forks.filter((f) => f.behind === undefined).length;
  stages.upstream.text = unread === forks.length
    ? "Upstream not read yet"
    : `${plural(stages.upstream.count, "commit")} behind upstream${unread ? ` · ${plural(unread, "fork")} not read yet` : ""}`;
  stages.nextSync.text = unread === forks.length
    ? "Next sync not read yet"
    : `${plural(stages.nextSync.count, "commit")} at the next sync · ${plural(stages.nextSync.services.length, "fork")}`;
  stages.held.text = unread === forks.length
    ? "Open sync PRs not read yet"
    : `${plural(stages.held.count, "commit")} in ${plural(stages.held.prs.length, "open sync PR")} · ${plural(stages.held.services.length, "fork")}`;
  stages.forks.text = unread === forks.length
    ? "Forks not read yet"
    : `${plural(stages.forks.services.length, "fork")} with nothing queued upstream`;
  return stages;
}

export function upstreamHorizon(model: Model, headline: string): Horizon {
  const services = model.upstream.forks.flatMap((f) => {
    const count = model.radar.services[f.service]?.ports?.owed.length ?? 0;
    return count > 0 ? [{ service: f.service, count }] : [];
  });
  const count = services.reduce((sum, f) => sum + f.count, 0);
  const read = Object.values(model.radar.services).some((service) => service.ports !== undefined);
  return {
    headline,
    stages: horizonStages(model),
    owed: {
      count,
      services,
      text: read
        ? `${plural(count, "upstream change")} not ported · ${plural(services.length, "fork")}`
        : "Upstream ports not read yet",
    },
  };
}
