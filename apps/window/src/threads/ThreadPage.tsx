// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ModelCatalogResult } from "@spi-code/contracts";
import { useEffect, useMemo } from "react";
import { useStore } from "zustand";
import { navigate } from "../app/navigation.js";
import { treeServices } from "../app/queue.js";
import { PaneTitle } from "../app/title-row.js";
import { watchStore } from "../store/watch.js";
import { clockTime } from "../time.js";
import { threadEntries } from "./entries.js";
import { AUTO } from "./ModelPicker.js";
import { type Draft, lastChoice, NEW_THREAD, threadStore } from "./store.js";
import { ThreadView } from "./ThreadView.js";
import type { ContextChip, CopilotAccount, ModelOption, ScopeOption } from "./types.js";

export const NOT_KNOWN = "not known";
const PROGRAM_NOT_BUILT = "Program threads come with a later build. Choose a service to ask in.";

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

const scopeLabel = (scope: string) => (scope === "program" ? "Program" : scope);

function draftChips(draft: Draft): ContextChip[] {
  const { chip, subject } = draft;
  if (!subject || chip?.state !== "done" || !chip.ok) return [];
  const label = chip.trimmed ? `${subject.label} · trimmed` : subject.label;
  return [{ id: chip.id, label, preview: chip.attachment.content }];
}

function draftNotice(draft: Draft): string | undefined {
  if (draft.failure) return draft.failure.reason;
  const refused = draft.chip?.state === "done" && !draft.chip.ok ? draft.chip.reason : undefined;
  if (!draft.scope) return refused ? `${refused} ${PROGRAM_NOT_BUILT}` : PROGRAM_NOT_BUILT;
  if (draft.chip?.state === "packing") return "Packing what you were looking at…";
  return refused;
}

function draftContextLine(draft: Draft): string | undefined {
  const { chip } = draft;
  if (chip?.state !== "done" || !chip.ok || !draft.scope) return undefined;
  const tokens = chip.tokens.toLocaleString("en-US");
  return `Context · ${draft.scope} · from the sweep at ${clockTime(chip.sweptAt)} · 1 item, ${tokens} tokens`;
}

/** The centre on a thread route: a draft, or a thread the host journals. */
export function ThreadPage({ id }: { id: string }) {
  const state = useStore(threadStore);
  const tree = useStore(watchStore, (watch) => watch.snapshot?.body.tree);
  const services = treeServices(tree);
  const { models, account } = useMemo(() => catalogModels(state.catalog), [state.catalog]);
  const isDraft = id === NEW_THREAD;
  const { draft, open, startDraft } = state;

  useEffect(() => {
    if (isDraft && !draft) startDraft(null);
    if (!isDraft) open(id);
  }, [isDraft, draft, id, open, startDraft]);

  const events = isDraft ? undefined : state.events[id];
  const { entries, running } = useMemo(() => threadEntries(events ?? [], models), [events, models]);
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
    const scopes: ScopeOption[] = services.map((service) => ({ id: service, label: service }));
    const scope = draft.scope;
    return (
      <>
        <PaneTitle>
          <h1 data-place>New thread</h1>
        </PaneTitle>
        <ThreadView
          {...shared}
          draft
          running={false}
          scope={scope ? { id: scope, label: scope } : { id: "program", label: "Program" }}
          scopes={scopes}
          onScopeChange={state.setDraftScope}
          context={draftChips(draft)}
          onRemoveContext={state.removeDraftChip}
          {...(draft.origin ? { origin: draft.origin } : {})}
          contextLine={draftContextLine(draft)}
          notice={draftNotice(draft)}
          canSend={
            Boolean(scope && services.includes(scope)) &&
            draft.chip?.state !== "packing" &&
            draft.sending === undefined
          }
          onSend={({ text }) =>
            state.sendDraft(text, (threadId) => navigate({ kind: "thread", id: threadId }))
          }
          onStop={() => {}}
        />
      </>
    );
  }

  const summary = state.threads?.find((thread) => thread.id === id);
  const status = summary?.status ?? NOT_KNOWN;
  const scope = summary?.thread.scope;
  return (
    <>
      <PaneTitle>
        <h1 data-place>{summary?.thread.title ?? "Thread"}</h1>
        <span className="thread-title-status" data-status={status}>
          {status}
        </span>
      </PaneTitle>
      <ThreadView
        {...shared}
        draft={false}
        running={running && summary !== undefined}
        scope={scope ? { id: scope, label: scopeLabel(scope) } : { id: "", label: NOT_KNOWN }}
        context={[]}
        onRemoveContext={() => {}}
        notice={
          state.failures[id] ??
          (state.threads && !summary ? "The host does not know this thread." : undefined)
        }
        onSend={({ text }) => state.send(id, text)}
        onStop={() => state.stop(id)}
      />
    </>
  );
}
