// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type Message,
  PROTOCOL_VERSION,
  type SetupInstallSchema,
  type SetupSigninProgress,
  type SetupSigninSchema,
  type SetupState,
  SetupStateSchema,
  type SetupToolSchema,
} from "@spi-code/contracts";
import type { DoctorView, Exec } from "@spi-code/core";
import type { Readiness } from "@spi-code/tools";
import type { z } from "zod";
import type { HostRoutes, HostSend } from "../process/port.js";
import type { SeatResult } from "./seat.js";
import { signinGh, signinGlab } from "./signin.js";
import { ghStatus, glabStatus } from "./status.js";

type ToolRow = z.infer<typeof SetupToolSchema>;
type InstallTool = z.infer<typeof SetupInstallSchema>["tool"];
type SigninRequest = z.infer<typeof SetupSigninSchema>;

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
  /** Builds the fleet's SweepService once git and gh are ready. */
  readonly createSweep: () => SetupSweep;
  readonly onError: (error: unknown) => void;
}

export const GITLAB_AREAS_REASON =
  "The GitLab areas (upstream, radar) are disabled until glab is ready.";
const GLAB_TOKEN_NEEDED = "Paste a GitLab token to sign in glab.";
const SEAT_FAILED = "The Copilot seat check did not complete.";
const COPILOT_NEEDS_GH = "Copilot signs in through gh. Install gh and sign in first.";
const WATCH_OFF = "Watch is off:";

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
  private queued: Promise<SetupState> | undefined;
  private seat: { gh: ToolRow["state"]; row: ToolRow } | undefined;
  private sweep: SetupSweep | undefined;
  private readonly signingIn = new Set<SigninRequest["tool"]>();
  private stopped = false;
  private sequence = 0;

  readonly routes: HostRoutes = {
    "setup.install": async (message) => {
      if (message.type !== "setup.install") return;
      await this.install(message.payload.tool);
    },
    "setup.signin": async (message) => {
      if (message.type !== "setup.signin") return;
      await this.signin(message.payload);
    },
  };

  constructor(private readonly options: SetupServiceOptions) {}

  /** The latest Setup state, or undefined before the first refresh completes. */
  get current(): SetupState | undefined {
    return this.state;
  }

  /** Replaces the window sender and sends it the current state, reading it first if needed. */
  connect(send: HostSend): void {
    this.sender = send;
    if (this.state) this.post(this.state);
    else void this.refresh().catch(this.options.onError);
  }

  /** Doctor for the sweep: partial while glab cannot read GitLab. */
  doctor(): DoctorView {
    const glab = this.state?.tools.find((row) => row.tool === "glab");
    if (!glab || glab.state === "ready") return { state: "clear", problems: [] };
    return { state: "partial", problems: [glab.reason ?? GITLAB_AREAS_REASON] };
  }

  /** Re-reads every tool, broadcasts a change, and starts or stops the sweep to match. */
  refresh(): Promise<SetupState> {
    if (this.queued) return this.queued;
    if (this.refreshing) {
      // Requests made during a read coalesce into one read after it.
      const queued = this.refreshing
        .catch(() => {})
        .then(() => {
          this.queued = undefined;
          return this.refresh();
        });
      this.queued = queued;
      return queued;
    }
    const run = (async () => {
      try {
        const next = await this.compute();
        const changed = JSON.stringify(next) !== JSON.stringify(this.state);
        this.state = next;
        if (changed) this.post(next);
        await this.gate(next.watchReady);
        return next;
      } finally {
        this.refreshing = undefined;
      }
    })();
    this.refreshing = run;
    return run;
  }

  /** Stops the sweep; await before closing its store. */
  async stop(): Promise<void> {
    this.stopped = true;
    const sweep = this.sweep;
    this.sweep = undefined;
    await sweep?.stop();
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

  private async signin(request: SigninRequest): Promise<void> {
    const tool = request.tool;
    if (this.signingIn.has(tool)) return;
    this.signingIn.add(tool);
    const report = (progress: SetupSigninProgress) =>
      this.emit(tool === "copilot" ? { ...progress, tool } : progress);
    try {
      if (tool === "glab") {
        if (request.tool === "glab" && request.token !== undefined) {
          await signinGlab(this.options.exec, request.token, { report });
        } else {
          report({ tool: "glab", state: "failed", reason: GLAB_TOKEN_NEEDED });
        }
      } else {
        await signinGh(this.options.exec, { report });
        this.seat = undefined;
      }
    } finally {
      this.signingIn.delete(tool);
    }
    await this.refresh();
  }

  private async compute(): Promise<SetupState> {
    const [git, gh, glab] = await Promise.all([
      this.gitRow(),
      this.toolRow("gh"),
      this.toolRow("glab"),
    ]);
    if (glab.state !== "ready") {
      glab.reason = glab.reason ? `${glab.reason} ${GITLAB_AREAS_REASON}` : GITLAB_AREAS_REASON;
    }
    const copilot = await this.copilotRow(gh);
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

  private async gitRow(): Promise<ToolRow> {
    let readiness: Readiness;
    try {
      readiness = await (await this.options.git()).readiness();
    } catch (error) {
      readiness = { state: "failed", error: errorText(error) };
    }
    const pending = installRow("git", readiness);
    if (pending) return pending;
    const version = "version" in readiness ? readiness.version : undefined;
    return readiness.state === "needs-update"
      ? { tool: "git", state: "needs-update", action: "install", ...(version ? { version } : {}) }
      : { tool: "git", state: "ready", action: null, ...(version ? { version } : {}) };
  }

  private async toolRow(tool: "gh" | "glab"): Promise<ToolRow> {
    let readiness: Readiness;
    try {
      readiness = await (await this.options.tools()).readiness(tool);
    } catch (error) {
      readiness = { state: "failed", error: errorText(error) };
    }
    const pending = installRow(tool, readiness);
    if (pending) return pending;
    const version = "version" in readiness ? readiness.version : undefined;
    const status = await (tool === "gh" ? ghStatus : glabStatus)(this.options.exec);
    const row: ToolRow = { tool, ...status, ...(version ? { version } : {}) };
    // An outdated gh still serves Watch, so needs-update shows only once it is signed in.
    if (readiness.state === "needs-update" && status.state === "ready") {
      return { ...row, state: "needs-update", action: "install" };
    }
    return row;
  }

  /** Probes the seat only when gh can supply a token, and again only once gh changes. */
  private async copilotRow(gh: ToolRow): Promise<ToolRow> {
    const usable = ["ready", "needs-update", "scope-missing", "classic-token"].includes(gh.state);
    if (!usable) {
      this.seat = undefined;
      return { tool: "copilot", state: "signed-out", action: "signin", reason: COPILOT_NEEDS_GH };
    }
    if (this.seat?.gh === gh.state) return this.seat.row;
    let row: ToolRow;
    try {
      row = seatRow(await this.options.probeSeat());
    } catch {
      row = { tool: "copilot", state: "failed", action: "attention", reason: SEAT_FAILED };
    }
    this.seat = { gh: gh.state, row };
    return row;
  }

  private async gate(ready: boolean): Promise<void> {
    if (this.stopped) return;
    if (ready && !this.sweep) {
      const sweep = this.options.createSweep();
      this.sweep = sweep;
      sweep.start().catch(this.options.onError);
    } else if (!ready && this.sweep) {
      const sweep = this.sweep;
      this.sweep = undefined;
      await sweep.stop();
    }
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
