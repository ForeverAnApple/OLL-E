// Minimal structural validation of an LLM-emitted tool input against the
// tool's JSON Schema. The host normally hands `inputSchema` straight to the
// vendor and does not introspect it; here it introspects just enough to turn
// a wrong-shaped call into a legible, self-correcting error instead of letting
// it fall into execute() and throw an opaque runtime error (e.g. a Node
// `path.join(base, undefined)` TypeError leaked verbatim to the model).
//
// This matters most for *blind calls*: the catalog lists every tool by name,
// so the model can call a deferred tool whose schema it never loaded, guessing
// the parameter names. A guess that misses ("file" instead of "path") should
// teach the model the shape — "missing required property: path" plus the
// schema — not crash. That is the difference between a constraint that feels
// like physics and one that reads as a system glitch.
//
// Deliberately a tiny subset of JSON Schema: required properties,
// `additionalProperties: false`, and primitive type checks on declared
// properties. Deep/semantic constraints are left to the vendor and to a
// tool's own optional `validate()`.

/** Returns a list of human-legible problems; empty means the input is
 *  structurally acceptable. Permissive by design — an unrecognized or
 *  non-object schema validates to no problems rather than guessing. */
export function validateToolInput(
  schema: Record<string, unknown> | undefined,
  input: unknown,
): string[] {
  const problems: string[] = [];
  if (!schema || typeof schema !== "object" || schema.type !== "object") {
    return problems;
  }

  // No-arg tools are routinely called with undefined/null input; treat that
  // as an empty object so required-property checks (if any) still fire while
  // a legitimately argument-free call passes cleanly.
  const raw = input === undefined || input === null ? {} : input;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    problems.push(`expected an object input, got ${describe(raw)}`);
    return problems;
  }
  const obj = raw as Record<string, unknown>;

  const props =
    schema.properties && typeof schema.properties === "object"
      ? (schema.properties as Record<string, Record<string, unknown>>)
      : {};

  const required = Array.isArray(schema.required)
    ? (schema.required as string[])
    : [];
  for (const key of required) {
    if (obj[key] === undefined) problems.push(`missing required property: ${key}`);
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(obj)) {
      if (!(key in props)) problems.push(`unexpected property: ${key}`);
    }
  }

  for (const [key, spec] of Object.entries(props)) {
    if (obj[key] === undefined) continue;
    const t = spec?.type;
    // Only check single-type declarations; skip unions / untyped properties.
    if (typeof t === "string" && !matchesType(obj[key], t)) {
      problems.push(`property "${key}" must be ${t}, got ${describe(obj[key])}`);
    }
  }

  return problems;
}

/** Renders the problems plus the expected schema into one tool-result string
 *  the model can read and self-correct from in a single turn. */
export function formatInputError(
  toolName: string,
  problems: string[],
  schema: Record<string, unknown>,
): string {
  return [
    `input validation failed for ${toolName}:`,
    ...problems.map((p) => `  - ${p}`),
    ``,
    `expected input schema:`,
    JSON.stringify(schema, null, 2),
  ].join("\n");
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true; // unknown type keyword — don't reject
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
