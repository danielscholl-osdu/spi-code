// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ModelCatalogResult } from "@spi-code/contracts";
import { useCallback, useEffect, useMemo } from "react";
import { useStore } from "zustand";
import { navigate, replaceRoute, routeHash, routeLabel } from "../app/navigation.js";
import { useRegistry } from "../app/routes.js";
import { matchesShiftShortcut, shiftShortcutLabel } from "../app/shortcuts.js";
import { PaneTitle } from "../app/title-row.js";
import { Icon } from "../components/icons/Icon.js";
import { routeAfterSettle } from "../components/sidebar/ThreadRows.js";
import { watchStore } from "../store/watch.js";
import { ContinueIn } from "./ContinueIn.js";
import { threadEntries } from "./entries.js";
import { AUTO } from "./ModelPicker.js";
import { NeedsYou } from "./NeedsYou.js";
import { openScopePicker } from "./picker.js";
import { canStartIn, PROGRAM, scopeIcon, scopeLabel } from "./scopes.js";
import { type Draft, lastChoice, NEW_THREAD, threadStore } from "./store.js";
import { ThreadView } from "./ThreadView.js";
import type { ContextChip, CopilotAccount, ModelOption } from "./types.js";

export const NOT_KNOWN = "not known";

const number = (value: unknown) => (typeof value === "number" ? value : undefined);

/** The catalog as the picker reads it; a field the host could not read stays unknown. */
export function catalogModels(catalog: ModelCatalogResult | null): {
  models: ModelOption[];
  account?: CopilotAccount;
} {
  if (!catalog) return { models: [] };
  const models = catalog.models.map((model): ModelOption => {
    const levels = model.reasoning?.levels;
    const fallback = model.reasoning?.defaultLevel;
    const multiplier = number(model.multiplier);
    return {
      id: model.id,
      name: model.name,
      policy: model.policy?.state ?? NOT_KNOWN,
      ...(multiplier === undefined ? {} : { multiplier }),
      ...(Array.isArray(levels) ? { reasoningEfforts: levels } : {}),
      ...(fallback && fallback !== NOT_KNOWN ? { defaultReasoningEffort: fallback } : {}),
    };
  });
  const account = catalog.account;
  if (!account || account === NOT_KNOWN) return { models };
  const usage = catalog.usage === NOT_KNOWN ? undefined : catalog.usage;
  const used = number(usage?.used);
  const entitlement = number(usage?.entitlement);
  return {
    models,
    account: {
      login: account.login,
      ...(used !== undefined && entitlement
        ? { usedPercent: Math.round((used / entitlement) * 100) }
        : {}),
    },
  };
}

function draftChips(draft: Draft): ContextChip[] {
  const { chip, subject } = draft;
  if (!subject || chip?.state !== "done" || !chip.ok) return [];
  const label = chip.trimmed ? `${subject.label} · trimmed` : subject.label;
  return [{ id: chip.id, label, preview: chip.attachment.content }];
}

function draftNotice(draft: Draft): string | undefined {
  if (draft.failure) return draft.failure.reason;
  if (draft.chip?.state === "packing") return "Packing what you were looking at…";
  return draft.chip?.state === "done" && !draft.chip.ok ? draft.chip.reason : undefined;
}

