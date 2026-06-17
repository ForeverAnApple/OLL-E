import { describe, expect, it } from "bun:test";
import {
  formatInputError,
  validateToolInput,
} from "../src/agent/validate-tool-input.ts";

const readExtFileSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    path: { type: "string" },
  },
  required: ["name", "path"],
  additionalProperties: false,
};

describe("validateToolInput", () => {
  it("accepts a correct call", () => {
    expect(
      validateToolInput(readExtFileSchema, { name: "claude-code", path: "index.ts" }),
    ).toEqual([]);
  });

  it("catches the blind-call param-name miss (file vs path)", () => {
    // The exact failure from the log: model guessed `file` instead of `path`.
    const problems = validateToolInput(readExtFileSchema, {
      name: "claude-code",
      file: "index.ts",
    });
    expect(problems).toContain("missing required property: path");
    expect(problems).toContain("unexpected property: file");
  });

  it("flags a type mismatch on a declared property", () => {
    expect(
      validateToolInput(readExtFileSchema, { name: 7, path: "index.ts" }),
    ).toContain('property "name" must be string, got number');
  });

  it("passes no-arg tools called with undefined or null input", () => {
    const noArg = { type: "object", properties: {}, additionalProperties: false };
    expect(validateToolInput(noArg, undefined)).toEqual([]);
    expect(validateToolInput(noArg, null)).toEqual([]);
    expect(validateToolInput(noArg, {})).toEqual([]);
  });

  it("passes optional-arg tools (no required) with extra-free input", () => {
    const optional = {
      type: "object",
      properties: { commands: { type: "array" } },
      additionalProperties: false,
    };
    expect(validateToolInput(optional, {})).toEqual([]);
    expect(validateToolInput(optional, { commands: ["claude"] })).toEqual([]);
  });

  it("allows extra props when additionalProperties is not false", () => {
    const loose = { type: "object", properties: { a: { type: "string" } } };
    expect(validateToolInput(loose, { a: "x", b: "y" })).toEqual([]);
  });

  it("is permissive on non-object or absent schemas", () => {
    expect(validateToolInput(undefined, { anything: true })).toEqual([]);
    expect(validateToolInput({ type: "string" }, "hello")).toEqual([]);
  });

  it("reports a non-object input for an object schema", () => {
    expect(validateToolInput(readExtFileSchema, "claude-code")).toContain(
      "expected an object input, got string",
    );
  });

  it("formats an error carrying the schema for self-correction", () => {
    const msg = formatInputError(
      "read_extension_file",
      ["missing required property: path"],
      readExtFileSchema,
    );
    expect(msg).toContain("input validation failed for read_extension_file");
    expect(msg).toContain("missing required property: path");
    expect(msg).toContain('"path"'); // schema is embedded so the model sees the shape
  });
});
