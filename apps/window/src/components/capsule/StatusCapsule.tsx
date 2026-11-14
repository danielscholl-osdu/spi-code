// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { SweepProgressLine, SweepSegment } from "./SweepSegment.js";
import "./capsule.css";

export function StatusCapsule() {
  return (
    <fieldset className="capsule" aria-label="Sweep" data-strip="">
      <SweepSegment />
      <SweepProgressLine />
    </fieldset>
  );
}
