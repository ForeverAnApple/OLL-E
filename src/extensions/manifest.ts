import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Manifest } from "./types.ts";

export function readManifest(dir: string): Manifest {
  const raw = readFileSync(join(dir, "manifest.json"), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return validateManifest(parsed, dir);
}

export function validateManifest(value: unknown, context = "(unknown)"): Manifest {
  if (!value || typeof value !== "object") {
    throw new Error(`manifest[${context}]: not an object`);
  }
  const v = value as Record<string, unknown>;
  if (typeof v.name !== "string" || !/^[a-z0-9][a-z0-9-_]*$/.test(v.name)) {
    throw new Error(`manifest[${context}]: invalid name`);
  }
  if (typeof v.version !== "string") {
    throw new Error(`manifest[${context}]: version required`);
  }
  const out: Manifest = { name: v.name, version: v.version };
  if (typeof v.description === "string") out.description = v.description;
  if (typeof v.author === "string") out.author = v.author;
  if (Array.isArray(v.secrets) && v.secrets.every((x) => typeof x === "string")) {
    out.secrets = v.secrets as string[];
  }
  if (Array.isArray(v.capabilities) && v.capabilities.every((x) => typeof x === "string")) {
    out.capabilities = v.capabilities as string[];
  }
  if (Array.isArray(v.callsTools) && v.callsTools.every((x) => typeof x === "string")) {
    out.callsTools = v.callsTools as string[];
  }
  if (Array.isArray(v.eventReads) && v.eventReads.every((x) => typeof x === "string")) {
    out.eventReads = v.eventReads as string[];
  }
  if (Array.isArray(v.eventWrites) && v.eventWrites.every((x) => typeof x === "string")) {
    out.eventWrites = v.eventWrites as string[];
  }
  return out;
}
