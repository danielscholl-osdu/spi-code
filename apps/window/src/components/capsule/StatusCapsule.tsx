// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useStore } from "zustand";
import { navigate, openSheet } from "../../app/navigation.js";
import { ariaShortcut } from "../../app/shortcuts.js";
import { type StripState, selectStrip } from "../../store/strip.js";
import { watchStore } from "../../store/watch.js";
import { clockTime } from "../../time.js";
import { useNow } from "../evidence/useNow.js";
import { Icon } from "../icons/Icon.js";
import { SweepProgressLine, SweepSegment } from "./SweepSegment.js";
import "./capsule.css";

const SYNC_WINDOW_MS = 2 * 60 * 60_000;

function Segment({
  label,
  state,
  field,
  onClick,
  extra,
}: {
  label: string;
  state: StripState | null;
  field: "environment" | "template" | "forks";
  onClick(): void;
  extra?: Record<string, string>;
}) {
  const classification = state?.classification ?? "unread";
  const tone =
    classification === "refreshing"
      ? "work"
      : classification === "maintenance"
        ? "warn"
        : state?.tone;
  const text = classification === "refreshing" ? "Refreshing" : state?.text;
  const sentence = state?.label ?? `${label}: not read yet`;
  return (
    <button
      type="button"
      className="capsule-seg"
      data-field={field}
      aria-label={sentence}
      title={sentence}
      onClick={onClick}
      {...extra}
    >
      <span className="capsule-label">{label}</span>
      {classification === "fine" && (
        <Icon name="check" size={14} stroke={2} className="capsule-ok" />
      )}
      {classification === "unread" && <span className="capsule-unread">—</span>}
      {classification !== "fine" && classification !== "unread" && (
        <span className="capsule-pill" data-tone={tone}>
          {text}
        </span>
      )}
    </button>
  );
}

function syncText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h${rest > 0 ? ` ${rest}m` : ""}` : `${rest}m`;
}

export function StatusCapsule() {
  const snapshot = useStore(watchStore, (state) => state.snapshot?.body);
  const strip = snapshot ? selectStrip(snapshot) : null;
  const syncAt = strip?.nextSync ? Date.parse(strip.nextSync) : Number.NaN;
  const now = useNow(30_000, syncAt > Date.now() ? syncAt : undefined);
  const nextSync = syncAt - now;
  return (
    <fieldset className="capsule" aria-label="Program status" data-strip="">
      <Segment
        label="Env"
        field="environment"
        state={strip?.environment ?? null}
        onClick={() => navigate({ kind: "environment" })}
      />
      <Segment
        label="Templates"
        field="template"
        state={strip?.template ?? null}
        onClick={() => navigate({ kind: "engineering-system" })}
      />
      <Segment
        label="Forks"
        field="forks"
        state={strip?.forks ?? null}
        onClick={() => openSheet()}
        extra={{
          "data-services": String(strip?.forks.services ?? 0),
          "aria-keyshortcuts": ariaShortcut("l"),
          "aria-controls": "app-line-sheet",
        }}
      />
      {nextSync > 0 && nextSync <= SYNC_WINDOW_MS && strip?.nextSync && (
        <button
          type="button"
          className="capsule-seg"
          data-field="next-sync"
          title={`Next upstream sync ${clockTime(strip.nextSync, { now })}`}
          onClick={() => openSheet()}
        >
          <Icon name="upstream" size={14} stroke={2} className="capsule-up" />
          <span className="capsule-sync">Sync {syncText(nextSync)}</span>
        </button>
      )}
      <span className="capsule-divider" aria-hidden />
      <SweepSegment />
      <SweepProgressLine />
    </fieldset>
  );
}
