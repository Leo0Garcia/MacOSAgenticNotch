// The four hard limits from docs/DESIGN.md section 3, and how a denial reads.

export type RuleId =
  | "no-money"
  | "no-real-consequences"
  | "no-contacting-as-leo"
  | "no-harm";

export const RULE_IDS: readonly RuleId[] = [
  "no-money",
  "no-real-consequences",
  "no-contacting-as-leo",
  "no-harm",
];

export const SAFE_ALTERNATIVE: Record<RuleId, string> = {
  "no-money":
    "I can look it up read-only, summarise it, or set a reminder for you to do it yourself",
  "no-real-consequences":
    "I can summarise what's needed, draft what to enter for you to submit yourself, or set a reminder",
  "no-contacting-as-leo":
    "I can write a draft and show it to you to send yourself",
  "no-harm":
    "I can show you the exact command to run yourself, or work on a copy inside ~/Jarvis",
};

export interface Denial {
  rule: RuleId;
  /** One line, no trailing period. */
  reason: string;
}

export function deny(rule: RuleId, reason: string): Denial {
  // \u0000SUBST\u0000 marks a $(...) the shell parser couldn't expand
  return { rule, reason: reason.replace(/\u0000SUBST\u0000/g, "$(...)").replace(/[\u0000-\u001f]/g, " ") };
}

/** The permissionDecisionReason Claude sees and relays to Leo. */
export function formatReason(d: Denial): string {
  return `guard:${d.rule}: ${d.reason}. Safe alternative: ${SAFE_ALTERNATIVE[d.rule]}.`;
}
