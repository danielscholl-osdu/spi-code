// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import {
  type Message,
  PROTOCOL_VERSION,
  type SetupInstallSchema,
  type SetupSigninProgress,
  type SetupSigninSchema,
  type SetupSigninStep,
  type SetupState,
  SetupStateSchema,
  type SetupToolSchema,
  type SweepStatus,
  SweepStatusSchema,
  signinRunningReason,
} from "@spi-code/contracts";
import { type Clock, type DoctorView, type Exec, systemClock } from "@spi-code/core";
import type { Readiness } from "@spi-code/tools";
import type { z } from "zod";
import type { HostRoutes, HostSend } from "../process/port.js";
import type { SeatResult } from "./seat.js";
import { signinGh, signinGlab } from "./signin.js";
import { GH_HOST, ghStatus, glabStatus } from "./status.js";

type ToolRow = z.infer<typeof SetupToolSchema>;
type InstallTool = z.infer<typeof SetupInstallSchema>["tool"];
type SigninRequest = z.infer<typeof SetupSigninSchema>;
type SigninFlow = {
  readonly requestId: string;
  readonly abort: AbortController;
  retired: boolean;
  finished: boolean;
};

/** The managed tool installer: gh and glab. */
export interface SetupTools {
  readiness(tool: string): Promise<Readiness>;
  install(tool: string, signal?: AbortSignal): Promise<void>;
}

/** The platform's git installer. */
export interface SetupGit {
  readiness(): Promise<Readiness>;
  install(signal?: AbortSignal): Promise<void>;
}

/** The SweepService surface Setup drives. */
export interface SetupSweep {
  start(): Promise<boolean>;
  stop(): Promise<void>;
}

export interface SetupServiceOptions {
  readonly exec: Exec;
  readonly tools: () => Promise<SetupTools>;
  readonly git: () => Promise<SetupGit>;
  readonly probeSeat: () => Promise<SeatResult>;
  readonly refreshBudget: (
    signal: AbortSignal,
  ) => Promise<Pick<SweepStatus, "remaining" | "resetAt">>;
  readonly sweepStatus: () => SweepStatus;
  readonly clock?: Clock;
  /** Builds the fleet's SweepService once git and gh are ready. */
  readonly createSweep: () => SetupSweep;
  readonly onError: (error: unknown) => void;
  /** How often a connected Setup re-reads every tool, so changes outside the app show. */
  readonly intervalMs?: number;
}

export const GITLAB_AREAS_REASON =
  "The GitLab areas (upstream, radar) are disabled until glab is ready.";
const GLAB_TOKEN_NEEDED = "Paste a GitLab token to sign in glab.";
const SEAT_FAILED = "The Copilot seat check did not complete.";
const BUDGET_FAILED = "The GitHub API budget check did not complete.";
const COPILOT_NEEDS_GH = "Copilot signs in through gh. Install gh and sign in first.";
const WATCH_OFF = "Watch is off:";
const REFRESH_MS = 60_000;
const PROBE_TIMEOUT_MS = 10_000;
const BUDGET_TIMEOUT_MS = 5_000;
const GH_USABLE = new Set(["ready", "needs-update", "scope-missing", "classic-token"]);

type Source = "managed" | "path";
type Found =
  | { source: Source; version: string | undefined; outdated: boolean }
  | { pending: ToolRow };

function sourceText(tool: string, source: Source, version: string | undefined): string {
  const named = version ? `${tool} ${version}` : tool;
  return source === "managed"
    ? `Using ${named} installed by SPI Code.`
    : `Using ${named} from the login-shell PATH.`;
}

function installRow(tool: InstallTool, readiness: Readiness): ToolRow | undefined {
  switch (readiness.state) {
    case "missing":
      return { tool, state: "missing", action: "install", reason: `${tool} is not installed.` };
    case "installing":
      return { tool, state: "installing", action: null, reason: `${tool} is installing.` };
    case "failed":
      return {
        tool,
        state: "failed",
        action: "install",
        reason: `${tool} could not be installed: ${readiness.error}`.slice(0, 300),
      };
    default:
      return undefined;
  }
}

