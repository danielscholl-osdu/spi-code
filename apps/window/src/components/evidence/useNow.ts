// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useEffect, useState } from "react";

/** The wall clock, ticking each `everyMs`, so relative ages in evidence stay current. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
