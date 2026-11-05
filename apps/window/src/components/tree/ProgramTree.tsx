// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT
//
// Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import { Button } from "@base-ui/react/button";
import { type TreeStatus, TreeStatusSchema } from "@spi-code/contracts";
import { type MouseEvent, useState } from "react";
import { useStore } from "zustand";
import { routes } from "../../app/routes.js";
import type { createWatchStore } from "../../store/watch.js";
import "./tree.css";

type Route = (typeof routes)[number];
type Status = TreeStatus[number]["status"];
const [today, repositories, releases, environment, flow, horizon, setup] = routes;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function workflowRuns(body: unknown) {
  const runs = new Map<string, { label: string; url: string }>();
  const briefing = isRecord(body) ? body.briefing : undefined;
  const focus = isRecord(briefing) && Array.isArray(briefing.focus) ? briefing.focus : [];
  for (const item of focus) {
    if (!isRecord(item) || !Array.isArray(item.evidence)) continue;
    for (const evidence of item.evidence) {
      if (!isRecord(evidence) || typeof evidence.url !== "string") continue;
      const match = /^(https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/(\d+))(?:\/|$)/.exec(
        evidence.url,
      );
      if (!match?.[1] || !match[2] || runs.has(`run:${match[2]}`)) continue;
      runs.set(`run:${match[2]}`, {
        label: `${typeof evidence.label === "string" ? evidence.label : "Workflow run"} · #${match[2]}`,
        url: evidence.url,
      });
    }
  }
  return runs;
}

function StatusDot({ status }: { status: Status }) {
  return <span className="tree-dot" role="img" aria-label={status} data-status={status} />;
}

export function ProgramTree({
  store,
  route,
  onNavigate,
}: {
  store: ReturnType<typeof createWatchStore>;
  route: Route;
  onNavigate(route: Route): void;
}) {
  const snapshot = useStore(store, (state) => state.snapshot);
  const [selection, setSelection] = useState<{ id: string; route: Route }>();
  const [externalError, setExternalError] = useState("");
  async function openEvidence(url: string) {
    setExternalError("");
    try {
      if (await window.spi.openExternal(url)) return;
    } catch {
      setExternalError("Could not open GitHub link in the browser.");
      return;
    }
    setExternalError("GitHub link was refused or could not be opened.");
  }
  const body = snapshot?.body;
  const parsed = TreeStatusSchema.safeParse(
    body === undefined ? [] : isRecord(body) ? body.tree : undefined,
  );
  const tree = parsed.success ? parsed.data : [];
  const status = (id: string): Status => tree.find((node) => node.id === id)?.status ?? "unread";
  const active = selection?.route === route ? selection.id : route.id;
  const services = tree.filter((node) => node.id.startsWith("service:"));
  const runs = tree.filter((node) => node.id.startsWith("run:"));
  const runDetails = workflowRuns(body);
  const heading = (id: string, label: string) => (
    <h2 className="tree-heading" data-selection-id={id}>
      <StatusDot status={status(id)} />
      {label}
    </h2>
  );
  const entry = (id: string, label: string, target: Route) => {
    const props = {
      className: "tree-entry",
      "data-selection-id": id,
      "aria-current": active === id ? ("page" as const) : undefined,
      onClick: (event: MouseEvent<HTMLElement>) => {
        event.preventDefault();
        setSelection({ id, route: target });
        onNavigate(target);
      },
      children: (
        <>
          <StatusDot status={status(id)} />
          <span>{label}</span>
        </>
      ),
    };
    return id === target.id ? (
      <Button key={id} {...props} />
    ) : (
      <a key={id} href={`#${target.id}/${encodeURIComponent(id)}`} {...props} />
    );
  };
  const service = (node: TreeStatus[number]) =>
    entry(node.id, node.id.slice("service:".length), flow);
  return (
    <nav aria-label="Program" className="program-tree">
      {entry("today", "Today", today)}
      {heading("system", "System")}
      {entry("template", "Template", flow)}
      {entry("repositories", "Repositories", repositories)}
      {entry("releases", "Releases", releases)}
      {heading("stack", "Stack")}
      {entry("environment", "Shared environment", environment)}
      {heading("services", "Services")}
      {entry("flow", "Flow", flow)}
      {entry("horizon", "Horizon", horizon)}
      {!parsed.success && <p role="alert">Invalid program tree: {parsed.error.message}</p>}
      {services.slice(0, 5).map(service)}
      {services.length > 5 && (
        <details className="service-overflow">
          <summary>+{services.length - 5} more</summary>
          {services.slice(5).map(service)}
        </details>
      )}
      {heading("threads", "Threads")}
      <p className="tree-empty">No threads yet</p>
      <div className="tree-footer">
        {heading("runs", "Runs")}
        <h3>GitHub workflow runs</h3>
        {runs.length === 0 && <p className="tree-empty">No GitHub workflow runs</p>}
        {runs.map((node) => {
          const evidence = runDetails.get(node.id);
          return (
            <div key={node.id}>
              {entry(node.id, evidence?.label ?? `GitHub run #${node.id.slice(4)}`, environment)}
              {evidence && (
                <a
                  className="tree-entry"
                  href={evidence.url}
                  aria-label={`Open ${evidence.label} on GitHub`}
                  onClick={(event) => {
                    event.preventDefault();
                    void openEvidence(evidence.url);
                  }}
                >
                  Open on GitHub
                </a>
              )}
            </div>
          );
        })}
        {externalError && <p role="alert">{externalError}</p>}
        <h3>App runs</h3>
        <p className="tree-empty">No app runs yet</p>
        {entry("setup", "Setup", setup)}
      </div>
    </nav>
  );
}
