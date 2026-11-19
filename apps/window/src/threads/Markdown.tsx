// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ReactNode } from "react";

type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; level: number; text: string }
  | { kind: "code"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] };

const FENCE = /^\s*```/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/;
const startsBlock = (line: string) =>
  FENCE.test(line) || HEADING.test(line) || LIST_ITEM.test(line);

function blocks(source: string): Block[] {
  const out: Block[] = [];
  const lines = source.split(/\r\n?|[\n\u2028\u2029]/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (FENCE.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i] ?? "")) code.push(lines[i++] ?? "");
      i++;
      out.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ kind: "h", level: heading[1]?.length ?? 1, text: heading[2] ?? "" });
      i++;
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const ordered = Boolean(item[2]);
      const items: string[] = [];
      for (
        let m: RegExpExecArray | null = item;
        m && Boolean(m[2]) === ordered;
        m = LIST_ITEM.exec(lines[i] ?? "")
      ) {
        items.push(m[3] ?? "");
        i++;
      }
      out.push({ kind: "list", ordered, items });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para = [line];
    i++;
    while (i < lines.length && (lines[i] ?? "").trim() && !startsBlock(lines[i] ?? "")) {
      para.push(lines[i] ?? "");
      i++;
    }
    out.push({ kind: "p", text: para.join("\n") });
  }
  return out;
}

const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

function inline(text: string, onOpenLink?: (url: string) => void): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const key = `${at}`;
    if (m[1] !== undefined) out.push(<code key={key}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={key}>{m[2]}</strong>);
    else if (m[3] !== undefined) out.push(<em key={key}>{m[3]}</em>);
    else {
      const url = m[5] ?? "";
      out.push(
        /^https?:\/\//.test(url) ? (
          <a
            key={key}
            href={url}
            onClick={(event) => {
              event.preventDefault();
              onOpenLink?.(url);
            }}
          >
            {m[4]}
          </a>
        ) : (
          m[4]
        ),
      );
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** The markdown Copilot writes: paragraphs, headings, lists, code and inline marks. No HTML passes through. */
export function Markdown({
  text,
  onOpenLink,
}: {
  text: string;
  onOpenLink?: (url: string) => void;
}) {
  return (
    <div className="thread-md">
      {blocks(text).map((block, index) => {
        const key = `${block.kind}${index}`;
        if (block.kind === "code")
          return (
            <pre key={key}>
              <code>{block.text}</code>
            </pre>
          );
        if (block.kind === "h")
          return (
            <p key={key} className="thread-md-h">
              {inline(block.text, onOpenLink)}
            </p>
          );
        if (block.kind === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List key={key}>
              {block.items.map((item, n) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: items have no identity beyond their place
                <li key={n}>{inline(item, onOpenLink)}</li>
              ))}
            </List>
          );
        }
        return <p key={key}>{inline(block.text, onOpenLink)}</p>;
      })}
    </div>
  );
}
