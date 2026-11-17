// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Link, RepoLine, ViewSnapshot } from "@spi-code/contracts";
import { type ReactNode, useCallback, useState } from "react";
import { setOpenSelection, useOpenSelection } from "../../app/navigation.js";
import { type BodyPlace, repositoryContent } from "../opened-body/content.js";
import { Popover } from "../popover/Popover.js";
import { timed } from "./opening.js";

export const repositorySelectionId = (repository: string, line: RepoLine, pointer: string) =>
  `${repository}|${line.id ?? pointer}`;

/** Repository identity supplies the source kind; an untyped list entry stays a plain source. */
function sourceLink(line: RepoLine): Link | undefined {
  if (!line.url) return undefined;
  const kind = line.id?.startsWith("issue:")
    ? "issue"
    : line.id?.startsWith("pr:")
      ? "pr"
      : "other";
  return { kind, label: line.text, url: line.url };
}

/** A repository line can be drawn on any place while keeping the same body and selection. */
export function RepositoryLine({
  repository,
  section,
  line,
  pointer,
  snapshot,
  className,
  place = {
    label: `Engineering system › ${repository} › ${section}`,
    destination: { kind: "engineering-system" },
  },
  children,
}: {
  repository: string;
  section: string;
  line: RepoLine;
  pointer: string;
  snapshot: ViewSnapshot;
  className?: string;
  /** Where the line is drawn, for its popover's place; Engineering system unless given. */
  place?: Omit<BodyPlace, "selection">;
  children: ReactNode;
}) {
  const marked = useOpenSelection();
  const id = repositorySelectionId(repository, line, pointer);
  const selected = marked?.kind === "rline" && marked.id === id;
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpenSelection(null), []);
  const selection = { kind: "rline", id };
  const source = sourceLink(line);
  const content = repositoryContent({
    entry: line,
    lines: snapshot.briefing.lines ?? [],
    items: [...snapshot.briefing.focus, ...snapshot.briefing.rest],
    canWait: snapshot.briefing.today?.canWait ?? [],
    place: { ...place, selection },
    ...(source ? { source } : {}),
  });
  return (
    <>
      <button
        ref={selected ? setAnchor : undefined}
        type="button"
        className={className}
        data-rline={id}
        aria-haspopup="dialog"
        aria-expanded={selected}
        onClick={() => setOpenSelection(selected ? null : selection, content.subject)}
      >
        {children}
      </button>
      {selected && anchor && (
        <Popover
          anchor={anchor}
          selection={selection}
          content={timed({
            ...content,
            ...(!content.cause && !content.subject ? { cause: "Not on Today." } : {}),
          })}
          onClose={close}
        />
      )}
    </>
  );
}
