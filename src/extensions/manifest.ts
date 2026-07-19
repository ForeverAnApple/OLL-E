import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Manifest } from "./types.ts";

export function readManifest(dir: string): Manifest {
  const raw = readFileSync(join(dir, "manifest.json"), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return validateManifest(parsed, dir);
}

/** Known manifest keys. `config` is on the list — it's a valid, unparsed
 *  passthrough (extensions re-read manifest.json raw for it), so it must not
 *  trigger an unknown-key warning even though it never lands in Manifest. */
const KNOWN_KEYS = new Set([
  "name",
  "version",
  "description",
  "author",
  "secrets",
  "capabilities",
  "callsTools",
  "eventReads",
  "eventWrites",
  "catalog",
  "egress",
  "requiresHost",
  "config",
]);

/** Throwing wrapper — the historical signature. Discards warnings; callers
 *  that want them use `validateManifestWithWarnings`. */
export function validateManifest(value: unknown, context = "(unknown)"): Manifest {
  return validateManifestWithWarnings(value, context).manifest;
}

/** Validate a manifest, collecting non-fatal warnings (unknown keys, a
 *  malformed `catalog`) instead of throwing on them. Genuinely invalid
 *  manifests (not an object, bad name, missing version) still throw. */
export function validateManifestWithWarnings(
  value: unknown,
  context = "(unknown)",
): { manifest: Manifest; warnings: string[] } {
  const warnings: string[] = [];
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
  for (const key of Object.keys(v)) {
    if (!KNOWN_KEYS.has(key)) {
      warnings.push(`manifest[${context}]: unknown key "${key}" (ignored)`);
    }
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
  if (v.catalog !== undefined) {
    const c = v.catalog;
    if (
      c &&
      typeof c === "object" &&
      typeof (c as Record<string, unknown>).tagline === "string" &&
      typeof (c as Record<string, unknown>).blurb === "string"
    ) {
      const cat = c as { tagline: string; blurb: string; tools?: unknown };
      const parsed: Manifest["catalog"] = { tagline: cat.tagline, blurb: cat.blurb };
      if (
        cat.tools &&
        typeof cat.tools === "object" &&
        Object.values(cat.tools).every((x) => typeof x === "string")
      ) {
        parsed.tools = cat.tools as Record<string, string>;
      }
      out.catalog = parsed;
    } else {
      warnings.push(
        `manifest[${context}]: catalog is malformed (needs string "tagline" and "blurb") — dropped`,
      );
    }
  }
  if (v.egress !== undefined) {
    if (Array.isArray(v.egress)) {
      const entries: NonNullable<Manifest["egress"]> = [];
      for (const [i, raw] of v.egress.entries()) {
        const entry = parseEgressEntry(raw);
        if (entry) entries.push(entry);
        else warnings.push(`manifest[${context}]: egress[${i}] is malformed (needs string[] "hosts") — dropped`);
      }
      if (entries.length > 0) out.egress = entries;
    } else {
      warnings.push(`manifest[${context}]: egress must be an array — dropped`);
    }
  }
  if (typeof v.requiresHost === "boolean") out.requiresHost = v.requiresHost;
  else if (v.requiresHost !== undefined) {
    warnings.push(`manifest[${context}]: requiresHost must be a boolean — dropped`);
  }
  return { manifest: out, warnings };
}

/** Parse one egress entry, returning null if malformed. `hosts` is required
 *  and must be a non-empty string[]; `secrets` and `mode` are optional and a
 *  bad value drops just that field, not the whole entry. */
function parseEgressEntry(raw: unknown): NonNullable<Manifest["egress"]>[number] | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.hosts) || r.hosts.length === 0 || !r.hosts.every((x) => typeof x === "string")) {
    return null;
  }
  const entry: NonNullable<Manifest["egress"]>[number] = { hosts: r.hosts as string[] };
  if (Array.isArray(r.secrets) && r.secrets.every((x) => typeof x === "string")) {
    entry.secrets = r.secrets as string[];
  }
  if (r.mode === "placeholder" || r.mode === "guest") entry.mode = r.mode;
  return entry;
}
