// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";
import type { ReactNode } from "react";
import { selectStrip } from "../../store/strip.js";
import { TimedText } from "../../time.js";
import { useNow } from "../evidence/useNow.js";
import { statusRows } from "../sidebar/status-marks.js";
import type { MemberPlace } from "./members.js";
import "./place.css";

const pins = {
  line: "sheet:line",
  environment: "place:environment",
  engineering: "place:engineering-system",
  upstream: "place:upstream",
} as const;

export function PlaceHead({
  name,
  place,
  snapshot,
  heading,
}: {
  name: string;
  place: MemberPlace;
  snapshot: ViewSnapshot | undefined;
  heading?: ReactNode;
}) {
  const now = useNow(30_000);
  const fields = snapshot && selectStrip(snapshot);
  const status = place === "security" ? undefined : statusRows(fields, now)[pins[place]];
  const field =
    place === "line"
      ? fields?.forks
      : place === "engineering"
        ? fields?.template
        : place === "environment"
          ? fields?.environment
          : undefined;
  const word =
    place === "line" && field?.classification === "stopped"
      ? `${field.count} of ${fields?.forks.services} forks stopped`
      : field?.text;
  const unread = snapshot?.briefing.places?.some(
    (row) => row.place === place && (row.unread?.areas.length ?? 0) > 0,
  );
  const statusWord = word || status?.sentence || (unread ? "not read yet" : undefined);
  if (!snapshot) return heading ?? <h1 data-place>{name}</h1>;
  return (
    <>
      {heading ?? <h1 data-place>{name}</h1>}
      <div className="place-status" data-place-head={place} title={status?.sentence}>
        {statusWord && (
          <span className="place-status-word" data-tone={field?.tone}>
            <TimedText text={statusWord} hint={false} />
          </span>
        )}
      </div>
    </>
  );
}