/** The centre on a thread route: a draft, or a thread the host journals. */
export function ThreadPage({ id }: { id: string }) {
  const state = useStore(threadStore);
  const tree = useStore(watchStore, (watch) => watch.snapshot?.body.tree);
  const registry = useRegistry();
  const { models, account } = useMemo(() => catalogModels(state.catalog), [state.catalog]);
  const isDraft = id === NEW_THREAD;
  const { draft, open } = state;
  const summary = isDraft ? undefined : state.threads?.find((thread) => thread.id === id);
  const status = summary?.status ?? NOT_KNOWN;
  const settled = status === "Settled";
  const settle = useCallback(() => {
    if (!summary) return;
    state.toggle(summary, (threads) => {
      const next = routeAfterSettle(threads, summary.id);
      if (next) navigate(next);
    });
  }, [state, summary]);

  useEffect(() => {
    if (isDraft && !draft && window.location.hash === routeHash({ kind: "thread", id: NEW_THREAD }))
      replaceRoute(registry.fallback);
    if (!isDraft && summary?.status !== "Can't be read") open(id);
  }, [isDraft, draft, id, open, registry.fallback, summary?.status]);
  useEffect(() => {
    if (!summary || (status !== "Open" && !settled)) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !matchesShiftShortcut(event, "s")) return;
      event.preventDefault();
      if (!event.repeat) settle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [summary, status, settled, settle]);

  const events = isDraft ? undefined : state.events[id];
  const pending = isDraft ? draft?.sending?.message : state.pending[id];
  const knownScope = isDraft ? draft?.scope : summary?.thread.scope;
  const { entries, running, activity } = useMemo(
    () => threadEntries(events ?? [], models, { scope: knownScope, pending }),
    [events, models, knownScope, pending],
  );
  const stopping = isDraft ? draft?.sending?.stopping === true : state.stopping[id] === true;
  const shown = activity && (stopping ? { ...activity, phase: "Stopping" } : activity);
  const key = isDraft ? "draft" : id;
  const choice = state.choices[key] ?? lastChoice(events) ?? { model: AUTO };
  const shared = {
    models,
    choice,
    onChoose: (next: typeof choice) => state.choose(key, next),
    ...(account ? { account } : {}),
    onRefreshModels: state.listModels,
    onOpenLink: (url: string) => void window.spi?.openExternal(url),
    places: [],
    entries,
  };

  if (isDraft) {
    if (!draft) return null;
    const scope = draft.scope;
    const back = draft.from ?? { label: routeLabel(registry.fallback), route: registry.fallback };
    return (
      <>
        <PaneTitle>
          <h1 className="thread-back-title">
            <a
              className="thread-back"
              href={routeHash(back.route)}
              onClick={(event) => {
                event.preventDefault();
                navigate(back.route);
              }}
            >
              ← {back.label}
            </a>
          </h1>
        </PaneTitle>
        {draft.sending ? (
          <ThreadView
            key="sending"
            {...shared}
            activity={shown}
            draft={false}
            running
            stopping={stopping}
            scope={{ id: scope, label: scopeLabel(scope), icon: scopeIcon(scope) }}
            context={[]}
            onRemoveContext={() => {}}
            onSend={() => {}}
            onStop={state.stopDraft}
          />
        ) : (
          <ThreadView
            key={`draft-${draft.opened ?? 0}`}
            {...shared}
            initialText={draft.failure?.words ?? draft.text}
            draft
            running={false}
            scope={{ id: scope, label: scopeLabel(scope), icon: scopeIcon(scope) }}
            onChangeScope={() => openScopePicker({ mode: "change", current: scope })}
            context={draftChips(draft)}
            onRemoveContext={state.removeDraftChip}
            notice={draftNotice(draft)}
            canSend={
              canStartIn(scope, tree) &&
              draft.chip?.state !== "packing" &&
              draft.sending === undefined
            }
            onSend={({ words, chipOnly }) =>
              state.sendDraft({ words, chipOnly }, (threadId) => {
                const thread = { kind: "thread", id: threadId } as const;
                if (window.location.hash === routeHash({ kind: "thread", id: NEW_THREAD }))
                  replaceRoute(thread);
                else navigate(thread);
              })
            }
            onStop={() => {}}
            below={
              <NeedsYou
                scope={scope}
                attached={draft.subject?.id}
                onAttach={state.attachDraftChip}
              />
            }
          />
        )}
      </>
    );
  }

  const scope = summary?.thread.scope;
  return (
    <>
      <PaneTitle
        end={
          summary && (
            <button
              type="button"
              className="thread-settle"
              data-settled={settled || undefined}
              disabled={status !== "Open" && !settled}
              title={`${settled ? "Un-settle" : "Settle"} ${shiftShortcutLabel("s")}${
                status !== "Open" && !settled ? ` · not while ${status}` : ""
              }`}
              onClick={settle}
            >
              <Icon name={settled ? "refresh" : "check"} size={13} stroke={2} />
              {settled ? "Un-settle" : "Settle"}
            </button>
          )
        }
      >
        <h1 data-place>{summary?.thread.title ?? "Thread"}</h1>
        <span className="thread-title-status" data-status={status}>
          {status}
        </span>
      </PaneTitle>
      <ThreadView
        {...shared}
        draft={false}
        activity={summary && shown}
        running={(running || activity !== undefined) && summary !== undefined}
        stopping={stopping}
        scope={scope ? { id: scope, label: scopeLabel(scope) } : { id: "", label: NOT_KNOWN }}
        context={[]}
        onRemoveContext={() => {}}
        notice={
          state.failures[id] ??
          (state.threads && !summary ? "The host does not know this thread." : undefined)
        }
        onSend={({ text }) => state.send(id, text)}
        onStop={() => state.stop(id)}
        onApprovalDecision={(approval, approved) =>
          state.decideApproval(id, approval.turnId, approval.approvalId, approved)
        }
        below={
          summary && scope === PROGRAM && !running && events ? (
            <ContinueIn thread={summary} events={events} />
          ) : undefined
        }
      />
    </>
  );
}
