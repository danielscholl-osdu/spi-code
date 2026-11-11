// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SweepProgress } from "@spi-code/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { Navigation } from "../../app/navigation.js";
import { useNow } from "../../components/evidence/useNow.js";
import { FirstSweepBody } from "../../components/sweep/FirstSweepBody.js";
import { openFreshness } from "../../components/sweep/reveal.js";
import { failedCount, settled } from "../../components/sweep/words.js";
import { openReadiness } from "../../settings/readiness.js";
import { type createWatchStore, watchStore } from "../../store/watch.js";
import { CaveatBand } from "./CaveatBand.js";
import { TodayFrame } from "./Frame.js";
import { motionSlot } from "./InMotion.js";
import { Since } from "./Since.js";
import { Verdict } from "./Verdict.js";
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
  onOpenSettings,
  onRequestSweep,
}: {
  progress: SweepProgress | null;
  nextSweepAt: string | null | undefined;
  onOpenSettings: () => void;
  onRequestSweep: () => void | Promise<void>;
}) {
  const now = useNow(progress?.outcome === "running" ? 1000 : 30_000);
  return (
    <section className="today" aria-label="Today">
      <header className="place-header pane-header">
        <h1 data-place>Today</h1>
      </header>
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
}: {
  store?: ReturnType<typeof createWatchStore>;
  onNavigate?: Navigation["navigate"];
  onOpenSettings?: () => void;
  onOpenEvidence?: () => void;
}) {
  const snapshot = useStore(store, (state) => state.snapshot);
  const progress = useStore(store, (state) => state.progress);
  const completed = useStore(store, (state) => state.completed);
  const nextSweepAt = useStore(store, (state) => state.sweep?.nextSweepAt);
  const requestSweep = useStore(store, (state) => state.requestSweep);
  const [leaving, settle] = useHandOver(Boolean(snapshot), progress);
  if (!snapshot) {
    return (
      <FirstSweep
        progress={progress}
        nextSweepAt={nextSweepAt}
        onOpenSettings={onOpenSettings}
        onRequestSweep={requestSweep}
      />
    );
  }
  const body = snapshot.body;
  const openEvidence = onOpenEvidence ?? (() => openFreshness(body));
  return (
    <section className={leaving ? "today today-handover" : "today"} aria-label="Today">
      <TodayFrame
        sweptAt={body.sweptAt}
        head={
          <>
            <Verdict verdict={body.briefing.verdict} />
            <Since snapshot={body} onOpenEvidence={openEvidence} />
          </>
        }
        caveat={
          <CaveatBand
            snapshot={body}
            completed={completed}
            onOpenEvidence={openEvidence}
            onOpenSettings={onOpenSettings}
          />
        }
        slots={{
          band: null,
          horizon: null,
          places: null,
          releases: null,
          motion: motionSlot(body),
        }}
      />
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
