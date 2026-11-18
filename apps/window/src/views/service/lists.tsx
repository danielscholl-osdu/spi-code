// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";
import { type ReactNode, useId } from "react";
import { navigate, routeHash } from "../../app/navigation.js";
import { When } from "../../time.js";
import "./lists.css";

export const listsOf = (snapshot: ViewSnapshot, id: string) =>
  snapshot.services?.find(({ service }) => service === id)?.upstreamSecurity;

/** The not-read line: what was not read, when the rows shown were read, and the Evidence link. */
export function NotRead({ id, what, at }: { id: string; what: string; at?: string | undefined }) {
  return (
    <p className="service-list-unread" data-unread="">
      ⌀ {what} not read
      {at ? (
        <>
          . Showing the read from <When at={at} />
        </>
      ) : null}
      .{" "}
      <a
        href={routeHash({ kind: "evidence", from: { kind: "service", id } })}
        onClick={(event) => {
          event.preventDefault();
          navigate({ kind: "evidence", from: { kind: "service", id } });
        }}
      >
        Evidence ›
      </a>
    </p>
  );
}

export function ListSection({
  id,
  label,
  count,
  tag,
  before,
  after,
  children,
}: {
  id: string;
  label?: string;
  count?: number | undefined;
  tag?: string;
  before?: ReactNode;
  after?: ReactNode;
  children?: ReactNode;
}) {
  const heading = useId();
  return (
    <section
      className="service-section service-list"
      data-section={id}
      {...(label ? { "aria-labelledby": heading } : {})}
    >
      {label && (
        <h2 className="service-section-head" id={heading}>
          <span className="service-section-dot" aria-hidden="true" />
          {label}
          {count !== undefined && <span className="service-section-count">{count}</span>}
          {tag && <span className="service-tag">{tag}</span>}
        </h2>
      )}
      {before}
      {children && <ul className="service-section-box">{children}</ul>}
      {after}
    </section>
  );
}
