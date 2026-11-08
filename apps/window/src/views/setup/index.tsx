// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type SetupSigninProgress,
  SetupSigninSchema,
  type SetupState,
  signinRunningReason,
} from "@spi-code/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { watchStore } from "../../store/watch.js";
import { Time } from "../../time.js";
import "./setup.css";

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

function DeviceCode({ code, url }: { code: string; url: string }) {
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  return (
    <div className="readiness-more">
      <label className="readiness-code-label">
        Code{" "}
        <input
          className="readiness-code"
          aria-label="Device code"
          readOnly
          value={code}
          onFocus={(event) => event.target.select()}
        />
      </label>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(code);
            setStatus("Copied");
          } catch {
            setStatus("Could not copy. Select and copy the text manually.");
          }
        }}
      >
        Copy code
      </button>
      <button
        type="button"
        className="readiness-primary"
        onClick={async () => {
          setError("");
          try {
            if (url !== "https://github.com/login/device" || !(await window.spi.openExternal(url)))
              setError("Could not open github.com in your browser.");
          } catch {
            setError("Could not open github.com in your browser.");
          }
        }}
      >
        Open github.com
      </button>
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

type Progress = SetupSigninProgress | undefined;
const GLAB_FAILED = "glab sign-in failed. Check the GitLab token and try again.";
const GLAB_UNSENT = "Could not send the sign-in to SPI Code. Try again.";
const SETUP_UNSENT = "Could not send the request to SPI Code.";

