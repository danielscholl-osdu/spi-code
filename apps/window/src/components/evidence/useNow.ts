// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useEffect, useState } from "react";

/** The wall clock, also rechecking at a deadline so an expired promise disappears on time. */
export function useNow(everyMs = 30_000, deadline?: number): number {
  const [, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const now = Date.now();
      timer = setTimeout(
        () => {
          setNow(Date.now());
          schedule();
        },
        deadline !== undefined && deadline > now ? Math.min(everyMs, deadline - now) : everyMs,
      );
    };
    schedule();
    return () => clearTimeout(timer);
  }, [everyMs, deadline]);
  return Date.now();
}
