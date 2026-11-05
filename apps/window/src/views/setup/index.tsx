// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SetupState } from "@spi-code/contracts";
import { useState } from "react";
import { useStore } from "zustand";
import { watchStore } from "../../store/watch.js";

type Tool = SetupState["tools"][number];
const names = { copilot: "Copilot", git: "git", gh: "gh", glab: "glab" };
const labels = {
  missing: "Missing",
  installing: "Installing",
  ready: "Ready",
  "needs-update": "Needs update",
  failed: "Failed",
  "signed-out": "Signed out",
  "scope-missing": "Scope missing",
  "no-seat": "No Copilot seat",
  "classic-token": "Classic ghp_ token",
};
const actions = { install: "Install", signin: "Sign in", attention: "Attention" };

function CopyText({ label, value }: { label: string; value: string }) {
  const [status, setStatus] = useState("");
  return (
    <div>
      <label>
        {label} <input readOnly value={value} onFocus={(event) => event.target.select()} />
      </label>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setStatus("Copied");
          } catch {
            setStatus("Could not copy. Select and copy the text manually.");
          }
        }}
      >
        Copy {label}
      </button>
      {status && <p role="status">{status}</p>}
    </div>
  );
}

function ToolRow({ tool }: { tool: Tool }) {
  const progress = useStore(watchStore, (state) =>
    tool.tool === "git" ? undefined : (state.signin[tool.tool] ?? state.signinOutcome[tool.tool]),
  );
  const [attention, setAttention] = useState(false);
  const busy =
    tool.state === "installing" ||
    (progress && ["starting", "device-code", "waiting"].includes(progress.state));
  const reason =
    tool.reason ??
    (tool.state === "classic-token"
      ? "A classic ghp_ token cannot authenticate Copilot. Use the gh OAuth browser sign-in."
      : tool.state === "no-seat"
        ? "This account has no Copilot seat. Check its Copilot subscription."
        : "Check this tool's configuration and try again.");
  return (
    <section aria-label={names[tool.tool]}>
      <h2>{names[tool.tool]}</h2>
      <p>
        {labels[tool.state]}
        {tool.version && ` (${tool.version})`}
      </p>
      {tool.reason && !attention && <p>{tool.reason}</p>}
      {!!tool.missingScopes?.length && <p>Required scopes: {tool.missingScopes.join(", ")}</p>}
      {tool.action && !(tool.tool === "git" && tool.action === "signin") && (
        <button
          type="button"
          disabled={!!busy}
          aria-expanded={tool.action === "attention" ? attention : undefined}
          onClick={() => {
            if (tool.action === "attention") setAttention(!attention);
            else if (tool.action === "install")
              watchStore.getState().requestSetup("setup.install", tool.tool);
            else if (tool.action === "signin" && tool.tool !== "git")
              watchStore.getState().requestSetup("setup.signin", tool.tool);
            else throw new Error(`Unsupported setup action for ${tool.tool}`);
          }}
        >
          {actions[tool.action]}
        </button>
      )}
      {attention && <p role="status">{reason}</p>}
      {progress?.state === "device-code" && (
        <div>
          <p>Open the URL in your browser and enter the device code.</p>
          <CopyText
            key={`code:${progress.deviceCode}`}
            label="Device code"
            value={progress.deviceCode}
          />
          <CopyText key={`url:${progress.url}`} label="Sign-in URL" value={progress.url} />
        </div>
      )}
      {progress && progress.state !== "device-code" && (
        <p role={progress.state === "failed" ? "alert" : "status"}>
          {progress.state === "failed" ? progress.reason : `Sign-in ${progress.state}`}
        </p>
      )}
    </section>
  );
}

export default function Setup() {
  const setup = useStore(watchStore, (state) => state.setup);
  const sweep = useStore(watchStore, (state) => state.sweep);
  const low =
    sweep?.remaining != null && sweep.floor !== undefined && sweep.remaining < sweep.floor;
  return (
    <>
      <h1>Setup</h1>
      {!setup ? (
        <p role="status">Checking Watch tools...</p>
      ) : (
        <>
          {!setup.watchReady && <p role="status">{setup.disabledReason}</p>}
          {Object.entries(names).map(([id, name]) => {
            const tool = setup.tools.find((item) => item.tool === id);
            return tool ? (
              <ToolRow key={id} tool={tool} />
            ) : (
              <section key={id} aria-label={name}>
                <h2>{name}</h2>
                <p>Checking...</p>
              </section>
            );
          })}
        </>
      )}
      <section aria-label="GraphQL budget">
        <h2>GraphQL budget</h2>
        <p role={low ? "alert" : "status"}>
          {sweep?.remaining == null ? "Points left: unknown" : `Points left: ${sweep.remaining}`}
          {low && ` - below the pacer floor (${sweep.floor})`}
        </p>
        {sweep?.floor === undefined && <p>Pacer floor not reported by the host.</p>}
        {sweep?.resetAt && (
          <p>
            Resets at <time dateTime={sweep.resetAt}>{sweep.resetAt}</time>
          </p>
        )}
        {sweep?.deferredAreas.map(({ area, reason }) => (
          <p key={area}>
            {area}: {reason}
          </p>
        ))}
      </section>
    </>
  );
}
