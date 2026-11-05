// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { EvidenceStateSchema, IdentifierSchema } from "./evidence.js";

export const SelectionIdSchema = IdentifierSchema;
export const TreeNodeSchema = z.strictObject({
  id: SelectionIdSchema,
  status: EvidenceStateSchema,
});
export const TreeStatusSchema = z.array(TreeNodeSchema);
export type TreeStatus = z.infer<typeof TreeStatusSchema>;
