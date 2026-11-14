// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { Popover } from "@base-ui/react/popover";
import { blocksWatch } from "@spi-code/contracts";
import { useId, useState } from "react";
import { useStore } from "zustand";
import { watchStore } from "../../store/watch.js";
import { clockTime, Time } from "../../time.js";
import { useNow } from "../evidence/useNow.js";
import { sweepSources } from "../evidence/words.js";
import { Icon } from "../icons/Icon.js";
import { openFreshness } from "../sweep/reveal.js";
import { settled } from "../sweep/words.js";
import { shortWhen, sourceState, sweepFill, sweepSegment } from "./sweep.js";

const plural = (n: number) => (n === 1 ? "source" : "sources");

function SweepPopover({ now, onClose }: { now: number; onClose(): void }) {
  const { snapshot, progress, sweep, sweepRequest, setup } = useStore(watchStore);
  const body = snapshot?.body ?? null;
  const live = progress?.outcome === "running" ? progress : null;
  const states = body
    ? sweepSources(body).map((source) => ({ ...source, state: sourceState(source.envelope, now) }))
    : [];
  const failed = states.filter(({ state }) => state.tone === "bad").length;
  const warned = states.filter(({ state }) => state.tone === "warn").length;
  const nextSweep =
    sweep?.nextSweepAt && Date.parse(sweep.nextSweepAt) > now ? sweep.nextSweepAt : null;
  const nextSync = shortWhen(body?.briefing.nextSyncAt, now);
  const blocked =
    sweep === null ||
    !setup?.watchReady ||
    setup.tools.some(blocksWatch) ||
    sweepRequest !== null ||
    (sweep.forceCooldownUntil ?? 0) > now;
  return (
    <>
      <div className="capsule-pop-head">
        <Popover.Title className="capsule-pop-title">
          {body ? `Swept ${clockTime(body.sweptAt, { now, hint: false })}` : "Not swept"}
        </Popover.Title>
        {failed > 0 ? (
          <span data-tone="bad">
            {failed} {plural(failed)} failed
          </span>
        ) : warned > 0 ? (
          <span data-tone="warn">
            {warned} {plural(warned)} stale or cut
          </span>
        ) : null}
      </div>
      {live && (
        <div className="capsule-pop-row" data-sweep-running="">
          <span className="capsule-pop-state" data-tone="work">
            {body ? "Sweeping" : "First sweep"} · {settled(live)} of {live.sources.length} done
          </span>
        </div>
      )}
      {states.map(({ key, name, state }) => (
        <div className="capsule-pop-row" key={key} data-source={key}>
          <span>{name}</span>
          <span className="capsule-pop-state" data-tone={state.tone}>
            {state.text}
          </span>
        </div>
      ))}
      <dl className="capsule-pop-times">
        <div>
          <dt>Next sweep</dt>
          <dd data-next="sweep">{nextSweep ? clockTime(nextSweep, { now }) : "not read yet"}</dd>
        </div>
        <div>
          <dt>Next upstream sync</dt>
          <dd data-next="sync">{nextSync ?? "not read yet"}</dd>
        </div>
      </dl>
      <div className="capsule-pop-foot">
        <button
          type="button"
          className="capsule-sweep-now"
          disabled={!!live || blocked}
          onClick={async () => {
            try {
              await watchStore.getState().requestSweepNow();
            } catch {
              // The store reports send failures without exposing transport details.
            }
          }}
        >
          {live ? "Sweeping" : "Sweep now"}
        </button>
        <span className="capsule-spacer" />
        <button
          type="button"
          className="capsule-evidence"
          onClick={() => {
            onClose();
            openFreshness(body);
          }}
        >
          Evidence
        </button>
      </div>
    </>
  );
}

/** The capsule's last segment: the sweep's time and tone, opening a popover of its sources. */
export function SweepSegment() {
  const labelId = useId();
  const [open, setOpen] = useState(false);
  const snapshot = useStore(watchStore, (state) => state.snapshot?.body ?? null);
  const progress = useStore(watchStore, (state) => state.progress);
  const nextSweepAt = useStore(watchStore, (state) => state.sweep?.nextSweepAt);
  const now = useNow(30_000, nextSweepAt ? Date.parse(nextSweepAt) : undefined);
  const view = sweepSegment(snapshot, progress, nextSweepAt, now);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className="capsule-seg capsule-sweep"
        data-sweep-line=""
        data-field="freshness"
        data-tone={view.tone}
        aria-labelledby={labelId}
        title={view.sentence}
      >
        <Icon name={view.icon} size={14} stroke={2} className="capsule-sweep-icon" />
        <span id={labelId} className="visually-hidden">
          {view.sentence}
        </span>
        <span className="capsule-sweep-text" data-sweep-display="" aria-hidden>
          {view.sweptAt ? <Time at={view.sweptAt} now={now} hint={false} /> : view.text}
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} align="end" className="capsule-positioner">
          <Popover.Popup className="capsule-popup" data-sweep-popover="">
            <SweepPopover now={now} onClose={() => setOpen(false)} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The 2 px line under the top row while a sweep runs, filled by sources settled over sources. */
export function SweepProgressLine() {
  const fill = useStore(watchStore, (state) => sweepFill(state.progress));
  if (fill === null) return null;
  return (
    <div className="sweep-progress" data-sweep-progress={fill} aria-hidden>
      <span style={{ width: `${fill * 100}%` }} />
    </div>
  );
}
