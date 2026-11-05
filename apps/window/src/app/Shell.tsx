// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ReactNode, useEffect, useState } from "react";
import { ProgramTree } from "../components/tree/ProgramTree.js";
import { RightPanel, selectionStore } from "../panels/index.js";
import { watchStore } from "../store/watch.js";
import { createAppearance } from "./appearance.js";
import { routes, useSetupLanding } from "./routes.js";

export { watchStore };

export function Shell({ children }: { children?: ReactNode }) {
  const [route, setRoute] = useState<(typeof routes)[number]>(routes[0]);
  useSetupLanding(setRoute);
  const [appearance, setAppearance] = useState<ReturnType<typeof createAppearance>>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = createAppearance();
    setAppearance(controller);
    const unsubscribe = window.spi.onMessage((message) => {
      selectionStore.getState().receive(message);
      try {
        watchStore.getState().receive(message);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    });
    return () => {
      controller.dispose();
      unsubscribe();
    };
  }, []);
  const View = route.View;
  return (
    <div className="shell">
      <header className="title-bar">
        <strong>SPI Code</strong>
        <label>
          Appearance{" "}
          <select
            aria-label="Appearance"
            key={appearance?.pin}
            defaultValue={appearance?.pin ?? "system"}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "system" || value === "light" || value === "dark")
                appearance?.setPin(value);
            }}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </header>
      <ProgramTree store={watchStore} route={route} onNavigate={setRoute} />
      <main>
        {error && <p role="alert">{error}</p>}
        <View />
        <details>
          <summary>Copilot turn</summary>
          {children}
        </details>
      </main>
      <RightPanel store={selectionStore} />
    </div>
  );
}
