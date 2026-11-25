// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { Popover } from "@base-ui/react/popover";
import { blocksWatch } from "@spi-code/contracts";
import { useId, useState } from "react";
import { useStore } from "zustand";
import { openEvidence } from "../../app/navigation.js";
import { watchStore } from "../../store/watch.js";
import { clockTime } from "../../time.js";
import { useNow } from "../evidence/useNow.js";
import { sourceName, sweepSources } from "../evidence/words.js";
import { Icon } from "../icons/Icon.js";
import { useSidebar } from "../sidebar/ui-sidebar.js";
import { revealFirstSweep } from "../sweep/reveal.js";
import { settled, sourceOutcome } from "../sweep/words.js";
import "../sweep/sweep.css";
import { sourceState, sweepFill, sweepSegment } from "./sweep.js";
import "./capsule.css";

const plural = (n: number) => (n === 1 ? "source" : "sources");

const MARK = { warn: "⚠", bad: "✕" } as const;

/** What the sweep read without trouble, in one muted line. */
function restLine(fine: number, unread: number, listed: number): string | null {
  if (listed === 0 && unread === 0) return `All ${fine} ${plural(fine)} read.`;
  const parts = [
    ...(fine > 0 ? [`${fine} ${listed > 0 ? "other " : ""}${plural(fine)} read`] : []),
    ...(unread > 0 ? [`${unread} not read yet`] : []),
  ];
  return parts.length > 0 ? parts.join(" · ") : null;
}

function SweepPopover({ now, onClose }: { now: number; onClose(): void }) {
  const { snapshot, progress, sweep, sweepRequest, sweepRequestError, setup } =
    useStore(watchStore);
  const { isMobile, setOpenMobile } = useSidebar();
  const body = snapshot?.body ?? null;
  const live = progress?.outcome === "running" ? progress : null;
  const states = body
    ? sweepSources(body).map((source) => ({ ...source, state: sourceState(source.envelope, now) }))
    : [];
  const listed = states
    .filter(({ state }) => state.tone === "bad" || state.tone === "warn")
    .sort((a, b) => Number(b.state.tone === "bad") - Number(a.state.tone === "bad"));
  const unread = states.filter(({ state }) => state.tone === "unread").length;
  const rest = restLine(states.length - listed.length - unread, unread, listed.length);
  const reading = live?.sources.find(
    ({ state }) => state === "reading" || state === "throttled",
  )?.source;
  const nextSweep =
    sweep?.nextSweepAt && Date.parse(sweep.nextSweepAt) > now ? sweep.nextSweepAt : null;
  const stopped = progress?.outcome === "failed" || progress?.outcome === "cancelled";
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
          {live ? (
            body ? (
              "Sweeping"
            ) : (
              "First sweep"
            )
          ) : body ? (
            <>
              Swept{" "}
              <time dateTime={body.sweptAt}>{clockTime(body.sweptAt, { now, hint: false })}</time>
            </>
          ) : (
            "Not swept"
          )}
        </Popover.Title>
        {live ? (
          <span className="capsule-pop-aside" data-sweep-running="">
            {settled(live)} of {live.sources.length}
          </span>
        ) : (
          nextSweep && (
            <span className="capsule-pop-aside" data-next="sweep">
              next {clockTime(nextSweep, { now, hint: false })}
            </span>
          )
        )}
      </div>
      {live ? (
        <>
          <div className="sweep-bar capsule-pop-bar" aria-hidden="true">
            {live.sources.map((source) => (
              <span
                key={source.source}
                className="sweep-segment"
                data-tone={sourceOutcome(source, now).tone}
              />
            ))}
          </div>
          <p className="capsule-pop-line">
            {reading && `Reading ${sourceName(reading)}.`}
            {reading && body && " "}
            {body &&
              `Today shows the ${clockTime(body.sweptAt, { now, hint: false })} sweep until this one ends.`}
          </p>
        </>
      ) : body ? (
        <>
          {listed.map(({ key, name, state }) => (
            <div className="capsule-pop-row" key={key} data-source={key} data-tone={state.tone}>
              <span className="capsule-pop-mark" aria-hidden="true">
                {MARK[state.tone as keyof typeof MARK]}
              </span>
              <span className="capsule-pop-name">{name}</span>
              <span className="capsule-pop-state">{state.text}</span>
            </div>
          ))}
          {rest && (
            <p className="capsule-pop-line" data-sweep-rest="">
              {rest}
            </p>
          )}
        </>
      ) : (
        <p className="capsule-pop-line">
          {stopped ? "The first sweep stopped." : "Nothing has been read yet."}
        </p>
      )}
      {sweepRequestError && (
        <p role="alert" className="capsule-pop-alert">
          {sweepRequestError}
        </p>
      )}
      <div className="capsule-pop-foot">
        {!live && (
          <button
            type="button"
            className="capsule-sweep-now"
            disabled={blocked}
            onClick={async () => {
              try {
                await watchStore.getState().requestSweepNow();
              } catch {
                // The store reports send failures without exposing transport details.
              }
            }}
          >
            <Icon name="refresh" size={14} stroke={2} />
            Sweep now
          </button>
        )}
        <span className="capsule-spacer" />
        <button
          type="button"
          className="capsule-evidence"
          onClick={() => {
            onClose();
            if (isMobile) setOpenMobile(false);
            if (body) openEvidence();
            else revealFirstSweep();
          }}
        >
          Evidence ›
        </button>
      </div>
    </>
  );
}

/** The footer sweep opens its sources above the button. */
export function SidebarSweep() {
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
        className="sidebar-sweep capsule-sweep"
        data-sweep-line=""
        data-keeps-popover=""
        data-field="freshness"
        data-tone={view.tone}
        aria-labelledby={labelId}
        title={view.sentence}
      >
        <Icon name={view.icon} size={14} stroke={2} className="capsule-sweep-icon" />
        <span id={labelId} className="visually-hidden">
          {view.sentence}
        </span>
        {view.text && (
          <span className="capsule-sweep-text" data-sweep-display="" aria-hidden>
            {view.text}
          </span>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" sideOffset={8} align="end" className="capsule-positioner">
          <Popover.Popup className="capsule-popup" data-sweep-popover="" data-keeps-popover="">
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
