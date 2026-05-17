import type { Event } from "../bus/types.ts";

export const MEMORY_EVENT_TYPES = new Set(["memory.wrote", "memory.forgotten"]);

type Payload = Record<string, unknown>;

export interface TeamScopeViolation {
  reason: "payload-team-mismatch" | "memory-non-team-scope";
  payloadTeamId: string | null;
  scope: string | null;
}

function payloadOf(event: Event): Payload | null {
  return event.payload && typeof event.payload === "object"
    ? (event.payload as Payload)
    : null;
}

function stringField(payload: Payload, field: string): string | null {
  const value = payload[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function isMemoryEvent(event: Event): boolean {
  return MEMORY_EVENT_TYPES.has(event.type);
}

export function routableTeamId(event: Event): string | null {
  const payload = payloadOf(event);
  if (!payload) return null;
  if (!isMemoryEvent(event)) return stringField(payload, "teamId");

  if (payload.scope !== "team") return null;
  return stringField(payload, "scopeRef") ?? stringField(payload, "teamId");
}

export function validateTeamScope(
  event: Event,
  teamId: string,
): { ok: true } | ({ ok: false } & TeamScopeViolation) {
  const payload = payloadOf(event);
  if (!payload) {
    return {
      ok: false,
      reason: "payload-team-mismatch",
      payloadTeamId: null,
      scope: null,
    };
  }

  if (isMemoryEvent(event)) {
    const scope = typeof payload.scope === "string" ? payload.scope : null;
    if (scope !== "team") {
      return {
        ok: false,
        reason: "memory-non-team-scope",
        payloadTeamId: stringField(payload, "teamId"),
        scope,
      };
    }
  }

  const payloadTeamId = routableTeamId(event);
  if (payloadTeamId !== teamId) {
    return {
      ok: false,
      reason: "payload-team-mismatch",
      payloadTeamId,
      scope: typeof payload.scope === "string" ? payload.scope : null,
    };
  }

  return { ok: true };
}
