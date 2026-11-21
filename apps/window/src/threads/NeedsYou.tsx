// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { todayMembers } from "@spi-code/contracts";
import { useStore } from "zustand";
import { navigate } from "../app/navigation.js";
import { todayContent } from "../components/opened-body/content.js";
import { askTarget } from "../components/opened-body/OpenedBody.js";
import { watchStore } from "../store/watch.js";
import { threadOwningRequest } from "./request-ownership.js";
import { type AskTarget, threadStore } from "./store.js";

const SHOWN = 3;
const TODAY = { label: "Today", destination: { kind: "today" } } as const;

/**
 * Up to three of a scope's Today rows that need the operator, under a draft's composer. A click
 * attaches the row as the draft's chip, as its own Ask about this would; a row a thread owns opens
 * that thread instead.
 */
export function NeedsYou({
  scope,
  attached,
  onAttach,
}: {
  scope: string;
  attached?: string | undefined;
  onAttach(target: AskTarget): void;
}) {
  const lines = useStore(watchStore, (watch) => watch.snapshot?.body.briefing.lines);
  const threads = useStore(threadStore, (state) => state.threads);
  const rows = todayMembers({ lines })
    .filter(({ member }) => member.fork === scope)
    .flatMap(({ line, member }) => {
      const target = askTarget(todayContent({ line, member, items: [], place: TODAY }));
      return target && target.subject !== attached ? [{ line, member, target }] : [];
    })
    .slice(0, SHOWN);
  if (rows.length === 0) return null;
  return (
    <section className="thread-needs" aria-label="Needs you">
      <h3>Needs you</h3>
      <ul>
        {rows.map(({ line, member, target }) => {
          const owner = threadOwningRequest(threads, target.subject, target.urls);
          return (
            <li key={target.subject}>
              <button
                type="button"
                data-section={line.section}
                title={owner ? "Open its thread" : "Attach to the message"}
                onClick={() =>
                  owner ? navigate({ kind: "thread", id: owner.id }) : onAttach(target)
                }
              >
                <span className="thread-needs-mark" aria-hidden />
                <span className="thread-needs-label">{line.headline}</span>
                {owner ? (
                  <small>
                    ✦ {owner.thread.title ?? "Untitled thread"} · {owner.status}
                  </small>
                ) : (
                  member.age && <small>{member.age}</small>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
