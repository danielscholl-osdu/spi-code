// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { askIn } from "../../threads/start.js";
import type { ThreadSummary } from "../../threads/store.js";
import type { ServicePathOwner } from "./OwnerTag.js";

type Landing = ThreadSummary["thread"]["landsIn"];

function landingOwner(landing: Landing): ServicePathOwner | undefined {
  if (!landing || landing.target === "asking") return undefined;
  if (landing.target === "request") return landing.forge === "gitlab" ? "upstream" : "fork";
  return landing.target === "upstream" ? "upstream" : "fork";
}

export function OwnershipMismatch({
  owner,
  path,
  scope,
  landing,
}: {
  owner: ServicePathOwner | undefined;
  path: string;
  scope: string;
  landing: Landing;
}) {
  const landed = landingOwner(landing);
  if (!owner || !landed || owner === landed) return null;
  const target = owner === "upstream" ? "upstream" : "fork-main";
  const destination = owner === "upstream" ? "Upstream" : "Fork · main";
  const warning =
    owner === "upstream"
      ? "Upstream owns this file. The next sync overwrites a change made here."
      : "Fork owns this file. A change made Upstream does not reach this fork by sync.";
  return (
    <div className="thread-owner-mismatch" role="status">
      <p>{warning}</p>
      <button
        type="button"
        onClick={() =>
          askIn(scope, null, {
            landsIn: target,
            text: `Redo the change to ${path} in this thread, which lands in ${destination}.`,
          })
        }
      >
        {`Redo this file in a thread that lands in ${destination}`}
      </button>
    </div>
  );
}
