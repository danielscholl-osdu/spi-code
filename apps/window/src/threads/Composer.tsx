// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useEffect, useRef, useState } from "react";
import { ModelPicker, modelChipLabel } from "./ModelPicker.js";
import type { ComposerProps, PlaceOption } from "./types.js";

/** The most context chips one message carries. */
export const CHIP_LIMIT = 8;
const LIMIT_REASON = `A message carries at most ${CHIP_LIMIT} context chips. Remove one to add another.`;
const MENTION = /(^|\s)@([\w.-]*)$/;

function mentionAt(text: string, caret: number): { from: number; query: string } | null {
  const match = MENTION.exec(text.slice(0, caret));
  if (!match) return null;
  return { from: caret - (match[2]?.length ?? 0) - 1, query: (match[2] ?? "").toLowerCase() };
}

export function Composer(props: ComposerProps) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [added, setAdded] = useState<PlaceOption[]>([]);
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [scopeMenu, setScopeMenu] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const mention = mentionAt(text, caret);
  const taken = new Set([...props.context.map((c) => c.id), ...added.map((p) => p.id)]);
  const choices =
    mention && mention.from !== dismissed
      ? props.places.filter(
          (p) => !taken.has(p.id) && p.label.toLowerCase().includes(mention.query),
        )
      : [];
  const chips = props.context.length + added.length;

  useEffect(() => {
    if (!picker && !scopeMenu) return;
    const close = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) {
        setPicker(false);
        setScopeMenu(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [picker, scopeMenu]);

  const addPlace = (place: PlaceOption) => {
    if (!mention) return;
    if (chips >= CHIP_LIMIT) {
      setNotice(LIMIT_REASON);
      setDismissed(mention.from);
      return;
    }
    const next = `${text.slice(0, mention.from)}${text.slice(caret)}`;
    setText(next);
    setCaret(mention.from);
    setAdded((list) => [...list, place]);
    setNotice("");
    setHighlight(0);
    input.current?.focus();
  };

  const canSend = !props.running && text.trim().length > 0;
  const send = () => {
    if (!canSend) return;
    props.onSend({ text: text.trim(), places: added });
    setText("");
    setCaret(0);
    setAdded([]);
    setNotice("");
  };

  return (
    <div ref={box} className="thread-composer" data-draft={props.draft || undefined}>
      {chips > 0 && (
        <div className="thread-chips">
          {props.context.map((chip) => (
            <span key={chip.id} className="thread-chip">
              <button
                type="button"
                aria-expanded={preview === chip.id}
                onClick={() => setPreview(preview === chip.id ? null : chip.id)}
              >
                {chip.label}
              </button>
              <button
                type="button"
                aria-label={`Remove ${chip.label}`}
                onClick={() => {
                  if (preview === chip.id) setPreview(null);
                  setNotice("");
                  props.onRemoveContext(chip.id);
                }}
              >
                ×
              </button>
            </span>
          ))}
          {added.map((place) => (
            <span key={place.id} className="thread-chip">
              <span>@{place.label}</span>
              <button
                type="button"
                aria-label={`Remove ${place.label}`}
                onClick={() => {
                  setNotice("");
                  setAdded((list) => list.filter((p) => p.id !== place.id));
                }}
              >
                ×
              </button>
            </span>
          ))}
          {chips >= CHIP_LIMIT && (
            <span className="thread-chip-count">
              {chips} of {CHIP_LIMIT}
            </span>
          )}
        </div>
      )}
      {preview && (
        <pre className="thread-chip-preview">
          {props.context.find((c) => c.id === preview)?.preview}
        </pre>
      )}
      <textarea
        ref={input}
        aria-label="Message Copilot"
        rows={props.draft ? 3 : 2}
        value={text}
        placeholder={
          props.draft ? "Ask about this, or say what to change…" : "Reply, or @ a place…"
        }
        onChange={(event) => {
          setText(event.target.value);
          setCaret(event.target.selectionStart ?? event.target.value.length);
          setHighlight(0);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (choices.length > 0) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setHighlight((h) => (h + step + choices.length) % choices.length);
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              const place = choices[Math.min(highlight, choices.length - 1)];
              if (place) addPlace(place);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setDismissed(mention?.from ?? null);
              return;
            }
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            send();
          }
        }}
      />
      {choices.length > 0 && (
        <ul className="thread-menu" aria-label="Places">
          {choices.map((place, index) => (
            <li key={place.id}>
              <button
                type="button"
                data-on={index === highlight || undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => addPlace(place)}
              >
                <span>{place.label}</span>
                {place.detail && <small>{place.detail}</small>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {notice && (
        <p className="thread-notice" role="status">
          {notice}
        </p>
      )}
      <div className="thread-composer-row">
        {props.draft && props.scopes && props.onScopeChange ? (
          <button
            type="button"
            className="thread-chip thread-chip--scope"
            aria-expanded={scopeMenu}
            aria-label={`Scope: ${props.scope.label}`}
            onClick={() => setScopeMenu((open) => !open)}
          >
            {props.scope.label} ▾
          </button>
        ) : (
          <span className="thread-chip thread-chip--scope">{props.scope.label}</span>
        )}
        <button
          type="button"
          className="thread-chip"
          aria-expanded={picker}
          aria-label={`Model: ${modelChipLabel(props.models, props.choice)}`}
          onClick={() => setPicker((open) => !open)}
        >
          ✦ {modelChipLabel(props.models, props.choice)}
        </button>
        {props.running ? (
          <button type="button" className="thread-send thread-send--stop" onClick={props.onStop}>
            Stop
          </button>
        ) : (
          <button type="button" className="thread-send" disabled={!canSend} onClick={send}>
            Send ⏎
          </button>
        )}
      </div>
      {scopeMenu && props.scopes && (
        <ul className="thread-menu thread-menu--scopes" aria-label="Scopes">
          {props.scopes.map((scope) => (
            <li key={scope.id}>
              <button
                type="button"
                aria-pressed={scope.id === props.scope.id}
                onClick={() => {
                  props.onScopeChange?.(scope.id);
                  setScopeMenu(false);
                }}
              >
                {scope.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      {picker && (
        <ModelPicker
          models={props.models}
          choice={props.choice}
          account={props.account}
          onChoose={props.onChoose}
          onClose={() => setPicker(false)}
          onRefresh={props.onRefreshModels}
          onOpenLink={props.onOpenLink}
        />
      )}
    </div>
  );
}
