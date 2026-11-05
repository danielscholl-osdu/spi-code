// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { ActionItem } from "./action-item.js";

export type { ActionItem } from "./action-item.js";

export const ACT_ACTION = "act";

export const targetSchema = z
  .object({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    kind: z.enum(["pr", "run", "issue", "repo", "workflow"]),
    number: z.number().int().positive().optional(),
    pr: z.number().int().positive().optional(),
    sha: z.string().optional(),
    state: z.string().optional(),
    workflow: z
      .string()
      .regex(/^[\w.-]+\.ya?ml$/)
      .optional(),
    issue: z.number().int().positive().optional(),
    label: z.string().min(1),
  })
  .strict();
export type Target = z.infer<typeof targetSchema>;

export const bindingSchema = z
  .object({
    verb: z.string().min(1),
    item: z.string().min(1),
    swept: z.string().min(1),
    targets: z.array(targetSchema).min(1),
  })
  .strict();
export type Binding = z.infer<typeof bindingSchema>;

export interface Verb {
  id: string;
  label: string;
  command(target: Target): string[];
  followUp?(target: Target): string[];
  paced?: boolean;
}

export function writeBlocked(sweptAt: string | undefined, scopes: string[] | undefined) {
  if (!sweptAt) return "no sweep has read GitHub yet";
  if (scopes && !scopes.includes("repo")) {
    return "gh's token lacks the repo scope; run gh auth refresh -s repo";
  }
  return undefined;
}

export interface VerbRegistry {
  registerVerb(verb: Verb): () => void;
  verbOf(id: string): Verb | undefined;
}

export function createRegistry(): VerbRegistry {
  const verbs = new Map<string, Verb>();
  return {
    registerVerb(verb) {
      if (verbs.has(verb.id)) throw new Error(`verb ${verb.id} is already registered`);
      verbs.set(verb.id, verb);
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        verbs.delete(verb.id);
      };
    },
    verbOf(id) {
      return verbs.get(id);
    },
  };
}

function quote(arg: string): string {
  return /^[\w./:=@#-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

export function commandText(verb: Verb, target: Target): string {
  const line = (args: string[]) => ["gh", ...args].map(quote).join(" ");
  const then = verb.followUp?.(target);
  return then ? `${line(verb.command(target))} && ${line(then)}` : line(verb.command(target));
}

export interface ButtonOptions {
  primary?: boolean;
  disabled?: string;
  label?: string;
  pending?: string;
  title?: string;
  detail?: string[];
  subject?: { value: string; label: string };
}

export function verbAction(
  verb: Verb,
  binding: Omit<Binding, "verb">,
  opts: ButtonOptions = {},
): ActionItem {
  const n = binding.targets.length;
  const commands = binding.targets.map((t) => commandText(verb, t));
  const label = opts.label ?? (n > 1 ? `${verb.label} ${n}` : verb.label);
  return {
    type: ACT_ACTION,
    label,
    pendingLabel: opts.pending ?? `${verb.label}…`,
    ...(opts.primary ? { tone: "brand" as const } : {}),
    binding: { ...binding, verb: verb.id },
    ...(opts.disabled
      ? { disabled: true, reason: opts.disabled }
      : {
          confirm: {
            title:
              opts.title ??
              (n > 1
                ? `${verb.label} · ${n} targets`
                : `${verb.label} · ${binding.targets[0]?.label}`),
            body: [
              ...(opts.detail?.length ? [opts.detail.join(" ")] : []),
              `Calls: ${commands.join("; ")}.`,
              "Each target is read again first; one that changed since the board drew it is skipped and named in the result.",
            ].join("\n\n"),
            confirmLabel: label,
            ...(opts.subject
              ? { irreversible: true, subject: opts.subject.value, label: opts.subject.label }
              : {}),
          },
        }),
  };
}
