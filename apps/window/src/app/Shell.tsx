// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { Button } from "@base-ui/react/button";
import { type ReactNode, useEffect, useState } from "react";
import { createWatchStore } from "../store/watch.js";
import { createAppearance } from "./appearance.js";
import { routes } from "./routes.js";

export const watchStore = createWatchStore((message) => window.spi.postMessage(message));

export function Shell({ children }: { children?: ReactNode }) {
  const [route, setRoute] = useState<(typeof routes)[number]>(routes[0]);
  const [appearance, setAppearance] = useState<ReturnType<typeof createAppearance>>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = createAppearance();
    setAppearance(controller);
    const unsubscribe = window.spi.onMessage((message) => {
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
      <nav aria-label="Program">
        {routes.map((item) => (
          <Button
            key={item.id}
            aria-current={item === route ? "page" : undefined}
            onClick={() => setRoute(item)}
          >
            {item.label}
          </Button>
        ))}
      </nav>
      <main>
        {error && <p role="alert">{error}</p>}
        <View />
        <details>
          <summary>Copilot turn</summary>
          {children}
        </details>
      </main>
      <aside aria-label="Inspector">
        <h2>Inspector</h2>
        <p>No selection</p>
      </aside>
    </div>
  );
}
