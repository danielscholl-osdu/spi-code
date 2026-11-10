// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { parseMessage, type WatchItem } from "@spi-code/contracts";
import { Notification } from "electron";
import type { WindowDestination } from "./window-navigation.js";

/** One line of display text for a native banner: secrets, paths and command output redacted, bounded. */
export function notificationText(text: string, limit: number) {
  const safe = (
    text
      .replace(/[\u2028\u2029\u0085]/g, "\n")
      .trim()
      .split(/[\r\n]/, 1)[0] ?? ""
  )
    .replace(/(?:gh[opsur]_|github_pat_|glpat-)[A-Za-z0-9_-]+|\bAKIA[0-9A-Z]{16}\b/g, "[redacted]")
    .replace(
      /\b(?:authorization\s*[:=]\s*(?:bearer\s+)?|bearer\s+|x-api-key\s*[:=]\s*|[\w-]*(?:token|secret|password)[\w-]*\s*[:=]\s*)["']?[^\s"']+["']?/gi,
      "[redacted]",
    )
    .replace(/(?<![\w@/\\.-])["']?(?:\/(?=\S)|~[\w.-]*\/|[A-Za-z]:\\)\S*/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
    .replace(/\t/g, " ")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Native banners must not carry control characters.
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (/^(?:[$>]|PS\s|fatal:|error:|stdout:|stderr:)/i.test(safe)) return "[redacted]";
  const points = Array.from(safe);
  return points.length > limit ? `${points.slice(0, limit - 3).join("")}...` : safe;
}

/** Per-run native banners; attention and acknowledgement stay owned by the snapshot and host. */
export function createInterruptNotifications({
  focused,
  open,
}: {
  focused(): boolean;
  open(destination: WindowDestination): void;
}) {
  const rungs = new Map<string, number>();
  const banners = new Map<Notification, number>();
  let cursor = -1;
  let firstSweep = false;
  return {
    observe(input: unknown) {
      const parsed = parseMessage(input);
      if (!parsed.ok) return;
      const message = parsed.message;
      if (message.type === "sweep.progress" && cursor < 0 && message.payload.first) {
        firstSweep = true;
      }
      if (message.type !== "view.snapshot" || message.payload.cursor <= cursor) return;
      const initial = cursor < 0;
      const snapshot = message.payload;
      cursor = snapshot.cursor;
      if ((initial && firstSweep) || focused() || !Notification.isSupported()) return;
      const since = new Set(snapshot.seen.since);
      const items: WatchItem[] = [];
      for (const item of [...snapshot.briefing.focus, ...snapshot.briefing.rest]) {
        if (item.attention !== "interrupt" || !since.has(item.id)) continue;
        const previous = rungs.get(item.id);
        if (previous !== undefined && item.rung >= previous) continue;
        rungs.set(item.id, item.rung);
        items.push(item);
      }
      const [first] = items;
      if (!first) return;
      const notification = new Notification({
        title:
          items.length === 1
            ? `Needs you · ${notificationText(first.scope, 60)}`
            : `${items.length} things need you`,
        body:
          items.length === 1
            ? `P${first.rung} ${notificationText(first.title, 160)}`.trimEnd()
            : items
                .slice(0, 2)
                .map(({ title }) => notificationText(title, 100))
                .join("; "),
      });
      banners.set(notification, cursor);
      notification.on("click", () => {
        banners.delete(notification);
        open({ to: "today", item: first.id });
      });
      notification.on("close", () => banners.delete(notification));
      notification.on("failed", () => {
        banners.delete(notification);
        console.warn("An Interrupt notification could not be displayed");
      });
      notification.show();
    },
    outgoing(input: unknown) {
      const parsed = parseMessage(input);
      if (!parsed.ok || parsed.message.type !== "view.acknowledge") return;
      if (parsed.message.payload.cursor > cursor) return;
      const acknowledged = parsed.message.payload.cursor;
      for (const [notification, at] of banners) {
        if (at > acknowledged) continue;
        banners.delete(notification);
        notification.close();
      }
    },
    dispose() {
      for (const notification of banners.keys()) notification.close();
      banners.clear();
    },
  };
}
