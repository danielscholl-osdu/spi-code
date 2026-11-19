// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ModelCatalogResult } from "@spi-code/contracts";
import type { CopilotRuntime } from "../copilot/runtime.js";

type RuntimeCatalog = Awaited<ReturnType<CopilotRuntime["listModelCatalog"]>>;

export function projectCatalog({ catalog, login, premium }: RuntimeCatalog): ModelCatalogResult {
  return {
    models: catalog.models.map((model) => ({
      id: model.id,
      name: model.name,
      multiplier: model.billing?.multiplier ?? "not known",
      reasoning: {
        supported: model.capabilities?.supports?.reasoningEffort ?? "not known",
        levels: model.supportedReasoningEfforts ?? "not known",
        defaultLevel: model.defaultReasoningEffort ?? "not known",
      },
      policy: {
        state: model.policy?.state ?? "not known",
        reason: model.policy?.terms || "not known",
      },
    })),
    account: login ? { login } : "not known",
    usage: premium
      ? {
          used: premium.usedRequests ?? "not known",
          entitlement: premium.isUnlimitedEntitlement
            ? "unlimited"
            : premium.entitlementRequests >= 0
              ? premium.entitlementRequests
              : "not known",
          resetAt: premium.resetDate ?? "not known",
        }
      : "not known",
  };
}
