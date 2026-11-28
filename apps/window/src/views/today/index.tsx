// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SweepProgress, TodayMemberStation } from "@spi-code/contracts";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { TodayTab } from "../../app/navigation.js";
import { useNow } from "../../components/evidence/useNow.js";
import { FirstSweepBody } from "../../components/sweep/FirstSweepBody.js";
import { openFreshness } from "../../components/sweep/reveal.js";
import { failedCount, settled } from "../../components/sweep/words.js";
import { openReadiness } from "../../settings/readiness.js";
import { type createWatchStore, watchStore } from "../../store/watch.js";
import { CalmContext, calmLine } from "./calm.js";
import { TodayFrame } from "./Frame.js";
import { TodayHome } from "./Home.js";
import { todayRead } from "./read.js";
import "./today.css";

const HAND_OVER_MS = 150;

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function stage(progress: SweepProgress | null): string {
  if (!progress) return "";
  if (progress.outcome === "failed" || progress.outcome === "cancelled")
    return "The first sweep stopped.";
  const failures = failedCount(progress);
  return `${settled(progress)} of ${progress.sources.length} sources done${failures > 0 ? `, ${failures} failed` : ""}.`;
}

function FirstSweep({
  progress,
  nextSweepAt,
  read,
  onOpenSettings,
  onRequestSweep,
}: {
  progress: SweepProgress | null;
  nextSweepAt: string | null | undefined;
  read: ReactNode;
  onOpenSettings: () => void;
  onRequestSweep: () => void | Promise<void>;
}) {
  const now = useNow(progress?.outcome === "running" ? 1000 : 30_000);
  return (
    <section className="today" aria-label="Today">
      {read}
      <FirstSweepBody
        progress={progress}
        now={now}
        nextSweepAt={nextSweepAt}
        onOpenSettings={onOpenSettings}
        onRequestSweep={onRequestSweep}
      />
      <p className="visually-hidden" role="status">
        {stage(progress)}
      </p>
    </section>
  );
}

/** The list the brief replaced, held for one crossfade unless motion is reduced. */
function useHandOver(brief: boolean, progress: SweepProgress | null) {
  const was = useRef(brief);
  const last = useRef(progress);
  const [leaving, setLeaving] = useState<{ progress: SweepProgress | null; now: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    if (brief && !was.current && !reducedMotion()) {
      setLeaving({ progress: last.current, now: Date.now() });
    }
    was.current = brief;
    if (!brief) last.current = progress;
  }, [brief, progress]);
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setLeaving(null), HAND_OVER_MS + 50);
    return () => clearTimeout(timer);
  }, [leaving]);
  return [leaving, () => setLeaving(null)] as const;
}

export default function Today({
  store = watchStore,
  onOpenSettings = openReadiness,
  onOpenEvidence,
  tab,
  station,
}: {
  store?: ReturnType<typeof createWatchStore>;
  onOpenSettings?: () => void;
  onOpenEvidence?: () => void;
  tab?: TodayTab | undefined;
  station?: TodayMemberStation | undefined;
}) {
  const snapshot = useStore(store, (state) => state.snapshot);
  const progress = useStore(store, (state) => state.progress);
  const nextSweepAt = useStore(store, (state) => state.sweep?.nextSweepAt);
  const requestSweep = useStore(store, (state) => state.requestSweep);
  const sweepRequested = useStore(store, (state) => state.sweepRequest !== null);
  const [leaving, settle] = useHandOver(Boolean(snapshot), progress);
  const read = todayRead(snapshot?.body ?? null, progress, sweepRequested);
  const calm = calmLine(read);
  const readAgain = async () => {
    const state = store.getState();
    if (state.sweepRequest !== null || state.progress?.outcome === "running") return;
    return state.requestReadAgain();
  };
  const frame = (children: ReactNode) => (
    <TodayFrame
      read={read}
      sweeping={read.reading}
      onReadAgain={() => void readAgain().catch(() => undefined)}
      onOpenEvidence={onOpenEvidence ?? (() => openFreshness(snapshot?.body ?? null))}
    >
      {children}
    </TodayFrame>
  );
  if (!snapshot) {
    return (
      <FirstSweep
        progress={progress}
        nextSweepAt={nextSweepAt}
        read={frame(calm && <p className="today-table-calm today-calm-first">{calm}</p>)}
        onOpenSettings={onOpenSettings}
        onRequestSweep={requestSweep}
      />
    );
  }
  return (
    <section
      className={leaving ? "today today-handover" : "today"}
      aria-label="Today"
      data-tab={tab ?? "yours"}
    >
      {frame(
        <CalmContext.Provider value={calm}>
          <TodayHome snapshot={snapshot.body} tab={tab} station={station} />
        </CalmContext.Provider>,
      )}
      {leaving && (
        <div className="today-leaving" aria-hidden="true" inert onAnimationEnd={settle}>
          <FirstSweepBody
            progress={leaving.progress}
            now={leaving.now}
            onOpenSettings={onOpenSettings}
            onRequestSweep={requestSweep}
          />
        </div>
      )}
    </section>
  );
}
