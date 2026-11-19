// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useState } from "react";
import { Icon } from "../components/icons/Icon.js";
import type { CopilotAccount, ModelChoice, ModelOption } from "./types.js";

export const AUTO = "auto";
const GITHUB_SETTINGS = "https://github.com/settings/copilot";
const FAVOURITE_KEYS = 4;

const effortWords = (effort: string) => effort.charAt(0).toUpperCase() + effort.slice(1);

export function modelChipLabel(models: readonly ModelOption[], choice: ModelChoice): string {
  const model = models.find((m) => m.id === choice.model);
  if (!model) return "Auto";
  return choice.effort ? `${model.name} · ${effortWords(choice.effort)}` : model.name;
}

const usable = (model: ModelOption) => model.policy === "enabled";

export interface ModelPickerProps {
  models: readonly ModelOption[];
  choice: ModelChoice;
  account?: CopilotAccount | undefined;
  onChoose(choice: ModelChoice): void;
  onClose(): void;
  onRefresh?: (() => void) | undefined;
  onOpenLink?: ((url: string) => void) | undefined;
}

/** T3 Code's model picker without the provider rail (CP-09). */
export function ModelPicker(props: ModelPickerProps) {
  const { models, choice } = props;
  const [query, setQuery] = useState("");
  const favourites = models.filter((m) => m.favourite).slice(0, FAVOURITE_KEYS);
  const others = models.filter((m) => !favourites.includes(m));
  const matches = (m: ModelOption) => m.name.toLowerCase().includes(query.trim().toLowerCase());
  const chosen = models.find((m) => m.id === choice.model);
  const efforts = chosen?.reasoningEfforts ?? [];

  const choose = (model: ModelOption | null) => {
    if (model && !usable(model)) return;
    props.onChoose(
      model?.defaultReasoningEffort
        ? { model: model.id, effort: model.defaultReasoningEffort }
        : { model: model?.id ?? AUTO },
    );
    props.onClose();
  };

  const row = (model: ModelOption, shortcut?: number) => {
    const on = model.id === choice.model;
    const enabled = usable(model);
    return (
      <li key={model.id} className="thread-picker-model" data-on={on || undefined}>
        <button
          type="button"
          aria-pressed={on}
          aria-disabled={!enabled || undefined}
          disabled={!enabled}
          onClick={() => choose(model)}
        >
          <span aria-hidden="true">{model.favourite ? "★" : ""}</span>
          <span>
            {model.name}
            {!enabled && <span className="thread-picker-off"> · not enabled for this account</span>}
          </span>
          <small>{model.multiplier === undefined ? "" : `${model.multiplier}×`}</small>
          <small>{shortcut === undefined ? "" : `⌘${shortcut}`}</small>
        </button>
        {!enabled && (
          <button
            type="button"
            className="thread-picker-link"
            onClick={() => props.onOpenLink?.(GITHUB_SETTINGS)}
          >
            GitHub settings ↗
          </button>
        )}
      </li>
    );
  };

  const shownFavourites = favourites.filter(matches);
  const shownOthers = others.filter(matches);
  return (
    <div
      className="thread-picker"
      role="dialog"
      aria-label="Choose a model"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          props.onClose();
          return;
        }
        if (!(event.metaKey || event.ctrlKey)) return;
        const n = Number(event.key);
        if (event.key === "0") choose(null);
        else if (n >= 1 && n <= favourites.length) choose(favourites[n - 1] ?? null);
        else return;
        event.preventDefault();
      }}
    >
      <div className="thread-picker-models">
        <input
          type="search"
          aria-label="Search models"
          placeholder="Search models…"
          value={query}
          // biome-ignore lint/a11y/noAutofocus: the picker opens to its search field
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
        />
        <ul aria-label="Models">
          {"auto".includes(query.trim().toLowerCase()) && (
            <li className="thread-picker-model" data-on={choice.model === AUTO || undefined}>
              <button
                type="button"
                aria-pressed={choice.model === AUTO}
                onClick={() => choose(null)}
              >
                <span aria-hidden="true">✦</span>
                <span>Auto</span>
                <small>default</small>
                <small>⌘0</small>
              </button>
            </li>
          )}
          {shownFavourites.map((m) => row(m, favourites.indexOf(m) + 1))}
          {shownFavourites.length > 0 && shownOthers.length > 0 && (
            <li className="thread-picker-rule" aria-hidden="true" />
          )}
          {shownOthers.map((m) => row(m))}
        </ul>
      </div>
      {chosen && efforts.length > 0 && (
        <div className="thread-picker-efforts">
          <p className="thread-picker-head">
            <span>Reasoning</span>
            <span>{chosen.name}</span>
          </p>
          <ul aria-label="Reasoning">
            {efforts.map((effort) => (
              <li key={effort}>
                <button
                  type="button"
                  aria-pressed={choice.effort === effort}
                  onClick={() => {
                    props.onChoose({ model: chosen.id, effort });
                    props.onClose();
                  }}
                >
                  <span>{effortWords(effort)}</span>
                  {effort === chosen.defaultReasoningEffort && <small>Default</small>}
                  {choice.effort === effort && <span aria-hidden="true">✓</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <footer className="thread-picker-foot">
        <span>
          Copilot · {props.account?.login ?? "account not read"} ·{" "}
          {props.account?.usedPercent === undefined
            ? "usage unavailable"
            : `${props.account.usedPercent}% of premium requests used`}
        </span>
        {props.onRefresh && (
          <button type="button" aria-label="Refresh models" onClick={props.onRefresh}>
            <Icon name="refresh" size={12} />
          </button>
        )}
      </footer>
    </div>
  );
}