export function ReadinessCheck() {
  const checkedAt = useStore(watchStore, (state) => state.setup?.checkedAt);
  const checking = useStore(watchStore, (state) => state.setupCheckRequest !== null);
  const epoch = useStore(watchStore, (state) => state.epoch);
  const hostError = useStore(watchStore, (state) => state.setupCheckError);
  const [failure, setFailure] = useState<number | null>(null);
  return (
    <>
      {checkedAt && (
        <span className="readiness-checked">
          Checked <Time at={checkedAt} />
        </span>
      )}
      <button
        type="button"
        className="readiness-check"
        disabled={checking}
        onClick={async () => {
          if (watchStore.getState().setupCheckRequest !== null) return;
          setFailure(null);
          try {
            await watchStore.getState().requestSetup("setup.check");
          } catch {
            if (watchStore.getState().epoch === epoch) setFailure(epoch);
          }
        }}
      >
        Check all
      </button>
      {(hostError || failure === epoch) && (
        <span className="readiness-check-error" role="alert">
          {hostError
            ? `${hostError}${hostError === SETUP_UNSENT ? " Try again." : ""}`
            : `${SETUP_UNSENT} Try again.`}
        </span>
      )}
    </>
  );
}

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
      className="readiness-more readiness-token"
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
      <button type="submit" className="readiness-primary" disabled={disabled || !filled}>
        {error || progress?.state === "failed" ? "Try again" : "Save"}
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
  useLayoutEffect(() => {
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
  const running = progress && ["starting", "device-code", "waiting"].includes(progress.state);
  const requestId =
    tool.tool === "git" ? undefined : watchStore.getState().signinRequest[tool.tool];
  const signinError =
    progress?.state === "failed"
      ? progress.reason === signinRunningReason("glab") ||
        progress.reason === signinRunningReason("gh")
        ? progress.reason
        : progress.tool === "glab"
          ? GLAB_FAILED
          : "Sign-in did not finish. Try again."
      : undefined;
  const reason =
    tool.reason ??
    (tool.state === "classic-token"
      ? "A classic ghp_ token cannot authenticate Copilot. Use the gh OAuth browser sign-in."
      : tool.state === "no-seat"
        ? "This account has no Copilot seat. Check its Copilot subscription."
        : "Check this tool's configuration and try again.");
  async function sendRequest(request: () => void | Promise<void>) {
    if (sends.current.pending) return;
    const sequence = ++sends.current.sequence;
    sends.current.pending = true;
    setSending(true);
    setFailure(null);
    try {
      await request();
    } catch {
      if (sends.current.sequence === sequence) setFailure({ epoch, action: tool.action });
    } finally {
      if (sends.current.sequence === sequence) {
        sends.current.pending = false;
        setSending(false);
      }
    }
  }
  return (
    <fieldset className="readiness-row" aria-label={names[tool.tool]}>
      <h3 className="readiness-name">{names[tool.tool]}</h3>
      <p
        className="readiness-chip"
        data-state={error || signinError ? "failed" : running ? "signed-out" : tool.state}
      >
        {error || signinError ? "Attention" : running ? "Sign in" : labels[tool.state]}
      </p>
      <div className="readiness-why">
        {error ? (
          <p role="alert">{error}</p>
        ) : (
          <>
            <p>
              {running
                ? "Waiting for you to finish signing in."
                : (tool.reason ?? tool.version ?? (tool.action ? reason : null))}
            </p>
            {!!tool.missingScopes?.length && (
              <p>Required scopes: {tool.missingScopes.join(", ")}</p>
            )}
          </>
        )}
      </div>
      {running && progress.state !== "starting" && tool.tool !== "glab" && requestId ? (
        <button
          type="button"
          className="readiness-action"
          disabled={sending}
          onClick={() =>
            sendRequest(() => watchStore.getState().requestSetup("setup.signin.cancel", requestId))
          }
        >
          {error ? "Try again" : "Cancel"}
        </button>
      ) : tool.state !== "ready" &&
        tool.state !== "installing" &&
        tool.action &&
        !(tool.action === "signin" && ["git", "glab"].includes(tool.tool)) ? (
        <button
          type="button"
          className="readiness-action"
          disabled={!!busy}
          onClick={() => {
            if (busy) return;
            return sendRequest(() => {
              if (tool.action === "attention")
                return watchStore.getState().requestSetup("setup.check");
              if (tool.action === "install")
                return watchStore.getState().requestSetup("setup.install", tool.tool);
              if (tool.action === "signin" && tool.tool !== "git" && tool.tool !== "glab")
                return watchStore.getState().requestSetup("setup.signin", tool.tool);
              throw new Error(`Unsupported setup action for ${tool.tool}`);
            });
          }}
        >
          {error || signinError || tool.state === "failed" ? "Try again" : actions[tool.action]}
        </button>
      ) : (
        <span />
      )}
      {tool.tool === "glab" && tool.action === "signin" && tool.state !== "ready" && (
        <GlabSignin key={epoch} busy={!!busy} progress={progress} />
      )}
      {tool.state === "installing" && (
        <div className="readiness-more" role="status">
          Installing {names[tool.tool]}...
          <progress aria-label={`Installing ${names[tool.tool]}`} />
        </div>
      )}
      {progress?.state === "device-code" && (
        <DeviceCode key={progress.requestId} code={progress.deviceCode} url={progress.url} />
      )}
      {progress && progress.state !== "device-code" && (
        <div className="readiness-more">
          <p role={signinError ? "alert" : "status"}>
            {signinError ?? `Sign-in ${progress.state}`}
          </p>
        </div>
      )}
    </fieldset>
  );
}

export default function Setup({ inSettings = false }: { inSettings?: boolean }) {
  const setup = useStore(watchStore, (state) => state.setup);
  const sweep = useStore(watchStore, (state) => state.sweep);
  const low =
    sweep?.remaining != null && sweep.floor !== undefined && sweep.remaining < sweep.floor;
  return (
    <>
      {!inSettings && (
        <header className="readiness-header">
          <h1>Setup</h1>
          <ReadinessCheck />
        </header>
      )}
      {!setup ? (
        <p role="status">Checking Watch tools...</p>
      ) : (
        !setup.watchReady && <p role="status">{setup.disabledReason}</p>
      )}
      <h2 className="readiness-group-title">Watch · read the program</h2>
      <div className="readiness-group">
        {Object.entries(names).map(([id, name]) => {
          const tool = setup?.tools.find((item) => item.tool === id);
          return tool ? (
            <ToolRow key={id} tool={tool} />
          ) : (
            <fieldset key={id} className="readiness-row" aria-label={name}>
              <h3 className="readiness-name">{name}</h3>
              <p className="readiness-chip">Checking</p>
              <span />
              <span />
            </fieldset>
          );
        })}
        <fieldset className="readiness-row" aria-label="GitHub API budget">
          <h3 className="readiness-name">GitHub API budget</h3>
          <p
            className="readiness-chip"
            data-state={sweep?.remaining == null || low ? "scope-missing" : "ready"}
          >
            {sweep?.remaining == null ? "Unknown" : low ? "Attention" : "Ready"}
          </p>
          <div className="readiness-why">
            <p role={low ? "alert" : "status"}>
              {sweep?.remaining == null
                ? "Points left: unknown"
                : `Points left: ${sweep.remaining}`}
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
          </div>
          <span />
        </fieldset>
      </div>
    </>
  );
}
