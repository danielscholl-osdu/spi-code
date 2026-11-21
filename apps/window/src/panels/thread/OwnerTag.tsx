// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

export type ServicePathOwner = "fork" | "upstream";

export function OwnerTag({ owner }: { owner: ServicePathOwner | undefined }) {
  if (!owner) return null;
  return (
    <span className="thread-owner-tag" data-owner={owner}>
      {owner === "fork" ? "Fork" : "Upstream"}
    </span>
  );
}
