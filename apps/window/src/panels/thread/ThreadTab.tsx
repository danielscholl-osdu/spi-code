// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { THREAD_SECTIONS } from "./sections.js";
import type { ThreadTab, ThreadTabProps } from "./tab.js";
import { useRereadAfterTurn } from "./useChanges.js";
import "./thread-tab.css";

/** Where the thread lands, its git actions and its worktree, one field each. */
function ThreadDetails(props: ThreadTabProps) {
  useRereadAfterTurn(props.id);
  return (
    <dl className="thread-fields">
      {THREAD_SECTIONS.map(({ id, label, Field }) => (
        <div key={id} className="thread-field" data-field={id}>
          <dt>{label}</dt>
          <dd>
            <Field {...props} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

export const THREAD_TAB: ThreadTab = { id: "thread", label: "Thread", Panel: ThreadDetails };
