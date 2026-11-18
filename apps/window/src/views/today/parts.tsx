// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ReactNode, useId } from "react";
import { navigate } from "../../app/navigation.js";

/** One section of Today's table: its heading and a box holding the shared four columns. */
export function Section({
  id,
  label,
  count,
  head = false,
  children,
}: {
  id: string;
  label: ReactNode;
  count?: number;
  head?: boolean;
  children: ReactNode;
}) {
  const heading = useId();
  return (
    <section className="today-section" data-section={id} aria-labelledby={heading}>
      <h2 className="today-section-head" id={heading}>
        <span className="today-section-dot" aria-hidden="true" />
        {label}
        {count !== undefined && (
          <>
            {" "}
            <span className="today-section-count">{count}</span>
          </>
        )}
      </h2>
      <div className="today-section-box">
        <table>
          <colgroup>
            <col className="today-col-fork" />
            <col />
            <col className="today-col-open" />
            <col className="today-col-age" />
          </colgroup>
          {head && (
            <thead>
              <tr>
                <th scope="col">Fork</th>
                <th scope="col">What</th>
                <th scope="col">Link</th>
                <th scope="col">Age</th>
              </tr>
            </thead>
          )}
          {children}
        </table>
      </div>
    </section>
  );
}

export function ageInOneUnit(age: string | undefined): string | undefined {
  const parts = age?.match(/^(\d+)d (\d+)h$|^(\d+)h$/);
  if (!parts) return age;
  const hours =
    parts[3] === undefined ? Number(parts[1]) * 24 + Number(parts[2]) : Number(parts[3]);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** A fork's name opens its service page; a subject that is no fork is only words. */
export function ForkName({ fork, services }: { fork: string; services: ReadonlySet<string> }) {
  return services.has(fork) ? (
    <button
      type="button"
      className="today-fork-name"
      title={`Open ${fork}`}
      onClick={(event) => {
        event.stopPropagation();
        navigate({ kind: "service", id: fork });
      }}
    >
      {fork}
    </button>
  ) : (
    <span className="today-fork-name" title={fork}>
      {fork}
    </span>
  );
}
