// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { Dialog } from "@base-ui/react/dialog";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { Appearance } from "../app/appearance.js";
import { navigate } from "../app/navigation.js";
import { type PaletteChoice, setPalette, usePalette } from "../app/palette-choice.js";
import { useMediaQuery } from "../components/sidebar/ui-sidebar.js";
import { openFreshness } from "../components/sweep/reveal.js";
import { SweepNow } from "../components/sweep/SweepNow.js";
import { watchStore } from "../store/watch.js";
import Setup, { ReadinessCheck } from "../views/setup/index.js";
import { READINESS_DOT_LABEL, type ReadinessDot, readinessDot, watchNeeds } from "./readiness.js";
import { SweepSection } from "./SweepSection.js";
import "./settings.css";

/** Below this window width the section nav folds into a picker in the dialog header. */
export const SETTINGS_PICKER_MEDIA_QUERY = "(max-width: 759px)";

export type SettingsSection = "readiness" | "sweep" | "appearance";
const SECTIONS: readonly { id: SettingsSection; label: string }[] = [
  { id: "readiness", label: "Readiness" },
  { id: "sweep", label: "Sweep" },
  { id: "appearance", label: "Appearance" },
];
const THEMES: readonly { id: Appearance; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

const PALETTES: readonly { id: PaletteChoice; label: string }[] = [
  { id: "warm", label: "Warm" },
  { id: "neutral", label: "Neutral" },
];

function Dot({ dot }: { dot: ReadinessDot | null }) {
  return dot ? (
    <span
      className="settings-dot"
      data-readiness={dot}
      role="img"
      aria-label={READINESS_DOT_LABEL[dot]}
    />
  ) : null;
}

function AppearanceSection({
  theme,
  onTheme,
}: {
  theme: Appearance | undefined;
  onTheme(theme: Appearance): void;
}) {
  const palette = usePalette();
  return (
    <div className="settings-group">
      <div className="settings-row">
        <span className="settings-row-name" id="settings-theme">
          Theme
        </span>
        <span className="settings-row-why">Follows the system unless you pin one.</span>
        <div className="settings-segments" role="radiogroup" aria-labelledby="settings-theme">
          {THEMES.map(({ id, label }) => (
            <label key={id} className="settings-segment">
              <input
                type="radio"
                name="settings-theme"
                value={id}
                checked={theme === id}
                onChange={() => onTheme(id)}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="settings-row">
        <span className="settings-row-name" id="settings-palette">
          Palette
        </span>
        <span className="settings-row-why">Warm paper or neutral grey, in light and dark.</span>
        <div className="settings-segments" role="radiogroup" aria-labelledby="settings-palette">
          {PALETTES.map(({ id, label }) => (
            <label key={id} className="settings-segment">
              <input
                type="radio"
                name="settings-palette"
                value={id}
                checked={palette === id}
                onChange={() => setPalette(id)}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Settings (PS-08, Setup): a dialog over the current place with Readiness, which hosts Setup,
 * Sweep and Appearance, on the section its opener chose. Escape or the close button closes it and focus
 * returns to where it was.
 */
export function SettingsDialog({
  open,
  onOpenChange,
  section,
  onSection: setSection,
  theme,
  onTheme,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  section: SettingsSection;
  onSection(section: SettingsSection): void;
  theme: Appearance | undefined;
  onTheme(theme: Appearance): void;
}) {
  const picker = useMediaQuery(SETTINGS_PICKER_MEDIA_QUERY);
  const setup = useStore(watchStore, (state) => state.setup);
  const dot = readinessDot(setup);
  const [awaitingWatch, setAwaitingWatch] = useState(false);
  useEffect(() => {
    if (!open) setAwaitingWatch(false);
    else if (setup && !setup.watchReady) setAwaitingWatch(true);
  }, [open, setup]);
  const changeOpen = (next: boolean) => {
    if (!next && awaitingWatch && setup?.watchReady) navigate({ kind: "today" });
    onOpenChange(next);
  };
  const popup = useRef<HTMLDivElement>(null);
  const current = SECTIONS.find(({ id }) => id === section) ?? SECTIONS[0];
  return (
    <Dialog.Root open={open} onOpenChange={changeOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className="settings-backdrop" />
        <Dialog.Popup
          ref={popup}
          className="settings"
          data-layout={picker ? "picker" : "nav"}
          initialFocus={() =>
            popup.current?.querySelector<HTMLElement>(
              picker ? ".settings-picker select" : ".settings-nav [aria-current]",
            ) ?? true
          }
        >
          {!picker && (
            <nav className="settings-nav" aria-label="Settings sections">
              <Dialog.Title className="settings-title">Settings</Dialog.Title>
              {SECTIONS.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  className="settings-nav-item"
                  aria-current={id === section ? "page" : undefined}
                  onClick={() => setSection(id)}
                >
                  <span>{label}</span>
                  {id === "readiness" && <Dot dot={dot} />}
                </button>
              ))}
            </nav>
          )}
          <div className="settings-main">
            <header className="settings-header">
              {picker ? (
                <>
                  <Dialog.Title className="visually-hidden">Settings</Dialog.Title>
                  <span className="settings-picker">
                    <select
                      aria-label="Settings section"
                      value={section}
                      onChange={(event) => {
                        const next = SECTIONS.find(({ id }) => id === event.target.value);
                        if (next) setSection(next.id);
                      }}
                    >
                      {SECTIONS.map(({ id, label }) => (
                        <option key={id} value={id}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <Dot dot={dot} />
                  </span>
                </>
              ) : (
                <span className="settings-crumb">
                  Settings / <b>{current?.label}</b>
                </span>
              )}
              <span className="settings-spacer" />
              {section === "readiness" && <ReadinessCheck />}
              {section === "sweep" && (
                <SweepNow
                  onViewSweep={() => {
                    changeOpen(false);
                    openFreshness(watchStore.getState().snapshot);
                  }}
                  onOpenReadiness={() => setSection("readiness")}
                />
              )}
              <Dialog.Close className="settings-close" aria-label="Close settings">
                <span aria-hidden>✕</span>
              </Dialog.Close>
            </header>
            <section
              className="settings-body"
              aria-label={current?.label}
              data-settings-section={section}
            >
              {section === "readiness" ? (
                <>
                  {setup && (!setup.watchReady || awaitingWatch) && (
                    <div
                      className="settings-readiness-banner"
                      data-readiness={setup.watchReady ? "ready" : "attention"}
                    >
                      <span role="status">
                        {setup.watchReady ? "Watch is ready" : watchNeeds(setup)}
                      </span>
                      {setup.watchReady && (
                        <button type="button" onClick={() => changeOpen(false)}>
                          Go to Today
                        </button>
                      )}
                    </div>
                  )}
                  <Setup inSettings onOpenSweep={() => setSection("sweep")} />
                </>
              ) : section === "sweep" ? (
                <SweepSection />
              ) : (
                <AppearanceSection theme={theme} onTheme={onTheme} />
              )}
            </section>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
