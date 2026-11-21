// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { Icon } from "../components/icons/Icon.js";
import { AskingLine } from "./AskingLine.js";
import { Composer } from "./Composer.js";
import { Timeline } from "./Timeline.js";
import type { ThreadViewProps } from "./types.js";
import "./threads.css";

/** A thread in the centre: its timeline and composer, or a draft with nothing sent. */
export function ThreadView({
  entries,
  activity,
  contextLine,
  onChangeScope,
  below,
  onApprovalDecision,
  ...composer
}: ThreadViewProps) {
  if (!composer.draft)
    return (
      <section className="thread-view">
        <Timeline
          entries={entries}
          contextLine={contextLine}
          running={composer.running}
          activity={activity}
          onOpenLink={composer.onOpenLink}
          onApprovalDecision={onApprovalDecision}
        />
        {below}
        <Composer {...composer} />
      </section>
    );
  const { scope } = composer;
  return (
    <section className="thread-view thread-view--draft">
      <div className="thread-draft">
        <h2 className="thread-draft-heading">
          Ask in{" "}
          <button
            type="button"
            className="thread-scope"
            aria-haspopup="dialog"
            aria-label={`Ask in ${scope.label}, change`}
            disabled={!onChangeScope}
            onClick={onChangeScope}
          >
            <Icon name={scope.icon ?? "box"} size={18} className="thread-scope-icon" />
            {scope.label}
            <span className="thread-scope-caret" aria-hidden>
              ▾
            </span>
          </button>
        </h2>
        <Composer {...composer} />
        <AskingLine />
        {below}
      </div>
    </section>
  );
}
