// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useEffect, useRef, useState } from "react";
import { ModelPicker, modelChipLabel } from "./ModelPicker.js";
import { CHIP_ONLY_PROMPT } from "./store.js";
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

const mentionKey = (mention: { from: number; query: string } | null) =>
  mention ? `${mention.from}:${mention.query}` : null;

export function Composer(props: ComposerProps) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [added, setAdded] = useState<PlaceOption[]>([]);
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const mention = mentionAt(text, caret);
  const taken = new Set([...props.context.map((c) => c.id), ...added.map((p) => p.id)]);
  const choices =
    mention && mentionKey(mention) !== dismissed
      ? props.places.filter(
          (p) => !taken.has(p.id) && p.label.toLowerCase().includes(mention.query),
        )
      : [];
  const chips = props.context.length + added.length;

  useEffect(() => {
    if (!picker) return;
    const close = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setPicker(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [picker]);
  useEffect(() => {
    if (props.draft) input.current?.focus();
  }, [props.draft]);

  const addPlace = (place: PlaceOption) => {
    if (!mention) return;
    if (chips >= CHIP_LIMIT) {
      setNotice(LIMIT_REASON);
      setDismissed(mentionKey(mention));
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

  const chipOnly = text.trim().length === 0 && props.context.length > 0;
  const canSend = props.canSend !== false && !props.running && (text.trim().length > 0 || chipOnly);
  const send = () => {
    if (!canSend) return;
    props.onSend({ text: chipOnly ? CHIP_ONLY_PROMPT : text.trim(), places: added });
    if (props.draft) return;
    setText("");
    setCaret(0);
    setAdded([]);
    setNotice("");
    setDismissed(null);
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
          props.context.length > 0
            ? CHIP_ONLY_PROMPT
            : props.draft
              ? `Ask about ${props.scope.label}…`
              : "Reply, or @ a place…"
        }
        onChange={(event) => {
          const value = event.target.value;
          const at = event.target.selectionStart ?? value.length;
          setText(value);
          setCaret(at);
          setHighlight(0);
          if (mentionKey(mentionAt(value, at)) !== dismissed) setDismissed(null);
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
              setDismissed(mentionKey(mention));
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
      {(notice || props.notice) && (
        <p className="thread-notice" role="status">
          {notice || props.notice}
        </p>
      )}
      <div className="thread-composer-row">
        {!props.draft && (
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
