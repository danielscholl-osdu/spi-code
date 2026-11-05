// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { PermissionRequest } from "@github/copilot-sdk";

export type CopilotPermissionKind = PermissionRequest["kind"];

// Ported from Keelson's tool-names.ts; SPI Code gates every SDK kind.
const PERMISSION_KINDS = {
  shell: true,
  write: true,
  read: true,
  mcp: true,
  url: true,
  memory: true,
  "custom-tool": true,
  hook: true,
  "extension-management": true,
  workflow: true,
  "extension-permission-access": true,
  "extension-env-access": true,
} satisfies Record<CopilotPermissionKind, true>;

export const GATED_KINDS: ReadonlySet<string> = new Set(Object.keys(PERMISSION_KINDS));

export type ToolTier = "Read" | "Local" | "Command" | "Change" | "Consequential";
export type ToolMilestone = "M3" | "M4" | "M5" | "M6";
export interface ToolMetadata {
  readonly name: string;
  readonly tier: ToolTier;
  readonly milestone: ToolMilestone;
}

export const APPENDIX_A_TOOLS: readonly ToolMetadata[] = [
  { name: "spi_brief", tier: "Read", milestone: "M3" },
  { name: "spi_watchstand", tier: "Read", milestone: "M3" },
  { name: "spi_incidents", tier: "Read", milestone: "M3" },
  { name: "spi_line", tier: "Read", milestone: "M3" },
  { name: "spi_stack", tier: "Read", milestone: "M3" },
  { name: "spi_template", tier: "Read", milestone: "M3" },
  { name: "spi_prs", tier: "Read", milestone: "M3" },
  { name: "spi_issues", tier: "Read", milestone: "M3" },
  { name: "spi_security", tier: "Read", milestone: "M3" },
  { name: "spi_radar", tier: "Read", milestone: "M3" },
  { name: "spi_release_notes", tier: "Read", milestone: "M3" },
  { name: "read_artifact", tier: "Read", milestone: "M3" },
  { name: "run_log", tier: "Read", milestone: "M3" },
  { name: "pr_diff", tier: "Read", milestone: "M3" },
  { name: "mr_diff", tier: "Read", milestone: "M6" },
  { name: "stack_status", tier: "Read", milestone: "M6" },
  { name: "stack_info", tier: "Read", milestone: "M6" },
  { name: "flux_state", tier: "Read", milestone: "M6" },
  { name: "pod_logs", tier: "Read", milestone: "M6" },
  { name: "k8s_get", tier: "Read", milestone: "M6" },
  { name: "az_show", tier: "Read", milestone: "M6" },
  { name: "read_file", tier: "Local", milestone: "M5" },
  { name: "search_files", tier: "Local", milestone: "M5" },
  { name: "edit_file", tier: "Local", milestone: "M5" },
  { name: "worktree_diff", tier: "Local", milestone: "M5" },
  { name: "commit", tier: "Local", milestone: "M5" },
  { name: "run_command", tier: "Command", milestone: "M5" },
  { name: "push_branch", tier: "Change", milestone: "M5" },
  { name: "approve_runs", tier: "Change", milestone: "M4" },
  { name: "rerun", tier: "Change", milestone: "M4" },
  { name: "merge_pr", tier: "Change", milestone: "M4" },
  { name: "sync_template", tier: "Change", milestone: "M4" },
  { name: "sync_upstream", tier: "Change", milestone: "M4" },
  { name: "dispatch_cascade", tier: "Change", milestone: "M4" },
  { name: "rerun_cascade", tier: "Change", milestone: "M4" },
  { name: "fleet_release", tier: "Change", milestone: "M4" },
  { name: "dispatch_env_refresh", tier: "Change", milestone: "M4" },
  { name: "dispatch_env_upgrade", tier: "Change", milestone: "M4" },
  { name: "open_issue", tier: "Change", milestone: "M4" },
  // Assumed M4: appendix A names open_pr, but the milestone rows do not schedule it.
  { name: "open_pr", tier: "Change", milestone: "M4" },
  { name: "open_upstream_mr", tier: "Change", milestone: "M6" },
  { name: "comment", tier: "Change", milestone: "M4" },
  { name: "assign_coding_agent", tier: "Change", milestone: "M4" },
  // Assumed M4: appendix A names sync_all_forks, but M4 does not identify its eleven verbs.
  { name: "sync_all_forks", tier: "Consequential", milestone: "M4" },
  { name: "roll_out", tier: "Consequential", milestone: "M4" },
  { name: "start_upstream", tier: "Consequential", milestone: "M4" },
  { name: "dispatch_env_reset", tier: "Consequential", milestone: "M6" },
  { name: "stack_reconcile", tier: "Consequential", milestone: "M6" },
  { name: "maintenance_set", tier: "Consequential", milestone: "M6" },
  { name: "maintenance_clear", tier: "Consequential", milestone: "M6" },
  { name: "service_pin", tier: "Consequential", milestone: "M6" },
  { name: "service_reset", tier: "Consequential", milestone: "M6" },
];
