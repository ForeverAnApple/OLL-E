// Permissions — v0 policy.
//
// The check is deliberately small: scope + tier, no separate capability
// tokens. Every tool carries a tier (operational default); every agent's
// scope has allowTiers / allowTools / denyTools.
//
// Rules (evaluated in order):
//   1. If denyTools contains the tool → deny.
//   2. If allowTools is present and does not contain the tool → deny.
//   3. If allowTiers is present and does not contain the tool's tier → deny.
//   4. Otherwise allow.
//
// "Undefined means unrestricted" is the convention — a brand-new agent
// with `scope: {}` can call any operational tool. Declaring allowTools
// narrows; denyTools always takes precedence.

import type { AgentScope } from "../store/schema.ts";
import type { Tier } from "../scheduler/index.ts";

export interface ToolPolicyInput {
  name: string;
  tier: Tier;
}

export type CheckResult =
  | { ok: true }
  | { ok: false; reason: string; code: "denied-by-deny" | "not-in-allow" | "tier-not-allowed" };

export function checkTool(scope: AgentScope, tool: ToolPolicyInput): CheckResult {
  if (scope.denyTools?.includes(tool.name)) {
    return { ok: false, code: "denied-by-deny", reason: `tool "${tool.name}" is in denyTools` };
  }
  if (scope.allowTools && !scope.allowTools.includes(tool.name)) {
    return { ok: false, code: "not-in-allow", reason: `tool "${tool.name}" is not in allowTools` };
  }
  if (scope.allowTiers && !scope.allowTiers.includes(tool.tier)) {
    return {
      ok: false,
      code: "tier-not-allowed",
      reason: `tier "${tool.tier}" is not in allowTiers (have: ${scope.allowTiers.join(",") || "none"})`,
    };
  }
  return { ok: true };
}

// Validates a proposed child scope against the parent's authority.
//
// Rules:
//   - Every tier in child.allowTiers must appear in parent.allowTiers
//     (if parent.allowTiers is defined; undefined = unrestricted).
//   - Every tool in child.allowTools must be permitted to the parent:
//       * not in parent.denyTools
//       * in parent.allowTools (if parent narrowed it)
//   - Child's denyTools and additional narrowing is always fine — you can
//     give a child *less* than yourself, never more.
export function narrowsScope(parent: AgentScope, child: AgentScope): CheckResult {
  if (child.allowTiers) {
    const parentTiers = parent.allowTiers;
    if (parentTiers) {
      for (const t of child.allowTiers) {
        if (!parentTiers.includes(t)) {
          return {
            ok: false,
            code: "tier-not-allowed",
            reason: `child tier "${t}" exceeds parent authority`,
          };
        }
      }
    }
  }
  if (child.allowTools) {
    for (const name of child.allowTools) {
      if (parent.denyTools?.includes(name)) {
        return {
          ok: false,
          code: "denied-by-deny",
          reason: `child tool "${name}" is parent-denied`,
        };
      }
      if (parent.allowTools && !parent.allowTools.includes(name)) {
        return {
          ok: false,
          code: "not-in-allow",
          reason: `child tool "${name}" is outside parent's allowTools`,
        };
      }
    }
  }
  return { ok: true };
}
