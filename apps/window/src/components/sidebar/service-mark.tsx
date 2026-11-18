// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";
import { Icon } from "../icons/Icon.js";
import "./sidebar.css";

export type ServiceMarkView =
  | { kind: "count"; tone: "error" | "warning"; count: number; label: string }
  | { kind: "check"; tone: "success"; label: string }
  | { kind: "unread"; label: string };

/**
 * A service's one mark, read from its home: its Blocked and Waiting rows as a count, filled in the
 * error tone when any is Blocked; a check when it has none; not read in place of the check. A
 * service the sweep gave no home draws none.
 */
export function serviceMark(
  snapshot: ViewSnapshot | undefined,
  service: string,
): ServiceMarkView | undefined {
  const mark = snapshot?.services?.find((entry) => entry.service === service)?.home?.mark;
  switch (mark?.kind) {
    case "count":
      return {
        kind: "count",
        tone: mark.tone,
        count: mark.count,
        label:
          mark.tone === "error"
            ? `${mark.count} blocked or waiting on you`
            : `${mark.count} waiting on you`,
      };
    case "check":
      return { kind: "check", tone: "success", label: "Nothing waiting on you" };
    case "unread":
      return { kind: "unread", label: "Not read" };
    default:
      return undefined;
  }
}

/** The mark as the sidebar's row and Find's result draw it. */
export function ServiceMark({ mark }: { mark: ServiceMarkView | undefined }) {
  if (!mark) return null;
  return (
    <span
      className="sidebar-mark"
      data-mark={mark.kind}
      data-tone={mark.kind === "unread" ? undefined : mark.tone}
      data-fill={(mark.kind === "count" && mark.tone === "error") || undefined}
      role="img"
      aria-label={mark.label}
      title={mark.label}
    >
      {mark.kind === "count" ? (
        mark.count
      ) : mark.kind === "check" ? (
        <Icon name="check" size={15} stroke={2} />
      ) : (
        "⌀"
      )}
    </span>
  );
}
