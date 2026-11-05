// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";

// The written half of a month's release notes: what GitHub cannot say. A person
// reviews it and sets status to approved; until then every copy reads as a draft.
export const notesSchema = z
  .object({
    status: z.enum(["draft", "approved"]).default("draft"),
    headline: z.string().default(""),
    keyChanges: z.array(z.string()).default([]),
    actions: z
      .array(
        z.object({
          level: z.enum(["required", "recommended", "info"]),
          title: z.string().min(1),
          body: z.string().optional(),
          owner: z.string().optional(),
          when: z.string().optional(),
          ifSkipped: z.string().optional(),
        }),
      )
      .default([]),
    highlights: z
      .array(
        z.object({
          title: z.string().min(1),
          body: z.string().optional(),
          visual: z.enum(["coverage", "library", "commands", "steps"]).optional(),
          items: z
            .array(z.object({ text: z.string().min(1), sub: z.string().optional() }))
            .optional(),
        }),
      )
      .default([]),
    knownIssues: z
      .array(
        z.object({
          state: z.enum(["open", "resolved"]),
          title: z.string().min(1),
          body: z.string().optional(),
        }),
      )
      .default([]),
    changelog: z
      .array(
        z.object({
          area: z.string().min(1),
          items: z.array(
            z.object({
              type: z.enum(["breaking", "new", "improved", "fixed", "security"]),
              text: z.string().min(1),
            }),
          ),
        }),
      )
      .optional(),
  })
  .strict();

export type Notes = z.infer<typeof notesSchema>;

export type NotesRead =
  | { state: "missing"; path: string }
  | { state: "invalid"; path: string; error: string }
  | { state: "ok"; path: string; notes: Notes };
