// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type SetupSigninProgress,
  SetupSigninSchema,
  type SetupState,
  signinRunningReason,
} from "@spi-code/contracts";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { watchStore } from "../../store/watch.js";
import { Time } from "../../time.js";

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
const actions = { install: "Install", signin: "Sign in", attention: "Check again" };

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

type Progress = SetupSigninProgress | undefined;
const GLAB_FAILED = "glab sign-in failed. Check the GitLab token and try again.";
const GLAB_UNSENT = "Could not send the sign-in to SPI Code. Try again.";
const SETUP_UNSENT = "Could not send the request to SPI Code.";

function GlabSignin({ busy, progress }: { busy: boolean; progress: Progress }) {
  const field = useRef<HTMLInputElement>(null);
  const [filled, setFilled] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState<{ progress: Progress } | null>(null);
  const disabled = busy || (sent !== null && sent.progress === progress);
  useEffect(() => {
    if (progress && ["starting", "device-code", "waiting"].includes(progress.state)) return;
    if (field.current) field.current.value = "";
    setFilled(false);
  }, [progress]);
  return (
    <form
      aria-label="glab sign-in"
      onSubmit={async (event) => {
        event.preventDefault();
        const input = field.current;
        if (!input || disabled) return;
        const token = input.value.trim();
        input.value = "";
        setFilled(false);
        if (!token) return;
        const parsed = SetupSigninSchema.safeParse({ tool: "glab", token });
        if (!parsed.success) {
          setError(parsed.error.issues[0]?.message ?? "Enter a valid GitLab token.");
          return;
        }
        try {
          await watchStore.getState().requestSetup("setup.signin", "glab", token);
        } catch {
          setError(GLAB_UNSENT);
          return;
        }
        setError("");
        setSent({ progress });
      }}
    >
      <label>
        GitLab token{" "}
        <input
          ref={field}
          type="password"
          name="glab-token"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          onInput={(event) => setFilled(event.currentTarget.value.trim() !== "")}
        />
      </label>
      <button type="submit" disabled={disabled || !filled}>
        {actions.signin}
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

function ToolRow({ tool }: { tool: Tool }) {
  const progress = useStore(watchStore, (state) =>
    tool.tool === "git" ? undefined : (state.signin[tool.tool] ?? state.signinOutcome[tool.tool]),
  );
  const epoch = useStore(watchStore, (state) => state.epoch);
  const pending = useStore(
    watchStore,
    (state) => tool.tool !== "git" && state.signinRequest[tool.tool] !== undefined,
  );
  const [failure, setFailure] = useState<{
    epoch: number;
    action: Tool["action"];
  } | null>(null);
  const sends = useRef({ sequence: 0, pending: false });
  const [sending, setSending] = useState(false);
  useEffect(() => {
    sends.current.sequence++;
    sends.current.pending = false;
    setSending(false);
    setFailure((current) =>
      current?.epoch === epoch && current.action === tool.action ? current : null,
    );
    return () => {
      sends.current.sequence++;
    };
  }, [epoch, tool.action]);
  const error =
    failure?.epoch === epoch && failure.action === tool.action ? SETUP_UNSENT : undefined;
  const busy =
    tool.state === "installing" ||
    sending ||
    pending ||
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
      {(error || tool.reason || tool.action === "attention") && (
        <p role={error ? "alert" : undefined}>{error ?? reason}</p>
      )}
      {!!tool.missingScopes?.length && <p>Required scopes: {tool.missingScopes.join(", ")}</p>}
      {tool.tool === "glab" && tool.action === "signin" && (
        <GlabSignin key={epoch} busy={!!busy} progress={progress} />
      )}
      {tool.action && !(tool.action === "signin" && ["git", "glab"].includes(tool.tool)) && (
        <button
          type="button"
          disabled={!!busy}
          onClick={async () => {
            if (busy || sends.current.pending) return;
            const sequence = ++sends.current.sequence;
            sends.current.pending = true;
            setSending(true);
            setFailure(null);
            try {
              if (tool.action === "attention")
                await watchStore.getState().requestSetup("setup.check");
              else if (tool.action === "install")
                await watchStore.getState().requestSetup("setup.install", tool.tool);
              else if (tool.action === "signin" && tool.tool !== "git" && tool.tool !== "glab")
                await watchStore.getState().requestSetup("setup.signin", tool.tool);
              else throw new Error(`Unsupported setup action for ${tool.tool}`);
            } catch {
              if (sends.current.sequence === sequence) setFailure({ epoch, action: tool.action });
            } finally {
              if (sends.current.sequence === sequence) {
                sends.current.pending = false;
                setSending(false);
              }
            }
          }}
        >
          {error ? "Try again" : actions[tool.action]}
        </button>
      )}
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
          {progress.state !== "failed"
            ? `Sign-in ${progress.state}`
            : progress.tool === "glab" && progress.reason !== signinRunningReason("glab")
              ? GLAB_FAILED
              : progress.reason}
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
            Resets at <Time at={sweep.resetAt} />
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
