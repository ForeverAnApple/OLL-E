// Line-delimited JSON wire protocol between daemon and clients.
//
// Client → server: {id, method, params}
// Server → client: one of
//   {id, ok: true, value}         — one-shot response
//   {id, ok: false, error}        — one-shot failure
//   {id, stream: "data", event}   — item in a subscription stream
//   {id, stream: "end"}           — subscription ended normally
//   {id, stream: "error", error}  — subscription errored
//
// The id space is per-connection; the client generates ids.

import type { Event } from "../bus/types.ts";

export interface Request {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export type Response =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: { message: string; code?: string } }
  | { id: number; stream: "data"; event: Event }
  | { id: number; stream: "end" }
  | { id: number; stream: "error"; error: { message: string; code?: string } };

/** Registry of known RPC methods — add here as daemon grows. */
export type Method =
  | "status"
  | "publish"
  | "tail"
  | "tail.cancel"
  | "version"
  | "team.create"
  | "team.invite"
  | "team.join"
  | "team.leave"
  | "team.status"
  | "observability.teams";

export function isRequest(v: unknown): v is Request {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === "number" && typeof r.method === "string";
}
