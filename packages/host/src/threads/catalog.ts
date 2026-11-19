// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ModelCatalogResult, ModelCatalogSchema } from "@spi-code/contracts";
import type { ZodType } from "zod";
import type { CopilotRuntime } from "../copilot/runtime.js";

type RuntimeCatalog = Awaited<ReturnType<CopilotRuntime["listModelCatalog"]>>;

const fields = ModelCatalogSchema.shape;
const modelFields = fields.models.element.shape;
const reasoningFields = modelFields.reasoning.unwrap().shape;
const policyFields = modelFields.policy.unwrap().shape;
const usageFields = fields.usage.unwrap().options[0].shape;

function known<T>(schema: ZodType<T>, value: unknown): T | "not known" {
  return schema.safeParse(value).data ?? "not known";
}

export function projectCatalog({ catalog, login, premium }: RuntimeCatalog): ModelCatalogResult {
  return {
    models: catalog.models.flatMap((model) => {
      const { data: id } = modelFields.id.safeParse(model.id);
      return id === undefined
        ? []
        : [
            {
              id,
              name: known(modelFields.name, model.name),
              multiplier: known(modelFields.multiplier, model.billing?.multiplier),
              reasoning: {
                supported: known(
                  reasoningFields.supported,
                  model.capabilities?.supports?.reasoningEffort,
                ),
                levels: known(reasoningFields.levels, model.supportedReasoningEfforts),
                defaultLevel: known(reasoningFields.defaultLevel, model.defaultReasoningEffort),
              },
              policy: {
                state: known(policyFields.state, model.policy?.state),
                reason: known(policyFields.reason, model.policy?.terms),
              },
            },
          ];
    }),
    account: known(fields.account, { login }),
    usage: premium
      ? {
          used: known(usageFields.used, premium.usedRequests),
          entitlement:
            premium.isUnlimitedEntitlement === true
              ? "unlimited"
              : known(usageFields.used, premium.entitlementRequests),
          resetAt: known(usageFields.resetAt, premium.resetDate),
        }
      : "not known",
  };
}
