// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { ObservedAtSchema } from "./evidence.js";

const WorkLink = z.strictObject({ number: z.int().positive(), url: z.string() });
const WorkRow = WorkLink.extend({
  title: z.string(),
  author: z.string().optional(),
  createdAt: ObservedAtSchema.optional(),
});

const Pull = WorkRow.extend({
  head: z.string(),
  base: z.string(),
  companion: WorkLink.optional(),
});
const OpenPull = Pull.extend({
  state: z.literal("open"),
  draft: z.boolean(),
  labels: z.array(z.string()),
  checks: z.strictObject({
    state: z.enum(["failing", "pending", "passing"]).nullable(),
    passed: z.int().nonnegative(),
    failed: z.array(z.string()),
  }),
  gate: z.string().optional(),
  waiting: z.literal(true).optional(),
  carries: z.string().optional(),
  reviewers: z.array(z.string()).optional(),
  reviewersCut: z.literal(true).optional(),
});
const PastPull = Pull.extend({
  state: z.enum(["merged", "closed"]),
  finishedAt: ObservedAtSchema.optional(),
});
const Issue = WorkRow.extend({
  state: z.enum(["open", "closed"]),
  labels: z.array(z.string()),
  closedAt: ObservedAtSchema.optional(),
  tracks: WorkLink.optional(),
  halt: z.string().optional(),
});
const count = z.int().nonnegative().nullable();

export const ServiceWorkSchema = z.strictObject({
  pulls: z.strictObject({
    count,
    partial: z.boolean(),
    pastRead: z.boolean(),
    rows: z.array(z.discriminatedUnion("state", [OpenPull, PastPull])),
  }),
  issues: z.strictObject({
    count,
    partial: z.boolean(),
    closedRead: z.boolean(),
    rows: z.array(Issue),
  }),
});

export type ServiceWork = z.infer<typeof ServiceWorkSchema>;
export type ServicePull = ServiceWork["pulls"]["rows"][number];
export type ServiceIssue = ServiceWork["issues"]["rows"][number];
