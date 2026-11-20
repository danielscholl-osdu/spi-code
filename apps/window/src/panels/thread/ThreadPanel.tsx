// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type KeyboardEvent, useId, useState } from "react";
import { useStore } from "zustand";
import { RightPanelToggle } from "../../app/PanelControls.js";
import { threadStore } from "../../threads/store.js";
import { RightPanelFrame } from "../RightPanelFrame.js";
import { THREAD_TABS } from "./tabs.js";
import "../panels.css";

/** A thread's right panel: its tabs with the toggle at their end, then the open tab. */
export function ThreadPanel({
  id,
  open,
  presentation,
  onToggle,
}: {
  id: string;
  open: boolean;
  presentation: "inline" | "sheet" | "closed";
  onToggle(): void;
}) {
  const base = useId();
  const [chosen, setChosen] = useState(THREAD_TABS[0]?.id);
  const summary = useStore(threadStore, (state) =>
    state.threads?.find((thread) => thread.id === id),
  );
  const active = THREAD_TABS.find((tab) => tab.id === chosen) ?? THREAD_TABS[0];
  if (!active) return null;
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const at = THREAD_TABS.indexOf(active);
    const next = THREAD_TABS[(at + step + THREAD_TABS.length) % THREAD_TABS.length];
    if (!next) return;
    setChosen(next.id);
    document.getElementById(`${base}-tab-${next.id}`)?.focus();
  };
  return (
    <RightPanelFrame open={open} presentation={presentation} onClose={onToggle}>
      <aside aria-label="Thread context" className="right-panel">
        <div role="tablist" aria-label="Right panel" className="panel-tabs pane-header">
          {THREAD_TABS.map((tab) => (
            <button
              key={tab.id}
              id={`${base}-tab-${tab.id}`}
              type="button"
              role="tab"
              data-tab={tab.id}
              aria-selected={tab === active}
              aria-controls={`${base}-panel`}
              tabIndex={tab === active ? 0 : -1}
              onClick={() => setChosen(tab.id)}
              onKeyDown={onKeyDown}
            >
              {tab.label}
            </button>
          ))}
          <RightPanelToggle open onToggleRightPanel={onToggle} />
        </div>
        <div
          id={`${base}-panel`}
          role="tabpanel"
          aria-labelledby={`${base}-tab-${active.id}`}
          className="panel-body"
          data-tab={active.id}
        >
          <active.Panel id={id} summary={summary} />
        </div>
      </aside>
    </RightPanelFrame>
  );
}
