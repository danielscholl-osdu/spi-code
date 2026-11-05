// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION } from "@spi-code/contracts";
import { expect, it } from "vitest";
import { settleTurn, signInStatus } from "./turn-state.js";

it("keeps the renderer busy when credential_changed ends the old session mid-turn", () => {
  let active: string | undefined = "turn";
  active = settleTurn(active, {
    version: PROTOCOL_VERSION,
    id: "turn",
    kind: "event",
    type: "session.ended",
    payload: { reason: "credential_changed" },
  });
  expect(active !== undefined).toBe(true);
  active = settleTurn(active, {
    version: PROTOCOL_VERSION,
    id: "turn",
    kind: "event",
    type: "turn.end",
    payload: { reason: "completed" },
  });
  expect(active !== undefined).toBe(false);
});

it.each(["turn.end", "error"] as const)("only settles %s for the active request", (type) => {
  const message =
    type === "turn.end"
      ? ({
          version: PROTOCOL_VERSION,
          id: "other",
          kind: "event",
          type,
          payload: { reason: "completed" },
        } as const)
      : ({
          version: PROTOCOL_VERSION,
          id: "other",
          kind: "response",
          type,
          payload: { code: "failed", message: "Failed" },
        } as const);
  expect(settleTurn("turn", message)).toBe("turn");
  expect(settleTurn("turn", { ...message, id: "turn" })).toBeUndefined();
});

it("labels the stub without claiming gh sign-in", () => {
  expect(signInStatus({ mode: "stub", signedIn: false })).toBe("Stub model (no Copilot seat)");
});