function seatRow(result: SeatResult): ToolRow {
  switch (result.kind) {
    case "seat-ok":
      return { tool: "copilot", state: "ready", action: null };
    case "no-seat":
      return { tool: "copilot", state: "no-seat", action: "attention", reason: result.reason };
    case "sign-in":
      return result.classicToken
        ? { tool: "copilot", state: "classic-token", action: "attention", reason: result.reason }
        : { tool: "copilot", state: "signed-out", action: "signin", reason: result.reason };
    case "error":
      return { tool: "copilot", state: "failed", action: "attention", reason: result.reason };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Setup end to end: tool rows for the window, install and sign-in routes, and the Watch gate.
 * The fleet's SweepService runs only while git is ready and gh is signed in with its scopes.
 */
export class SetupService {
  private sender: HostSend | undefined;
  private state: SetupState | undefined;
  private refreshing: Promise<SetupState> | undefined;
  private queued: { force: boolean; promise: Promise<SetupState> } | undefined;
  private checking: Promise<SetupState> | undefined;
  private seat: { key: string; row: ToolRow } | undefined;
  private sweep: { instance: SetupSweep; failed: boolean } | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  // copilot and gh share one gh auth login flow.
  private readonly flows = new Map<"gh" | "glab", SigninFlow>();
  private stopped = false;
  private sequence = 0;

  readonly routes: HostRoutes = {
    "setup.check": async (message) => {
      if (message.type !== "setup.check") return;
      await this.check();
    },
    "setup.install": async (message) => {
      if (message.type !== "setup.install") return;
      await this.install(message.payload.tool);
    },
    "setup.signin": async (message) => {
      if (message.type !== "setup.signin") return;
      await this.signin(message.payload, message.id);
    },
    "setup.signin.cancel": (message) => {
      if (message.type !== "setup.signin.cancel") return;
      const flow = this.flows.get("gh");
      if (flow?.requestId === message.payload.requestId && !flow.finished) {
        flow.abort.abort();
      }
    },
  };

  constructor(private readonly options: SetupServiceOptions) {}

  /** The latest Setup state, or undefined before the first refresh completes. */
  get current(): SetupState | undefined {
    return this.state;
  }

  /**
   * Replaces the window sender, sends it the last state at once, and re-reads every tool so a
   * change made outside the app (a sign-out, an account switch) reaches the window and the gate.
   * Sign-in flows started for the previous connection are cancelled and retired: none of their
   * progress reaches the new one, and its next sign-in request starts a fresh flow.
   */
  connect(send: HostSend): void {
    for (const flow of this.flows.values()) {
      flow.retired = true;
      flow.abort.abort();
    }
    this.flows.clear();
    this.sender = send;
    if (this.state) this.post(this.state);
    void this.refresh().catch(this.options.onError);
    if (!this.timer && !this.stopped) {
      this.timer = setInterval(
        () => void this.refresh().catch(this.options.onError),
        this.options.intervalMs ?? REFRESH_MS,
      );
      this.timer.unref?.();
    }
  }

  /** Doctor for the sweep: partial while glab cannot read GitLab. */
  doctor(): DoctorView {
    const glab = this.state?.tools.find((row) => row.tool === "glab");
    if (!glab || glab.state === "ready") return { state: "clear", problems: [] };
    return { state: "partial", problems: [glab.reason ?? GITLAB_AREAS_REASON] };
  }

  /** Re-reads every tool, broadcasts a change, and starts or stops the sweep to match. */
  refresh(force = false): Promise<SetupState> {
    if (this.queued) {
      this.queued.force ||= force;
      return this.queued.promise;
    }
    if (this.refreshing) {
      // Requests made during a read coalesce into one read after it.
      const queued: { force: boolean; promise: Promise<SetupState> } = {
        force,
        promise: this.refreshing
          .catch(() => {})
          .then(() => {
            this.queued = undefined;
            return this.refresh(queued.force);
          }),
      };
      this.queued = queued;
      return queued.promise;
    }
    const run = (async () => {
      try {
        const computed = await this.compute(force);
        const { checkedAt: _checkedAt, ...previous } = this.state ?? {};
        const changed = JSON.stringify(computed) !== JSON.stringify(previous);
        const checkedAt = force
          ? (this.options.clock ?? systemClock).now().toISOString()
          : this.state?.checkedAt;
        const next = {
          ...computed,
          ...(checkedAt === undefined ? {} : { checkedAt }),
        };
        this.state = next;
        if (changed || force) this.post(next);
        await this.gate(next.watchReady);
        return next;
      } finally {
        this.refreshing = undefined;
      }
    })();
    this.refreshing = run;
    return run;
  }

  private check(): Promise<SetupState> {
    this.checking ??= this.refresh(true)
      .then(async (next) => {
        const gh = next.tools.find((row) => row.tool === "gh");
        if (gh && GH_USABLE.has(gh.state)) await this.refreshBudget();
        return next;
      })
      .finally(() => {
        this.checking = undefined;
      });
    return this.checking;
  }

  private async refreshBudget(): Promise<void> {
    let rate: Pick<SweepStatus, "remaining" | "resetAt">;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(new Error(BUDGET_FAILED));
        }, BUDGET_TIMEOUT_MS);
      });
      const result = await Promise.race([this.options.refreshBudget(abort.signal), timeout]);
      rate = SweepStatusSchema.pick({ remaining: true, resetAt: true }).parse({
        remaining: result.remaining,
        resetAt: result.resetAt,
      });
    } catch {
      this.options.onError(new Error(BUDGET_FAILED));
      rate = { remaining: null, resetAt: null };
    } finally {
      clearTimeout(timer);
    }
    const status = SweepStatusSchema.parse({ ...this.options.sweepStatus(), ...rate });
    this.send({
      version: PROTOCOL_VERSION,
      id: `setup-budget-${++this.sequence}`,
      kind: "event",
      type: "sweep.status",
      payload: status,
    });
  }

  /** Stops the sweep; await before closing its store. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    const sweep = this.sweep;
    this.sweep = undefined;
    await sweep?.instance.stop();
  }

  private async install(tool: InstallTool): Promise<void> {
    if (tool === "copilot") throw new Error("Copilot is not installed through Setup");
    const job = (
      tool === "git"
        ? (await this.options.git()).install()
        : (await this.options.tools()).install(tool)
    ).catch(() => {
      // The installer keeps the failure in its readiness, which the next refresh reports.
    });
    // Installers mark the tool installing before their first await, so this read shows it.
    await this.refresh();
    await job;
    if (tool === "gh") this.seat = undefined;
    await this.refresh();
  }

  private async signin(request: SigninRequest, requestId: string): Promise<void> {
    const tool = request.tool;
    const key = tool === "glab" ? "glab" : "gh";
    if (this.flows.has(key)) {
      this.emit({ requestId, tool, state: "failed", reason: signinRunningReason(key) });
      return;
    }
    const flow: SigninFlow = {
      requestId,
      abort: new AbortController(),
      retired: false,
      finished: false,
    };
    this.flows.set(key, flow);
    const signal = flow.abort.signal;
    const report = (step: SetupSigninStep) => {
      if (flow.retired || flow.finished) return;
      if (signal.aborted && step.state !== "failed") return;
      flow.finished = step.state === "failed" || step.state === "completed";
      this.emit({ ...step, tool, requestId });
    };
    try {
      if (request.tool === "glab") {
        if (request.token !== undefined) {
          await signinGlab(this.options.exec, request.token, { report, signal });
        } else {
          report({ tool: "glab", state: "failed", reason: GLAB_TOKEN_NEEDED });
        }
      } else {
        await signinGh(this.options.exec, { report, signal });
        this.seat = undefined;
      }
    } finally {
      if (this.flows.get(key) === flow) this.flows.delete(key);
    }
    await this.refresh();
  }

  private async compute(force: boolean): Promise<SetupState> {
    const [git, gh, glab] = await Promise.all([
      this.gitRow(),
      this.toolRow("gh"),
      this.toolRow("glab"),
    ]);
    if (glab.state !== "ready") {
      glab.reason = glab.reason ? `${glab.reason} ${GITLAB_AREAS_REASON}` : GITLAB_AREAS_REASON;
    }
    const copilot = await this.copilotRow(gh, force);
    const blocking = [git, gh].find((row) => row.state !== "ready" && row.state !== "needs-update");
    const disabledReason = blocking
      ? `${WATCH_OFF} ${blocking.reason ?? `${blocking.tool} is not ready.`}`
      : null;
    return SetupStateSchema.parse({
      tools: [copilot, git, gh, glab],
      watchReady: disabledReason === null,
      disabledReason,
    });
  }

  /**
   * Finds a tool the way HostExec runs it: the managed copy first, then the captured login-shell
   * PATH. A tool already on PATH serves Watch without a managed install.
   */
  private async find(tool: "git" | "gh" | "glab"): Promise<Found> {
    let readiness: Readiness;
    try {
      readiness =
        tool === "git"
          ? await (await this.options.git()).readiness()
          : await (await this.options.tools()).readiness(tool);
    } catch (error) {
      readiness = { state: "failed", error: errorText(error) };
    }
    if (readiness.state === "ready" || readiness.state === "needs-update") {
      return {
        source: "managed",
        version: readiness.version,
        outdated: readiness.state === "needs-update",
      };
    }
    const pending = installRow(tool, readiness);
    if (readiness.state === "installing" && pending) return { pending };
    const probe = await this.options.exec.runText(tool, ["--version"], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (probe.ok) {
      const version = /(\d+\.\d+\.\d+)/.exec(probe.data)?.[1];
      return { source: "path", version, outdated: false };
    }
    return { pending: pending ?? { tool, state: "missing", action: "install" } };
  }

  private async gitRow(): Promise<ToolRow> {
    const found = await this.find("git");
    if ("pending" in found) return found.pending;
    const { source, version, outdated } = found;
    const reason = sourceText("git", source, version);
    return outdated
      ? {
          tool: "git",
          state: "needs-update",
          action: "install",
          reason,
          ...(version ? { version } : {}),
        }
      : { tool: "git", state: "ready", action: null, reason, ...(version ? { version } : {}) };
  }

  private async toolRow(tool: "gh" | "glab"): Promise<ToolRow> {
    const found = await this.find(tool);
    if ("pending" in found) return found.pending;
    const { source, version, outdated } = found;
    const status = await (tool === "gh" ? ghStatus : glabStatus)(this.options.exec);
    const where = sourceText(tool, source, version);
    const row: ToolRow = {
      tool,
      ...status,
      reason: status.reason ? `${status.reason} ${where}` : where,
      ...(version ? { version } : {}),
    };
    // An outdated gh still serves Watch, so needs-update shows only once it is signed in.
    if (outdated && status.state === "ready") {
      return { ...row, state: "needs-update", action: "install" };
    }
    return row;
  }

  /** Probes a usable gh credential on change or an explicit check; otherwise uses the cached seat. */
  private async copilotRow(gh: ToolRow, force: boolean): Promise<ToolRow> {
    if (!GH_USABLE.has(gh.state)) {
      this.seat = undefined;
      return { tool: "copilot", state: "signed-out", action: "signin", reason: COPILOT_NEEDS_GH };
    }
    const key = `${gh.state}:${await this.credential()}`;
    if (!force && this.seat?.key === key) return this.seat.row;
    let row: ToolRow;
    try {
      row = seatRow(await this.options.probeSeat());
    } catch {
      row = { tool: "copilot", state: "failed", action: "attention", reason: SEAT_FAILED };
    }
    this.seat = { key, row };
    return row;
  }

  /** A fingerprint of gh's active credential, so an account switch re-probes the seat. */
  private async credential(): Promise<string> {
    const result = await this.options.exec.runText("gh", ["auth", "token", "--hostname", GH_HOST], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const token = result.ok ? result.data.trim() : "";
    return token ? createHash("sha256").update(token).digest("hex") : "none";
  }

  private async gate(ready: boolean): Promise<void> {
    if (this.stopped) return;
    if (ready) {
      if (!this.sweep) {
        this.sweep = { instance: this.options.createSweep(), failed: false };
        this.start(this.sweep);
      } else if (this.sweep.failed) {
        // A start that rejected may never have armed its timers, so try it again.
        this.sweep.failed = false;
        this.start(this.sweep);
      }
    } else if (this.sweep) {
      const sweep = this.sweep;
      this.sweep = undefined;
      await sweep.instance.stop();
    }
  }

  private start(sweep: { instance: SetupSweep; failed: boolean }): void {
    sweep.instance.start().catch((error: unknown) => {
      sweep.failed = true;
      this.options.onError(error);
    });
  }

  private post(state: SetupState): void {
    this.send({
      version: PROTOCOL_VERSION,
      id: `setup-state-${++this.sequence}`,
      kind: "event",
      type: "setup.state",
      payload: state,
    });
  }

  private emit(progress: SetupSigninProgress): void {
    this.send({
      version: PROTOCOL_VERSION,
      id: `setup-signin-${++this.sequence}`,
      kind: "event",
      type: "setup.signin.progress",
      payload: progress,
    });
  }

  private send(message: Message): void {
    try {
      this.sender?.(message);
    } catch (error) {
      this.options.onError(error);
    }
  }
}
